// CoinGecko price feed for the server market (Node 18+ global fetch).
// Same mapping as the client used - but now only the SERVER talks to the
// price source; clients get prices over the arena websocket.

import { TOKENS } from '../src/engine/tokens.js'

// The curated pools are gone, so none of these ids is in the arena any more -
// applyFeed drops ids no registered token carries. This poller STAYS because it
// is the feed-status heartbeat (with Pyth): duel/tourney void a battle after
// 90s of 'sim', and a successful pull here is what reports 'live'.
//
// Majors ids only, on purpose: every ticker below sits permanently in the
// ingest's EXCLUDE list, so no Robinhood-chain coin can ever claim these ids
// and receive a mainnet price by accident. The old Solana meme ids (WIF,
// BONK…) are NOT ingest-excluded and were removed from here for exactly that
// reason. Robinhood-chain tokens price off DexScreener/firehose, never off a
// mainnet CoinGecko id.
const CG_IDS = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  BNB: 'binancecoin',
  XRP: 'ripple',
  ADA: 'cardano',
  AVAX: 'avalanche-2',
  LINK: 'chainlink',
  DOT: 'polkadot',
  LTC: 'litecoin',
  ATOM: 'cosmos',
}

const POLL_MS = 30000

// Blue Chips are the one pool with no DEX pair to embed a chart from: BTC is
// not an ERC-20 and the wrapped proxies are a different asset with a different
// pool. So their chart is ours to draw - true OHLC candles from CoinGecko, the
// same series every screener shows - and these are the ids that get one.
const CG_CHART_IDS = TOKENS.filter((t) => t.pool === 'majors' && CG_IDS[t.id]).map((t) => t.id)
export const cgChartIds = () => [...CG_CHART_IDS]
export const isCgCharted = (tokenId) => CG_CHART_IDS.includes(tokenId)

// Real 7-day price shape per curated token, for the token-table sparkline.
// Live-since-boot history is honest but near-flat for a blue chip (BTC moves
// ~0.02% a minute), so the chart looked broken. CoinGecko's 7d array is the
// genuine week of price action - 168 hourly points, the same series every
// screener shows - fetched once and refreshed slowly (7d data barely changes
// minute to minute). Curated tokens only; ingested memecoins have no CG id and
// fall back to the accumulated live history.
const spark7d = new Map() // tokenId -> number[]
export const getSpark7d = (tokenId) => spark7d.get(tokenId) || null

// ---- one throttled lane to CoinGecko ----
// The public API answers 429 long before it answers slowly, and we already
// spend a call every 30s on prices. So every request queues behind the last
// one, calls are spaced, and a 429 parks the whole lane for a minute rather
// than hammering it - callers fall back to their last good data meanwhile.
const CALL_GAP_MS = 2000
const COOLDOWN_MS = 60000
let lane = Promise.resolve()
let coolUntil = 0
let rateLimited = 0

// A demo key (free, 30 calls/min) if the operator has one - the keyless tier is
// a handful of calls a minute for the whole IP, and charts now share it with
// prices. Every CoinGecko call in this file goes through here so the key, when
// set, lifts all of them at once.
const cgHeaders = () => (process.env.HOOD_CG_KEY ? { 'x-cg-demo-api-key': process.env.HOOD_CG_KEY } : {})

const cgFetch = (url) => {
  const run = async () => {
    if (Date.now() < coolUntil) throw new Error('cg cooldown')
    const res = await fetch(url, { headers: cgHeaders(), signal: AbortSignal.timeout(15000) })
    if (res.status === 429) {
      coolUntil = Date.now() + COOLDOWN_MS
      rateLimited++
      throw new Error('cg 429')
    }
    if (!res.ok) throw new Error('cg http ' + res.status)
    const json = await res.json()
    await new Promise((r) => setTimeout(r, CALL_GAP_MS)) // hold the lane, not the caller's data
    return json
  }
  const job = lane.then(run, run) // one at a time, whatever the previous one did
  lane = job.catch(() => {})
  return job
}

