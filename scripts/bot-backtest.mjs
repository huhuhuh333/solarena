// Head-to-head: would a bot strategy actually BEAT a player?
//
// bot-research.mjs asked whether any signal predicts a coin's next five
// minutes. This asks the only question that decides money: given two 3-coin
// portfolios locked at the same instant, how often is the bot's ahead when the
// clock runs out?
//
// Those are different questions and the second is the one the arena pays on.
// A strategy can be terrible at forecasting and still win a 1v1, and a
// strategy with a great mean can lose most battles - the universe here is so
// skewed that mean and win-rate point in opposite directions.
//
// Everything is walk-forward: picks at T use only candles at or before T, the
// result comes from candles after T. Draws use the arena's real 0.05pp band.
//
// Usage: node scripts/bot-backtest.mjs [--days 7] [--horizon 5] [--seed 1]
import { DatabaseSync } from 'node:sqlite'

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > -1 ? Number(process.argv[i + 1]) : d }
const DAYS = arg('days', 7)
const HORIZON = arg('horizon', 5)
const MIN = 60000
const STEP = 5 * MIN
const DRAW_BAND = 0.05          // rules.js DRAW_THRESHOLD
const MIN_TRADES24 = arg('trades24', 200)
const MIN_USD24 = arg('usd24', 50000)

// Deterministic RNG: a backtest that reshuffles on every run cannot be argued
// with, only re-rolled until it says something nice.
let seed = arg('seed', 1) >>> 0
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }

const db = new DatabaseSync(process.env.HOOD_DB || 'server/data/hoodarena.db', { readOnly: true })
db.exec('PRAGMA busy_timeout = 20000')
const { b: newest } = db.prepare('SELECT MAX(t) b FROM fh_c1m').get()
const from = newest - DAYS * 86400000

const keep = new Set(db.prepare(`SELECT token FROM fh_c1m WHERE t >= ? GROUP BY token HAVING COUNT(*) >= 40`).all(from).map((r) => r.token))
const series = new Map()
for (const r of db.prepare(`SELECT token, t, c, v, n, buys FROM fh_c1m WHERE t >= ? ORDER BY token, t`).all(from)) {
  if (!keep.has(r.token)) continue
  let s = series.get(r.token)
  if (!s) { s = []; series.set(r.token, s) }
  s.push(r)
}
console.log(`window ${DAYS}d · horizon ${HORIZON}m · ${series.size} coins · seed ${arg('seed', 1)}\n`)

// ---- per-coin view at an instant ----
const at = (s, lo, hi) => { const o = []; for (const c of s) { if (c.t > hi) break; if (c.t > lo) o.push(c) } return o }
const lastAtOrBefore = (s, t) => { let b = null; for (const c of s) { if (c.t > t) break; b = c } return b }

const viewAt = (s, T) => {
  const here = lastAtOrBefore(s, T)
  if (!here || !(here.c > 0)) return null
  const w5 = at(s, T - 5 * MIN, T)
  const w15 = at(s, T - 15 * MIN, T)
  const w60 = at(s, T - 60 * MIN, T)
  const day = at(s, T - 1440 * MIN, T)
  if (w15.length < 3) return null
  let trades24 = 0, usd24 = 0
  for (const c of day) { trades24 += c.n || 0; usd24 += c.v || 0 }
  if (trades24 < MIN_TRADES24 || usd24 < MIN_USD24) return null

  let trades5 = 0, buys5 = 0, usd5 = 0
  for (const c of w5) { trades5 += c.n || 0; buys5 += c.buys || 0; usd5 += c.v || 0 }
  const closes = w60.map((c) => c.c)
  const hi = Math.max(...closes), lo = Math.min(...closes)
  // Realised movement over the hour: the cheapest honest proxy for how wild a
  // coin is about to be.
  let moves = 0
  for (let i = 1; i < w60.length; i++) moves += Math.abs(w60[i].c - w60[i - 1].c) / (w60[i - 1].c || 1)
  const churn = w60.length > 1 ? moves / (w60.length - 1) * 100 : 0

  const r = (w) => (w.length && w[0].c > 0 ? (here.c - w[0].c) / w[0].c * 100 : 0)
  return {
    px: here.c,
    r5: r(w5), r15: r(w15), r60: r(w60), r24: r(day),
    flow5: trades5 > 0 ? (2 * buys5 - trades5) / trades5 : 0,
    trades5, usd5, trades24, usd24, churn,
    pos60: hi > lo ? (here.c - lo) / (hi - lo) : 0.5,
    prints15: w15.length,
  }
}

const fwd = (s, T, px) => {
  const w = at(s, T, T + HORIZON * MIN)
  if (!w.length) return 0            // never traded - the screen reads 0.00%
  return (w[w.length - 1].c - px) / px * 100
}

// ---- strategies ----
// A strategy is (universe, rnd) -> [{token, pct}]. All of them get exactly the
// same universe at the same instant, so nothing here can peek at anything the
// other side could not have seen.
const SPLIT = [50, 30, 20]
const take3 = (ranked) => ranked.slice(0, 3).map((u, i) => ({ token: u.token, pct: SPLIT[i] }))
const byDesc = (u, key) => [...u].sort((a, b) => b.v[key] - a.v[key])
const byAsc = (u, key) => [...u].sort((a, b) => a.v[key] - b.v[key])

