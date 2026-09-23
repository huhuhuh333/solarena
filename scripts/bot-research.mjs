// Does anything we can see actually predict the next five minutes?
//
// This runs BEFORE the bot exists, on purpose. Building a scorer first and
// measuring it after is how you end up with a confident bot that loses money:
// every signal looks reasonable in a comment, and only the data says which of
// them carries information.
//
// Walk-forward and lookahead-free by construction: features at minute T are
// built from candles at or before T, the answer is the return AFTER T, and the
// two are never in the same query.
//
// A coin that prints nothing in the forward window scores 0.00% - that is not
// a gap in the data, it is exactly what a player sees when their pick doesn't
// trade for five minutes.
//
// Usage: node scripts/bot-research.mjs [--days 7] [--horizon 5]
import { DatabaseSync } from 'node:sqlite'

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > -1 ? Number(process.argv[i + 1]) : d }
const DAYS = arg('days', 7)
const HORIZON = arg('horizon', 5)      // minutes a Classic battle's shortest table runs / 60
const MIN = 60000
const STEP = 5 * MIN                    // one evaluation point per 5 minutes
const LOOKBACK = 60 * MIN

const db = new DatabaseSync(process.env.HOOD_DB || 'server/data/hoodarena.db', { readOnly: true })
db.exec('PRAGMA busy_timeout = 20000')

const { b: newest } = db.prepare('SELECT MAX(t) b FROM fh_c1m').get()
const from = newest - DAYS * 86400000
console.log(`window: ${new Date(from).toISOString().slice(0, 16)} → ${new Date(newest).toISOString().slice(0, 16)} (${DAYS}d), horizon ${HORIZON}m\n`)

// Only coins with enough prints to have a history at all. Everything below this
// is a token that traded twice and would be noise in every bucket.
const tokens = db.prepare(`SELECT token, COUNT(*) n FROM fh_c1m WHERE t >= ? GROUP BY token HAVING n >= 40`).all(from)
console.log(`universe: ${tokens.length} coins with >=40 candles in the window`)

const series = new Map()
const rows = db.prepare(`SELECT token, t, c, v, n, buys FROM fh_c1m WHERE t >= ? ORDER BY token, t`).all(from)
const keep = new Set(tokens.map((t) => t.token))
for (const r of rows) {
  if (!keep.has(r.token)) continue
  let s = series.get(r.token)
  if (!s) { s = []; series.set(r.token, s) }
  s.push(r)
}
console.log(`loaded ${rows.length.toLocaleString()} candles into ${series.size} series\n`)

// ---- features, all strictly backward-looking ----
const at = (s, lo, hi) => { // candles with lo < t <= hi
  const out = []
  for (const c of s) { if (c.t > hi) break; if (c.t > lo) out.push(c) }
  return out
}
const lastAtOrBefore = (s, t) => {
  let best = null
  for (const c of s) { if (c.t > t) break; best = c }
  return best
}

// "Is this coin in the arena's book at time T?" - judged from the trailing
// tape only. Using today's fh_stats would be survivorship bias: it would only
// ever offer coins that are still alive now, which is knowledge the bot could
// not have had at T.
// Tuned to the top of the arena's book, not to "has ever traded": the ranked
// book is ~1,200 pools out of ~346k, so the coins a player actually meets are
// far busier than the median chain token.
const BOOK = process.argv.includes('--book')
const MIN_TRADES24 = arg('trades24', 200)
const MIN_USD24 = arg('usd24', 50000)
const inBook = (s, T) => {
  const day = at(s, T - 24 * 60 * MIN, T)
  let trades = 0, usd = 0
  for (const c of day) { trades += c.n || 0; usd += c.v || 0 }
  return trades >= MIN_TRADES24 && usd >= MIN_USD24
}

const featuresFor = (s, T) => {
  const here = lastAtOrBefore(s, T)
  if (!here) return null
  const w5 = at(s, T - 5 * MIN, T)
  const w15 = at(s, T - 15 * MIN, T)
  const w60 = at(s, T - LOOKBACK, T)
  if (w15.length < 3) return null // not live enough to be pickable
  if (BOOK && !inBook(s, T)) return null

  const px = (w) => (w.length ? w[0].c : here.c)
  const r = (a, b) => (a > 0 ? (b - a) / a * 100 : 0)

  const trades5 = w5.reduce((a, c) => a + (c.n || 0), 0)
  const buys5 = w5.reduce((a, c) => a + (c.buys || 0), 0)
  const usd5 = w5.reduce((a, c) => a + (c.v || 0), 0)
  const hi60 = Math.max(...w60.map((c) => c.c))
  const lo60 = Math.min(...w60.map((c) => c.c))

  let up = 0
  for (let i = w15.length - 1; i > 0; i--) { if (w15[i].c > w15[i - 1].c) up++; else break }

  return {
    px: here.c,
    r5: r(px(w5), here.c),
    r15: r(px(w15), here.c),
    r60: r(px(w60), here.c),
    // Order flow: +1 all buys, −1 all sells. The one signal nobody without a
    // chain-wide firehose can compute.
    flow5: trades5 > 0 ? (2 * buys5 - trades5) / trades5 : 0,
    trades5,
    usd5,
    // Where the price sits in its own hour: 1 = at the top of the range.
    pos60: hi60 > lo60 ? (here.c - lo60) / (hi60 - lo60) : 0.5,
    runUp: up,
    prints15: w15.length,
  }
}

