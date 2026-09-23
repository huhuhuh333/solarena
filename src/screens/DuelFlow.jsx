import React, { useEffect, useRef, useState } from 'react'
import { useApp, effToken, allTokens } from '../engine/store'
import { duelCancel, leaveDuelLocal, lockPicks, queueJoin, queueOfferReply, trainingStart } from '../engine/net'
import { tokenAllowed, validatePicks, SWAP_COST, feeFor } from '../engine/duel'
import { poolLabel } from '../engine/tokens'
import { fmtUsd, fmtClock, fmtPct, fmtPrice, durLabel } from '../engine/format'
import { TokenLogo, CatBadge, Pct, LeadBar, Avatar, PortfolioRows, LivePrice, LiveDay } from '../components/ui'
import { TokenInfoModal } from '../components/tokeninfo'
import { fmtCompact } from '../engine/format'
import { drawShareCard, shareText, downloadCanvas } from '../components/sharecard'
import { TourneyLive, TourneyResult } from './Tournaments'

/* ---------------- searching ---------------- */
// Nobody at your number. Rather than let the wait run forever, the arena names
// the nearest smaller table - always smaller, so the answer can only ever
// reduce what you have at risk.
const StakeOffer = ({ offer }) => (
  <div className="card" style={{ marginTop: 22, textAlign: 'left', maxWidth: 460 }}>
    <div className="card-title">Take a smaller table?</div>
    <p className="small" style={{ margin: '6px 0 12px' }}>{offer.text}</p>
    <div className="vs-row">
      <button className="btn btn-gold" style={{ flex: 1 }} onClick={() => queueOfferReply(true)}>
        Fight for {fmtUsd(offer.theirStake)}
      </button>
      <button className="btn" onClick={() => queueOfferReply(false)}>Keep waiting</button>
    </div>
    <p className="small muted" style={{ marginTop: 8 }}>
      {fmtUsd(offer.yourStake - offer.theirStake)} goes straight back to your balance. Decline and you stay
      in the queue at {fmtUsd(offer.yourStake)}.
    </p>
  </div>
)

// How long they have been standing here. Counted locally from mount because
// the queue stub carries no join time - and it only ever needs to be right to
// the second, not to the server's clock.
const useElapsed = () => {
  const [secs, setSecs] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setSecs((s) => s + 1), 1000)
    return () => clearInterval(t)
  }, [])
  return secs
}

// The wait, made to look like something rather than nothing.
//
// The old version was an emoji in a ring on an empty page, and the terms of
// the battle they had just PAID for were one line of grey text. Now the ticket
// is the page: the sweep says the arena is looking, the ticket says exactly
// what was bought, and the clock says how long it has taken. Everything on it
// is real - the prize comes from the live fee config, not from a guess.
// Round money loses its cents here: "$100" is what a player would say, and
// "$100.00" reads like a receipt for something that hasn't happened yet.
const money = (n) => (n % 1 === 0 ? '$' + n.toLocaleString('en-US') : fmtUsd(n))

const Searching = ({ d, offer, user }) => {
  const secs = useElapsed()
  const priced = !d.training && d.mode === 'classic'
  const rows = [
    ['Entry', d.training ? 'Free' : money(d.stake)],
    ['Mode', d.training ? 'Training' : d.mode === 'live' ? 'Live Arena' : 'Classic'],
    ['Clock', durLabel(d.duration)],
    ['Battlefield', poolLabel(d.battlePool) || '-'],
    // Live pays the winner both portfolios at their market value, so there is
    // no fixed number to promise; saying one would be the lie.
    priced ? ['Winner takes', money(feeFor(d.stake).prize)] : null,
  ].filter(Boolean)

  return (
    <div className="mm">
      <div className="mm-radar" aria-hidden="true">
        <span className="mm-ring" /><span className="mm-ring" /><span className="mm-ring" />
        <span className="mm-sweep" />
        <span className="mm-you">
          <Avatar size={54} tone="you" name={user?.name}>{user?.avatar}</Avatar>
        </span>
      </div>

      <h2 className="mm-title">
        {d.opponentName ? `Waiting for ${d.opponentName}…` : d.training ? 'Setting up your training battle…' : 'Finding your opponent'}
      </h2>
      <p className="mm-sub">
        {d.opponentName
          ? 'They have the link. The battle starts the moment they take it.'
          : d.training
            ? 'No stake, no opponent - the arena takes the other corner.'
            : 'The next player who sits down at this exact table is your opponent.'}
      </p>

      <div className="mm-ticket">
        <div className="mm-ticket-h">Your table</div>
        {rows.map(([k, v]) => (
          <div className="mm-row" key={k}><span>{k}</span><b className={k === 'Winner takes' ? 'gold' : ''}>{v}</b></div>
        ))}
      </div>

      <div className="mm-stats">
        <span className="num">{fmtClock(secs)}<em>searching</em></span>
        {!d.training && <span className="num">{d.playersSearching}<em>in the queue</em></span>}
      </div>

      {offer && <StakeOffer offer={offer} />}

      <button className="btn btn-danger mm-cancel" onClick={duelCancel}>
        Cancel search{!d.training && ' (full refund)'}
      </button>
      {!d.training && <p className="mm-foot">Your {money(d.stake)} is held, not spent. Cancelling returns it in full.</p>}
    </div>
  )
}