// ---- OHLC candles: the Blue Chips' real chart ----
// Granularity is the endpoint's, not ours - 1-2 days come back as 30-minute
// candles, 3-30 days as 4-hour, beyond that 4-day. These are the ranges it can
// answer honestly, and every response carries the candle size it actually is,
// so the chart can say what it is showing instead of implying a finer one.
const RANGES = {
  '1d': { days: 1, bucket: '30m', ttl: 5 * 60e3 },
  '7d': { days: 7, bucket: '4h', ttl: 20 * 60e3 },
  '30d': { days: 30, bucket: '4h', ttl: 60 * 60e3 },
  '90d': { days: 90, bucket: '4d', ttl: 6 * 3600e3 },
}
export const OHLC_RANGES = Object.keys(RANGES)

const ohlcCache = new Map()    // `${id}:${range}` -> { at, candles }
const ohlcInflight = new Map()

export const getOhlc = async (tokenId, range = '1d') => {
  const spec = RANGES[range]
  const cg = CG_IDS[tokenId]
  if (!spec || !cg || !CG_CHART_IDS.includes(tokenId)) return null
  const key = `${tokenId}:${range}`
  const hit = ohlcCache.get(key)
  if (hit && Date.now() - hit.at < spec.ttl) return { candles: hit.candles, bucket: spec.bucket, at: hit.at, stale: false }
  if (ohlcInflight.has(key)) {
    // Someone is already fetching. A player mid-pick must not queue behind a
    // vendor round trip when we are holding a perfectly good older series.
    if (hit) return { candles: hit.candles, bucket: spec.bucket, at: hit.at, stale: true }
    return ohlcInflight.get(key)
  }
  const job = (async () => {
    try {
      const raw = await cgFetch(`https://api.coingecko.com/api/v3/coins/${cg}/ohlc?vs_currency=usd&days=${spec.days}`)
      const candles = (Array.isArray(raw) ? raw : [])
        .filter((c) => Array.isArray(c) && c.length >= 5 && c.every((n) => Number.isFinite(n)) && c[4] > 0)
        .map(([t, o, h, l, c]) => [t, o, h, l, c])
      if (candles.length < 2) throw new Error('empty series')
      ohlcCache.set(key, { at: Date.now(), candles })
      return { candles, bucket: spec.bucket, at: Date.now(), stale: false }
    } catch {
      // A rate-limited minute must not blank a chart that was fine a moment ago.
      return hit ? { candles: hit.candles, bucket: spec.bucket, at: hit.at, stale: true } : null
    } finally { ohlcInflight.delete(key) }
  })()
  ohlcInflight.set(key, job)
  // An expired series is still a real one: serve it now, let the refresh land
  // in the cache for the next caller. Only a token nobody has ever charted
  // pays the vendor's latency.
  if (hit) { job.catch(() => {}); return { candles: hit.candles, bucket: spec.bucket, at: hit.at, stale: true } }
  return job
}

// 6h change, read off the 30-minute candles the warm loop keeps hot - the one
// timeframe on the card CoinGecko's markets row does not carry.
export const getCgChange6h = (tokenId) => {
  const c = ohlcCache.get(`${tokenId}:1d`)?.candles
  if (!c || c.length < 14) return null
  const now = c[c.length - 1][4]
  const then = c[c.length - 1 - 12][4] // 12 × 30m
  return then > 0 ? ((now - then) / then) * 100 : null
}

// Keep every Blue Chip's day of candles warm, one token at a time: the chart is
// there the instant a player opens the coin, and the 6h change has a series to
// read. Slow on purpose - 11 tokens on a 45s stride is under one call a minute.
const WARM_GAP_MS = 45000
export const startOhlcWarm = () => {
  if (!CG_CHART_IDS.length) return () => {}
  let i = 0
  const tick = () => { getOhlc(CG_CHART_IDS[i++ % CG_CHART_IDS.length], '1d').catch(() => {}) }
  tick()
  const timer = setInterval(tick, WARM_GAP_MS)
  return () => clearInterval(timer)
}

