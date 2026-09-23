// The in-app chart: TradingView's Lightweight Charts, fed by our own candle
// service (server/candles.js). The point is speed on the pick clock - a chart
// here is one JSON read from our server's candle cache, against the 1.5-2.0s a
// DexScreener iframe took to boot, every time, on every coin the player looked at.
//
// The renderer is theirs on purpose: candles, wicks, volume, crosshair, price
// scale and zoom that read like every terminal a player already uses, rather
// than something hand-drawn. Their licence asks for the attribution mark, so
// it is on the chart, bottom-right, and it links back to them.
//
// `HOOD_CHARTS=embed` (or ?charts=embed) puts the old iframe back everywhere -
// this file simply stops being rendered. Nothing here is load-bearing for
// anything else.

import React, { useEffect, useRef, useState } from 'react'
import { createChart, CandlestickSeries, HistogramSeries } from 'lightweight-charts'
import { api } from '../engine/net'

export const TIMEFRAMES = [['1m', '1m'], ['5m', '5m'], ['15m', '15m'], ['1h', '1h'], ['4h', '4h'], ['1d', '1d']]

// Axis and crosshair labels in the READER'S clock. The series itself stays in
// UTC - only what is printed moves, so nothing downstream has to know.
// `withTime` is false for the coarse tick types the library uses for day and
// month marks, where a clock reading would be noise.
const fmtLocal = (t, withTime) => {
  const d = new Date((typeof t === 'number' ? t : Number(t)) * 1000)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return withTime ? `${p(d.getHours())}:${p(d.getMinutes())}` : `${d.getDate()} ${d.toLocaleString(undefined, { month: 'short' })}`
}

// One fetch per (token, timeframe) shared by every mount, and kept warm for
// the length of a pick phase: flipping back to a coin you already looked at
// must cost nothing.
const TTL_MS = 30000
const cache = new Map()
const inflight = new Map()

const load = (id, tf, { force = false } = {}) => {
  const key = `${id}:${tf}`
  const hit = cache.get(key)
  // `force` is the live refresh asking for the newest bars. It still fills the
  // cache, so the hover prefetch and a re-mount keep their instant path.
  if (!force && hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.data)
  if (inflight.has(key)) return inflight.get(key)
  const job = api(`/api/token/${encodeURIComponent(id)}/candles?tf=${tf}`)
    .then((data) => { cache.set(key, { at: Date.now(), data }); return data })
    .finally(() => inflight.delete(key))
  inflight.set(key, job)
  return job
}

// How often an open chart pulls new bars. The server caches each series and
// shares it across viewers, so this is cheap - and without it the chart is a
// photograph of the moment the page loaded: leave a token page open for two
// hours and you are reading a two-hour-old market.
const REFRESH_MS = 10000

// Pull a coin's candles before the player clicks it - called on row hover in
// the pick terminal, exactly where the old code warmed an iframe.
export const warmCandles = (token, tf = '1h') => {
  if (token?.id) load(token.id, tf).catch(() => {})
}

const fmtBucket = (ms) => {
  if (!ms) return ''
  if (ms % 86400e3 === 0) return `${ms / 86400e3}d`
  if (ms % 3600e3 === 0) return `${ms / 3600e3}h`
  return `${Math.round(ms / 60e3)}m`
}

// Decimals scale to the coin: a memecoin at $0.0000031 needs eight, BTC needs
// none. Lightweight Charts formats every axis and tooltip off this.
const precisionFor = (p) => (p >= 100 ? 2 : p >= 1 ? 4 : p >= 0.01 ? 6 : 8)

