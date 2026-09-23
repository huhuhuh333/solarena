// SolArena pick terminal - a simplified GMGN trading terminal tuned to ONE
// action: find 3 coins, build a portfolio, lock in. Full-bleed, three panes:
// token list (left) · selected-token detail + real chart (middle) · picks and
// battle summary (right). Rendered by App for the duel `picking` phase.

import React, { useState, useMemo, useEffect } from 'react'
import { useApp, effToken, allTokens } from '../engine/store'
import { duelCancel, lockPicks } from '../engine/net'
import { tokenAllowed, validatePicks, SWAP_COST, priceImpactFor } from '../engine/duel'
import { poolLabel, dexUrlFor, marketScore } from '../engine/tokens'
import { fmtUsd, fmtClock, fmtPct, fmtPrice, fmtCompact, fmtNum, durLabel } from '../engine/format'
import { dayChange } from '../engine/prices'
import { useMarket, TokenLogo, Pct, Avatar, LivePrice, LiveDay } from '../components/ui'
import { TokenChart, SocialLinks, fmtAge, warmChart } from '../components/tokeninfo'
import { warmCandles } from '../components/lwchart'

const TABS = [
  { key: 'trending', label: 'Trending' },
  { key: 'new', label: 'New Migrated' },
  { key: 'volume', label: 'Top Volume' },
  { key: 'gainers', label: 'Gainers' },
  { key: 'favorites', label: 'Favorites ★' },
]
// The row already carries the ticker in bold above, and the parenthetical is
// the same justification on every blocked row - at a 5-minute duration that is
// the whole list repeating one sentence. Both survive in the tooltip; the row
// keeps the part that differs.
const shortWhy = (ticker, why = '') => {
  const w = why.startsWith(`${ticker} `) ? why.slice(ticker.length + 1) : why
  return w.replace(/\s*\([^)]*\)\s*$/, '')
}

// Our own timeframe keys, not a vendor's. The embed engine translates them to
// DexScreener's intervals on its way into the iframe URL (components/tokeninfo.jsx).
const TIMEFRAMES = [['1m', '1m'], ['5m', '5m'], ['15m', '15m'], ['1h', '1h'], ['4h', '4h'], ['1d', '1d']]
// The list scrolls, it doesn't paginate. Rows mount in steps of this as the
// scroll approaches the bottom, so a 400-coin book never renders 400 live
// price cells at once.
const STEP = 24
const FAV_KEY = 'hood_favs'

const STATUS = {
  verified: { label: 'Arena Verified', cls: 'verified' },
  degen: { label: 'Degen Approved', cls: 'degen' },
  fresh: { label: 'Low Liquidity', cls: 'fresh' },
  suspended: { label: 'Suspended', cls: 'suspended' },
  ineligible: { label: 'Not Eligible', cls: 'ineligible' },
}

export const loadFavs = () => { try { return new Set(JSON.parse(localStorage.getItem(FAV_KEY)) || []) } catch { return new Set() } }
export const saveFavs = (s) => { try { localStorage.setItem(FAV_KEY, JSON.stringify([...s])) } catch { /* ignore */ } }

const explorerUrl = (t) => {
  if (!t?.address) return dexUrlFor(t)
  if (t.srcChain === 'solana' || t.pool === 'sol') return `https://solscan.io/token/${t.address}`
  return dexUrlFor(t)
}
const shortAddr = (a) => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || '-')

// Equal split in WHOLE percent, remainder on the first slot → exactly 100.
// Whole numbers because that is what a locked portfolio actually is: the server
// rounds every slice to an integer when it stores the picks. A fractional split
// (33.34/33.33/33.33) passes validation at 100 and then lands as 33/33/33 = 99,
// quietly leaving 1% of the entry unallocated - dead weight in Classic, and a
// dollar that never reaches the market in Live.
export const equalSplit = (ids) => {
  const n = ids.length
  if (!n) return {}
  const base = Math.floor(100 / n)
  const out = {}
  ids.forEach((id) => { out[id] = base })
  out[ids[0]] = 100 - base * (n - 1)
  return out
}

