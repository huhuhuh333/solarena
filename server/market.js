// Server-authoritative market. REAL prices first: once a token has a live
// anchor (Pyth / CoinGecko / DexScreener / GeckoTerminal), its displayed price
// and its settlement history ARE that anchor - held flat between updates, like
// any real trading UI. GBM simulation only covers tokens that have never
// received a real print (and the pre-anchor boot window). Tokens are
// registered dynamically: the static curated set at boot, plus whatever the
// token-source ingests from the DEXs. Both players in a duel see prices from
// THIS process - no browser is trusted with settlement.
//
// HOOD_SPEED (env) advances N sim-seconds per real second - test runs only.

import { TOKENS } from '../src/engine/tokens.js'

const VOL = { low: 0.0009, mid: 0.0022, high: 0.005, insane: 0.011 }
const DAY_RANGE = { low: 0.03, mid: 0.08, high: 0.18, insane: 0.4 }
const HIST_CAP = 900

const randn = () => {
  let u = 0, v = 0
  while (u === 0) u = Math.random()
  while (v === 0) v = Math.random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

const state = {
  t: 0,
  speed: Math.max(1, Number(process.env.HOOD_SPEED) || 1),
  prices: {},          // id -> { p, day0, drift, v, vol24, hist }
  anchors: {},
  feedStatus: 'sim',
  listeners: new Set(),
  snapGuard: () => true, // may the first real anchor snap prices? (false while battles run)
}

const seed = (id, base, volTier) => {
  const r = DAY_RANGE[volTier] ?? DAY_RANGE.high
  const day0 = base * (1 - (Math.random() * 2 * r - r))
  state.prices[id] = {
    p: base, day0,
    drift: (Math.random() - 0.48) * 2e-5,
    v: VOL[volTier] ?? VOL.high,
    hist: [{ t: state.t, p: base }],
  }
}

for (const tok of TOKENS) seed(tok.id, tok.base, tok.vol)

// Register a token discovered at runtime (idempotent). base = current price.
export const registerToken = (id, { base, vol = 'high' } = {}) => {
  if (state.prices[id]) return
  seed(id, base > 0 ? base : 1e-9, vol)
}

export const knownTokens = () => Object.keys(state.prices)

// Switch a token from the simulated seed onto real prices.
//
// The seed history is fabricated - a geometric random walk around a stale seed
// (BTC seeded at 117k while real is ~64k). Rescaling it onto the real level
// keeps a shape that never happened, so a chart labelled LIVE PRICES would show
// 80% invented wiggle and 20% real price, meeting at a visible step. So the sim
// history is DISCARDED the moment a real price lands: the chart starts clean and
// fills with genuine movement. A blue chip that has barely moved then reads as a
// nearly flat line, which is the truth. This is the only place a token turns
// real, so it happens exactly once per token.
const goReal = (s, price) => {
  s.p = price
  s.real = true
  s.hist = [{ t: state.t, p: price }] // drop the simulated past; keep only real prints
}

const step = (dt) => {
  state.t += dt
  for (const id in state.prices) {
    const s = state.prices[id]
    const a = state.anchors[id]
    if (s.real && a != null) {
      // Real mode: the price IS the last real print, held flat until the next
      // one. No synthetic movement ever enters the history (or the TWAP).
      s.p = a
    } else {
      s.p *= Math.exp((s.drift - (s.v * s.v) / 2) * dt + s.v * Math.sqrt(dt) * randn())
      if (a) s.p += (a - s.p) * (1 - Math.exp(-dt / 20))
      // A battle blocked the initial snap - flip to real as soon as it's allowed,
      // rescaling the history so the switch never shows as a cliff.
      if (a != null && !s.real && state.snapGuard()) goReal(s, a)
    }
    s.hist.push({ t: state.t, p: s.p })
    if (s.hist.length > HIST_CAP) s.hist.shift()
  }
}

export const applyFeed = (data) => {
  const snapOk = state.snapGuard()
  for (const [id, d] of Object.entries(data)) {
    const s = state.prices[id]
    if (!s || !(d.price > 0)) continue
    if (s.real) {
      s.p = d.price // already tracking real prices - follow the print directly
    } else if (snapOk) {
      goReal(s, d.price) // first real print: rescale the sim history onto it
    }
    state.anchors[id] = d.price
    if (d.change24 != null) s.day0 = d.price / (1 + d.change24 / 100)
    if (d.vol24 != null) s.vol24 = d.vol24
  }
}

export const isReal = (id) => state.prices[id]?.real === true

export const setSnapGuard = (fn) => { state.snapGuard = fn }
export const setFeedStatus = (x) => { state.feedStatus = x }
export const getFeedStatus = () => state.feedStatus
export const getVol24 = (id) => state.prices[id]?.vol24 ?? null

let interval = null
export const startMarket = () => {
  if (interval) return
  for (let i = 0; i < 240; i++) step(1)
  // The sim clock owes the WALL clock, not the interval. setInterval only
  // fires when the event loop is free, and this process has real stalls (the
  // firehose stats rollup alone held the loop ~3.7s in every 15 measured) -
  // with a naive `step(speed)` per fire, every stalled second silently
  // vanished from the battle clock. Players watched the countdown hit 0:00 and
  // the match play on for another minute, with the outcome still moving.
  // Duels end at `simTime() >= endsAt`, so the sim clock must track wall time:
  // each fire pays down however many whole seconds actually passed, and a
  // stall is caught up in one step - the settle check runs on the same tick.
  let lastWall = Date.now()
  let owedMs = 0
  interval = setInterval(() => {
    const now = Date.now()
    owedMs += now - lastWall
    lastWall = now
    const secs = Math.floor(owedMs / 1000)
    if (secs <= 0) return // fired early; the debt carries to the next fire
    owedMs -= secs * 1000
    step(secs * state.speed)
    state.listeners.forEach((fn) => {
      try { fn(state.t) } catch (e) { console.error('[market] tick listener error:', e) }
    })
  }, 1000)
}

// Advance the simulation by hand. Exactly the step the 1s ticker runs - exposed
// so a test can play out a whole battle deterministically instead of sleeping
// through real seconds, which is the only way settlement (a 30-reading TWAP)
// can be exercised at all.
export const stepMarket = (dt = 1) => step(dt)

export const onTick = (fn) => {
  state.listeners.add(fn)
  return () => state.listeners.delete(fn)
}

export const simTime = () => state.t
export const getPrice = (id) => state.prices[id]?.p ?? 0
export const getHist = (id) => state.prices[id]?.hist ?? []

// A small, real sparkline for the token table: the accumulated REAL history,
// evenly downsampled to at most `n` points. Sent with the token list so the
// chart shows genuine price action the instant the page loads - no local sim to
// flash first, no per-refresh reset. Empty until a token has real history.
export const getSpark = (id, n = 48) => {
  const h = state.prices[id]?.hist ?? []
  if (h.length < 2) return []
  if (h.length <= n) return h.map((x) => Math.round(x.p * 1e6) / 1e6)
  const out = []
  for (let i = 0; i < n; i++) out.push(Math.round(h[Math.floor((i * (h.length - 1)) / (n - 1))].p * 1e6) / 1e6)
  return out
}

export const dayChange = (id) => {
  const s = state.prices[id]
  return s ? ((s.p - s.day0) / s.day0) * 100 : 0
}

// Change over the last `secs` of REAL prints. The short timeframes on a token
// card come from the pair's own stats for ingested coins; a Blue Chip has no
// pair, and the vendor's markets row starts at 1h - but our own print history
// covers minutes exactly, so 5m is ours to answer. Null until the window is
// actually covered: a made-up percentage is worse than a dash.
export const changeOverSec = (id, secs) => {
  const s = state.prices[id]
  if (!s?.real) return null
  const h = s.hist
  if (h.length < 2) return null
  const last = h[h.length - 1]
  const cutoff = last.t - secs
  if (h[0].t > cutoff) return null
  let lo = 0, hi = h.length - 1
  while (lo < hi) { const mid = (lo + hi) >> 1; if (h[mid].t < cutoff) lo = mid + 1; else hi = mid }
  const then = h[lo].p
  return then > 0 ? ((last.p - then) / then) * 100 : null
}

// Time-weighted average over the last `secs` of price history, ending at `endT`
// (defaults to now).
//
// This used to average the last N READINGS, which was the same thing only while
// readings arrived once a second. They no longer do: the Robinhood pool feeds
// the engine one print per TRADE (server/pricewatch.js), so a coin doing 200
// trades a minute would have packed "30 readings" into nine seconds - and a
// nine-second window is one a last-second buy can move. The window is now
// measured in TIME, so how busy a coin is cannot shrink the protection.
//
// Weighted by how long each price stood, not by how many prints it got: a real
// print is held flat until the next one, so a price that ruled for 20 seconds
// counts twenty times more than one that lasted a second. That is what makes
// this a TWAP rather than an average of whatever the tape happened to print.
export const TWAP_SECS = 30

const twapOver = (h, endT, secs) => {
  if (!h.length) return null
  const from = endT - secs
  // Newest first: walk back until the window is covered.
  let i = h.length - 1
  while (i >= 0 && h[i].t > endT) i--
  if (i < 0) return h[0].p
  let sum = 0, dur = 0, next = Math.min(endT, h[i].t + secs)
  for (; i >= 0; i--) {
    const start = Math.max(h[i].t, from)
    const w = next - start
    if (w > 0) { sum += h[i].p * w; dur += w }
    next = h[i].t
    if (h[i].t <= from) break
  }
  if (dur <= 0) return h[Math.max(0, i)].p // a single print covers the window
  return sum / dur
}

export const twap = (id, secs = TWAP_SECS) => {
  const h = state.prices[id]?.hist ?? []
  const v = twapOver(h, h.length ? h[h.length - 1].t : state.t, secs)
  return v == null ? getPrice(id) : v
}

// The same TWAP, but as of a moment: readings at or before sim time `atT`.
//
// Settlement runs on the first tick after a battle's end, and this process can
// be held for seconds by the indexer - so "now" at settle time is not always
// the same instant as 0:00 on the players' clocks. A battle must be decided by
// the market it was fought in: whatever happens after the timer runs out
// belongs to the next battle, not this one. Readings after `atT` are ignored,
// so a settlement delayed by a stall returns exactly the result it would have
// returned on time.
export const twapAt = (id, atT, secs = TWAP_SECS) => {
  const h = state.prices[id]?.hist ?? []
  if (!h.length) return getPrice(id)
  const v = twapOver(h, atT, secs)
  return v == null ? getPrice(id) : v
}

export const portfolioReturn = (picks, startPrices, priceFn = getPrice) => {
  let r = 0
  for (const { tokenId, pct } of picks) {
    const p0 = startPrices[tokenId]
    if (!p0) continue
    r += (pct / 100) * ((priceFn(tokenId) - p0) / p0)
  }
  return r * 100
}

// Compact snapshot for the public market ticker (only tokens surfaced to clients).
let broadcastIds = new Set(TOKENS.map((t) => t.id))
const lastSent = new Map() // id -> { p, day } as last put on the wire
export const setBroadcastIds = (ids) => {
  broadcastIds = new Set([...TOKENS.map((t) => t.id), ...ids])
  for (const id of lastSent.keys()) if (!broadcastIds.has(id)) lastSent.delete(id)
}

// Every surfaced token used to go out every second, whether or not it had
// moved - and prices are HELD FLAT between real prints, so the overwhelming
// majority of every tick was the previous tick repeated. That put a hard
// ceiling on how many coins the arena could carry: at ~1,150 tokens the tick
// was already 51 KB/s per client, and it scales linearly.
//
// So the wire carries only what CHANGED. `full` rebuilds the whole picture -
// sent on subscribe and periodically - so a client that missed a delta (or
// connected mid-stream) is never left holding a stale price forever. The
// client merges either shape identically, so this costs it nothing.
export const marketSnapshot = ({ full = false } = {}) => {
  const out = {}
  for (const id of broadcastIds) {
    const s = state.prices[id]
    if (!s) continue
    const day = dayChange(id)
    const prev = lastSent.get(id)
    if (!full && prev && prev.p === s.p && prev.day === day) continue
    out[id] = { p: s.p, day }
    lastSent.set(id, { p: s.p, day })
  }
  return out
}
