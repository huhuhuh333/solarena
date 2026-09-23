// Solana RPC for the treasury: more than one endpoint, and a send path that can
// never pay twice.
//
// ENDPOINTS. HOOD_SOL_RPC is the primary (a free provider key is plenty - the
// arena makes one or two reads a minute). HOOD_SOL_RPC_FALLBACK is a comma list
// tried in order when the primary does not answer; on mainnet the public
// endpoint is added automatically behind a keyed primary. Only a TRANSPORT
// failure moves a call to the next endpoint (rate limit, 5xx, refused, timeout).
// A real answer - "insufficient funds", "invalid account" - is the same answer
// everywhere and is returned at once. An endpoint that fails sits out for 30s so
// every call does not first wait on the one that is down.
//
// SENDING. The old path (web3's sendAndConfirmTransaction) signed, sent and
// waited in one call, and any error - including "the confirmation timed out" for
// a transfer that had in fact landed - came back as a failure the withdrawal
// queue REFUNDED. That is a double payment. Here a transaction is signed ONCE
// and its signature is known before a byte leaves; every broadcast, retry and
// fallback sends those same bytes, which the chain can execute at most once.
// Then the outcome is read back from the chain, and an error says whether it is
// DEFINITE (provably not executed: rejected in simulation, landed with an
// error, or its blockhash died without it landing) or not. Only a definite
// failure may be refunded; anything else is held and checked again later.
//
// PRIORITY FEE. Every transaction carries a compute-unit limit sized to what it
// does and a priority price from recent network fees, clamped - so a payout
// still lands when the network is busy, for a fraction of a cent.

import { Connection, Transaction, ComputeBudgetProgram } from '@solana/web3.js'
import bs58 from 'bs58'

const DOWN_MS = Number(process.env.HOOD_SOL_RPC_DOWN_MS) || 30_000
// Micro-lamports per compute unit. At the ceiling a SOL transfer (1,400 CU)
// costs 1,400 lamports and a token payout (80,000 CU) 0.00008 SOL.
const PRIORITY_MIN = Number(process.env.HOOD_SOL_PRIORITY_MIN ?? 50_000)
const PRIORITY_MAX = Number(process.env.HOOD_SOL_PRIORITY_MAX ?? 1_000_000)

// Did the endpoint fail to ANSWER (worth asking another), as opposed to answer
// with something we did not want?
export const transientRpcError = (e) => /\b(429|403|500|502|503|504)\b|Too Many Requests|fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|timed? ?out|network|UND_ERR|Blockhash not found/i
  .test(String(e?.message || e))

const alreadyProcessed = (e) => /already been processed|AlreadyProcessed/i.test(String(e?.message || e))

export class SendError extends Error {
  constructor(message, { definite, signature = null } = {}) {
    super(message)
    this.definite = definite
    this.signature = signature
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// connect is injectable so the failover can be tested without a network.
export const makeRpc = (urls, { connect = (url) => new Connection(url, 'confirmed') } = {}) => {
  const list = [...new Set(urls.filter(Boolean))]
  if (!list.length) throw new Error('no Solana RPC endpoint configured')
  const eps = list.map((url) => {
    let host = url
    try { host = new URL(url).host } catch { /* a test label */ }
    return { url, host, conn: connect(url), downUntil: 0, calls: 0, fails: 0 }
  })
  const stats = { failovers: 0, lastError: null }

  // Healthy endpoints in configured order; if every one is sitting out, the one
  // due back soonest goes first rather than refusing to try at all.
  const order = () => {
    const now = Date.now()
    const up = eps.filter((e) => e.downUntil <= now)
    return up.length ? up : [...eps].sort((a, b) => a.downUntil - b.downUntil)
  }

  const call = async (fn) => {
    const tries = order()
    let last
    for (let i = 0; i < tries.length; i++) {
      const ep = tries[i]
      ep.calls++
      try {
        return await fn(ep.conn)
      } catch (e) {
        last = e
        stats.lastError = `${ep.host}: ${String(e?.message || e).slice(0, 110)}`
        if (!transientRpcError(e)) throw e
        ep.fails++
        ep.downUntil = Date.now() + DOWN_MS
        if (i < tries.length - 1) stats.failovers++
      }
    }
    throw last
  }

  return {
    call,
    urls: list,
    status: () => ({
      endpoints: eps.map((e) => ({ host: e.host, calls: e.calls, fails: e.fails, down: e.downUntil > Date.now() })),
      failovers: stats.failovers,
      lastError: stats.lastError,
    }),
  }
}

// Priority price from what the network has been paying lately, clamped both
// ways: never zero (a busy network drops zero-priority transactions first) and
// never enough to matter.
export const priorityPrice = async (rpc) => {
  try {
    const fees = await rpc.call((c) => c.getRecentPrioritizationFees())
    const vals = fees.map((f) => f.prioritizationFee).filter((v) => v > 0).sort((a, b) => a - b)
    const p75 = vals.length ? vals[Math.floor(vals.length * 0.75)] : 0
    return Math.min(PRIORITY_MAX, Math.max(PRIORITY_MIN, p75))
  } catch {
    return PRIORITY_MIN
  }
}

// Broadcast signed bytes and follow them to an outcome. Resolves with the
// signature once confirmed; throws a SendError whose `definite` says whether
// the transaction provably did NOT execute.
export const settleRaw = async (rpc, raw, signature, lastValidBlockHeight, {
  timeoutMs = 120_000, pollMs = 1500, resendMs = 4000,
} = {}) => {
  try {
    // Preflight on the first send: a simulation the chain rejects is a clean,
    // definite no - nothing was forwarded.
    await rpc.call((c) => c.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0 }))
  } catch (e) {
    // "Already processed" means an earlier attempt of THESE bytes got through.
    if (!alreadyProcessed(e) && !transientRpcError(e)) {
      throw new SendError(`rejected: ${String(e?.message || e).slice(0, 200)}`, { definite: true, signature })
    }
    // Every endpoint failed to answer: it may or may not have been received.
    // Either way the chain is the only authority now - read it below.
  }