// Move one slice; the rest of the pie follows. The sliders used to be three
// independent numbers, so raising one raised the TOTAL - the terminal sat at
// "148% allocated" in red and left the player to work out which of the other two
// to pull back, on a clock. A portfolio is a division of one stake.
//
// Lives here rather than in either screen because the pick terminal and the
// board's posting flow both drive it, and two copies of this would disagree the
// first time one of them changed.
export const allocWith = (alloc, ids, id, raw, maxFor = () => 100) => {
  const v = Math.max(0, Math.min(maxFor(id), Math.round(Number(raw) || 0)))
  const others = ids.filter((x) => x !== id)
  if (!others.length) return { ...alloc, [id]: 100 }

  const left = 100 - v
  const cur = others.map((x) => Math.max(0, alloc[x] || 0))
  const sum = cur.reduce((s, n) => s + n, 0)
  // Proportional to where the player had them, so the SHAPE of a portfolio
  // survives a nudge - 60/30/10 stays weighted that way. Equal only when there
  // is no shape yet to preserve.
  const share = others.map((_, i) => (sum > 0 ? (cur[i] / sum) * left : left / others.length))

  // A degen coin is capped at 50%. Whatever it cannot absorb passes to the
  // others, in proportion to the room each of them has left.
  let spill = 0
  others.forEach((x, i) => {
    const cap = maxFor(x)
    if (share[i] > cap) { spill += share[i] - cap; share[i] = cap }
  })
  if (spill > 0) {
    const room = others.map((x, i) => Math.max(0, maxFor(x) - share[i]))
    const roomSum = room.reduce((s, n) => s + n, 0)
    if (roomSum > 0) others.forEach((_, i) => { share[i] += (room[i] / roomSum) * spill })
  }

  // Whole percent, because that is what a locked portfolio is stored as. The
  // rounding residue lands on the largest OTHER slice - the slider the player is
  // holding keeps exactly the number they chose.
  const out = share.map((n) => Math.round(n))
  const diff = left - out.reduce((s, n) => s + n, 0)
  if (diff !== 0 && out.length) {
    let k = 0
    for (let i = 1; i < out.length; i++) if (out[i] > out[k]) k = i
    out[k] = Math.max(0, Math.min(maxFor(others[k]), out[k] + diff))
  }

  const next = { ...alloc, [id]: v }
  others.forEach((x, i) => { next[x] = out[i] })
  return next
}

/* ============================ HEADER ============================ */
const Header = ({ d, nav }) => {
  const ty = d.tourney
  const arena = ty ? 'TOURNAMENT' : d.training ? 'TRAINING' : d.mode === 'live' ? 'LIVE ARENA' : 'CLASSIC ARENA'
  const oppReady = d.opp?.locked
  return (
    <header className="pt-head">
      <a className="pt-logo" href="/play" onClick={(e) => { e.preventDefault() }}>SOL<em>ARENA</em></a>
      <div className="pt-duelinfo">
        <span className={`pt-arena ${d.mode === 'live' ? 'live' : ''}`}>{arena}</span>
        <span className="pt-dot">·</span>
        <span>{d.training ? 'FREE' : `$${d.stake} ${ty ? 'ENTRY' : 'STAKE'}`}</span>
        <span className="pt-dot">·</span>
        <span>{durLabel(d.duration).toUpperCase()}</span>
        {poolLabel(d.battlePool) && <><span className="pt-dot">·</span><span className="pt-pool">{poolLabel(d.battlePool)}</span></>}
      </div>
      <div className="pt-head-right">
        <div className="pt-opp">
          {ty ? (
            <>
              <span className="pt-opp-l">⚔ {ty.count} PLAYERS · ${ty.money.pot} POT</span>
              <span className={`pt-opp-s ${ty.lockedCount === ty.count ? 'ready' : ''}`}>{ty.lockedCount}/{ty.count} locked in</span>
            </>
          ) : (
            <>
              <span className="pt-opp-l">{d.opp ? <>⚔ {d.opp.name}</> : 'Matching…'}</span>
              <span className={`pt-opp-s ${oppReady ? 'ready' : ''}`}>{d.opp ? (oppReady ? 'Opponent ready' : 'Opponent picking…') : 'Finding opponent…'}</span>
            </>
          )}
        </div>
        <div className="pt-timer">
          <span className="pt-timer-l">PORTFOLIO LOCK IN</span>
          <span className={`pt-timer-v ${d.pickLeft <= 15 ? 'hurry' : ''}`}>{fmtClock(d.pickLeft)}</span>
        </div>
        <button className="pt-exit" onClick={() => { duelCancel(); nav(ty ? '/tournaments' : '/play') }}>
          {ty ? 'Leave (refund) ⤶' : 'Exit Battle ⤶'}
        </button>
      </div>
    </header>
  )
}

/* ============================ LEFT - TOKEN LIST ============================ */
const StatusPill = ({ cat }) => {
  const s = STATUS[cat] || STATUS.fresh
  return <span className={`pt-status pt-status-${s.cls}`}>{s.label}</span>
}