/* ---------------- picking ---------------- */
const defaultsFor = (n) => (n === 1 ? [100] : n === 2 ? [60, 40] : [50, 30, 20])

const PickView = ({ d }) => {
  const [sel, setSel] = useState(() => (d.you.picks ? d.you.picks.map((p) => p.tokenId) : []))
  const [alloc, setAlloc] = useState(() => {
    const m = {}
    if (d.you.picks) d.you.picks.forEach((p) => { m[p.tokenId] = p.pct })
    return m
  })
  const [error, setError] = useState(null)
  const [info, setInfo] = useState(null) // tokenId whose GMGN card is open

  const toggle = (id) => {
    setError(null)
    if (sel.includes(id)) {
      const next = sel.filter((x) => x !== id)
      setSel(next)
      setAlloc(Object.fromEntries(next.map((t, i) => [t, defaultsFor(next.length)[i]])))
    } else if (sel.length < 3) {
      const next = [...sel, id]
      setSel(next)
      setAlloc(Object.fromEntries(next.map((t, i) => [t, defaultsFor(next.length)[i]])))
    }
  }

  const total = sel.reduce((a, id) => a + (alloc[id] || 0), 0)
  const locked = d.you.locked
  // rules cfg: the battle category travels as `pool` in the rule engine
  const cfg = { mode: d.mode, stake: d.stake, duration: d.duration, training: d.training, allowedIds: d.allowedIds, pool: d.battlePool }

  const lockIn = () => {
    const picks = sel.map((tokenId) => ({ tokenId, pct: alloc[tokenId] || 0 }))
    const err = validatePicks(picks, cfg)
    if (err) { setError(err); return }
    lockPicks(picks) // the server re-validates; a rejection comes back as d.banner
  }

  return (
    <>
      <div className="section-head" style={{ marginTop: 20 }}>
        <div>
          <div className="eyebrow">
            {d.training ? 'Free battle' : `$${d.stake} ${d.mode} battle`} · {durLabel(d.duration)}
            {poolLabel(d.battlePool) && <> · {poolLabel(d.battlePool)}</>}
          </div>
          <h2 className="section-title">Build your portfolio</h2>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className={`pick-timer ${d.pickLeft <= 15 ? 'hurry' : ''}`}>{fmtClock(d.pickLeft)}</div>
          <div className="small muted">to lock in</div>
        </div>
      </div>

      {d.banner && <div className="notice notice-danger" style={{ marginBottom: 14 }}>{d.banner}</div>}

      <div className="pick-layout">
        <div>
          <div className="pick-grid">
            {allTokens().filter((t) => !d.battlePool || t.pool === d.battlePool).map((t) => {
              const allowed = tokenAllowed(t.id, cfg)
              const isSel = sel.includes(t.id)
              return (
                <div key={t.id} role="button" tabIndex={0}
                  className={`pick-tok ${isSel ? 'sel' : ''} ${!allowed.ok ? 'blocked' : ''} ${locked ? 'locked' : ''}`}
                  onClick={() => { if (allowed.ok && !locked) toggle(t.id) }}
                  onKeyDown={(e) => { if (e.key === 'Enter' && allowed.ok && !locked) toggle(t.id) }}>
                  <span className="pick-tok-head">
                    <TokenLogo token={t} size={28} />
                    <span style={{ fontWeight: 700 }}>{t.ticker}</span>
                    <button className="pick-info" title={`${t.ticker} - chart, socials, stats`}
                      onClick={(e) => { e.stopPropagation(); setInfo(t.id) }}>ⓘ</button>
                    {isSel && <span style={{ color: 'var(--you)' }}>✓</span>}
                  </span>
                  <div className="pick-tok-price">
                    <span className="num small"><LivePrice id={t.id} /></span>
                    <LiveDay id={t.id} />
                  </div>
                  <div className="pick-tok-meta small muted">
                    {t.marketCap ? <>MC {fmtCompact(t.marketCap)} · </> : null}liq {fmtCompact(t.liquidity)}
                  </div>
                  <CatBadge cat={t.category} small />
                  {!allowed.ok && <div className="why">{allowed.why}</div>}
                </div>
              )
            })}
          </div>
          <p className="small muted" style={{ marginTop: 10 }}>
            Pick exactly 3 coins, then split your stake between them.
            Degen Approved coins can carry at most 50% of a portfolio and need battles of 15 minutes or longer.
          </p>
        </div>

        <div>
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="card-title">Your allocation {sel.length}/3</div>
            {sel.length === 0 && <p className="small muted">Select tokens from the grid to start.</p>}
            {sel.map((id) => {
              const t = effToken(id)
              return (
                <div key={id} className="alloc-row">
                  <TokenLogo token={t} size={28} />
                  <span style={{ fontWeight: 700 }}>{t.ticker}</span>
                  <input type="range" min="5" max="90" step="5" disabled={locked}
                    value={alloc[id] || 0}
                    onChange={(e) => { setError(null); setAlloc({ ...alloc, [id]: +e.target.value }) }} />
                  <span className="alloc-pct">{alloc[id] || 0}%</span>
                </div>
              )
            })}
            {sel.length > 0 && (
              <div className="alloc-total">
                <span>Total</span>
                <span className={`num ${total === 100 ? 'good' : 'bad'}`}>{total}%</span>
              </div>
            )}
            {error && <div className="notice notice-danger" style={{ marginTop: 8 }}>{error}</div>}
            {!locked
              ? <button className="btn btn-you btn-block btn-lg" style={{ marginTop: 12 }} disabled={sel.length !== 3 || total !== 100} onClick={lockIn}>
                  Lock in portfolio
                </button>
              : <div className="notice" style={{ marginTop: 12 }}>✔ Locked in. Waiting for your opponent…</div>}
          </div>

          <div className="card">
            <div className="vs-row" style={{ marginBottom: 10 }}>
              <Avatar tone="opp" size={34} name={d.opp.name}>{d.opp.avatar}</Avatar>
              <div style={{ flex: 1 }}>
                <div className="vs-name">{d.opp.name}</div>
                <div className="small muted">{d.opp.record}</div>
              </div>
              {d.opp.locked
                ? <span className="cat-badge cat-verified sm">Locked in</span>
                : <span className="cat-badge cat-degen sm">Picking…</span>}
            </div>
            <PortfolioRows hidden tokens={effToken} picks={[]} />
            <p className="small muted" style={{ marginTop: 8 }}>Picks stay hidden until both players lock in - no copying. They're stored on the server, not in anyone's browser.</p>
          </div>

          <button className="btn btn-danger btn-block" style={{ marginTop: 14 }} onClick={duelCancel}>
            Cancel battle{!d.training && ' (full refund for both)'}
          </button>
        </div>
      </div>
      {info && <TokenInfoModal token={effToken(info)} onClose={() => setInfo(null)} />}
    </>
  )
}

