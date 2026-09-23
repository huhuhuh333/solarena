// GMGN-style token intelligence: real chart, website + socials, market cap,
// FDV, liquidity, volume, buys/sells, timeframe changes, contract address.
// Shared by the Tokens screen, the token detail page and the pick-phase modal -
// players see everything about a coin wherever they meet it.

import React, { useState, useEffect } from 'react'
import { getHist } from '../engine/prices'
import { fmtCompact, fmtNum } from '../engine/format'
import { poolLabel, dexUrlFor } from '../engine/tokens'
import { TokenLogo, CatBadge, Sparkline, LivePrice, LiveDay, Pct, useMarket } from './ui'
import { CgChart } from './candles'
import LwChart from './lwchart'
import { useApp } from '../engine/store'

export const fmtAge = (h) => {
  if (h == null || !Number.isFinite(h)) return '-'
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`
  if (h < 48) return `${Math.round(h)}h`
  if (h < 24 * 365) return `${Math.round(h / 24)}d`
  return `${(h / 24 / 365).toFixed(1)}y`
}

const SOCIAL_LABEL = { twitter: 'X', telegram: 'Telegram', discord: 'Discord', website: 'Website' }

// Website + socials + explorer chips - exactly the links GMGN shows.
export const SocialLinks = ({ token, small }) => {
  const links = []
  for (const url of token.websites || []) links.push({ label: SOCIAL_LABEL.website, url, icon: '🌐' })
  for (const s of token.socials || []) {
    const label = SOCIAL_LABEL[s.type] || (s.type ? s.type[0].toUpperCase() + s.type.slice(1) : 'Link')
    links.push({ label, url: s.url, icon: s.type === 'twitter' ? '𝕏' : s.type === 'telegram' ? '✈️' : '🔗' })
  }
  const dex = dexUrlFor(token)
  if (dex) links.push({ label: 'DexScreener', url: dex, icon: '📊' })
  if (!links.length) return null
  return (
    <div className={`ti-links ${small ? 'ti-links-sm' : ''}`}>
      {links.map((l, i) => (
        <a key={i} className="ti-link" href={l.url} target="_blank" rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}>
          <span aria-hidden="true">{l.icon}</span> {l.label}
        </a>
      ))}
    </div>
  )
}

const shortAddr = (a) => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a)

const AddressChip = ({ address }) => {
  const [copied, setCopied] = useState(false)
  if (!address) return null
  return (
    <button className="ti-addr num" title={address}
      onClick={(e) => { e.stopPropagation(); navigator.clipboard?.writeText(address); setCopied(true); setTimeout(() => setCopied(false), 1200) }}>
      {copied ? 'copied ✓' : shortAddr(address)}
    </button>
  )
}

// The REAL chart. Tokens with a resolved DEX pair embed the live DexScreener
// candle chart (same chart GMGN traders live on); everything else falls back
// to the server's real price history.
//
// That embed is a whole third-party app booting inside an iframe - the
// "Loading pair…" spinner is THEIRS, and no code here makes their boot faster.
// What we control is how often a player has to sit through it:
//   · frames live in a small pool and stay mounted, so coming back to a token
//     (or back to a timeframe) reveals a chart that is already running;
//   · warmChart() starts that boot on hover in the token list, so it happens
//     while the player is still reading the row instead of after they click;
//   · src changes are debounced - scanning down a 400-coin book must start one
//     load, not one per row it passes through;
//   · until the frame is up we paint the token's real server price history, so
//     the pane is never an empty grey box.

const POOL_MAX = 3
// Fixed DOM order, never reordered: moving an <iframe> within the document
// reloads it, which would defeat the entire point of keeping a pool.
let slots = []            // [{ src, at }] - index === DOM position
let tick = 0
let pinnedSrc = null      // the frame a mounted chart is currently showing
const loadedSrcs = new Set()
const poolSubs = new Set()
const emitPool = () => { slots = [...slots]; poolSubs.forEach((fn) => fn()) }

// The arena speaks in '1m'…'1d'; DexScreener's embed wants its own interval
// codes. Translating here keeps the vendor's vocabulary inside the vendor's
// component - everything else, including the timeframe row, stays ours.
const DEX_INTERVAL = { '1m': '1', '5m': '5', '15m': '15', '1h': '60', '4h': '240', '1d': '1D' }

const dexSrc = (token, interval) => {
  if (!token?.pairAddress || !token?.srcChain) return null
  const iv = DEX_INTERVAL[interval] || interval
  return `https://dexscreener.com/${token.srcChain}/${token.pairAddress}`
    + `?embed=1&theme=dark&trades=0&info=0${iv ? `&interval=${iv}` : ''}`
}