export default function LwChart({ token, height = 380, tf: tfProp, onTf, showTf = true, fallback = null }) {
  const [ownTf, setOwnTf] = useState('1h')
  const tf = tfProp || ownTf
  const setTf = onTf || setOwnTf
  const box = useRef(null)
  const chartRef = useRef(null)
  const seriesRef = useRef(null)
  const volRef = useRef(null)
  const minBodyRef = useRef(null)  // body floor, held steady across live refreshes
  const lastTimeRef = useRef(0)    // newest bar already on the chart
  const barsRef = useRef(0)
  const [meta, setMeta] = useState({ loading: true, empty: false, src: null, bucketMs: null, stale: false })

  // Bar width follows the pane, so it has to be recomputed when the pane
  // changes size too - a chart drawn in a narrow box and then widened kept its
  // old spacing and left the right side of itself empty.
  const applySpacing = React.useCallback(() => {
    const ts = chartRef.current?.timeScale()
    const n = barsRef.current
    if (!ts || !n) return
    const usable = Math.max(160, (box.current?.clientWidth || 600) - 90)
    // Fit a READABLE bar and show as many as fit - do not squeeze the whole
    // series in. Four hundred one-minute bars across 1,100px is 2.7px each,
    // which draws as confetti: hairline bodies with hairline gaps, and the
    // chart reads as scattered specks rather than a market. Every screener
    // shows ~120-160 bars at this width and lets you scroll back for the rest,
    // which is exactly what the series still holds.
    const READABLE = 7
    const ideal = n <= 40 ? Math.min(48, usable / n) : READABLE
    ts.applyOptions({ barSpacing: Math.max(3, ideal), rightOffset: 2 })
    ts.scrollToPosition(0, false) // stay pinned to the newest bar
  }, [])

  // The chart instance outlives data and timeframe changes: creating one per
  // update is what makes hand-rolled charts flicker.
  useEffect(() => {
    const el = box.current
    if (!el) return undefined
    const chart = createChart(el, {
      width: el.clientWidth,
      height,
      layout: {
        background: { color: '#09080b' },
        textColor: '#867e8c',
        fontFamily: "'Inter', system-ui, sans-serif",
        fontSize: 11,
        attributionLogo: true,
      },
      grid: {
        vertLines: { color: 'rgba(34, 29, 38, 0.55)' },
        horzLines: { color: 'rgba(34, 29, 38, 0.55)' },
      },
      rightPriceScale: { borderColor: '#221d26', scaleMargins: { top: 0.1, bottom: 0.1 } },
      // The library labels UNIX timestamps in UTC, so a player in Belgrade read
      // 16:00 on the newest bar while their own clock said 18:12 and concluded
      // the chart was two hours stale. It never was. The data stays UTC - only
      // the labels move to the reader's clock, on the axis and the crosshair.
      localization: { timeFormatter: (t) => fmtLocal(t, true) },
      timeScale: {
        borderColor: '#221d26', timeVisible: true, secondsVisible: false, rightOffset: 3,
        tickMarkFormatter: (t, tickType) => fmtLocal(t, tickType >= 3),
      },
      crosshair: {
        mode: 0,
        vertLine: { color: 'rgba(233, 230, 239, 0.28)', width: 1, style: 2, labelBackgroundColor: '#221d26' },
        horzLine: { color: 'rgba(233, 230, 239, 0.28)', width: 1, style: 2, labelBackgroundColor: '#221d26' },
      },
      handleScale: { axisPressedMouseMove: { time: true, price: false } },
    })
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: '#14f195', downColor: '#ff5c4d',
      wickUpColor: '#14f195', wickDownColor: '#ff5c4d',
      borderVisible: false,
      // Two things the default autoscale gets wrong on coins priced at
      // 0.0000026: it lets the axis run BELOW zero (no price is negative), and
      // on a near-flat series it zooms so far in that a 0.4% wiggle fills the
      // pane under a dozen near-identical labels. Floor the window at 2% so a
      // quiet coin draws as quiet.
      autoscaleInfoProvider: (original) => {
        const res = original()
        if (!res?.priceRange) return res
        let { minValue, maxValue } = res.priceRange
        const mid = (minValue + maxValue) / 2
        const floor = Math.abs(mid) * 0.02
        if (maxValue - minValue < floor) { minValue = mid - floor / 2; maxValue = mid + floor / 2 }
        res.priceRange = { minValue: Math.max(0, minValue), maxValue }
        return res
      },
    })
    chartRef.current = chart
    seriesRef.current = candles
    volRef.current = null

    const ro = new ResizeObserver(([e]) => {
      chart.applyOptions({ width: Math.round(e.contentRect.width) })
      applySpacing()
    })
    ro.observe(el)
    return () => { ro.disconnect(); chart.remove(); chartRef.current = null; seriesRef.current = null; volRef.current = null }
  }, [height, applySpacing])

  useEffect(() => {
    let alive = true
    const key = `${token.id}:${tf}`
    const hit = cache.get(key)
    setMeta((m) => ({ ...m, loading: !hit, empty: false }))

    // A one-trade minute has open === close: a body zero pixels tall, which on
    // a dark pane reads as a floating hairline - a coin trading about once a
    // minute turned into morse code. Every screener quietly enforces a minimum
    // BODY height for exactly this reason, so we do too: a floor of ~2px in
    // price terms, derived from the series range. Wicks, direction and every
    // stored number stay untouched - this is paint, not data, and a flat
    // candle takes its color from the previous close the way candles always
    // have. The floor is computed once per series so a bar keeps the same
    // thickness when the live refresh redraws it.
    const bodyFloor = (rows) => {
      let lo = Infinity, hi = -Infinity
      for (const r of rows) { if (r.low < lo) lo = r.low; if (r.high > hi) hi = r.high }
      const mid = (lo + hi) / 2
      const range = Math.max(hi - lo, Math.abs(mid) * 0.02) // matches the autoscale floor
      // 3px, not 2.2: a filled minute is o=h=l=c and there are a lot of them on
      // a bursty coin, so the floor decides whether a quiet stretch reads as a
      // run of bars or as dust.
      return (range / Math.max(120, height * 0.7)) * 3
    }
    const thicken = (r, minBody, prevClose) => {
      if (Math.abs(r.close - r.open) >= minBody) return r
      const up = r.close > r.open || (r.close === r.open && (prevClose == null || r.close >= prevClose))
      const m = (r.open + r.close) / 2
      const open = up ? m - minBody / 2 : m + minBody / 2
      const close = up ? m + minBody / 2 : m - minBody / 2
      return { ...r, open, close, high: Math.max(r.high, open, close), low: Math.min(r.low, open, close) }
    }
    const volBar = (r) => ({
      time: r.time, value: r.volume,
      color: r.close >= r.open ? 'rgba(20, 241, 149, 0.30)' : 'rgba(255, 92, 77, 0.30)',
    })

    const paint = (data, first) => {
      if (!alive || !seriesRef.current || !chartRef.current) return
      const raw = (data.candles || []).map(([t, o, h, l, c, v]) =>
        ({ time: Math.floor(t / 1000), open: o, high: h, low: l, close: c, volume: v }))
      if (!raw.length) {
        if (first) setMeta({ loading: false, empty: true, src: null, bucketMs: null, stale: false })
        return
      }
      // The price range can outgrow the floor that was measured for it (a coin
      // doubles, a wick lands); recompute and redraw the whole series when it
      // does, so old bars and new ones stay drawn to one scale.
      const floor = bodyFloor(raw)
      const reset = first || !minBodyRef.current || floor > minBodyRef.current * 1.8 || floor < minBodyRef.current / 1.8
      if (reset) minBodyRef.current = floor
      const minBody = minBodyRef.current

      const last = raw[raw.length - 1].close
      seriesRef.current.applyOptions({ priceFormat: { type: 'price', precision: precisionFor(last), minMove: 1 / 10 ** precisionFor(last) } })

      // Volume lives in its own pane, not overlaid on the price scale: an
      // overlay needs a bottom margin, and on a coin trading near zero that
      // margin makes the axis print NEGATIVE prices under the candles.
      // CoinGecko's OHLC has no volume at all, so for Blue Chips the pane is
      // removed outright rather than drawn as a row of zero bars.
      const hasVolume = raw.some((r) => r.volume > 0)
      if (hasVolume && !volRef.current) {
        volRef.current = chartRef.current.addSeries(HistogramSeries, {
          priceFormat: { type: 'volume' },
          color: 'rgba(134, 126, 140, 0.35)',
          lastValueVisible: false,
          priceLineVisible: false,
        }, 1)
        const panes = chartRef.current.panes()
        panes[0]?.setStretchFactor(4)
        panes[1]?.setStretchFactor(1)
      } else if (!hasVolume && volRef.current) {
        chartRef.current.removeSeries(volRef.current)
        volRef.current = null
      }

      if (reset) {
        const rows = raw.map((r, i) => thicken(r, minBody, i ? raw[i - 1].close : null))
        seriesRef.current.setData(rows)
        volRef.current?.setData(raw.map(volBar))
        barsRef.current = rows.length
        // Bar width = pane width / bar count, clamped at both ends. The floor
        // keeps a 400-bar day from becoming hairlines; the ceiling only stops a
        // 3-trade coin from drawing three monster candles.
        applySpacing()
        // Anchor on the LAST BAR, never on the wall clock. scrollToRealTime()
        // scrolls to *now*, so a series that ends ten minutes ago opens ten
        // minutes of blank pane on the right - and a stale chart looked like a
        // broken one.
        chartRef.current.timeScale().scrollToPosition(0, false)
      } else {
        // Steady state: only the bars that changed, so the player's own zoom
        // and scroll survive every refresh.
        const from = raw.findIndex((r) => r.time >= lastTimeRef.current)
        for (let i = Math.max(0, from); i < raw.length; i++) {
          const r = thicken(raw[i], minBody, i ? raw[i - 1].close : null)
          seriesRef.current.update(r)
          volRef.current?.update(volBar(raw[i]))
          if (r.time > lastTimeRef.current) barsRef.current++
        }
      }
      lastTimeRef.current = raw[raw.length - 1].time
      setMeta({
        loading: false, empty: false, src: data.src, bucketMs: data.bucketMs,
        stale: !!data.stale, bars: barsRef.current,
            })
    }

    minBodyRef.current = null
    lastTimeRef.current = 0
    load(token.id, tf)
      .then((d) => paint(d, true))
      .catch(() => { if (alive) setMeta({ loading: false, empty: true, src: null, bucketMs: null, stale: false }) })

    // Live from here on. Hidden tabs don't poll (a backgrounded pick terminal
    // must not keep pulling), and coming back to the tab refreshes at once
    // rather than waiting out the interval.
    const tick = () => {
      if (document.hidden) return
      load(token.id, tf, { force: true }).then((d) => paint(d, false)).catch(() => {})
    }
    const timer = setInterval(tick, REFRESH_MS)
    const onVisible = () => { if (!document.hidden) tick() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive = false
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [token.id, tf])

  // A coin that traded six times all day draws six bars in a wide empty pane,
  // which reads as a broken chart unless the chart says otherwise. It is the
  // market that is empty, not the data - so the caption says which.
  const label = meta.empty
    ? 'no candles for this coin yet'
    : meta.loading ? 'loading candles…'
      : `${fmtBucket(meta.bucketMs)} candles · ${meta.src || ''}`
        + (meta.stale ? ' · last good series' : '')
        + (meta.bars > 0 && meta.bars < 8 ? ` · ${meta.bars} bar${meta.bars === 1 ? '' : 's'} - barely traded` : '')
        // A coin that trades once every three minutes draws as a line with the
        // occasional body. Without saying so it reads as a broken chart rather
        // than a quiet one - and the number tells the player themselves that a
        // coarser timeframe is the one worth opening.
        + (meta.quiet >= 0.35 ? ` · ${Math.round(meta.quiet * 100)}% of these bars had no trade` : '')

  // A coin whose source has nothing for us yet (a Solana pool GeckoTerminal
  // has not indexed, a chain-fresh listing) must not end up with an empty
  // frame - that would be worse than what it had. It gets the vendor embed
  // instead, so this engine is never a downgrade for any token.
  if (meta.empty && fallback) return fallback

  return (
    <div className="lw-pane">
      {showTf && (
        <div className="lw-head">
          <div className="lw-tfs">
            {TIMEFRAMES.map(([lbl, key]) => (
              <button key={key} type="button" className={tf === key ? 'on' : ''} onClick={() => setTf(key)}>{lbl}</button>
            ))}
          </div>
          <span className="lw-cap">{label}</span>
        </div>
      )}
      <div className="lw-box" style={{ height }}>
        <div ref={box} className="lw-canvas" />
        {(meta.loading || meta.empty) && (
          <div className="lw-overlay">
            <span className="muted small">{meta.empty ? 'No candles for this coin yet - the live price above is unaffected.' : 'loading candles…'}</span>
          </div>
        )}
      </div>
    </div>
  )
}
