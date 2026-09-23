// Client-side market view. While the arena websocket is up, prices come from
// the SERVER (the same numbers both players see - the client is never trusted
// with settlement). When offline or logged out, a local GBM simulation keeps
// the charts alive as ambience.

import { TOKENS } from './tokens'

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
  prices: {},          // id -> { p, day0, dayOverride, drift, hist }
  feedStatus: 'sim',
  listeners: new Set(),
}

let serverActiveUntil = 0 // wall-clock ms; while in the future, local sim yields to server ticks

for (const tok of TOKENS) {
  const r = DAY_RANGE[tok.vol]
  const day0 = tok.base * (1 - (Math.random() * 2 * r - r))
  state.prices[tok.id] = {
    p: tok.base,
    day0,
    dayOverride: null,
    drift: (Math.random() - 0.48) * 2e-5,
    hist: [{ t: 0, p: tok.base }],
  }
}

const step = (dt) => {
  state.t += dt
  for (const tok of TOKENS) {
    const s = state.prices[tok.id]
    // Once a token has a real price it is never simulated again - not by the
    // websocket's ticks and not here. The arena's rule is that a real print is
    // held flat until the next one, so a logged-out visitor watching the strip
    // sees a stale-by-15-seconds truth instead of a fluent invention.
    if (s.real) continue
    const v = VOL[tok.vol]
    s.p *= Math.exp((s.drift - (v * v) / 2) * dt + v * Math.sqrt(dt) * randn())
    s.hist.push({ t: state.t, p: s.p })
    if (s.hist.length > HIST_CAP) s.hist.shift()
  }
}

// Seed a client-side price entry for a token discovered at runtime (idempotent).
export const ensureToken = (id, base, day = null) => {
  if (state.prices[id] || !(base > 0)) return
  state.prices[id] = { p: base, day0: base, dayOverride: day, drift: 0, hist: [{ t: state.t, p: base }] }
}

// The public token list carries the server's CURRENT price for every token it
// has a real print for, and it refreshes every 15s whether or not anyone is
// logged in. That is the only price a visitor without a websocket should ever
// see: this promotes the local entry to real (dropping the simulated past
// exactly as the first websocket tick does) and then just keeps it current.
export const applyServerPrices = (rows) => {
  let changed = false
  for (const { id, price, day, real } of rows) {
    if (!(price > 0)) continue
    let s = state.prices[id]
    if (!s) { ensureToken(id, price, day); s = state.prices[id]; if (!s) continue }
    // A token the server has no print for is still a seed: seed it, but leave
    // it to the simulation rather than dressing a guess up as a real price.
    if (!real) { if (day != null) s.dayOverride = day; continue }
    s.p = price
    if (day != null) s.dayOverride = day
    if (!s.real) { s.real = true; s.hist = [{ t: state.t, p: price }] } // drop the sim past
    else if (!isServerFed() && s.hist[s.hist.length - 1]?.p !== price) {
      // No socket: this poll IS the chart's clock. With one, the per-second
      // ticks own the history and this must not double-write it.
      s.hist.push({ t: state.t, p: price })
      if (s.hist.length > HIST_CAP) s.hist.shift()
    }
    changed = true
  }
  if (changed) state.listeners.forEach((fn) => fn(state.t))
}

// Authoritative per-second snapshot from the arena websocket.
//
// The local seed history is a random walk around a stale base (BTC seeded at
// 117k while real is ~64k). The first server price for a token is the moment its
// chart becomes real, so its simulated past is DISCARDED then - otherwise the
// sparkline shows the fabricated seed line meeting the real line at a cliff.
// After that the token accumulates only real prints.
export const applyServerTick = (data) => {
  serverActiveUntil = Date.now() + 3500
  state.t += 1
  for (const [id, d] of Object.entries(data)) {
    let s = state.prices[id]
    if (!s) { ensureToken(id, d.p, d.day); s = state.prices[id]; if (!s) continue }
    s.p = d.p
    s.dayOverride = d.day
    if (!s.real) { s.real = true; s.hist = [{ t: state.t, p: d.p }] } // drop the sim past
    else {
      s.hist.push({ t: state.t, p: d.p })
      if (s.hist.length > HIST_CAP) s.hist.shift()
    }
  }
  state.listeners.forEach((fn) => fn(state.t))
}

export const setFeedStatus = (x) => { state.feedStatus = x }
export const getFeedStatus = () => state.feedStatus
export const isServerFed = () => Date.now() < serverActiveUntil

let interval = null
export const startMarket = () => {
  if (interval) return
  for (let i = 0; i < 240; i++) step(1)
  interval = setInterval(() => {
    if (isServerFed()) return // server ticks are driving the view
    step(1)
    state.listeners.forEach((fn) => fn(state.t))
  }, 1000)
}

export const onTick = (fn) => {
  state.listeners.add(fn)
  return () => state.listeners.delete(fn)
}

export const simTime = () => state.t
export const getPrice = (id) => state.prices[id]?.p ?? 0
export const getHist = (id) => state.prices[id]?.hist ?? []

export const dayChange = (id) => {
  const s = state.prices[id]
  if (!s) return 0
  if (s.dayOverride != null) return s.dayOverride
  return ((s.p - s.day0) / s.day0) * 100
}

// Display helper for exhibition portfolios (settlement math lives on the server).
export const portfolioReturn = (picks, startPrices, priceFn = getPrice) => {
  let r = 0
  for (const { tokenId, pct } of picks) {
    const p0 = startPrices[tokenId]
    if (!p0) continue
    r += (pct / 100) * ((priceFn(tokenId) - p0) / p0)
  }
  return r * 100
}
