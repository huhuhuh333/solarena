// One candle service for the whole book, so a chart is a JSON read instead of
// a third-party app booting inside an iframe (measured: 1.5-2.0s to first
// paint, and the same again on a second look). Every pool answers from the
// source that actually knows it:
//
//   Solana pool    → Jupiter's chart API: TOKEN-level candles (every pool the
//                    coin trades in, the same view its settlement price comes
//                    from), cached per (token, timeframe). GeckoTerminal's
//                    pool OHLCV is the fallback when Jupiter has no series.
//   Blue Chips     → CoinGecko OHLC (server/feed.js), which is where their
//                    prices already come from.
//
// Timeframe honesty: a vendor's granularity is its own. The response always
// carries the bucket size it actually is, so the chart can say "4h candles"
// when that is what a 1h request could be answered with, rather than drawing
// coarse data under a fine label.

import { getOhlc, isCgCharted } from './feed.js'

export const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d']
export const TF_MS = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '1h': 3600e3, '4h': 4 * 3600e3, '1d': 86400e3 }

// ---- Solana: GeckoTerminal, one throttled lane, cached per (token, tf) ----
// The free tier is ~30 calls a minute for the whole server and the token
// ingest already spends part of that, so chart traffic paces itself well under
// the limit and leans on the cache. A stale series is served instantly while a
// fresh one is fetched behind it - a player mid-pick never waits on a vendor.
// Two doors to the same data. The keyless GeckoTerminal API is what we have by
// default and it answers 429 readily; with HOOD_CG_KEY set, CoinGecko's
// on-chain endpoints serve the identical series under the demo tier's much
// higher budget. Same shape either way, so only the URL and headers differ.
const GT = 'https://api.geckoterminal.com/api/v2'
const CG_ONCHAIN = 'https://api.coingecko.com/api/v3/onchain'
const cgKey = () => process.env.HOOD_CG_KEY || null
const gtUrl = (path) => (cgKey() ? `${CG_ONCHAIN}${path}` : `${GT}${path}`)
const gtHeaders = () => (cgKey() ? { 'x-cg-demo-api-key': cgKey() } : {})
const GT_MAP = {
  '1m': ['minute', 1], '5m': ['minute', 5], '15m': ['minute', 15],
  '1h': ['hour', 1], '4h': ['hour', 4], '1d': ['day', 1],
}
// An open chart asks every 10s; the 1m series is the one a player watches move.
const TTL = { '1m': 15e3, '5m': 30e3, '15m': 60e3, '1h': 120e3, '4h': 600e3, '1d': 1800e3 }
const GT_GAP_MS = 1300
const GT_COOLDOWN_MS = 60e3

const cache = new Map()      // `${id}:${tf}` -> { at, candles, bucketMs, src }
const inflight = new Map()
let lane = Promise.resolve()
let coolUntil = 0

const gtFetch = (url) => {
  const run = async () => {
    if (Date.now() < coolUntil) throw new Error('gt cooldown')
    const res = await fetch(url, { headers: gtHeaders(), signal: AbortSignal.timeout(12000) })
    if (res.status === 429) { coolUntil = Date.now() + GT_COOLDOWN_MS; throw new Error('gt 429') }
    if (!res.ok) throw new Error('gt http ' + res.status)
    const json = await res.json()
    await new Promise((r) => setTimeout(r, GT_GAP_MS))
    return json
  }
  const job = lane.then(run, run)
  lane = job.catch(() => {})
  return job
}

const fetchGecko = async (token, tf) => {
  const [unit, aggregate] = GT_MAP[tf]
  const body = await gtFetch(
    gtUrl(`/networks/solana/pools/${token.pairAddress}/ohlcv/${unit}?aggregate=${aggregate}&limit=300`))
  const list = body?.data?.attributes?.ohlcv_list
  if (!Array.isArray(list) || list.length < 2) throw new Error('empty series')
  return [...list]
    .map((c) => [Number(c[0]) * 1000, Number(c[1]), Number(c[2]), Number(c[3]), Number(c[4]), Number(c[5]) || 0])
    .filter((c) => c.every((n) => Number.isFinite(n)) && c[4] > 0)
    .sort((a, b) => a[0] - b[0])
}

// ---- Jupiter: token-level candles, keyless ----
// Its own lane with a small gap between calls: charts are opened by players,
// so the rate is bounded by attention, and the cache below absorbs the 10s
// refresh of every open chart on the same coin.
const JUP_CHART = 'https://datapi.jup.ag/v2/charts'
const JUP_IV = { '1m': '1_MINUTE', '5m': '5_MINUTE', '15m': '15_MINUTE', '1h': '1_HOUR', '4h': '4_HOUR', '1d': '1_DAY' }
const JUP_GAP_MS = 250
let jupLane = Promise.resolve()
let jupCoolUntil = 0