/* ---------------- pre-live checks ---------------- */
const CHECK_ITEMS = ['Can buy', 'Can sell', 'Liquidity above floor', 'Slippage within limit', 'Taxes unchanged', 'Contract functions safe']
const Checking = ({ d }) => (
  <div style={{ maxWidth: 560, margin: '40px auto' }}>
    <div className="eyebrow">Live Arena · pre-battle verification</div>
    <h2 className="section-title" style={{ marginBottom: 14 }}>Re-checking every token…</h2>
    <div className="card">
      {(d.checks || []).map((c) => {
        const t = effToken(c.tokenId)
        return (
          <div key={c.tokenId} className="check-row">
            <TokenLogo token={t} size={26} />
            <span style={{ fontWeight: 700 }}>{t.ticker}</span>
            <span className="small muted">{CHECK_ITEMS.join(' · ')}</span>
            <span className="check-status">
              {c.status === 'pending' ? <span className="muted">checking…</span>
                : c.status === 'pass' ? <span className="up">PASS</span>
                : <span className="down">FAIL</span>}
            </span>
          </div>
        )
      })}
    </div>
    <p className="small muted" style={{ marginTop: 10 }}>
      If any token fails, the battle will not start - you'll replace it or get a full refund.
    </p>
  </div>
)

/* ---------------- live battle ---------------- */
// The live screen is a RACE. Everything on it exists to answer two questions
// at a glance - who is ahead, and by how much is it changing - and to make the
// answer feel like something is happening: the race chart draws both
// portfolios' paths as they fight, returns tick with a flash when they move,
// the gap is written in plain points, and the clock turns hostile at the end.