export const cgFeedStatus = () => ({
  charted: CG_CHART_IDS.length,
  series: ohlcCache.size,
  rateLimited,
  coolingDown: Date.now() < coolUntil,
})

// The same markets call already pays for the week of prices, so it also carries
// what the Blue Chips' card had to hardcode until now: real market cap, FDV and
// the 1h/24h moves. A catalog constant ages the moment it is written (BTC's
// $2.3T was true at $117k, not at $64k) - a live number never does.
const cgStats = new Map() // tokenId -> { marketCap, fdv, volume24, priceChange: { h1, h24 } }
export const getCgStats = (tokenId) => cgStats.get(tokenId) || null

// Everything the card should read off CoinGecko for a Blue Chip, or null for
// every token whose numbers come from its own DEX pair.
export const cgCard = (tokenId) => {
  if (!CG_CHART_IDS.includes(tokenId)) return null
  return { chartSrc: 'cg', ...(cgStats.get(tokenId) || {}) }
}

const SPARK_MS = 10 * 60 * 1000
export const startSparklines = () => {
  const ids = Object.values(CG_IDS).join(',')
  const byCg = Object.fromEntries(Object.entries(CG_IDS).map(([tid, cg]) => [cg, tid]))
  const poll = async () => {
    try {
      const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids}`
        + `&sparkline=true&price_change_percentage=1h,24h`
      const body = await cgFetch(url)
      for (const c of body) {
        const tid = byCg[c.id]
        if (!tid) continue
        const arr = c.sparkline_in_7d?.price
        if (Array.isArray(arr) && arr.length > 2) {
          spark7d.set(tid, arr.map((p) => Math.round(p * 1e6) / 1e6))
        }
        // Field by field, last good value wins over a missing one: a hiccup in
        // one row of the response must not blank a card that was correct.
        const prev = cgStats.get(tid) || {}
        const num = (v, was) => (Number.isFinite(v) && v > 0 ? v : (was ?? null))
        const pct = (v, was) => (Number.isFinite(v) ? v : (was ?? null))
        cgStats.set(tid, {
          marketCap: num(c.market_cap, prev.marketCap),
          fdv: num(c.fully_diluted_valuation, prev.fdv),
          volume24: num(c.total_volume, prev.volume24),
          priceChange: {
            h1: pct(c.price_change_percentage_1h_in_currency, prev.priceChange?.h1),
            h24: pct(c.price_change_percentage_24h_in_currency, prev.priceChange?.h24),
          },
        })
      }
    } catch { /* keep the last good sparklines and stats */ }
  }
  poll()
  const timer = setInterval(poll, SPARK_MS)
  return () => clearInterval(timer)
}

export const startFeed = (apply, setStatus) => {
  const poll = async () => {
    try {
      const ids = Object.values(CG_IDS).join(',')
      const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true`
      // Deliberately NOT on the shared lane: this is the price feed. It must
      // never queue behind a chart fetch or be parked by a chart's 429.
      const res = await fetch(url, { headers: cgHeaders(), signal: AbortSignal.timeout(10000) })
      if (!res.ok) throw new Error('http ' + res.status)
      const data = await res.json()
      const out = {}
      for (const [tid, cgid] of Object.entries(CG_IDS)) {
        const d = data[cgid]
        if (d && typeof d.usd === 'number' && d.usd > 0) {
          out[tid] = { price: d.usd, change24: d.usd_24h_change ?? null, vol24: d.usd_24h_vol ?? null }
        }
      }
      if (Object.keys(out).length) { apply(out); setStatus('live') }
      else setStatus('sim')
    } catch {
      setStatus('sim')
    }
  }
  poll()
  const timer = setInterval(poll, POLL_MS)
  return () => clearInterval(timer)
}
