// Jupiter executor - real Solana swaps, SOL <-> memecoin, signed by the custody
// treasury key. The hedge buys each Live basket with the SOL the players
// deposited, so the arena spends their money and keeps the fee. Mainnet only:
// Jupiter has no devnet liquidity, which is why the paper book stands in there.
//
// Same contract as every executor the hedger has held: canTrade() / learn()
// decide which coins may back a Live payout, trade() fills, refresh() and
// spendableUsd() feed the capacity gate, assetOf() lets a winner withdraw the
// coin itself.

import { PublicKey, VersionedTransaction } from '@solana/web3.js'
import bs58 from 'bs58'
import { solKeypair, solRpc } from './chains.js'
import { settleRaw } from './solrpc.js'
import { dynamicById } from './registry.js'

const API = process.env.HOOD_JUP_SWAP_URL || 'https://lite-api.jup.ag/swap/v1'
const TOKENS = process.env.HOOD_JUP_TOKENS_URL || 'https://lite-api.jup.ag/tokens/v2'
const SOL_MINT = 'So11111111111111111111111111111111111111112'
const SLIPPAGE_BPS = Number(process.env.HOOD_JUP_SLIPPAGE_BPS) || 300

// A non-2xx is an answer only when it is a 4xx about the pair; a 429, a 5xx or
// a timeout means Jupiter did not answer at all, and a coin must never be
// condemned for that - it stays unknown and is asked again later.
const call = async (url, opts = {}) => {
  const res = await fetch(url, { headers: { accept: 'application/json', 'content-type': 'application/json' }, signal: AbortSignal.timeout(20000), ...opts })
  if (!res.ok) {
    const err = new Error(`jupiter http ${res.status}`)
    err.status = res.status
    throw err
  }
  return res.json()
}