// Give `src` a slot. Already-held srcs just refresh their recency - no reload.
const claim = (src, pin) => {
  if (!src) return
  if (pin) pinnedSrc = src
  const hit = slots.find((s) => s.src === src)
  if (hit) { hit.at = ++tick; emitPool(); return }
  if (slots.length < POOL_MAX) { slots.push({ src, at: ++tick }); emitPool(); return }
  let victim = null
  for (const s of slots) if (s.src !== pinnedSrc && (!victim || s.at < victim.at)) victim = s
  if (!victim) return                       // whole pool pinned - leave it alone
  loadedSrcs.delete(victim.src)
  victim.src = src                          // same element, new src: navigate, don't remount
  victim.at = ++tick
  emitPool()
}

// Boot a pair's chart without showing it - called on hover in the pick terminal.
export const warmChart = (token, interval) => {
  const src = dexSrc(token, interval)
  if (src && !slots.some((s) => s.src === src)) claim(src, false)
}

// A cross-origin frame gives us onLoad (their document arrived) but never tells
// us when their chart has actually painted, so we hold our own history chart
// over it for a short grace window rather than swapping straight into their
// spinner.
const BOOT_GRACE_MS = 600
const markSettled = (src) => setTimeout(() => {
  if (slots.some((s) => s.src === src)) { loadedSrcs.add(src); emitPool() }
}, BOOT_GRACE_MS)

const usePool = () => {
  const [, bump] = useState(0)
  useEffect(() => {
    const fn = () => bump((n) => n + 1)
    poolSubs.add(fn)
    return () => {
      poolSubs.delete(fn)
      // The frames are children of the chart that just unmounted, so they died
      // with it. Forget that they ever loaded - otherwise the next mount trusts
      // a stale flag, skips the history placeholder and shows the player a
      // DexScreener spinner while the frame boots all over again.
      if (!poolSubs.size) { slots = []; loadedSrcs.clear(); pinnedSrc = null }
    }
  }, [])
  return slots
}

// First paint is immediate; only rapid *changes* are damped.
const useSettledValue = (value, ms) => {
  const [v, setV] = useState(value)
  useEffect(() => {
    if (value === v) return undefined
    const id = setTimeout(() => setV(value), ms)
    return () => clearTimeout(id)
  }, [value])
  return v
}

const HistChart = ({ token, height }) => (
  <Sparkline id={token.id} data={getHist(token.id).slice(-400)} w={1100}
    h={Math.max(70, Math.min(height, 180) - 20)} strokeWidth={2} />
)

// Which renderer draws a chart. Two complete engines live side by side so the
// old one is a config flip away, not a rewrite: 'lw' is ours (candles from
// server/candles.js), 'embed' is the DexScreener iframe exactly as it was.
// Split into separate components on purpose - each engine owns its own hooks,
// so flipping the flag can never change hook order inside one component.
export const TokenChart = (props) => {
  const app = useApp()
  if (app.config.charts === 'embed') return <EmbedChart {...props} />
  // The old engine stays mounted as the fallback for anything our candle
  // service cannot answer for yet - never an empty chart where there used to
  // be one.
  return <LwChart {...props} fallback={<EmbedChart {...props} />} />
}

const EmbedChart = ({ token, height = 380, interval }) => {
  const [broken, setBroken] = useState(false)
  // `wanted` decides what is VISIBLE and updates the instant the player clicks;
  // only the decision to spend a slot on a load is debounced. Debouncing
  // visibility too would leave the previous coin's candles on screen under the
  // new coin's name and price for as long as the damping lasts - a chart
  // showing the wrong token is worse than a chart that is not there yet.
  const wanted = broken ? null : dexSrc(token, interval)
  const claimed = useSettledValue(wanted, 160)
  const frames = usePool()

  useEffect(() => { claim(claimed, true) }, [claimed])

  // Blue Chips have no pair to embed - the server draws them real candles off
  // CoinGecko instead of leaving them with a since-boot line (components/candles.jsx).
  if (!wanted && token?.chartSrc === 'cg') {
    return <CgChart token={token} height={height}
      fallback={<HistChart token={token} height={height} />} />
  }

  if (!wanted) {
    return (
      <div className="ti-chart ti-chart-spark" style={{ height: Math.min(height, 180) }}>
        <HistChart token={token} height={height} />
      </div>
    )
  }

  // A hovered coin is already booted and loaded, so its frame shows with no
  // placeholder at all - the debounce never delays that, it only holds back
  // loads for coins the cursor is passing over.
  const showing = loadedSrcs.has(wanted)
  return (
    <div className="ti-chart ti-chart-live" style={{ height }}>
      {frames.map((s, i) => (
        <iframe key={i} src={s.src} title="Live pair chart"
          className={s.src === wanted ? 'on' : ''}
          onLoad={() => markSettled(s.src)} onError={() => setBroken(true)} />
      ))}
      {!showing && (
        <div className="ti-chart-boot">
          <HistChart token={token} height={height} />
          <span className="ti-chart-boot-l">arena price history · live chart loading</span>
        </div>
      )}
    </div>
  )
}