// ---- the answer ----
const forward = (s, T) => {
  const w = at(s, T, T + HORIZON * MIN)
  const here = lastAtOrBefore(s, T)
  if (!here || !(here.c > 0)) return null
  if (!w.length) return 0 // never traded - the player watches 0.00% for five minutes
  return (w[w.length - 1].c - here.c) / here.c * 100
}

// ---- sample ----
const samples = []
for (const [token, s] of series) {
  for (let T = from + LOOKBACK; T <= newest - HORIZON * MIN; T += STEP) {
    const f = featuresFor(s, T)
    if (!f) continue
    const fwd = forward(s, T)
    if (fwd == null) continue
    samples.push({ token, T, ...f, fwd })
  }
}
console.log(`samples: ${samples.length.toLocaleString()}\n`)
if (samples.length < 500) { console.log('too few samples to say anything - widen --days'); process.exit(1) }

const median = (a) => { const x = [...a].sort((p, q) => p - q); return x.length % 2 ? x[(x.length - 1) / 2] : (x[x.length / 2 - 1] + x[x.length / 2]) / 2 }
const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1)

const base = samples.map((s) => s.fwd)
console.log(`BASELINE - a random live coin over ${HORIZON} minutes`)
console.log(`  mean ${mean(base).toFixed(3)}%   median ${median(base).toFixed(3)}%   up ${(base.filter((x) => x > 0).length / base.length * 100).toFixed(1)}%   flat ${(base.filter((x) => x === 0).length / base.length * 100).toFixed(1)}%\n`)

// Bucketed by each feature: does the answer change as the signal changes?
// Median matters more than mean here - a 1v1 is won by beating one opponent,
// not by having a fat tail.
const BUCKETS = 5
const study = (name, key) => {
  const sorted = [...samples].sort((a, b) => a[key] - b[key])
  const size = Math.floor(sorted.length / BUCKETS)
  console.log(`${name}`)
  const lines = []
  for (let i = 0; i < BUCKETS; i++) {
    const cut = sorted.slice(i * size, i === BUCKETS - 1 ? sorted.length : (i + 1) * size)
    const f = cut.map((s) => s.fwd)
    lines.push({
      band: `${cut[0][key].toFixed(2)} … ${cut[cut.length - 1][key].toFixed(2)}`,
      mean: mean(f), median: median(f), up: f.filter((x) => x > 0).length / f.length * 100, n: f.length,
    })
  }
  for (const [i, l] of lines.entries()) {
    console.log(`  Q${i + 1} ${l.band.padEnd(24)} mean ${l.mean.toFixed(3).padStart(7)}%  median ${l.median.toFixed(3).padStart(7)}%  up ${l.up.toFixed(1).padStart(5)}%`)
  }
  // The spread top-vs-bottom is the whole question: no spread, no signal.
  const d = lines[BUCKETS - 1].median - lines[0].median
  console.log(`  → top-vs-bottom median spread: ${d >= 0 ? '+' : ''}${d.toFixed(3)}pp\n`)
  return d
}

const found = {}
found.r5 = study('SHORT MOMENTUM (return, last 5m)', 'r5')
found.r15 = study('MOMENTUM (return, last 15m)', 'r15')
found.r60 = study('HOUR MOMENTUM (return, last 60m)', 'r60')
found.flow5 = study('ORDER FLOW (buy/sell imbalance, last 5m)', 'flow5')
found.trades5 = study('ACTIVITY (trades, last 5m)', 'trades5')
found.usd5 = study('VOLUME (USD, last 5m)', 'usd5')
found.pos60 = study('POSITION IN THE HOUR RANGE (1 = at the high)', 'pos60')
found.runUp = study('CONSECUTIVE UP MINUTES', 'runUp')

console.log('SUMMARY - median spread, best signal first')
for (const [k, v] of Object.entries(found).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))) {
  console.log(`  ${k.padEnd(9)} ${v >= 0 ? '+' : ''}${v.toFixed(3)}pp  ${Math.abs(v) < 0.05 ? '(nothing)' : v > 0 ? '(higher is better)' : '(LOWER is better)'}`)
}
db.close()