// One polyline per player, accumulated client-side from the per-second ticks.
// The x-axis covers time ELAPSED, not the whole battle - a chart scaled to the
// full five minutes spends its first minute as two dots in a corner. This way
// the lines always fill the pane and the race reads from the first seconds.
const RaceChart = ({ series }) => {
  const W = 1000, H = 230, PAD = 6
  if (series.length < 2) {
    return <div className="race-wait small muted">Charting the race - first prints incoming…</div>
  }
  let span = 0.4
  for (const s of series) span = Math.max(span, Math.abs(s.y), Math.abs(s.o))
  span *= 1.15
  const t0 = series[0].r
  const tEnd = series[series.length - 1].r
  const window = Math.max(t0 - tEnd, 20) // never a zero-width axis in the first ticks
  const x = (t) => PAD + ((t0 - t) / window) * (W - PAD * 2)
  const y = (v) => H / 2 - (v / span) * (H / 2 - PAD)
  const path = (key) => series.map((s, i) => `${i ? 'L' : 'M'}${x(s.r).toFixed(1)},${y(s[key]).toFixed(1)}`).join('')
  const last = series[series.length - 1]
  // No end labels: the two numbers already dominate the scoreboard above, and
  // when the race is close the tags sat on top of each other and hid the very
  // thing the chart is for - where the lines are going.
  return (
    <div className="race-box">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="race-svg" aria-hidden="true">
        <line x1={PAD} y1={H / 2} x2={W - PAD} y2={H / 2} className="race-zero" />
        <path d={`${path('o')}`} className="race-line race-opp" />
        <path d={`${path('y')}`} className="race-line race-you" />
        <circle cx={x(last.r)} cy={y(last.o)} r="4" className="race-dot race-opp" />
        <circle cx={x(last.r)} cy={y(last.y)} r="4" className="race-dot race-you" />
      </svg>
      <span className="race-scale num">±{span.toFixed(1)}%</span>
    </div>
  )
}

// A number that FLASHES when it changes - the difference between a scoreboard
// and a screenshot of one.
const TickNum = ({ v, cls = '', children }) => {
  const [flash, setFlash] = useState('')
  const prev = useRef(v)
  useEffect(() => {
    if (v !== prev.current) {
      setFlash(v > prev.current ? 'tick-up' : 'tick-down')
      prev.current = v
      const t = setTimeout(() => setFlash(''), 450)
      return () => clearTimeout(t)
    }
    return undefined
  }, [v])
  return <span className={`${cls} ${flash}`}>{children}</span>
}

const FighterTokens = ({ picks, startPrices, prices, tone }) => (
  <div className="ft-rows">
    {picks.map((p) => {
      const t = effToken(p.tokenId)
      const now = prices[p.tokenId] ?? startPrices[p.tokenId]
      const ret = ((now - startPrices[p.tokenId]) / startPrices[p.tokenId]) * 100
      return (
        <div key={p.tokenId} className="ft-row">
          <TokenLogo token={t} size={30} />
          <span className="ft-name">
            <b>{t?.ticker ?? p.tokenId}</b>
            <span className="ft-wbar"><i style={{ width: `${p.pct}%`, background: tone }} /></span>
          </span>
          <span className="ft-pct num muted">{p.pct}%</span>
          <span className="num small muted"><TickNum v={now}>{fmtPrice(now)}</TickNum></span>
          <TickNum v={ret} cls="ft-ret"><Pct v={ret} /></TickNum>
        </div>
      )
    })}
  </div>
)

