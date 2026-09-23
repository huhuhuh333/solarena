// The Blue Chips' chart. Every other pool has a DEX pair, so its chart is the
// DexScreener embed traders already live on (components/tokeninfo.jsx). BTC is
// not an ERC-20 and the wrapped proxies are a different asset in a different
// pool - embedding one would put a WBTC chart under a card that says Bitcoin.
// So we draw these ourselves, from true OHLC candles the server pulls off
// CoinGecko and caches.
//
// The vendor's granularity is fixed per range (a day comes back as 30-minute
// candles, a month as 4-hour), so the range chips are the ones it can answer
// honestly and the caption names the candle size it actually is - the chart
// never implies a finer resolution than the data has.

import React, { useEffect, useRef, useState } from 'react'
import { api } from '../engine/net'
import { fmtPrice } from '../engine/format'

export const RANGES = [
  { key: '1d', label: '1D' },
  { key: '7d', label: '7D' },
  { key: '30d', label: '1M' },
  { key: '90d', label: '3M' },
]

// One fetch per (token, range) shared by every mount - the pick terminal and
// the token page ask for the same series, and the server is rate-limited.
const TTL_MS = 60000
const cache = new Map()
const inflight = new Map()

const load = (id, range) => {
  const key = `${id}:${range}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.data)
  if (inflight.has(key)) return inflight.get(key)
  const job = api(`/api/token/${encodeURIComponent(id)}/ohlc?range=${range}`)
    .then((data) => {
      if (!data?.candles?.length) throw new Error('empty')
      cache.set(key, { at: Date.now(), data })
      return data
    })
    .finally(() => inflight.delete(key))
  inflight.set(key, job)
  return job
}

const useCandles = (id, range) => {
  const [state, setState] = useState(() => {
    const hit = cache.get(`${id}:${range}`)
    return { data: hit?.data || null, loading: !hit, failed: false }
  })
  useEffect(() => {
    let alive = true
    const hit = cache.get(`${id}:${range}`)
    setState({ data: hit?.data || null, loading: !hit, failed: false })
    load(id, range)
      .then((data) => { if (alive) setState({ data, loading: false, failed: false }) })
      .catch(() => { if (alive) setState({ data: null, loading: false, failed: true }) })
    return () => { alive = false }
  }, [id, range])
  return state
}

// Width comes from the box, not from a guess: the same chart sits in a 380px
// modal pane and a full-width token page.
const useWidth = (ref) => {
  const [w, setW] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return undefined
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)))
    ro.observe(el)
    setW(Math.round(el.getBoundingClientRect().width))
    return () => ro.disconnect()
  }, [ref])
  return w
}

const PAD = { l: 4, r: 60, t: 10, b: 20 }

const timeLabel = (ms, bucket) => {
  const d = new Date(ms)
  if (bucket === '30m') return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (bucket === '4h') return d.toLocaleDateString([], { day: 'numeric', month: 'short' })
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' })
}

const stamp = (ms, bucket) => {
  const d = new Date(ms)
  const date = d.toLocaleDateString([], { day: 'numeric', month: 'short' })
  return bucket === '4d' ? date : `${date} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

export const Candles = ({ candles, bucket, width, height }) => {
  const [hover, setHover] = useState(null)
  const n = candles.length
  const plotW = Math.max(10, width - PAD.l - PAD.r)
  const plotH = Math.max(10, height - PAD.t - PAD.b)

  let lo = Infinity, hi = -Infinity
  for (const c of candles) { if (c[3] < lo) lo = c[3]; if (c[2] > hi) hi = c[2] }
  const mid = (lo + hi) / 2
  // A flat week must draw flat. Without a floor on the span, a 0.2% range fills
  // the frame and every quiet blue chip reads as a rollercoaster.
  const span = Math.max(hi - lo, mid * 0.004) || 1
  const top = mid + span / 2 + span * 0.06
  const bot = mid - span / 2 - span * 0.06
  const y = (p) => PAD.t + ((top - p) / (top - bot)) * plotH
  const slot = plotW / n
  const x = (i) => PAD.l + (i + 0.5) * slot
  const bodyW = Math.max(1, Math.min(14, slot * 0.62))

  const last = candles[n - 1]
  const lastUp = last[4] >= last[1]
  // The last price owns its slot on the axis: any grid label that would sit
  // under its tag is dropped rather than printed behind it.
  const lastY = y(last[4])
  const gridPrices = [0, 1, 2, 3]
    .map((i) => bot + ((top - bot) * (i + 0.5)) / 4)
    .filter((p) => Math.abs(y(p) - lastY) > 13)
  const tickEvery = Math.max(1, Math.round(n / 5))

  const onMove = (e) => {
    const box = e.currentTarget.getBoundingClientRect()
    const i = Math.max(0, Math.min(n - 1, Math.floor((e.clientX - box.left - PAD.l) / slot)))
    setHover(i)
  }

  const h = hover != null ? candles[hover] : null
  const tipLeft = h ? Math.max(0, Math.min(width - 168, x(hover) - 84)) : 0

  return (
    <div className="cdl-wrap" style={{ height }}>
      <svg width={width} height={height} className="cdl-svg">
        {gridPrices.map((p, i) => (
          <g key={i}>
            <line className="cdl-grid" x1={PAD.l} x2={PAD.l + plotW} y1={y(p)} y2={y(p)} />
            <text className="cdl-axis" x={PAD.l + plotW + 6} y={y(p) + 3.5}>{fmtPrice(p)}</text>
          </g>
        ))}
        {candles.map((c, i) => {
          if (i % tickEvery !== 0 || i >= n - tickEvery / 2) return null
          // The first stamp is half off the left edge when centred, so the ends
          // anchor inward and only the middle ones sit over their candle.
          const first = i < tickEvery
          return (
            <text key={'t' + i} className="cdl-axis cdl-axis-x"
              x={first ? PAD.l : x(i)} y={height - 6} textAnchor={first ? 'start' : 'middle'}>
              {timeLabel(c[0], bucket)}
            </text>
          )
        })}
        {candles.map((c, i) => {
          const up = c[4] >= c[1]
          const oy = y(c[1]), cy = y(c[4])
          return (
            <g key={i} className={up ? 'cdl-up' : 'cdl-dn'}>
              <line className="cdl-wick" x1={x(i)} x2={x(i)} y1={y(c[2])} y2={y(c[3])} />
              <rect className="cdl-body" x={x(i) - bodyW / 2} y={Math.min(oy, cy)}
                width={bodyW} height={Math.max(1, Math.abs(cy - oy))} />
            </g>
          )
        })}
        <line className={`cdl-lastline ${lastUp ? 'cdl-up' : 'cdl-dn'}`}
          x1={PAD.l} x2={PAD.l + plotW} y1={y(last[4])} y2={y(last[4])} />
        <rect className={`cdl-lasttag ${lastUp ? 'cdl-up' : 'cdl-dn'}`}
          x={PAD.l + plotW + 2} y={y(last[4]) - 8} width={PAD.r - 6} height={16} rx={2} />
        <text className="cdl-lasttxt" x={PAD.l + plotW + 6} y={y(last[4]) + 3.5}>{fmtPrice(last[4])}</text>
        {h && (
          <g>
            <line className="cdl-cross" x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={PAD.t + plotH} />
            <line className="cdl-cross" x1={PAD.l} x2={PAD.l + plotW} y1={y(h[4])} y2={y(h[4])} />
          </g>
        )}
        <rect x={0} y={0} width={width} height={height} fill="transparent"
          onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
      </svg>
      {h && (
        <div className="cdl-tip" style={{ left: tipLeft }}>
          <div className="cdl-tip-t">{stamp(h[0], bucket)}</div>
          <div className="cdl-tip-g">
            <span>O</span><b>{fmtPrice(h[1])}</b>
            <span>H</span><b>{fmtPrice(h[2])}</b>
            <span>L</span><b>{fmtPrice(h[3])}</b>
            <span>C</span><b className={h[4] >= h[1] ? 'up' : 'down'}>{fmtPrice(h[4])}</b>
          </div>
        </div>
      )}
    </div>
  )
}

// The chart pane: range chips, the candles, and a caption that states exactly
// what is on screen - source, candle size, and whether the series is the last
// good one rather than a fresh pull.
export const CgChart = ({ token, height = 380, range, onRange, fallback = null }) => {
  const [own, setOwn] = useState('1d')
  const sel = range || own
  const setSel = onRange || setOwn
  const box = useRef(null)
  const width = useWidth(box)
  const { data, loading, failed } = useCandles(token.id, sel)

  const chartH = Math.max(120, height - 34)
  return (
    <div className="cdl-pane">
      <div className="cdl-head">
        <div className="cdl-ranges">
          {RANGES.map((r) => (
            <button key={r.key} type="button" className={sel === r.key ? 'on' : ''}
              onClick={() => setSel(r.key)}>{r.label}</button>
          ))}
        </div>
        <span className="cdl-cap">
          {data
            ? <>{data.bucket} candles · CoinGecko{data.stale ? ' · last good series' : ''}</>
            : loading ? 'loading candles…' : 'candles unavailable'}
        </span>
      </div>
      <div ref={box} className="cdl-box" style={{ height: chartH }}>
        {data && width > 60
          ? <Candles candles={data.candles} bucket={data.bucket} width={width} height={chartH} />
          : (
            <div className="cdl-empty">
              {loading ? <span className="muted small">loading candles…</span>
                : failed ? (fallback || <span className="muted small">No candle series right now - the live price above is unaffected.</span>)
                  : null}
            </div>
          )}
      </div>
    </div>
  )
}
