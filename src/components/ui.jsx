import React, { useEffect, useReducer } from 'react'
import { CATEGORY } from '../engine/tokens'
import { onTick, getHist, getPrice, dayChange } from '../engine/prices'
import { useApp } from '../engine/store'
import { fmtPct, fmtPrice } from '../engine/format'

// Re-render subscriber for anything showing live prices (1 tick / second)
export const useMarket = () => {
  const [, force] = useReducer((x) => x + 1, 0)
  useEffect(() => onTick(force), [])
}

// A token's picture is the one its team published - never a generated stand-in.
// The reason most of the book looked logo-less was not a missing image source:
// it was that the book was ranked by LIQUIDITY, which every launchpad seeds
// identically (~$58k), so dead clones outranked real coins. Ranked by trading
// instead, the tokens that surface are the ones with real teams - and those
// have real logos (measured: coins with a logo do a median 1,709 trades a day,
// coins without do 10). What is left over shows its ticker, plainly.
export const TokenLogo = ({ token, size = 34 }) => {
  const [broken, setBroken] = React.useState(false)
  React.useEffect(() => { setBroken(false) }, [token.img])
  if (token.img && !broken) {
    return (
      <img className="tok-logo tok-logo-img" src={token.img} alt={token.ticker} loading="lazy"
        onError={() => setBroken(true)}
        style={{ width: size, height: size, border: '1px solid rgba(233, 230, 239, 0.1)' }} />
    )
  }
  const label = token.glyph || String(token.ticker || '?').slice(0, 2)
  return (
    <span className="tok-logo" style={{
      width: size, height: size, fontSize: label.length > 1 ? size * 0.36 : size * 0.5,
      background: token.color + '26', border: `1px solid ${token.color}55`, color: token.color,
    }}>{label}</span>
  )
}

export const CatBadge = ({ cat, small }) => (
  <span className={`cat-badge cat-${cat} ${small ? 'sm' : ''}`}>
    {cat === 'verified' && '✔ '}
    {cat === 'degen' && '⚠ '}
    {cat === 'fresh' && '🌱 '}
    {cat === 'suspended' && '⏸ '}
    {cat === 'ineligible' && '✕ '}
    {CATEGORY[cat]?.label ?? cat}
  </span>
)

export const Pct = ({ v, digits = 2, className = '' }) => (
  <span className={`num ${v > 0 ? 'up' : v < 0 ? 'down' : 'flat'} ${className}`}>{fmtPct(v, digits)}</span>
)

export const LivePrice = ({ id }) => <span className="num">{fmtPrice(getPrice(id))}</span>
export const LiveDay = ({ id }) => <Pct v={dayChange(id)} />

// The terminal tick: flashes green or red for a beat when the wrapped number
// changes. The changing key swaps the DOM node, which is what restarts the CSS
// animation - no timers, no state.
export const NumFlash = ({ value, className = '', children }) => {
  const prev = React.useRef(value)
  const dir = value > prev.current ? 'nf-up' : value < prev.current ? 'nf-down' : ''
  useEffect(() => { prev.current = value }, [value])
  return <span key={value} className={`${dir} ${className}`}>{children ?? value}</span>
}

export const FeedBadge = () => {
  const app = useApp()
  if (app.user && app.conn !== 'online') {
    return (
      <span className="feed-badge feed-sim" title="Reconnecting to the arena server…">
        ● {app.conn === 'connecting' ? 'connecting…' : 'offline'}
      </span>
    )
  }
  const live = app.feed === 'live'
  return (
    <span className={`feed-badge ${live ? 'feed-live' : 'feed-sim'}`}
      title={live
        ? 'Prices for real tokens are anchored to live CoinGecko data on the arena server.'
        : 'The arena server has no market connection - prices run on its built-in simulation.'}>
      ● {live ? 'live prices' : 'simulated'}
    </span>
  )
}