const LiveView = ({ d, user }) => {
  const live = d.live || { remaining: d.remaining ?? d.duration, prices: d.startPrices, retYou: 0, retOpp: 0 }
  const you = live.retYou, opp = live.retOpp
  const youLeads = you >= opp
  const gap = Math.abs(you - opp)
  const entry = d.training ? 100 : d.mode === 'live' ? (d.stake - d.fee / 2) * (1 - SWAP_COST) : d.stake
  const valYou = entry * (1 + you / 100)
  const valOpp = entry * (1 + opp / 100)
  const closing = live.remaining <= 30

  // The race so far: one point per server tick (plus per-trade points when a
  // tick carries them). Lives across renders, dies with the battle id.
  const seriesRef = useRef({ id: null, pts: [], microAt: 0 })
  useEffect(() => {
    const s = seriesRef.current
    if (s.id !== d.id) { s.id = d.id; s.pts = []; s.microAt = 0 }
    // Trades first, in the order they happened, each placed at its own moment
    // inside the second that is closing. `r` counts DOWN, so a trade 400ms ago
    // sits at remaining + 0.4 - just before the tick's own point.
    if (live.micro && live.at !== s.microAt) {
      s.microAt = live.at
      for (const [msAgo, y, o] of live.micro) {
        s.pts.push({ r: live.remaining + msAgo / 1000, y, o, trade: true })
      }
      s.pts.sort((a, b) => b.r - a.r)
      if (s.pts.length > 4000) s.pts.splice(0, s.pts.length - 4000)
    }
    const lastPt = s.pts[s.pts.length - 1]
    if (lastPt && lastPt.r === live.remaining) {
      // Same second, fresher numbers. The clock now ticks locally between
      // server messages, so a point gets stamped the instant the second
      // changes - before that second's returns arrive. Leaving it alone froze
      // the chart's end label one update behind the headline (the chart said
      // −1.79% while the scoreboard said −1.59%). Overwrite in place so the
      // line always ends exactly where the big number says it does.
      lastPt.y = you
      lastPt.o = opp
    } else {
      s.pts.push({ r: live.remaining, y: you, o: opp })
      if (s.pts.length > 4000) s.pts.shift()
    }
  }, [d.id, live.remaining, live.at, you, opp])

  return (
    <div className="duel2">
      {/* scoreboard: you - clock - them */}
      <div className="duel2-top">
        <div className={`fighter fighter-you ${youLeads ? 'lead' : ''}`}>
          <div className="fighter-id">
            <Avatar tone="you" size={52} name={user.name}>{user.avatar}</Avatar>
            <div>
              <div className="fighter-name">{user.name} <span className="small muted">(you)</span></div>
              <div className="fighter-val num small muted">{d.mode === 'classic' || d.training ? 'virtual' : 'portfolio'} {fmtUsd(valYou)}</div>
            </div>
          </div>
          <TickNum v={you} cls={`fighter-ret ${you >= 0 ? 'up' : 'down'}`}>{fmtPct(you)}</TickNum>
          {youLeads && <span className="lead-chip lead-you">LEADING</span>}
        </div>

        <div className={`duel2-mid ${closing ? 'closing' : ''}`}>
          {/* At zero the battle is decided - the server prices it at exactly
              this moment and ignores anything after. Saying SETTLING rather
              than holding a frozen 0:00 is the honest reading: the numbers
              above are final, the payout is one round trip away. */}
          {live.remaining <= 0
            ? <div className="duel2-clock duel2-settling">SETTLING</div>
            : <div className={`duel2-clock num ${closing ? 'clock-hot' : ''}`}>{fmtClock(live.remaining)}</div>}
          {/* "pp" meant percentage points and meant nothing to anyone reading
              it mid-battle. The gap is a difference between two percentages,
              so say it the way a player would: ahead by 1.82%. */}
          <div className="duel2-gap">
            <span className="small muted">{youLeads ? "you're ahead by" : `${d.opp.name} is ahead by`}</span>
            <b className={`num ${youLeads ? 'up' : 'down'}`}>{gap < 0.005 ? 'dead even' : `${gap.toFixed(2)}%`}</b>
          </div>
          <div className="duel2-stakes small muted">
            <span className={`mode-pill mode-${d.training ? 'training' : d.mode}`}>{d.training ? 'training' : d.mode}</span>
            {!d.training && <> · {d.mode === 'classic' ? <>prize {fmtUsd(d.prize)}</> : <>pool {fmtUsd(valYou + valOpp)}</>}</>}
          </div>
        </div>

        <div className={`fighter fighter-opp ${!youLeads ? 'lead' : ''}`}>
          <div className="fighter-id">
            <Avatar tone="opp" size={52} name={d.opp.name}>{d.opp.avatar}</Avatar>
            <div>
              <div className="fighter-name">{d.opp.name}</div>
              <div className="fighter-val num small muted">{d.mode === 'classic' || d.training ? 'virtual' : 'portfolio'} {fmtUsd(valOpp)}</div>
            </div>
          </div>
          <TickNum v={opp} cls={`fighter-ret ${opp >= 0 ? 'up' : 'down'}`}>{fmtPct(opp)}</TickNum>
          {!youLeads && <span className="lead-chip lead-opp">LEADING</span>}
        </div>
      </div>

      {/* the race itself */}
      <RaceChart series={seriesRef.current.pts} />

      {/* the two lineups, moving */}
      <div className="duel2-lineups">
        <div className={`lineup lineup-you ${youLeads ? 'lead' : ''}`}>
          <FighterTokens picks={d.you.picks} startPrices={d.startPrices} prices={live.prices} tone="var(--you)" />
        </div>
        <div className={`lineup lineup-opp ${!youLeads ? 'lead' : ''}`}>
          <FighterTokens picks={d.opp.picks} startPrices={d.startPrices} prices={live.prices} tone="var(--opp)" />
        </div>
      </div>

      <div className="beam-strip">
        <span className="beam-side beam-you">{user.name}</span>
        <LeadBar you={you} opp={opp} large />
        <span className="beam-side beam-opp">{d.opp.name}</span>
      </div>

      <p className="small muted" style={{ textAlign: 'center', marginTop: 14 }}>
        Settlement uses a time-weighted average price on the server, not a single last trade - last-second manipulation doesn't pay.
        You can close this tab: the battle keeps running on the server.
      </p>
    </div>
  )
}

