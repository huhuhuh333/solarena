// Settlement prices for the Solana pool: Jupiter's price API.
//
// Jupiter quotes a TOKEN from the last swaps across every pool it routes
// through, which is the number a battle should settle on - a DexScreener pair
// is one pool, refreshed on a shared budget that turns the whole book over only
// every ~20s. Two lanes:
//
//   hot   - every coin in a live or picking battle, every HOT_MS. These are the
//           prices money moves on, so they never wait behind the book.
//   sweep - the rest of the book in a rotating window, one batch per SWEEP_MS,
//           so every card and the ticker stay seconds-to-a-minute fresh.
//
// Jupiter answers up to 50 mints per call. A refusal (429 / timeout) backs the
// whole feeder off instead of hammering, and the DexScreener sweep in
// tokensource.js keeps pricing any coin this feed has not reached in a minute.

import { applyFeed, getPrice } from './market.js'
import { dynamicTokens } from './registry.js'
import { mark } from './blockwatch.js'

const PRICE_API = 'https://lite-api.jup.ag/price/v3'
const BATCH = 50
const HOT_MS = Number(process.env.HOOD_JUP_HOT_MS) || 2000
const SWEEP_MS = Number(process.env.HOOD_JUP_SWEEP_MS) || 3000
const FRESH_MS = 60_000
const BACKOFF_MS = 30_000
// A print more than this far from the last one, inside one hot interval, is
// held back for one confirmation read rather than settled on immediately: a
// single-block spike on a thin coin is exactly the print a battle must not end on.
const JUMP_CONFIRM = 0.5

const st = {
  started: false, hotIds: () => [], sweepAt: 0,
  lastAt: new Map(),          // token id -> ms of the last Jupiter price we applied
  pending: new Map(),         // token id -> unconfirmed jump
  backoffUntil: 0, sent: 0, failed: 0, applied: 0, lastOk: 0, lastErr: null,
}

// ---- SOL/USD: the price the ledger, the deposit watcher and the hedge share ----
//
// One number for crediting a deposit, converting a balance and sizing a Live
// buy - never two. Jupiter's quote for wrapped SOL, refreshed every 10s. Zero
// when unknown, and the ledger then refuses to move money on mainnet rather than
// guess.
const SOL_MINT = 'So11111111111111111111111111111111111111112'
const SOL_MS = 10_000
const sol = { usd: 0, at: 0 }
const readSolUsd = async () => {
  try {
    const res = await fetch(`${PRICE_API}?ids=${SOL_MINT}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) })
    if (!res.ok) return
    const p = Number((await res.json())?.[SOL_MINT]?.usdPrice)
    if (p > 1 && p < 100000) { sol.usd = p; sol.at = Date.now() }
  } catch { /* keep the last price */ }
}
// Stale after five minutes: a price that old is not the one to credit at.
export const solUsdNow = () => (sol.at && Date.now() - sol.at < 5 * 60e3 ? sol.usd : 0)
// Boot waits for the first read, so the ledger has a price before anything moves.
export const primeSolUsd = async () => { await readSolUsd(); return solUsdNow() }

export const jupPriceFresh = (id) => {
  const at = st.lastAt.get(id)
  return at != null && Date.now() - at < FRESH_MS
}

// Which coins are being fought over right now. Wired from index.js so this
// module never has to know about rooms or tournaments.
export const setHotTokens = (fn) => { st.hotIds = fn }

const poolTokens = () => dynamicTokens().filter((t) => t.pool === 'sol' && !t.retired && t.address)

const fetchBatch = async (tokens) => {
  const res = await fetch(`${PRICE_API}?ids=${tokens.map((t) => t.address).join(',')}`, {
    headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000),
  })
  st.sent++
  if (res.status === 429) { st.backoffUntil = Date.now() + BACKOFF_MS; throw new Error('jup 429') }
  if (!res.ok) throw new Error('jup http ' + res.status)
  return res.json()
}

const apply = (tokens, body, { confirmJumps }) => {
  const feed = {}
  const now = Date.now()
  for (const t of tokens) {
    const q = body?.[t.address]
    const price = Number(q?.usdPrice)
    if (!(price > 0)) continue
    const prev = getPrice(t.id)
    if (confirmJumps && prev > 0 && Math.abs(price / prev - 1) > JUMP_CONFIRM) {
      const p = st.pending.get(t.id)
      // Accept on the second read that lands in the same neighbourhood.
      if (!p || Math.abs(price / p - 1) > 0.1) { st.pending.set(t.id, price); continue }
    }
    st.pending.delete(t.id)
    feed[t.id] = {
      price,
      ...(Number.isFinite(Number(q.priceChange24h)) ? { change24: Number(q.priceChange24h) } : {}),
    }
    st.lastAt.set(t.id, now)
  }
  const n = Object.keys(feed).length
  if (n) { applyFeed(feed); st.applied += n; st.lastOk = now }
}

const run = async (tokens, opts) => {
  for (let i = 0; i < tokens.length; i += BATCH) {
    if (Date.now() < st.backoffUntil) return
    const batch = tokens.slice(i, i + BATCH)
    try {
      const body = await fetchBatch(batch)
      mark('solprices.apply', () => apply(batch, body, opts))
    } catch (e) {
      st.failed++
      st.lastErr = String(e.message).slice(0, 80)
    }
  }
}

let hotBusy = false
const hotOnce = async () => {
  if (hotBusy || Date.now() < st.backoffUntil) return
  hotBusy = true
  try {
    const ids = new Set(st.hotIds() || [])
    if (!ids.size) return
    const tokens = poolTokens().filter((t) => ids.has(t.id))
    await run(tokens, { confirmJumps: true })
  } finally { hotBusy = false }
}

let sweepBusy = false
const sweepOnce = async () => {
  if (sweepBusy || Date.now() < st.backoffUntil) return
  sweepBusy = true
  try {
    const all = poolTokens()
    if (!all.length) return
    // Stalest first: a coin the feed never reached, then the one it reached
    // longest ago. One batch per tick keeps the rate flat however big the book.
    all.sort((a, b) => (st.lastAt.get(a.id) || 0) - (st.lastAt.get(b.id) || 0))
    await run(all.slice(0, BATCH), { confirmJumps: false })
  } finally { sweepBusy = false }
}

export const startSolPrices = () => {
  if (st.started) return
  st.started = true
  setInterval(() => { readSolUsd() }, SOL_MS)
  setInterval(() => { hotOnce().catch(() => {}) }, HOT_MS)
  setInterval(() => { sweepOnce().catch(() => {}) }, SWEEP_MS)
  console.log('[solprices] Jupiter price feed up - battle coins every 2s, the book on rotation')
}

export const solPricesStatus = () => {
  const now = Date.now()
  const tokens = poolTokens()
  const fresh = tokens.filter((t) => jupPriceFresh(t.id)).length
  return {
    started: st.started, solUsd: solUsdNow(), book: tokens.length, freshUnder60s: fresh,
    requests: st.sent, failed: st.failed, applied: st.applied,
    lastOkSecAgo: st.lastOk ? Math.round((now - st.lastOk) / 1000) : null,
    backingOff: now < st.backoffUntil, lastErr: st.lastErr,
  }
}