const ChangeCell = ({ v, label }) => (
  <div className="ti-chg">
    <div className="ti-chg-l">{label}</div>
    {v != null && Number.isFinite(v) ? <Pct v={v} /> : <span className="muted num">-</span>}
  </div>
)

// Full GMGN-style card: header, real chart, timeframe changes, stat grid, links.
export default function TokenInfoPanel({ token, chartHeight = 380, children }) {
  useMarket()
  const t = token
  const pc = t.priceChange || {}
  const txs = t.txns24
  return (
    <div className="ti-panel">
      <div className="ti-head">
        <TokenLogo token={t} size={54} />
        <div className="ti-title">
          <div className="ti-name">{t.name} <span className="muted">· {t.ticker}</span></div>
          <div className="ti-badges">
            <CatBadge cat={t.category} small />
            {/* poolLabel, not poolById: a coin won in a retired pool still
                shows the battlefield it came from instead of an empty chip */}
            {poolLabel(t.pool) && <span className="cat-badge cat-pool sm">{poolLabel(t.pool)}</span>}
            {t.paused && <span className="cat-badge cat-suspended sm">⏸ Paused</span>}
            <AddressChip address={t.address} />
          </div>
        </div>
        <div className="ti-price">
          <div className="num ti-price-v"><LivePrice id={t.id} /></div>
          <LiveDay id={t.id} />
        </div>
      </div>

      <SocialLinks token={t} />

      <TokenChart token={t} height={chartHeight} />

      <div className="ti-chgs">
        <ChangeCell label="5m" v={pc.m5} />
        <ChangeCell label="1h" v={pc.h1} />
        <ChangeCell label="6h" v={pc.h6} />
        <ChangeCell label="24h" v={pc.h24} />
      </div>

      <div className="ti-stats">
        <div className="ti-stat"><div className="ti-stat-v num">{t.marketCap ? fmtCompact(t.marketCap) : '-'}</div><div className="ti-stat-l">Market cap</div></div>
        <div className="ti-stat"><div className="ti-stat-v num">{t.fdv ? fmtCompact(t.fdv) : '-'}</div><div className="ti-stat-l">FDV</div></div>
        <div className="ti-stat"><div className="ti-stat-v num">{fmtCompact(t.liquidity)}</div><div className="ti-stat-l">Liquidity</div></div>
        <div className="ti-stat"><div className="ti-stat-v num">{fmtCompact(t.vol24 ?? t.volume24)}</div><div className="ti-stat-l">Volume 24h</div></div>
        <div className="ti-stat">
          <div className="ti-stat-v num">
            {txs ? <><span className="up">{fmtNum(txs.buys)}</span><span className="muted"> / </span><span className="down">{fmtNum(txs.sells)}</span></> : '-'}
          </div>
          <div className="ti-stat-l">Buys / sells 24h</div>
        </div>
        <div className="ti-stat"><div className="ti-stat-v num">{fmtAge(t.ageHours)}</div><div className="ti-stat-l">Pool age</div></div>
      </div>

      {children}
    </div>
  )
}

// Lightweight modal wrapper used from the pick phase - research without leaving the battle.
export const TokenInfoModal = ({ token, onClose }) => (
  <div className="modal-back" onClick={onClose}>
    <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
      <TokenInfoPanel token={token} chartHeight={340}>
        <div style={{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap', alignItems: 'center' }}>
          <a className="btn" href={'/token/' + token.id} onClick={onClose}>Full token page</a>
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </TokenInfoPanel>
    </div>
  </div>
)