export const Sparkline = ({ id, data, w = 120, h = 34, color, strokeWidth = 1.6 }) => {
  const hist = data ?? getHist(id).slice(-90)
  if (hist.length < 2) return <svg width={w} height={h} />
  const ps = hist.map((x) => x.p ?? x)
  const min = Math.min(...ps), max = Math.max(...ps)
  // Auto-scaling to the raw min/max turns a 0.05% wiggle into a full-height
  // cliff - every near-flat blue chip reads as a crash. Floor the vertical span
  // at 1.5% of the price and centre the line, so a coin that barely moved draws
  // as a nearly flat line and only a real move fills the frame.
  const mid = (min + max) / 2
  const span = Math.max(max - min, mid * 0.015) || 1
  const y = (p) => h - 3 - ((p - (mid - span / 2)) / span) * (h - 6)
  const pts = ps.map((p, i) => `${(i / (ps.length - 1)) * w},${y(p).toFixed(2)}`).join(' ')
  const trend = ps[ps.length - 1] >= ps[0]
  const c = color ?? (trend ? 'var(--up)' : 'var(--down)')
  return (
    <svg width={w} height={h} className="spark" aria-hidden="true">
      <polyline points={pts} fill="none" stroke={c} strokeWidth={strokeWidth} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

// Central tug-of-war bar: shifts toward whoever leads
export const LeadBar = ({ you, opp, large = false, small = false }) => {
  const diff = you - opp
  const shift = Math.max(-50, Math.min(50, diff * 10)) // 1pp lead = 10% shift
  const size = large ? ' leadbar-lg' : small ? ' leadbar-sm' : ''
  return (
    <div className={'leadbar' + size} role="img"
      aria-label={`Lead: ${diff >= 0 ? 'you' : 'opponent'} by ${Math.abs(diff).toFixed(2)} points`}>
      <div className="leadbar-you" style={{ width: `${50 + shift}%` }} />
      <div className="leadbar-notch" style={{ left: `${50 + shift}%` }} />
    </div>
  )
}

export const Section = ({ eyebrow, title, children, right }) => (
  <section className="section">
    <div className="section-head">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h2 className="section-title">{title}</h2>
      </div>
      {right}
    </div>
    {children}
  </section>
)

/* One rule for every face in the arena: an uploaded picture renders as the
   picture, anything else renders as a monogram struck from the player's name.
   The emoji strings older accounts still carry are deliberately never shown -
   they read as placeholders, not as identity. */
const AVA_HUES = ['#4dd8ff', '#f7b955', '#ff5c8f', '#14f195', '#ff8a4c', '#e9e6ef']
const avaHue = (name) => {
  let h = 0
  for (const c of String(name)) h = (h * 31 + c.codePointAt(0)) >>> 0
  return AVA_HUES[h % AVA_HUES.length]
}

// The face alone (img or monogram letter), for containers that draw their own
// circle - the landing battle card, the duel corners.
export const AvaFace = ({ value, name }) => {
  const v = typeof value === 'string' ? value : ''
  // any rooted path is an image: user uploads (/api/avatar/…) and built-in
  // faces like the arena bot (/bot.png)
  if (v.startsWith('/')) return <img className="ava-img" src={v} alt="" />
  const label = String(name || '').trim()
  return label ? <b className="ava-letter">{[...label][0].toUpperCase()}</b> : <>{value}</>
}

export const Avatar = ({ children, name, size = 40, tone }) => {
  const v = typeof children === 'string' ? children : ''
  const isImg = v.startsWith('/')
  const label = String(name || '').trim()
  const style = { width: size, height: size, fontSize: size * (isImg ? 0.52 : label ? 0.44 : 0.52) }
  if (!isImg && label) style.color = avaHue(label)
  return (
    <span className={`avatar ${tone ? 'avatar-' + tone : ''}`} style={style}>
      <AvaFace value={children} name={name} />
    </span>
  )
}

export const PortfolioRows = ({ picks, tokens, hidden }) => (
  <div className="pf-rows">
    {hidden
      ? [1, 2, 3].map((i) => (
          <div key={i} className="pf-row pf-hidden"><span className="pf-mystery">?</span><span>Hidden until both lock in</span></div>
        ))
      : picks.map((p) => {
          const t = tokens(p.tokenId)
          return (
            <div key={p.tokenId} className="pf-row">
              <TokenLogo token={t} size={26} />
              <span className="pf-ticker">{t.ticker}</span>
              <span className="pf-pct num">{p.pct}%</span>
            </div>
          )
        })}
  </div>
)