const pickRandom = (u) => {
  const p = [...u]
  const out = []
  for (let i = 0; i < 3 && p.length; i++) out.push(p.splice(Math.floor(rnd() * p.length), 1)[0])
  return out.map((x, i) => ({ token: x.token, pct: SPLIT[i] }))
}

const STRATEGIES = {
  // controls
  random: pickRandom,
  even: (u) => pickRandom(u).map((p) => ({ ...p, pct: [34, 33, 33][SPLIT.indexOf(p.pct)] ?? 33 })),
  // what the bot does today: back the day's top movers
  momentum24: (u) => take3(byDesc(u, 'r24')),
  momentum60: (u) => take3(byDesc(u, 'r60')),
  momentum5: (u) => take3(byDesc(u, 'r5')),
  // the opposite bet - buy what just bled
  contrarian60: (u) => take3(byAsc(u, 'r60')),
  // order flow: most one-sided buying in the last five minutes
  flow: (u) => take3(byDesc(u, 'flow5')),
  // the busiest coins on the chain right now
  busiest: (u) => take3(byDesc(u, 'trades5')),
  // deliberately dull: the least-moving coins, aiming to land on 0.00% and let
  // a negative-drift opponent lose to a flat line
  quiet: (u) => take3(byAsc(u, 'churn')),
  // active but not extended: trading hard, not already at the top of its hour
  steady: (u) => take3([...u].sort((a, b) =>
    (b.v.trades5 > 0 ? 1 : 0) - (a.v.trades5 > 0 ? 1 : 0)
    || Math.abs(a.v.pos60 - 0.5) - Math.abs(b.v.pos60 - 0.5))),
}

// The human on the other side. Players meet a book sorted by depth × turnover
// and, overwhelmingly, chase what is already green - so that is what this
// models. `--opp random` runs the pessimistic case instead.
const OPP = process.argv.includes('--opp') ? process.argv[process.argv.indexOf('--opp') + 1] : 'chaser'
const opponent = (u) => {
  if (OPP === 'random') return pickRandom(u)
  const ranked = byDesc(u, 'r24').slice(0, Math.max(3, Math.floor(u.length * 0.3)))
  const p = [...ranked]
  const out = []
  for (let i = 0; i < 3 && p.length; i++) {
    // Weighted to the top of that shortlist, but not deterministic - real
    // players do not all pick the same three coins.
    const k = Math.min(p.length - 1, Math.floor(Math.abs(rnd() - rnd()) * p.length))
    out.push(p.splice(k, 1)[0])
  }
  return out.map((x, i) => ({ token: x.token, pct: SPLIT[i] }))
}

const ret = (picks, universe, T) => {
  let acc = 0
  for (const p of picks) {
    const u = universe.find((x) => x.token === p.token)
    acc += (p.pct / 100) * fwd(series.get(p.token), T, u.v.px)
  }
  return acc
}

// ---- run ----
const tally = {}
for (const k of Object.keys(STRATEGIES)) tally[k] = { w: 0, l: 0, d: 0, sum: 0, oppSum: 0 }
let rounds = 0

for (let T = from + 60 * MIN; T <= newest - HORIZON * MIN; T += STEP) {
  const universe = []
  for (const [token, s] of series) {
    const v = viewAt(s, T)
    if (v) universe.push({ token, v })
  }
  if (universe.length < 12) continue // not enough of a book to hold a battle
  rounds++
  const oppPicks = opponent(universe)
  const oppRet = ret(oppPicks, universe, T)
  for (const [name, fn] of Object.entries(STRATEGIES)) {
    const mine = ret(fn(universe), universe, T)
    const t = tally[name]
    t.sum += mine
    t.oppSum += oppRet
    const gap = mine - oppRet
    if (Math.abs(gap) < DRAW_BAND) t.d++
    else if (gap > 0) t.w++
    else t.l++
  }
}

console.log(`battles simulated: ${rounds.toLocaleString()} · opponent model: ${OPP}\n`)
console.log('strategy        win%    loss%   draw%   decided-win%   avg return   opp avg')
const rows = Object.entries(tally).map(([name, t]) => {
  const n = t.w + t.l + t.d
  const decided = t.w + t.l
  return {
    name, n,
    win: t.w / n * 100, loss: t.l / n * 100, draw: t.d / n * 100,
    dec: decided ? t.w / decided * 100 : 0,
    avg: t.sum / n, opp: t.oppSum / n,
  }
}).sort((a, b) => b.dec - a.dec)
for (const r of rows) {
  console.log(`${r.name.padEnd(14)} ${r.win.toFixed(1).padStart(5)}%  ${r.loss.toFixed(1).padStart(5)}%  ${r.draw.toFixed(1).padStart(5)}%   ${r.dec.toFixed(1).padStart(10)}%   ${r.avg.toFixed(2).padStart(9)}%  ${r.opp.toFixed(2).padStart(7)}%`)
}

// Break-even is what decides whether any of this is worth running: the house
// wins `stake` and loses `stake − fee`, so it clears well under half.
console.log('\nHouse break-even win rate (of DECIDED battles), by table:')
for (const [stake, pct] of [[10, 10], [100, 8], [1000, 5]]) {
  const f = pct / 100
  console.log(`  $${String(stake).padEnd(5)} fee ${pct}%   break-even ${((1 - 2 * f) / (2 * (1 - f)) * 100).toFixed(1)}%`)
}
db.close()