  const start = Date.now()
  let lastResend = Date.now()
  for (;;) {
    await sleep(pollMs)
    let st = null
    try { st = (await rpc.call((c) => c.getSignatureStatuses([signature]))).value[0] } catch { /* unreadable this round */ }
    if (st?.err) throw new SendError(`landed but failed: ${JSON.stringify(st.err).slice(0, 160)}`, { definite: true, signature })
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return signature

    // The same bytes again now and then: identical signature, so this can only
    // help it land - it can never make it land twice.
    if (Date.now() - lastResend >= resendMs) {
      lastResend = Date.now()
      rpc.call((c) => c.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 })).catch(() => {})
    }

    let height = null
    try { height = await rpc.call((c) => c.getBlockHeight('confirmed')) } catch { /* unreadable */ }
    if (height != null && height > lastValidBlockHeight) {
      // Its blockhash has expired: from here on it can never land. One last
      // look through history decides it.
      let fin
      try {
        fin = (await rpc.call((c) => c.getSignatureStatuses([signature], { searchTransactionHistory: true }))).value[0]
      } catch { fin = undefined }
      if (fin !== undefined) {
        if (fin?.err) throw new SendError(`landed but failed: ${JSON.stringify(fin.err).slice(0, 160)}`, { definite: true, signature })
        if (fin) return signature
        throw new SendError('expired without landing', { definite: true, signature })
      }
    }
    if (Date.now() - start > timeoutMs) {
      throw new SendError('could not confirm either way - left for the chain to answer later', { definite: false, signature })
    }
  }
}

// Build, sign once, hand the signature to the caller (so it can be recorded
// BEFORE anything is broadcast), then settle.
export const sendInstructions = async (rpc, {
  instructions, feePayer, signers, cuLimit, onSigned, ...opts
}) => {
  const { blockhash, lastValidBlockHeight } = await rpc.call((c) => c.getLatestBlockhash('confirmed'))
  const price = await priorityPrice(rpc)
  const tx = new Transaction({ feePayer, blockhash, lastValidBlockHeight }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }),
    ...instructions,
  )
  tx.sign(...signers)
  const signature = bs58.encode(tx.signature)
  if (onSigned) onSigned(signature, lastValidBlockHeight)
  return settleRaw(rpc, tx.serialize(), signature, lastValidBlockHeight, opts)
}

// For a transaction recorded earlier whose outcome was not known: what does
// the chain say now? 'landed' | 'failed' (provably not executed) | 'unknown'.
export const signatureOutcome = async (rpc, signature, lastValidBlockHeight) => {
  try {
    const st = (await rpc.call((c) => c.getSignatureStatuses([signature], { searchTransactionHistory: true }))).value[0]
    if (st) {
      if (st.err) return 'failed'
      return st.confirmationStatus === 'processed' ? 'unknown' : 'landed'
    }
    if (lastValidBlockHeight) {
      const height = await rpc.call((c) => c.getBlockHeight('confirmed'))
      // Not found anywhere and its blockhash is dead: it never landed and never will.
      if (height > lastValidBlockHeight) return 'failed'
    }
    return 'unknown'
  } catch {
    return 'unknown'
  }
}