export const TokenList = ({ cfg, pool, favs, toggleFav, selectedId, onSelect, onAdd, sel, tf }) => {
  useMarket()
  const [tab, setTab] = useState('trending')
  const [q, setQ] = useState('')
  const [visible, setVisible] = useState(STEP)
  const rowsRef = React.useRef(null)
  const [showFilters, setShowFilters] = useState(false)
  // Hover intent: a coin the cursor merely sweeps over is not a coin the player
  // is considering. Pausing on a row starts its chart booting, so by the time
  // they click, the pane has a live chart instead of a spinner.
  const warmRef = React.useRef(null)
  const warmOn = (t) => {
    clearTimeout(warmRef.current)
    // Warm whichever engine is drawing: a candle fetch for ours, an iframe boot
    // for the embed. Both are wasted if the timeframe differs from the one the
    // detail pane will ask for, so both get `tf`.
    warmRef.current = setTimeout(() => { warmCandles(t, tf); warmChart(t, tf) }, 180)
  }
  const warmOff = () => clearTimeout(warmRef.current)
  useEffect(() => () => clearTimeout(warmRef.current), [])
  const [f, setF] = useState({ minLiq: 0, minMcap: 0, maxAgeDays: 0, verified: false, degen: false, eligible: false, migrated: false })

  const universe = useMemo(() => allTokens().filter((t) => !pool || t.pool === pool), [pool])

  const needle = q.trim().toUpperCase()
  const list = useMemo(() => {
    let arr = universe.filter((t) => {
      if (needle && !(t.ticker.includes(needle) || (t.name || '').toUpperCase().includes(needle) || (t.address || '').toUpperCase() === needle)) return false
      if (tab === 'favorites' && !favs.has(t.id)) return false
      if (f.verified && t.category !== 'verified') return false
      if (f.degen && t.category !== 'degen') return false
      if (f.eligible && !tokenAllowed(t.id, cfg).ok) return false
      if (f.migrated && t.safety?.migrated === false) return false
      if (f.minLiq && (t.liquidity || 0) < f.minLiq) return false
      if (f.minMcap && (t.marketCap || 0) < f.minMcap) return false
      if (f.maxAgeDays && (t.ageHours ?? Infinity) / 24 > f.maxAgeDays) return false
      return true
    })
    const chg = (t) => (Number.isFinite(t.priceChange?.h24) ? t.priceChange.h24 : dayChange(t.id))
    const vol = (t) => t.vol24 ?? t.volume24 ?? 0
    if (tab === 'new') arr.sort((a, b) => (a.ageHours ?? 9e9) - (b.ageHours ?? 9e9))
    else if (tab === 'gainers') arr.sort((a, b) => chg(b) - chg(a))
    else if (tab === 'volume') arr.sort((a, b) => vol(b) - vol(a))
    // Trending = depth × turnover (see marketScore). Volume alone can be one
    // wash-trading wallet on a dust pool; depth alone is a launchpad template.
    else arr.sort((a, b) => marketScore(b) - marketScore(a))
    return arr
  }, [universe, needle, tab, favs, f, cfg])

  useEffect(() => {
    setVisible(STEP)
    if (rowsRef.current) rowsRef.current.scrollTop = 0
  }, [needle, tab, f])
  const rows = list.slice(0, visible)
  const onScroll = (e) => {
    const el = e.currentTarget
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 160 && visible < list.length) {
      setVisible((v) => v + STEP)
    }
  }
  // A tall viewport can swallow the first batch without ever scrolling - keep
  // feeding rows until the container actually overflows (or the list runs out).
  useEffect(() => {
    const el = rowsRef.current
    if (el && visible < list.length && el.scrollHeight <= el.clientHeight + 40) setVisible((v) => v + STEP)
  }, [visible, list.length])

  const numField = (key, label, opts) => (
    <label className="pt-fnum">
      <span>{label}</span>
      <select value={f[key]} onChange={(e) => setF({ ...f, [key]: Number(e.target.value) })}>
        {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  )

  return (
    <section className="pt-left">
      <div className="pt-search-row">
        <div className="pt-search">
          <span aria-hidden="true">🔍</span>
          <input placeholder="Search token, ticker or address…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <button className={`pt-filter-btn ${showFilters ? 'on' : ''}`} title="Filters" onClick={() => setShowFilters((v) => !v)}>⚙</button>
      </div>

      <div className="pt-tabs">
        {TABS.map((t) => (
          <button key={t.key} className={tab === t.key ? 'on' : ''} onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </div>

      {showFilters && (
        <div className="pt-filters">
          {numField('minLiq', 'Min liquidity', [[0, 'Any'], [1e4, '$10K'], [5e4, '$50K'], [2.5e5, '$250K'], [1e6, '$1M']])}
          {numField('minMcap', 'Min market cap', [[0, 'Any'], [1e5, '$100K'], [1e6, '$1M'], [1e7, '$10M'], [1e8, '$100M']])}
          {numField('maxAgeDays', 'Max age', [[0, 'Any'], [1, '1d'], [7, '7d'], [30, '30d'], [365, '1y']])}
          <label className="pt-fchk"><input type="checkbox" checked={f.verified} onChange={(e) => setF({ ...f, verified: e.target.checked, degen: false })} /> Arena Verified</label>
          <label className="pt-fchk"><input type="checkbox" checked={f.degen} onChange={(e) => setF({ ...f, degen: e.target.checked, verified: false })} /> Degen Approved</label>
          <label className="pt-fchk"><input type="checkbox" checked={f.eligible} onChange={(e) => setF({ ...f, eligible: e.target.checked })} /> Eligible for this battle</label>
          <label className="pt-fchk"><input type="checkbox" checked={f.migrated} onChange={(e) => setF({ ...f, migrated: e.target.checked })} /> Migrated only</label>
        </div>
      )}

      <div className="pt-table">
        <div className="pt-row pt-row-head">
          <span /><span>Token</span><span>Price</span><span>5m</span><span>1h</span>
          <span>MCap</span><span>Liq</span><span>Vol</span><span>Holders</span><span>Age</span><span>Status</span><span>Add</span>
        </div>
        <div className="pt-rows" ref={rowsRef} onScroll={onScroll}>
          {rows.map((t) => {
            const allowed = tokenAllowed(t.id, cfg)
            const isSel = sel.includes(t.id)
            const active = selectedId === t.id
            const pc = t.priceChange || {}
            return (
              <div key={t.id} className={`pt-row ${active ? 'active' : ''} ${!allowed.ok ? 'blocked' : ''}`}
                onClick={() => onSelect(t.id)} onMouseEnter={() => warmOn(t)} onMouseLeave={warmOff}>
                <button className={`pt-fav ${favs.has(t.id) ? 'on' : ''}`} title="Favorite"
                  onClick={(e) => { e.stopPropagation(); toggleFav(t.id) }}>{favs.has(t.id) ? '★' : '☆'}</button>
                <span className="pt-tok">
                  <TokenLogo token={t} size={32} />
                  <span className="pt-tok-txt">
                    <span className="pt-tok-name">{t.ticker}</span>
                    {/* One second line, never two: the reason REPLACES the name
                        on a blocked row rather than stacking under it, so every
                        row in the list is the same height and the eye lands on
                        the same spot whether or not the coin can be picked. */}
                    {allowed.ok
                      ? <span className="pt-tok-sub">{t.name}</span>
                      : <span className="pt-reason" title={allowed.why}>{shortWhy(t.ticker, allowed.why)}</span>}
                  </span>
                </span>
                <span className="num"><LivePrice id={t.id} /></span>
                <span>{Number.isFinite(pc.m5) ? <Pct v={pc.m5} digits={1} /> : <span className="muted num">-</span>}</span>
                <span>{Number.isFinite(pc.h1) ? <Pct v={pc.h1} digits={1} /> : <LiveDay id={t.id} />}</span>
                <span className="num">{t.marketCap ? fmtCompact(t.marketCap) : '-'}</span>
                <span className="num">{fmtCompact(t.liquidity)}</span>
                <span className="num">{fmtCompact(t.vol24 ?? t.volume24)}</span>
                <span className="num">{fmtNum(t.holders)}</span>
                <span className="num">{fmtAge(t.ageHours)}</span>
                <span><StatusPill cat={t.category} /></span>
                <span>
                  <button className={`pt-add ${isSel ? 'rm' : ''}`} disabled={!allowed.ok && !isSel}
                    title={isSel ? 'Remove' : allowed.ok ? 'Add to portfolio' : allowed.why}
                    onClick={(e) => { e.stopPropagation(); onAdd(t.id, !isSel) }}>{isSel ? '−' : '+'}</button>
                </span>
              </div>
            )
          })}
          {!rows.length && <div className="pt-empty">No tokens match your filters.</div>}
        </div>
      </div>

      <div className="pt-list-foot">
        <span className="small muted">
          {list.length === 0 ? '0 tokens' : `Showing ${Math.min(visible, list.length)} of ${list.length} tokens${visible < list.length ? ' - scroll for more' : ''}`}
        </span>
      </div>
    </section>
  )
}

/* ============================ MIDDLE - TOKEN DETAIL ============================ */
const SafetyRow = ({ label, state, note }) => (
  <div className={`pt-safe pt-safe-${state}`}>
    <span>{label}</span>
    <span className="pt-safe-mark">{state === 'ok' ? '✓' : state === 'warn' ? '!' : '✕'}</span>
    {note && <span className="pt-safe-note">{note}</span>}
  </div>
)

// `tf` lives in the parent: the token list warms charts on hover and has to
// warm the SAME timeframe the detail pane will ask for, or the warmed frame is
// wasted and the click still pays a cold boot.
export const Detail = ({ token, cfg, inPortfolio, onAdd, tf, setTf }) => {
  useMarket()
  const [copied, setCopied] = useState(false)
  if (!token) return <section className="pt-mid"><div className="pt-mid-empty">Select a token to inspect it.</div></section>
  const t = token
  const allowed = tokenAllowed(t.id, cfg)
  const s = t.safety || {}
  const liveEligible = t.category === 'verified'
  const expl = explorerUrl(t)

  return (
    <section className="pt-mid">
      <div className="pt-mid-head">
        <TokenLogo token={t} size={46} />
        <div className="pt-mid-title">
          <div className="pt-mid-name">{t.name} <span className="muted">{t.ticker}</span></div>
          <div className="pt-mid-addr">
            <button className="pt-addr" title={t.address || ''} onClick={() => { navigator.clipboard?.writeText(t.address || ''); setCopied(true); setTimeout(() => setCopied(false), 1200) }}>
              {copied ? 'copied ✓' : shortAddr(t.address)} ⧉
            </button>
            {expl && <a className="pt-addr" href={expl} target="_blank" rel="noopener noreferrer">Explorer ↗</a>}
          </div>
        </div>
        <div className="pt-mid-price">
          <div className="num pt-mid-p"><LivePrice id={t.id} /></div>
          <LiveDay id={t.id} />
        </div>
        <button className={`pt-mid-add ${inPortfolio ? 'rm' : ''}`} disabled={!allowed.ok && !inPortfolio}
          onClick={() => onAdd(t.id, !inPortfolio)} title={allowed.ok ? '' : allowed.why}>
          {inPortfolio ? '− Remove' : '+ Add to portfolio'}
        </button>
      </div>

      {/* The terminal owns the timeframe row: the token list warms the chart on
          hover and must warm the SAME timeframe this pane will ask for. The one
          case it steps aside for is a Blue Chip on the old embed engine, whose
          CoinGecko ranges are fixed per range and bring their own chips. */}
      {!(cfg.charts === 'embed' && t.chartSrc === 'cg') && (
        <div className="pt-tf">
          {TIMEFRAMES.map(([lbl, iv]) => (
            <button key={iv} className={tf === iv ? 'on' : ''} onClick={() => setTf(iv)}>{lbl}</button>
          ))}
        </div>
      )}
      <TokenChart token={t} interval={tf} tf={tf} onTf={setTf} showTf={false} height={300} />
      <SocialLinks token={t} small />

      <div className="pt-dstats">
        <div><span className="num">{t.marketCap ? fmtCompact(t.marketCap) : '-'}</span><label>Market cap</label></div>
        <div><span className="num">{fmtCompact(t.liquidity)}</span><label>Liquidity</label></div>
        <div><span className="num">{fmtCompact(t.vol24 ?? t.volume24)}</span><label>24h volume</label></div>
        <div><span className="num">{fmtNum(t.holders)}</span><label>Holders</label></div>
        <div><span className="num">{fmtAge(t.ageHours)}</span><label>Pool age</label></div>
        <div><span className="num">{t.topHolderPct != null ? t.topHolderPct.toFixed(2) + '%' : '-'}</span><label>Top holder</label></div>
        <div><span className="num">{t.buyTax != null ? t.buyTax.toFixed(1) + '%' : '-'}</span><label>Buy tax</label></div>
        <div><span className="num">{t.sellTax != null ? t.sellTax.toFixed(1) + '%' : '-'}</span><label>Sell tax</label></div>
        <div><span className="num">{t.txns24 ? <><span className="up">{t.txns24.buys}</span>/<span className="down">{t.txns24.sells}</span></> : '-'}</span><label>Buys / sells</label></div>
      </div>

      <div className="pt-safety">
        <div className="pt-safety-h">Safety &amp; Eligibility</div>
        <div className="pt-safety-grid">
          <SafetyRow label="Sellable" state={s.sellNotBlockable !== false && s.tradable !== false ? 'ok' : 'bad'} />
          <SafetyRow label="No honeypot" state={s.honeypot === true ? 'bad' : 'ok'} />
          <SafetyRow label="Depth for this size" state={s.slippageOk !== false ? 'ok' : 'warn'} />
          <SafetyRow label="Live eligible" state={liveEligible ? 'ok' : 'warn'} />
          {/* Rug signals - informational, they do not block anything. */}
          <SafetyRow label="Liquidity locked" state={s.lpLocked ? 'ok' : 'warn'} />
          <SafetyRow label="Mint authority revoked" state={s.mintLocked !== false ? 'ok' : 'warn'} />
        </div>
        {!allowed.ok
          ? <div className="pt-elig bad">{cfg.mode === 'live' ? 'Live Arena unavailable' : 'Not eligible for this battle'} - {allowed.why}</div>
          : <div className="pt-elig ok">Eligible for this ${cfg.stake} {cfg.mode} battle{cfg.mode === 'live' && (t.reachableLiquidity ?? t.liquidity) ? ` · ~$${Math.round(t.reachableLiquidity ?? t.liquidity).toLocaleString()} on-chain depth - big slices pay their price impact` : ''}.</div>}
      </div>
    </section>
  )
}

/* ============================ RIGHT - PICKS + SUMMARY ============================ */
const Donut = ({ segments, size = 96, stroke = 13 }) => {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  let off = 0
  const cx = size / 2
  return (
    <svg width={size} height={size} className="pt-donut">
      <circle cx={cx} cy={cx} r={r} fill="none" stroke="var(--line)" strokeWidth={stroke} />
      {segments.map((sg, i) => {
        const len = c * Math.min(1, sg.frac)
        const el = (
          <circle key={i} cx={cx} cy={cx} r={r} fill="none" stroke={sg.color} strokeWidth={stroke}
            strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-off} transform={`rotate(-90 ${cx} ${cx})`} strokeLinecap="butt" />
        )
        off += len
        return el
      })}
      <text x="50%" y="47%" textAnchor="middle" className="pt-donut-v">{Math.round(segments.reduce((a, sg) => a + sg.frac, 0) * 100)}%</text>
      <text x="50%" y="62%" textAnchor="middle" className="pt-donut-l">ALLOC</text>
    </svg>
  )
}

const Slot = ({ n, token, pct, maxPct, locked, onPct, onRemove, onSelect }) => {
  if (!token) {
    return (
      <div className="pt-slot pt-slot-empty">
        <span className="pt-slot-n">{n}</span>
        <span className="pt-slot-plus">＋</span>
        <div className="pt-slot-mid"><div className="pt-slot-name">Choose a token</div><div className="small muted">unallocated {pct}%</div></div>
      </div>
    )
  }
  return (
    <div className="pt-slot">
      <span className="pt-slot-n">{n}</span>
      <TokenLogo token={token} size={30} />
      <div className="pt-slot-mid" onClick={() => onSelect(token.id)}>
        <div className="pt-slot-name">{token.ticker} <span className="muted small">{token.name}</span></div>
        <input type="range" min="1" max={maxPct} step="1" value={Math.round(pct)} disabled={locked}
          onChange={(e) => onPct(token.id, Number(e.target.value))} onClick={(e) => e.stopPropagation()} />
      </div>
      <div className="pt-slot-pct">
        {/* whole percent only - that is how a locked portfolio is stored */}
        <input className="num" type="number" min="0" max="100" step="1" value={Math.round(pct)} disabled={locked}
          onChange={(e) => onPct(token.id, Math.max(0, Math.min(maxPct, Math.round(Number(e.target.value) || 0))))} />
        <span>%</span>
      </div>
      {!locked && <button className="pt-slot-x" title="Remove" onClick={() => onRemove(token.id)}>✕</button>}
    </div>
  )
}

const SummaryRow = ({ label, value, tone }) => (
  <div className="pt-sumrow"><span>{label}</span><span className={`num ${tone || ''}`}>{value}</span></div>
)

/* ============================ ROOT ============================ */
export default function PickTerminal({ nav }) {
  const app = useApp()
  const d = app.duel
  const [sel, setSel] = useState(() => (d?.you?.picks ? d.you.picks.map((p) => p.tokenId) : []))
  const [alloc, setAlloc] = useState(() => {
    const m = {}; if (d?.you?.picks) d.you.picks.forEach((p) => { m[p.tokenId] = p.pct }); return m
  })
  const [touched, setTouched] = useState(() => !!d?.you?.picks)
  const [selectedId, setSelectedId] = useState(null)
  const [tf, setTf] = useState('15m')
  const [favs, setFavs] = useState(loadFavs)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState(null)

  if (!d || d.phase !== 'picking') return null
  const locked = d.you.locked
  const training = d.training
  const cfg = { mode: d.mode, stake: d.stake, duration: d.duration, training, allowedIds: d.allowedIds, pool: d.battlePool, charts: app.config.charts }

  const maxFor = (id) => { const t = effToken(id); return (!training && t?.category === 'degen') ? 50 : 100 }

  const toggleFav = (id) => setFavs((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); saveFavs(n); return n })

  const setPicks = (nextSel, keepTouched) => {
    setSel(nextSel)
    if (!keepTouched) setAlloc(equalSplit(nextSel))
    else setAlloc((a) => { const m = {}; nextSel.forEach((id) => { m[id] = a[id] ?? 0 }); return m })
  }

  const addToken = (id, add) => {
    if (locked) return
    setError(null)
    if (add) {
      if (sel.includes(id) || sel.length >= 3) return
      if (!tokenAllowed(id, cfg).ok) return
      const next = [...sel, id]
      if (!touched) setPicks(next, false)
      else { setSel(next); setAlloc((a) => ({ ...a, [id]: Math.max(1, Math.min(maxFor(id), 100 - Object.values(a).reduce((x, y) => x + y, 0))) })) }
      setSelectedId(id)
    } else {
      const next = sel.filter((x) => x !== id)
      setPicks(next, touched)
    }
  }

  const setPct = (id, raw) => {
    setTouched(true)
    setError(null)
    setAlloc((a) => allocWith(a, sel, id, raw, maxFor))
  }
  const doEqual = () => { setTouched(false); setAlloc(equalSplit(sel)); setError(null) }
  const doClear = () => { setSel([]); setAlloc({}); setTouched(false); setError(null) }
  const doRandom = () => {
    const cands = allTokens().filter((t) => (!d.battlePool || t.pool === d.battlePool) && tokenAllowed(t.id, cfg).ok)
    const picks = []
    const pool = [...cands]
    for (let k = 0; k < 3 && pool.length; k++) picks.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0].id)
    setSel(picks); setTouched(false); setAlloc(equalSplit(picks)); setSelectedId(picks[0] || null); setError(null)
  }

  const total = sel.reduce((a, id) => a + (alloc[id] || 0), 0)
  const totalRound = Math.round(total)
  // Tournament fee comes off the POT at settlement - a player's share is 1/Nth.
  const feeShare = training ? 0 : d.tourney ? d.fee / Math.max(1, d.tourney.count) : d.fee / 2
  const capital = training ? 100 : d.stake - feeShare
  const feePerPlayer = feeShare

  // Preview of the REAL charge: the same priceImpactFor the server applies to
  // each slice when it builds the basket - what you see here is what you pay.
  const slippage = useMemo(() => {
    if (d.mode !== 'live' || training) return null
    let sPct = SWAP_COST * 100
    const entryNet = capital * (1 - SWAP_COST)
    for (const id of sel) {
      const w = (alloc[id] || 0) / 100
      sPct += w * priceImpactFor(id, entryNet * w) * 100
    }
    return sPct
  }, [sel, alloc, d.mode, training, capital])

  const picks = sel.map((id) => ({ tokenId: id, pct: alloc[id] || 0 }))
  const validationErr = validatePicks(picks, cfg)
  const ready = !validationErr
  const eligibility = sel.length === 0 ? 'Empty' : validationErr ? (totalRound !== 100 ? `${totalRound}% allocated` : 'Check picks') : 'Ready'

  const detailToken = effToken(selectedId) || effToken(sel[0]) || allTokens().find((t) => !d.battlePool || t.pool === d.battlePool)

  const doLock = () => {
    const err = validatePicks(picks, cfg)
    if (err) { setError(err); return }
    setConfirming(true)
  }
  const confirmLock = () => { lockPicks(picks); setConfirming(false) }

  const segments = sel.map((id) => ({ frac: (alloc[id] || 0) / 100, color: effToken(id)?.color || 'var(--you)' }))

  return (
    <div className="pt-root">
      <Header d={d} nav={nav} />
      <div className="pt-body">
        <TokenList cfg={cfg} pool={d.battlePool} favs={favs} toggleFav={toggleFav}
          selectedId={detailToken?.id} onSelect={setSelectedId} onAdd={addToken} sel={sel} tf={tf} />

        <Detail token={detailToken} cfg={cfg} inPortfolio={sel.includes(detailToken?.id)} onAdd={addToken}
          tf={tf} setTf={setTf} />

        <section className="pt-right">
          <div className="pt-picks-head">
            <span>YOUR PICKS - <b className={sel.length === 3 ? 'good' : ''}>{sel.length}/3</b></span>
          </div>

          {locked ? (
            <div className="pt-locked">
              <div className="pt-locked-mark">🔒</div>
              <div className="pt-locked-h">Portfolio locked</div>
              <div className="muted">
                {d.tourney
                  ? `Waiting for the field - ${d.tourney.lockedCount}/${d.tourney.count} locked`
                  : <>Waiting for {d.opp?.name || 'opponent'}…</>}
              </div>
              <div className="pt-locked-rows">
                {picks.map((p, i) => { const t = effToken(p.tokenId); return (
                  <div key={p.tokenId} className="pt-locked-row"><span className="pt-slot-n">{i + 1}</span><TokenLogo token={t} size={26} /><span className="pt-slot-name">{t.ticker}</span><span className="num" style={{ marginLeft: 'auto' }}>{Math.round(p.pct)}%</span></div>
                ) })}
              </div>
            </div>
          ) : (
            <>
              <div className="pt-slots">
                {[0, 1, 2].map((i) => {
                  const id = sel[i]
                  const t = id ? effToken(id) : null
                  const leftover = Math.max(0, 100 - totalRound)
                  return <Slot key={i} n={i + 1} token={t} pct={t ? (alloc[id] || 0) : leftover} maxPct={t ? maxFor(id) : 100}
                    locked={locked} onPct={setPct} onRemove={(rid) => addToken(rid, false)} onSelect={setSelectedId} />
                })}
              </div>

              <div className="pt-quick">
                <button onClick={doEqual} disabled={sel.length < 2}>⇄ Equal Split</button>
                <button onClick={doClear} disabled={!sel.length}>🗑 Clear</button>
                <button onClick={doRandom}>🎲 Random</button>
              </div>

              {error && <div className="pt-err">{error}</div>}

              <div className="pt-summary">
                <div className="pt-summary-rows">
                  <SummaryRow label="Total allocation" value={`${totalRound}%`} tone={totalRound === 100 ? 'good' : 'bad'} />
                  <SummaryRow label={training ? 'Virtual capital' : d.mode === 'live' ? 'Trading capital' : 'Tracked capital'} value={fmtUsd(capital)} />
                  {slippage != null && <SummaryRow label="Est. slippage" value={slippage.toFixed(2) + '%'} />}
                  <SummaryRow label="Selected coins" value={`${sel.length}/3`} />
                  <SummaryRow label="Status" value={eligibility} tone={ready ? 'good' : ''} />
                </div>
                {sel.length > 0 && <Donut segments={segments} />}
              </div>
            </>
          )}

          <div className="pt-battle">
            <div className="pt-battle-h">Battle Summary</div>
            <div className="pt-battle-mode">
              <span className={`pt-arena ${d.mode === 'live' ? 'live' : ''}`}>● {d.tourney ? 'TOURNAMENT' : training ? 'TRAINING' : d.mode === 'live' ? 'LIVE ARENA' : 'CLASSIC ARENA'}</span>
              <span className="pt-vs">{d.tourney ? `1 OF ${d.tourney.count}` : 'VS'}</span>
            </div>
            {d.tourney ? (
              <>
                <SummaryRow label="Entry" value={fmtUsd(d.stake)} />
                <SummaryRow label={`Pot (${d.tourney.count} players)`} value={fmtUsd(d.tourney.money.pot)} />
                <SummaryRow label={`Arena fee (${d.tourney.money.pct}%)`} value={fmtUsd(d.tourney.money.fee)} />
                {d.tourney.payouts.map((p) => (
                  <SummaryRow key={p.place} label={`${p.place === 1 ? '1st' : p.place === 2 ? '2nd' : '3rd'} place`} value={fmtUsd(p.amount)} tone={p.place === 1 ? 'good' : ''} />
                ))}
                <SummaryRow label="Locked in" value={`${d.tourney.lockedCount}/${d.tourney.count}`} tone={d.tourney.lockedCount === d.tourney.count ? 'good' : ''} />
                <p className="pt-battle-note">Everyone starts from the same prices, captured at the bell. Best portfolio return{d.tourney.payouts.length > 1 ? 's take the places' : ' takes the pot'} - ties split the prize. Not locking in time refunds your entry.</p>
              </>
            ) : training ? (
              <>
                <SummaryRow label="Mode" value="Free training" />
                <SummaryRow label="Duration" value={durLabel(d.duration)} />
                <p className="pt-battle-note">Practice run against an arena bot - no stake, no payout. Prices are real.</p>
              </>
            ) : d.mode === 'live' ? (
              <>
                <SummaryRow label="Stake" value={fmtUsd(d.stake)} />
                <SummaryRow label="Platform fee" value={fmtUsd(feePerPlayer)} />
                <SummaryRow label="Trading capital" value={fmtUsd(capital)} />
                <SummaryRow label="Duration" value={durLabel(d.duration)} />
                <SummaryRow label="Prize type" value="Dynamic" />
                <SummaryRow label="Opponent" value={d.opp?.locked ? 'Ready' : 'Picking…'} tone={d.opp?.locked ? 'good' : ''} />
                <p className="pt-battle-note">Your capital buys the selected tokens. The winner receives the final combined value of both portfolios.</p>
              </>
            ) : (
              <>
                <SummaryRow label="Stake" value={fmtUsd(d.stake)} />
                <SummaryRow label="Platform fee" value={fmtUsd(feePerPlayer)} />
                <SummaryRow label="Winner payout" value={fmtUsd(d.prize)} tone="good" />
                <SummaryRow label="Duration" value={durLabel(d.duration)} />
                <SummaryRow label="Prize type" value="Fixed" />
                <SummaryRow label="Opponent" value={d.opp?.locked ? 'Ready' : 'Picking…'} tone={d.opp?.locked ? 'good' : ''} />
                <p className="pt-battle-note">Your tokens are not purchased - their prices are only tracked to decide the winner.</p>
              </>
            )}
          </div>

          {!locked && (
            <div className="pt-lockzone">
              <button className="pt-lock" disabled={!ready} onClick={doLock}>🔒 LOCK PICKS</button>
              <p className="pt-lock-warn">Your picks will be locked and cannot be changed after confirmation.</p>
            </div>
          )}
        </section>
      </div>

      {confirming && (
        <div className="modal-back" onClick={() => setConfirming(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="card-title">Confirm your portfolio</div>
            <div className="pt-confirm-list">
              {picks.map((p, i) => { const t = effToken(p.tokenId); return (
                <div key={p.tokenId} className="pt-confirm-row">
                  <span className="pt-slot-n">{i + 1}</span><TokenLogo token={t} size={30} />
                  <span className="pt-slot-name">{t.ticker} <span className="muted small">{t.name}</span></span>
                  <span className="num" style={{ marginLeft: 'auto', fontWeight: 700 }}>{Math.round(p.pct)}%</span>
                </div>
              ) })}
            </div>
            <div className="pt-confirm-sum">
              {!training && <SummaryRow label={d.tourney ? 'Entry' : 'Stake'} value={fmtUsd(d.stake)} />}
              {!training && !d.tourney && <SummaryRow label="Platform fee" value={fmtUsd(feePerPlayer)} />}
              {d.mode === 'live' && !training && <SummaryRow label="Trading capital" value={fmtUsd(capital)} />}
              {d.mode === 'classic' && !training && !d.tourney && <SummaryRow label="Winner payout" value={fmtUsd(d.prize)} tone="good" />}
              {d.tourney && <SummaryRow label={`Pot · ${d.tourney.count} players`} value={fmtUsd(d.tourney.money.pot)} />}
              {d.tourney && <SummaryRow label="1st place" value={fmtUsd(d.prize)} tone="good" />}
              <SummaryRow label="Duration" value={durLabel(d.duration)} />
            </div>
            <p className="pt-lock-warn" style={{ marginTop: 4 }}>Once locked, your picks are final - they cannot be changed for the rest of this battle.</p>
            <div className="pt-confirm-btns">
              <button className="pt-lock" onClick={confirmLock}>🔒 CONFIRM &amp; LOCK PORTFOLIO</button>
              <button className="btn btn-ghost" onClick={() => setConfirming(false)}>Back</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