const fetchJupiter = (token, tf) => {
  const job = jupLane.then(async () => {
    if (Date.now() < jupCoolUntil) throw new Error('jup cooldown')
    const url = `${JUP_CHART}/${token.address}?interval=${JUP_IV[tf]}&to=${Date.now()}&candles=300&type=price&quote=usd`
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10000) })
    await new Promise((r) => setTimeout(r, JUP_GAP_MS))
    if (res.status === 429) { jupCoolUntil = Date.now() + 30e3; throw new Error('jup 429') }
    if (!res.ok) throw new Error('jup http ' + res.status)
    const body = await res.json()
    const list = body?.candles
    if (!Array.isArray(list) || list.length < 2) throw new Error('empty series')
    return list
      .map((c) => [Number(c.time) * 1000, Number(c.open), Number(c.high), Number(c.low), Number(c.close), Number(c.volume) || 0])
      .filter((c) => c.every((n) => Number.isFinite(n)) && c[4] > 0)
      .sort((a, b) => a[0] - b[0])
  })
  jupLane = job.catch(() => {})
  return job
}

const fetchSolana = async (token, tf) => {
  try {
    return { candles: await fetchJupiter(token, tf), src: 'jupiter' }
  } catch (e) {
    if (!token.pairAddress) throw e
    return { candles: await fetchGecko(token, tf), src: 'geckoterminal' }
  }
}

// ---- Blue Chips: the vendor's ranges, mapped onto the timeframe row ----
// CoinGecko serves a fixed candle size per range (a day back is 30-minute
// candles, a month is 4-hour). These are the closest honest answers to each
// button; the caller is told the real bucket and prints it.
const CG_RANGE = { '1m': '1d', '5m': '1d', '15m': '1d', '1h': '7d', '4h': '30d', '1d': '90d' }
const CG_BUCKET = { '30m': 1800e3, '4h': 4 * 3600e3, '4d': 4 * 86400e3 }

// Open each candle where the last one closed.
//
// This is the difference between a candle chart and a field of islands. A
// bucket's raw open is its FIRST TRADE, and on a coin with a wide spread that
// is nowhere near the previous bucket's last trade - so no body touches the
// one before it, every bar floats on its own, and the colour (which is close
// vs open) ends up encoding WHICH SIDE OF THE SPREAD the minute printed on
// rather than which way the price went. Green sat permanently at the top of
// the range and red permanently at the bottom, which is exactly what it looked
// like: marks hanging in space, sorted by colour.
//
// Chaining fixes it and invents nothing. The open becomes a price that really
// traded - the previous close - and the high and low are widened to contain it,
// so no candle can claim a range the market did not print. Direction becomes
// what a reader expects: this bar against where the last one ended.
// Rows are [t, o, h, l, c, v].
const chainRows = (rows) => {
  let prev = null
  return rows.map((c) => {
    const o = prev == null ? c[1] : prev
    prev = c[4]
    return [c[0], o, Math.max(c[2], o), Math.min(c[3], o), c[4], c[5]]
  })
}

export const candlesForToken = async (token, tf = '1h', limit = 400) => {
  if (!token || !TIMEFRAMES.includes(tf)) return null

  if (token.pool === 'majors' && isCgCharted(token.id)) {
    const out = await getOhlc(token.id, CG_RANGE[tf])
    if (!out) return null
    return {
      candles: out.candles.map((c) => [c[0], c[1], c[2], c[3], c[4], 0]),
      bucketMs: CG_BUCKET[out.bucket] || TF_MS[tf], src: 'coingecko', stale: !!out.stale,
    }
  }

  if (token.pool === 'sol' && token.address) {
    const key = `${token.id}:${tf}`
    const hit = cache.get(key)
    const fresh = hit && Date.now() - hit.at < (TTL[tf] || 300e3)
    if (fresh) return { ...hit, stale: false }
    // Stale-while-revalidate: hand back what we have, refresh behind it.
    const job = inflight.get(key) || (() => {
      const p = fetchSolana(token, tf)
        .then(({ candles, src }) => {
          const rec = { at: Date.now(), candles: chainRows(candles), bucketMs: TF_MS[tf], src }
          cache.set(key, rec)
          return rec
        })
        .finally(() => inflight.delete(key))
      inflight.set(key, p)
      return p
    })()
    if (hit) { job.catch(() => {}); return { ...hit, stale: true } }
    try { return { ...(await job), stale: false } } catch { return null }
  }

  return null
}

export const candleStatus = () => ({ solSeries: cache.size, gtCoolingDown: Date.now() < coolUntil })
