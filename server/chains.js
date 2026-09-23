// Custody adapter for the arena's ONE rail: Solana (owner, 22 Sep 2026 - "novac
// nek bude solana, totalno izbacujemo sve sem solane").
//
// Players deposit native SOL to an address derived for them, balances are held
// in SOL, Live baskets are bought with it on Jupiter and withdrawals go out in
// it. Every key derives from ONE master seed (HOOD_WALLET_SEED) - back that seed
// up and every address, deposit and treasury alike, is recoverable.
//
// HOOD_CHAIN_ENV=testnet (default) runs on Solana devnet, where the coins are
// worthless and the whole money cycle can be proven; mainnet is a deliberate
// switch. RPC endpoints, failover and the send path live in solrpc.js.

import { createHmac } from 'node:crypto'
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js'
import {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction, getMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token'
import { makeRpc, sendInstructions, signatureOutcome } from './solrpc.js'

const TESTNET = (process.env.HOOD_CHAIN_ENV || 'testnet') !== 'mainnet'
export const CHAIN_ENV = TESTNET ? 'testnet' : 'mainnet'

// Primary first, then the fallbacks. On mainnet the public endpoint always
// stands behind a keyed primary: free, rate-limited, but an answer when the
// provider has none.
const PUBLIC_RPC = TESTNET ? 'https://api.devnet.solana.com' : 'https://api.mainnet-beta.solana.com'
const PRIMARY_RPC = process.env.HOOD_SOL_RPC || PUBLIC_RPC
const FALLBACK_RPCS = (process.env.HOOD_SOL_RPC_FALLBACK || '').split(',').map((s) => s.trim()).filter(Boolean)
export const solRpc = makeRpc([PRIMARY_RPC, ...FALLBACK_RPCS, PUBLIC_RPC])
export const RPC_URLS = { sol: PRIMARY_RPC }

// Compute budgets, sized to what each transaction does (see solrpc.js).
const CU_TRANSFER = 1_400
const CU_TOKEN = 80_000

// ---- key derivation ----
let masterSeed = null
export const setMasterSeed = (hex) => { masterSeed = Buffer.from(hex, 'hex') }

const derive = (chainId, who) => {
  if (!masterSeed) throw new Error('wallet seed not initialised')
  return createHmac('sha512', masterSeed).update(`${chainId}:${who}`).digest().subarray(0, 32)
}

// Exported for the Jupiter executor: the treasury that swaps is the same
// treasury deposits sweep into, derived from the same seed.
export const solKeypair = (who) => Keypair.fromSeed(derive('sol', who))

// A lamport balance read is cheap but the wallet screen polls it from every open
// tab; one read per address per few seconds is plenty.
const cache = new Map()
const cached = async (key, ttlMs, fn) => {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < ttlMs) return hit.value
  const value = await fn()
  cache.set(key, { at: Date.now(), value })
  return value
}
const drop = (...keys) => keys.forEach((k) => cache.delete(k))

// Money is only ever sent to a key someone holds. An address OFF the ed25519
// curve is a program-derived address or similar: SOL sent there is gone. The
// classic version of this mistake is pasting a token account instead of a
// wallet, and this check refuses it before anything leaves the treasury.
const walletAddress = (a) => {
  try { const pk = new PublicKey(String(a).trim()); return PublicKey.isOnCurve(pk.toBytes()) ? pk : null } catch { return null }
}