/* ---------------- result ---------------- */
const ShareModal = ({ match, userName, onClose }) => {
  const ref = useRef(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => { if (ref.current) drawShareCard(ref.current, match, userName) }, [match, userName])
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="card-title">Share your battle</div>
        <canvas ref={ref} className="share-canvas" />
        <div style={{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
          <button className="btn btn-gold" onClick={() => downloadCanvas(ref.current, `solarena-${match.id}.png`)}>Download image</button>
          <button className="btn" onClick={() => { navigator.clipboard?.writeText(shareText(match, userName)); setCopied(true) }}>
            {copied ? 'Copied ✓' : 'Copy text for X / Telegram'}
          </button>
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

export const ResultView = ({ match, user, nav, onRematch }) => {
  const [share, setShare] = useState(false)
  const m = match
  const TokTable = ({ rows, title, tone }) => (
    <div className="card">
      <div className="card-title" style={{ color: tone }}>{title}</div>
      <table className="table">
        <thead><tr><th>Token</th><th>Alloc</th><th>Start</th><th>End</th><th>Result</th></tr></thead>
        <tbody>
          {rows.map((p) => {
            const t = effToken(p.tokenId)
            return (
              <tr key={p.tokenId}>
                <td style={{ fontWeight: 700 }}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>{t && <TokenLogo token={t} size={22} />} {t?.ticker ?? p.tokenId}</span></td>
                <td className="num">{p.pct}%</td>
                <td className="num">{fmtPrice(p.start)}</td>
                <td className="num">{fmtPrice(p.end)}</td>
                <td><Pct v={p.ret} /></td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )

  return (
    <>
      <div className={`result-hero result-${m.outcome}`}>
        <div className="eyebrow">
          {m.training ? 'Training' : `$${m.stake}`} {m.mode} battle
          {poolLabel(m.battlePool) && <> · {poolLabel(m.battlePool)}</>} · vs {m.opp.name}
        </div>
        <div className="display">{m.outcome === 'win' ? 'Victory' : m.outcome === 'draw' ? 'Draw' : 'Defeat'}</div>
        <div className="vs-row" style={{ justifyContent: 'center', gap: 24, marginTop: 10 }}>
          <span><b>{user.name}</b> <Pct v={m.retYou} /></span>
          <span className="vs-mid">VS</span>
          <span><b>{m.opp.name}</b> <Pct v={m.retOpp} /></span>
        </div>
        {m.payout > 0 && <div className="result-payout gold">{m.outcome === 'draw' ? '' : '+'}{fmtUsd(m.payout)}</div>}
        <div className="small muted" style={{ marginTop: 4 }}>{m.payoutNote}{!m.training && <> · SolArena fee {m.outcome === 'draw' && m.mode === 'classic' ? 'waived' : fmtUsd(m.fee)}</>}</div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 20, flexWrap: 'wrap' }}>
          {onRematch && <button className="btn btn-you btn-lg" onClick={onRematch}>Play again</button>}
          <button className="btn btn-gold btn-lg" onClick={() => setShare(true)}>Share result</button>
          <button className="btn btn-lg" onClick={() => { leaveDuelLocal(); nav('/play') }}>Back to matchmaking</button>
        </div>
      </div>
      <div className="grid2" style={{ marginTop: 10 }}>
        <TokTable rows={m.youTokens} title={`${user.name} - your lineup`} tone="var(--you)" />
        <TokTable rows={m.oppTokens} title={`${m.opp.name} - opponent lineup`} tone="var(--opp)" />
      </div>
      {m.mode === 'live' && !m.training && m.finalYou != null && (
        <div className="notice" style={{ marginTop: 14 }}>
          Final portfolio values after selling back to cash: yours {fmtUsd(m.finalYou)} · opponent {fmtUsd(m.finalOpp)}.
          {m.costYou != null && <> Trading costs (slippage + swap fees): yours {fmtUsd(m.costYou)} · opponent {fmtUsd(m.costOpp)}.</>}
          {' '}Winner receives the combined amount.
        </div>
      )}
      {m.events?.length > 0 && (
        <details className="card timeline" style={{ marginTop: 14 }}>
          <summary>Match timeline · {m.events.length} events</summary>
          {m.events.map((e, i) => (
            <div key={i} className="big-win-row">
              <span className="small muted num" style={{ width: 86 }}>{new Date(e.ts).toLocaleTimeString()}</span>
              <span style={{ flex: 1 }}>{e.msg}</span>
            </div>
          ))}
        </details>
      )}
      {share && <ShareModal match={m} userName={user.name} onClose={() => setShare(false)} />}
    </>
  )
}

/* ---------------- flow root ---------------- */
export default function DuelFlow({ nav }) {
  const app = useApp()
  const d = app.duel

  if (!d) {
    return (
      <div className="mm-wrap">
        <h2 className="display" style={{ fontSize: 34 }}>No active battle</h2>
        <p className="muted" style={{ margin: '10px 0 20px' }}>Set one up and get in the arena.</p>
        <button className="btn btn-gold btn-lg" onClick={() => nav('/play')}>Enter the arena</button>
      </div>
    )
  }

  if (d.phase === 'cancelled') {
    return (
      <div className="mm-wrap">
        <h2 className="display" style={{ fontSize: 34 }}>Battle cancelled</h2>
        <p className="muted" style={{ margin: '10px 0 20px' }}>{d.banner}</p>
        <button className="btn btn-gold btn-lg" onClick={() => { leaveDuelLocal(); nav('/play') }}>Back to the arena</button>
      </div>
    )
  }

  if (d.phase === 'done') {
    if (d.tourney) return <TourneyResult d={d} user={app.user} nav={nav} />
    const match = app.matches.find((m) => m.id === d.id)
    const rematch = () => {
      leaveDuelLocal()
      if (d.training) trainingStart({ duration: d.duration, pool: d.battlePool || undefined })
      // An approved wallet can pay for the rematch even with nothing sitting in
      // the arena balance, so the gate is what is playable, not what is held.
      else if (app.wallet.balance >= d.stake) queueJoin({ mode: d.mode, stake: d.stake, duration: d.duration, pool: d.battlePool })
      else nav('/play')
    }
    return match ? <ResultView match={match} user={app.user} nav={nav} onRematch={rematch} /> : null
  }

  if (d.phase === 'searching') return <Searching d={d} offer={app.queueOffer} user={app.user} />
  if (d.phase === 'picking') return <PickView key={d.id + (d.banner || '')} d={d} />
  if (d.phase === 'checking') return <Checking d={d} />
  if (d.phase === 'live') return d.tourney ? <TourneyLive d={d} user={app.user} /> : <LiveView d={d} user={app.user} />
  return null
}