export const makeJupiterExecutor = async ({
  // The treasury's RPC, with its fallbacks (solrpc.js) - the same endpoints
  // deposits and payouts use.
  rpc = solRpc, pool = 'sol', fallback,
  // Dollars per SOL, from the same feed that credits deposits.
  solPriceUsd = () => 0,
  // SOL held back from the capacity gate: network fees, and the rent every new
  // token account costs (~0.002 SOL each). Battles never spend it.
  feeReserveSol = Number(process.env.HOOD_SOL_FEE_RESERVE) || 0.05,
  // { load, save } - route verdicts cost real API budget to earn, so they
  // survive restarts.
  cache = null,
}) => {
  if (!rpc?.call) throw new Error('jupiter executor needs an RPC')
  const treasury = solKeypair('treasury')
  console.log(`[jupiter] ready - treasury ${treasury.publicKey.toBase58()}`)

  let idleLamports = 0
  const readIdle = async () => {
    try {
      const l = await rpc.call((c) => c.getBalance(treasury.publicKey, 'confirmed'))
      const reserve = Math.round(feeReserveSol * 1e9)
      idleLamports = Math.max(0, l - reserve)
    } catch { /* keep last */ }
  }
  await readIdle()
  const idleUsdNow = () => (idleLamports / 1e9) * solPriceUsd()

  const toLamports = (usd) => {
    const px = solPriceUsd()
    if (!(px > 0)) throw new Error('SOL price unknown - refusing to size a trade')
    return BigInt(Math.round((usd / px) * 1e9))
  }

  // mint -> { ok, ts, decimals }. Only DEFINITIVE answers are stored: priced both
  // ways (ok) or refused by Jupiter (not ok). "No" expires after 6h - a coin can
  // gain a market - and "yes" after 24h, because a market can also dry up.
  const routable = new Map()
  const RETRY_NO_MS = 6 * 3600e3
  const RETRY_YES_MS = 24 * 3600e3
  try {
    for (const [mint, v] of Object.entries(cache?.load() || {})) {
      if (v && typeof v.ok === 'boolean' && v.ts) routable.set(mint, v)
    }
    if (routable.size) console.log(`[jupiter] warmed ${routable.size} route verdict(s) from the last run`)
  } catch { /* cold start */ }
  const persist = () => { try { cache?.save(Object.fromEntries(routable)) } catch { /* best effort */ } }
  let coolUntil = 0

  const mintOf = (tokenId) => {
    const t = dynamicById(tokenId)
    return t && t.pool === pool && t.address ? t.address : null
  }

  const quote = (inputMint, outputMint, amount) =>
    call(`${API}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${SLIPPAGE_BPS}&restrictIntermediateTokens=true`)

  const decimalsOf = async (mint) => {
    const known = routable.get(mint)?.decimals
    if (known != null) return known
    const rows = await call(`${TOKENS}/search?query=${mint}`)
    const hit = (Array.isArray(rows) ? rows : []).find((r) => r.id === mint)
    if (hit?.decimals == null) throw Object.assign(new Error('mint unknown to jupiter'), { status: 404 })
    return hit.decimals
  }

  // Routable means Jupiter prices BOTH directions. A one-way route is a coin the
  // treasury could buy and never sell - the position that would leave the house
  // holding a payout it cannot back. Tri-state: true / false are answers, null
  // is "no answer", and a null never becomes a verdict.
  const probe = async (mint) => {
    try {
      const decimals = await decimalsOf(mint)
      const spend = toLamports(10)
      const buy = await quote(SOL_MINT, mint, spend.toString())
      const out = BigInt(buy?.outAmount ?? 0)
      if (out <= 0n) return { ok: false, decimals }
      const sell = await quote(mint, SOL_MINT, out.toString())
      const back = BigInt(sell?.outAmount ?? 0)
      // Losing more than half of $10 on a round trip isn't a market, it's a trap.
      return { ok: Number(back) / Number(spend) > 0.5, decimals }
    } catch (e) {
      if (e?.status === 429) { coolUntil = Date.now() + 10 * 60e3; return null }
      if (e?.status && e.status >= 400 && e.status < 500) return { ok: false, decimals: null }
      return null
    }
  }

  // Everything the treasury holds of one mint, across both token programs.
  const heldUnits = async (mint) => {
    const r = await rpc.call((c) => c.getParsedTokenAccountsByOwner(treasury.publicKey, { mint: new PublicKey(mint) }, 'confirmed'))
    return r.value.reduce((a, x) => a + BigInt(x.account.data.parsed.info.tokenAmount.amount), 0n)
  }

  const swap = async (inputMint, outputMint, amount) => {
    const q = await quote(inputMint, outputMint, amount.toString())
    if (!q?.outAmount) throw new Error('jupiter returned no route')
    const s = await call(`${API}/swap`, {
      method: 'POST',
      body: JSON.stringify({
        quoteResponse: q, userPublicKey: treasury.publicKey.toBase58(),
        wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: 'auto',
      }),
    })
    if (!s?.swapTransaction) throw new Error('jupiter returned no transaction')
    const tx = VersionedTransaction.deserialize(Buffer.from(s.swapTransaction, 'base64'))
    tx.sign([treasury])
    // Signed once; every broadcast and fallback sends these same bytes, and the
    // outcome is read back from the chain (solrpc.js). Jupiter already set the
    // priority fee ('auto' above).
    const sig = bs58.encode(tx.signatures[0])
    await settleRaw(rpc, tx.serialize(), sig, s.lastValidBlockHeight)
    return { sig, quote: q }
  }

  return {
    venue: 'jupiter',

    // Asked before a coin may enter Live Arena. Unknown means no.
    canTrade: (token) => token?.pool === pool && routable.get(token.address)?.ok === true,

    // Probe the book a slice at a time, deepest coins first (that is the order
    // the token source hands them over in), so the Live-eligible set grows every
    // cycle without hammering a keyless API into a ban.
    async learn(tokens, budget = Number(process.env.HOOD_JUP_PROBE_BUDGET) || 25) {
      if (Date.now() < coolUntil) return
      let dirty = false
      for (const t of tokens) {
        if (budget <= 0 || Date.now() < coolUntil) break
        if (t.pool !== pool || !t.address) continue
        const known = routable.get(t.address)
        if (known && Date.now() - known.ts < (known.ok ? RETRY_YES_MS : RETRY_NO_MS)) continue
        budget--
        const v = await probe(t.address)
        if (v) { routable.set(t.address, { ok: v.ok, decimals: v.decimals, ts: Date.now() }); dirty = true }
        await new Promise((r) => setTimeout(r, 400))
      }
      if (dirty) persist()
    },

    async trade(tokenId, side, usd, oraclePrice) {
      const mint = mintOf(tokenId)
      const route = mint ? routable.get(mint) : null
      if (!mint || route?.ok !== true || route.decimals == null) return fallback.trade(tokenId, side, usd, oraclePrice)
      const scale = 10 ** route.decimals
      if (side === 'buy') {
        const before = await heldUnits(mint).catch(() => null)
        const { sig, quote: q } = await swap(SOL_MINT, mint, toLamports(usd))
        // What actually landed, not what was quoted: transfer-fee coins arrive
        // short, and a book that runs ahead of the wallet sells tokens that are
        // not there.
        const after = before == null ? null : await heldUnits(mint).catch(() => null)
        const units = after != null && after > before ? after - before : BigInt(q.outAmount)
        const amount = Number(units) / scale
        return { amount, usd, price: usd / amount, txhash: sig, venue: 'jupiter' }
      }
      let units = BigInt(Math.round((usd / oraclePrice) * scale))
      try { const held = await heldUnits(mint); if (held < units) units = held } catch { /* let the chain judge */ }
      if (units <= 0n) throw new Error('the treasury holds none of this coin - nothing to sell')
      const { sig, quote: q } = await swap(mint, SOL_MINT, units)
      const gotUsd = (Number(q.outAmount) / 1e9) * solPriceUsd()
      const amount = Number(units) / scale
      return { amount, usd: gotUsd, price: gotUsd / amount, txhash: sig, venue: 'jupiter' }
    },

    refresh: readIdle,
    spendableUsd: () => idleUsdNow(),

    assetOf: (tokenId) => {
      const mint = mintOf(tokenId)
      if (!mint) return null
      return { chain: 'sol', address: mint, decimals: routable.get(mint)?.decimals ?? null }
    },

    stats: () => ({
      venue: 'jupiter', treasury: treasury.publicKey.toBase58(),
      probed: routable.size, routable: [...routable.values()].filter((v) => v.ok).length,
      cooldown: Date.now() < coolUntil ? new Date(coolUntil).toISOString() : null,
      spendableUsd: Math.round(idleUsdNow() * 100) / 100,
      solPriceUsd: Math.round(solPriceUsd() * 100) / 100,
    }),
  }
}