const makeSol = () => {
  const rpc = solRpc
  const stats = { reads: 0, readFails: 0, sends: 0, sendFails: 0, lastError: null }
  const note = (e) => { stats.lastError = String(e?.message || e).slice(0, 120) }

  // Every outgoing transfer goes through here: signed once, recorded by the
  // caller via onSigned, settled against the chain. A failure the chain did not
  // prove (definite === false) is left for the caller to hold, never to refund.
  const send = async (instructions, feePayer, signers, cuLimit, onSigned) => {
    stats.sends++
    try {
      return await sendInstructions(rpc, { instructions, feePayer, signers, cuLimit, onSigned })
    } catch (e) { stats.sendFails++; note(e); throw e }
  }

  // Token program per mint: classic SPL and Token-2022 coins both trade on
  // Jupiter, and a transfer built for the wrong program fails on-chain.
  const mintInfo = new Map()
  const mintOf = async (mint) => {
    if (mintInfo.has(mint)) return mintInfo.get(mint)
    const pk = new PublicKey(mint)
    const acct = await rpc.call((c) => c.getAccountInfo(pk, 'confirmed'))
    if (!acct) throw new Error('mint not found on-chain')
    const programId = acct.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
    const m = await rpc.call((c) => getMint(c, pk, 'confirmed', programId))
    const info = { programId, decimals: m.decimals }
    mintInfo.set(mint, info)
    return info
  }

  return {
    id: 'sol', label: 'Solana', icon: '◎',
    nativeSymbol: 'SOL', nativeLabel: 'SOL', nativeDecimals: 9,
    // Single-asset rail: there is no stable here, only SOL.
    stableOffered: false, stableSymbol: null, usdcDecimals: 6,
    network: TESTNET ? 'Solana devnet' : 'Solana',
    explorer: TESTNET ? 'https://solscan.io/tx/{tx}?cluster=devnet' : 'https://solscan.io/tx/{tx}',
    // True when the money on this rail is real. Devnet SOL is not.
    liveNetwork: !TESTNET,
    rpcStatus: () => ({ endpoint: rpc.status().endpoints[0]?.host, ...stats, ...rpc.status(), cached: cache.size }),

    address: (who) => solKeypair(who).publicKey.toBase58(),
    validAddress: (a) => !!walletAddress(a),

    async balances(address) {
      return cached(`bal:${address}`, 4000, async () => {
        stats.reads++
        try {
          const lamports = await rpc.call((c) => c.getBalance(new PublicKey(address), 'finalized'))
          return { native: BigInt(lamports), usdc: 0n }
        } catch (e) { stats.readFails++; note(e); throw e }
      })
    },
    async balancesFresh(address) {
      drop(`bal:${address}`)
      return this.balances(address)
    },

    /// Many deposit addresses, 100 per request, all read at one finalized slot.
    /// An account that does not exist yet is a real zero - nobody has sent it
    /// anything - which is different from a read that failed: a failed batch
    /// throws, and the watcher falls back to one address at a time.
    async balancesMany(addresses) {
      const out = new Map()
      for (let i = 0; i < addresses.length; i += 100) {
        const slice = addresses.slice(i, i + 100)
        stats.reads++
        let infos
        try {
          infos = await rpc.call((c) => c.getMultipleAccountsInfo(slice.map((a) => new PublicKey(a)), 'finalized'))
        } catch (e) { stats.readFails++; note(e); throw e }
        slice.forEach((a, n) => out.set(a, { native: BigInt(infos[n]?.lamports ?? 0), usdc: 0n }))
      }
      return out
    },

    async send(fromWho, to, asset, baseUnits, { onSigned } = {}) {
      if (asset !== 'native') throw new Error('this rail carries SOL only')
      const toPk = walletAddress(to)
      if (!toPk) throw new Error('not a wallet address')
      const payer = solKeypair(fromWho)
      const sig = await send([SystemProgram.transfer({
        fromPubkey: payer.publicKey, toPubkey: toPk, lamports: BigInt(baseUnits),
      })], payer.publicKey, [payer], CU_TRANSFER, onSigned)
      drop(`bal:${payer.publicKey.toBase58()}`, `bal:${toPk.toBase58()}`)
      return sig
    },

    // Send an SPL coin the treasury holds - a player's Live winnings, to their
    // own wallet. The treasury pays for the recipient's token account if they
    // have none; nobody should need the coin already to receive it. Sends what
    // is actually held when that is a hair under the book (transfer-fee coins
    // arrive short), rather than failing the whole withdrawal over dust.
    async sendToken(fromWho, to, mint, baseUnits, { onSigned } = {}) {
      const toPk = walletAddress(to)
      if (!toPk) throw new Error('not a wallet address')
      const payer = solKeypair(fromWho)
      const mintPk = new PublicKey(mint)
      const { programId, decimals } = await mintOf(mint)
      const fromAta = getAssociatedTokenAddressSync(mintPk, payer.publicKey, false, programId)
      const toAta = getAssociatedTokenAddressSync(mintPk, toPk, false, programId)
      let units = BigInt(baseUnits)
      try {
        const held = BigInt((await rpc.call((c) => c.getTokenAccountBalance(fromAta, 'confirmed'))).value.amount)
        if (held < units) units = held
      } catch { /* unreadable - send what was asked and let the chain judge */ }
      if (units <= 0n) throw new Error('the treasury holds none of this coin')
      return send([
        createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, toAta, toPk, mintPk, programId),
        createTransferCheckedInstruction(fromAta, mintPk, toAta, payer.publicKey, units, decimals, [], programId),
      ], payer.publicKey, [payer], CU_TOKEN, onSigned)
    },

    // Deposit address → treasury. The TREASURY pays the network fee, so the
    // deposit address needs no SOL of its own and the whole credited amount
    // moves; the account is emptied, which Solana allows (a zero-lamport
    // account simply stops existing - no rent minimum applies to it). A sweep
    // that errors is simply tried again next round: the watcher reconciles
    // against the finalized balance, so one that did land is never re-swept.
    async sweep(who, to, asset, baseUnits) {
      if (asset !== 'native') return { txhash: null, sent: 0n }
      const user = solKeypair(who)
      const treasury = solKeypair('treasury')
      const txhash = await send([SystemProgram.transfer({
        fromPubkey: user.publicKey, toPubkey: new PublicKey(to), lamports: BigInt(baseUnits),
      })], treasury.publicKey, [treasury, user], CU_TRANSFER)
      drop(`bal:${user.publicKey.toBase58()}`, `bal:${to}`)
      return { txhash, sent: BigInt(baseUnits) }
    },

    // A transfer whose outcome was not known when it was sent: what does the
    // chain say now? 'landed' | 'failed' | 'unknown'.
    checkTx: (signature, lastValidBlockHeight) => signatureOutcome(rpc, signature, lastValidBlockHeight),

    // For the browser: a wallet like Phantom signs a transfer the page builds,
    // and the page needs a recent blockhash to build it. Served from here so the
    // operator's RPC endpoint (which may carry an API key) never reaches a browser.
    async latestBlockhash() {
      return cached('blockhash', 5000, () => rpc.call((c) => c.getLatestBlockhash('confirmed')))
    },

    async requestAirdrop(address, sol) { // devnet only
      if (!TESTNET) throw new Error('airdrops exist on devnet only')
      const sig = await rpc.call((c) => c.requestAirdrop(new PublicKey(address), Math.round(sol * LAMPORTS_PER_SOL)))
      await rpc.call((c) => c.confirmTransaction(sig, 'confirmed'))
      drop(`bal:${address}`)
      return sig
    },
  }
}

export const CHAINS = { sol: makeSol() }

export const chainById = (id) => CHAINS[id] || null

export const fromBase = (units, decimals) => Number(units) / 10 ** decimals
// Rounded at 9 decimals before scaling, so an amount never picks up float dust
// that turns into a lamport more than the balance holds.
export const toBase = (amount, decimals) => BigInt(Math.round(Number(amount) * 10 ** Math.min(decimals, 9))) * 10n ** BigInt(Math.max(0, decimals - 9))
