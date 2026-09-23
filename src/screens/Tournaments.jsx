// Real multiplayer tournaments: $10 / $50 / $100 standing lobbies, 5-10
// players, one Classic battle, the top of the field takes the pot. All state
// is server-owned - this screen renders the lobby board the server broadcasts,
// and the pick/live/result phases ride the duel flow like any battle.

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useApp, effToken } from '../engine/store'
import { api, tourneyJoin, tourneyLeave, refreshTourneys, leaveDuelLocal } from '../engine/net'
import { poolLabel } from '../engine/tokens'
import { fmtUsd, fmtClock, fmtPrice, durLabel, timeAgo } from '../engine/format'
import { Section, Avatar, TokenLogo, Pct } from '../components/ui'
import { poolMark } from '../engine/marks'

const place = (n) => (n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`)

/* ---------------- lobby card ---------------- */
// A card is a TABLE you sit down at: the buy-in chip, the seats (with a tick
// where the clock starts), and the money - the pool, then a prize LADDER with
// a row per place, so how it pays is never a guess: an unpaid place says
// exactly how many players it takes to open it.
const money = (n) => (n % 1 === 0 ? '$' + n.toLocaleString('en-US') : fmtUsd(n))

// Read once: no browser changes this mid-session, and a media query per frame
// would be the one expensive thing in an otherwise free loop.
const REDUCED_MOTION = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

// The lobby countdown, running on its own clock between server messages.
//
// The server broadcasts once a second, but not on a metronome: the tick rides
// the sim clock, and a stalled event loop makes one message arrive late and
// the next carry two or three seconds at once. A CSS `transition: width 1s`
// can only animate towards the last number it was handed, so the bar drains,
// arrives, and waits - drain, wait, drain, wait.
//
// So the bar keeps its own deadline and moves every frame. The server reading
// is a CORRECTION, not the source: ordinary jitter is eased away so it never
// shows as a jolt, and only a difference too large to be jitter is taken whole
// (a repaid stall, or a countdown that stopped and restarted), because at that
// point the local clock is simply wrong. The digits come off the same clock,
// so they can never disagree with the bar beside them.
const useSmoothCountdown = (left, total) => {
  const barRef = useRef(null)
  const deadline = useRef(performance.now() + left * 1000)
  const [secs, setSecs] = useState(left)
  const paint = (v) => { if (barRef.current && total > 0) barRef.current.style.width = `${Math.min(100, (v / total) * 100)}%` }

  useEffect(() => {
    const target = performance.now() + left * 1000
    deadline.current = Math.abs(target - deadline.current) > 1500
      ? target
      : deadline.current * 0.75 + target * 0.25
    if (REDUCED_MOTION) { setSecs(left); paint(left) }
  }, [left, total])

  useEffect(() => {
    if (REDUCED_MOTION || !(total > 0)) return undefined
    let raf = 0
    const draw = () => {
      const now = Math.max(0, (deadline.current - performance.now()) / 1000)
      paint(now)
      // Same value bails out of the re-render, so this costs one comparison a
      // frame and re-renders only when the displayed second actually changes.
      setSecs((s) => (Math.ceil(now) === s ? s : Math.ceil(now)))
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [total])

  return { secs, barRef }
}

const TierCard = ({ l, user, inAnyLobby }) => {
  const joined = !!user && l.players.some((p) => p.name === user.name)
  const seats = Array.from({ length: l.max }, (_, i) => l.players[i] || null)
  const countdown = l.countdownLeft != null
  const need = Math.max(0, l.min - l.count)
  const { secs, barRef } = useSmoothCountdown(l.countdownLeft ?? 0, l.countdownTotal)
  return (
    <div className={`card ty-card ${joined ? 'ty-joined' : ''}`}>
      <div className="ty-head">
        <span className="ty-chip num" aria-label={`$${l.stake} entry`}>${l.stake}</span>
        <span className="ty-head-txt">
          <span className="ty-head-pool">
            <TokenLogo token={poolMark({ id: l.pool, label: poolLabel(l.pool) })} size={18} />
            {poolLabel(l.pool)}
          </span>
          <span className="ty-head-sub">Classic · {durLabel(l.duration)} · same start prices</span>
        </span>
      </div>

      <div className="ty-seatrow" title={`${l.count}/${l.max} joined - the clock starts at ${l.min}`}>
        {seats.map((p, i) => (
          <React.Fragment key={i}>
            {p
              ? <Avatar size={24} name={p.name}>{p.avatar}</Avatar>
              : <span className={`ty-seat-empty ${i < l.min ? 'req' : ''}`} />}
            {i === l.min - 1 && <span className="ty-seat-gate" aria-hidden="true" />}
          </React.Fragment>
        ))}
        <span className="ty-seatcount num">{l.count}/{l.max}</span>
      </div>

      <div className="ty-status">
        {countdown ? (
          <>
            <span className="ty-count num">⏱ {fmtClock(secs)}</span>
            <span className="small muted">starts with whoever is in</span>
          </>
        ) : (
          <span className="small muted">
            {l.count === 0 ? `Open table - first ${l.min} start the clock` : `${need} more player${need === 1 ? '' : 's'} to start the clock`}
          </span>
        )}
      </div>
      {countdown && l.countdownTotal > 0 && (
        // Width is owned by the frame loop above, not by React. Starting at
        // zero rather than unset matters: an <i> with no width is a block that
        // fills its parent, which would flash a full bar for one frame.
        <div className="ty-drain"><i ref={barRef} style={{ width: 0 }} /></div>
      )}

      <div className="ty-prize">
        <div className="eyebrow">Prize pool at {Math.max(l.count, l.min)} players</div>
        <div className="ty-prize-v">{money(l.money.prizePool)}</div>
        <div className="ty-ladder">
          {[0, 1, 2].map((i) => {
            const paid = l.payouts[i]
            return (
              <div key={i} className={`ty-lrow ${paid ? '' : 'off'}`}>
                <span className="ty-lplace">{place(i + 1)}</span>
                {paid ? (
                  <span className="ty-lamt num">{money(paid.amount)}</span>
                ) : (
                  <span className="ty-lfrom">
                    🔒 Unlocks at {l.placesFrom?.[i] ?? 9} players
                    <span className="ty-lupto"> · wins up to {money(l.payoutsFull[i].amount)}</span>
                  </span>
                )}
              </div>
            )
          })}
        </div>
        {l.count < l.max && (
          <div className="ty-full">Full table ({l.max} players) · {money(l.moneyFull.prizePool)} prize pool</div>
        )}
      </div>

      {joined ? (
        <button className="btn btn-danger btn-block" style={{ marginTop: 14 }} onClick={tourneyLeave}>
          Leave (full refund)
        </button>
      ) : l.blocked ? (
        <>
          <button className="btn btn-block" style={{ marginTop: 14 }} disabled>Table locked</button>
          <p className="small muted" style={{ margin: '8px 0 0' }}>{l.blocked}</p>
        </>
      ) : (
        <button className="btn btn-gold btn-block" style={{ marginTop: 14 }} disabled={inAnyLobby} onClick={() => tourneyJoin(l.tier, l.pool)}>
          Enter for ${l.stake}
        </button>
      )}

      {l.running.length > 0 && (
        <p className="small muted" style={{ margin: '10px 0 0' }}>
          {l.running.length} battle{l.running.length > 1 ? 's' : ''} running now{l.running[0].remaining != null ? ` - ${fmtClock(l.running[0].remaining)} left` : ''}
        </p>
      )}
    </div>
  )
}

/* ---------------- live scoreboard (routed from DuelFlow) ---------------- */
const YourTokens = ({ picks, startPrices, prices }) => (
  <div className="ty-your-toks">
    {picks.map((p) => {
      const t = effToken(p.tokenId)
      const now = prices?.[p.tokenId] ?? startPrices[p.tokenId]
      const ret = ((now - startPrices[p.tokenId]) / startPrices[p.tokenId]) * 100
      return (
        <div key={p.tokenId} className="duel-tok-row">
          <TokenLogo token={t} size={26} />
          <span style={{ fontWeight: 700 }}>{t?.ticker ?? p.tokenId} <span className="muted small">{p.pct}%</span></span>
          <span className="num small muted">{fmtPrice(now)}</span>
          <Pct v={ret} />
        </div>
      )
    })}
  </div>
)

/* ---------------- the race ---------------- */
// A tournament's drama is not a ranking, it's the CROSSINGS - third place
// climbing over second with ninety seconds left. A table can only ever show
// the current order; the chart shows how it got there, which is the thing
// worth watching. One line per player, same idea as the 1v1 race chart, just
// with up to ten runners instead of two.
//
// You are always the arena's purple, and nobody else is: the other nine take
// a palette picked for separation on black, deliberately WITHOUT purple (it
// would pass for your line), red or green - the Return column already paints
// losses red and gains green, and a red line would read as "this player is
// down" rather than "this player is Mila".
const YOU_LINE = '#9945ff'
const RACE_LINES = ['#4dd8ff', '#ffd23f', '#ff6bb5', '#a3e635', '#ff9142', '#5eead4', '#e2e8f0', '#6b8afd', '#d4a373']

// One point per server tick. The x-axis covers time ELAPSED, not the full
// battle, so the lines fill the pane from the first seconds instead of
// crawling out of a corner for a minute.
const TourneyRace = ({ series, names, colorOf, youName, focus }) => {
  const W = 1000, H = 240, PAD = 8
  if (series.length < 2) {
    return <div className="ty-race-wait small muted">Charting the race - first prints incoming…</div>
  }
  let span = 0.4
  for (const s of series) for (const n of names) {
    const v = s.vals[n]
    if (v != null) span = Math.max(span, Math.abs(v))
  }
  span *= 1.15

  const t0 = series[0].r
  const tEnd = series[series.length - 1].r
  // The axis IS the elapsed time, so the race fills the pane from the first
  // seconds. A fixed floor here (the 1v1 uses 20s) leaves four fifths of the
  // panel empty for the opening minute - the emptiest possible version of the
  // most exciting moment. The 3s guard only stops a zero-width axis.
  const window = Math.max(t0 - tEnd, 3)
  const x = (t) => PAD + ((t0 - t) / window) * (W - PAD * 2)
  const y = (v) => H / 2 - (v / span) * (H / 2 - PAD)
  const path = (n) => {
    const pts = series.filter((s) => s.vals[n] != null)
    return pts.map((s, i) => `${i ? 'L' : 'M'}${x(s.r).toFixed(1)},${y(s.vals[n]).toFixed(1)}`).join('')
  }
  const last = series[series.length - 1]
  // Draw order is z-order: your line on top of the pack, and whatever is being
  // pointed at on top of everything.
  const weight = (n) => (n === focus ? 2 : n === youName ? 1 : 0)
  const order = [...names].sort((a, b) => weight(a) - weight(b))

  return (
    <div className={`ty-race ${focus ? 'focused' : ''}`}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="ty-race-svg" aria-hidden="true">
        <line x1={PAD} y1={H / 2} x2={W - PAD} y2={H / 2} className="ty-race-zero" />
        {order.map((n) => (
          <path key={n} d={path(n)}
            className={`ty-race-line ${n === youName ? 'you' : ''} ${focus === n ? 'on' : ''}`}
            style={{ stroke: colorOf(n) }} />
        ))}
        {order.map((n) => last.vals[n] == null ? null : (
          <circle key={n} cx={x(last.r)} cy={y(last.vals[n])} r={n === youName || n === focus ? 4.5 : 3.2}
            className={`ty-race-dot ${n === youName ? 'you' : ''} ${focus === n ? 'on' : ''}`} style={{ fill: colorOf(n) }} />
        ))}
      </svg>
      <span className="ty-race-scale num">±{span.toFixed(1)}%</span>
    </div>
  )
}

export const TourneyLive = ({ d, user }) => {
  const ty = d.tourney
  const live = d.live || { remaining: d.remaining ?? d.duration, prices: d.startPrices, rows: null }
  const rows = (live.rows || ty.players.map((p) => ({ name: p.name, avatar: p.avatar, ret: 0 })))
    .slice().sort((a, b) => b.ret - a.ret)
  const paying = ty.payouts.length
  const picksByName = new Map(ty.players.map((p) => [p.name, p.picks]))

  // Colour is assigned from the SERVER's player order, not the standings - a
  // player who slips from 2nd to 5th has to keep their line, or the chart
  // becomes a lie the moment anyone overtakes anyone.
  const roster = ty.players.map((p) => p.name)
  const youName = ty.players.find((p) => p.you)?.name ?? user?.name
  const colors = useMemo(() => {
    const m = new Map()
    let k = 0
    for (const p of ty.players) m.set(p.name, p.name === youName ? YOU_LINE : RACE_LINES[k++ % RACE_LINES.length])
    return m
  }, [roster.join('|'), youName])
  const colorOf = (n) => colors.get(n) || 'var(--muted)'

  // The race so far, accumulated client-side from the per-second ticks. Lives
  // across renders, dies with the tournament id. Unlike a 1v1 there is no
  // per-trade lane here - the server's tournament tick carries one reading a
  // second for the whole field - so this is exactly as granular as the ticks.
  const seriesRef = useRef({ id: null, pts: [] })
  if (seriesRef.current.id !== d.id) seriesRef.current = { id: d.id, pts: [] }

  // The newest reading is folded in during RENDER, not in an effect. An effect
  // runs after paint, which would leave the line ending one second behind the
  // number in the table beside it - the 1v1 hides that with a local clock that
  // stamps the point early, and a tournament tick has no such lane. Cheap:
  // one array copy of a few hundred points, once a second.
  const drawn = useMemo(() => {
    const pts = seriesRef.current.pts
    if (!live.rows) return pts
    const vals = {}
    for (const r of live.rows) vals[r.name] = r.ret
    const tail = pts[pts.length - 1]
    // Same second, fresher numbers - replace rather than stack two points on
    // one x, which draws as a vertical spike.
    const next = tail && tail.r === live.remaining
      ? [...pts.slice(0, -1), { r: live.remaining, vals }]
      : [...pts, { r: live.remaining, vals }]
    return next.length > 2000 ? next.slice(next.length - 2000) : next
  }, [d.id, live.remaining, live.rows])

  // …and committed after it, so the next tick builds on this one.
  useEffect(() => { seriesRef.current.pts = drawn }, [drawn])

  // Ten lines in one pane is genuinely tangled - that IS what ten portfolios
  // look like. Pointing at a row lifts that player's line out of the pack and
  // pushes the rest back, which is cheaper than any amount of chart chrome.
  const [focus, setFocus] = useState(null)

  return (
    <>
      <div className="section-head" style={{ marginTop: 20 }}>
        <div>
          <div className="eyebrow">${d.stake} tournament · {ty.count} players · {poolLabel(d.battlePool)}</div>
          <h2 className="section-title">{fmtUsd(ty.money.pot)} pot</h2>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="duel-clock">{fmtClock(live.remaining)}</div>
          <div className="small muted">time left</div>
        </div>
      </div>

      <TourneyRace series={drawn} names={roster} colorOf={colorOf} youName={youName} focus={focus} />

      <div className="card" style={{ padding: '4px 8px', marginTop: 12 }}>
        <table className="table ty-board">
          <thead><tr><th style={{ width: 40 }}>#</th><th>Player</th><th>Portfolio</th><th style={{ textAlign: 'right' }}>Return</th><th style={{ textAlign: 'right' }}>Pays</th></tr></thead>
          <tbody>
            {rows.map((r, i) => {
              const you = user && r.name === user.name
              const picks = picksByName.get(r.name) || []
              return (
                <tr key={r.name} className={`ty-row-live ${you ? 'ty-row-you' : ''} ${focus === r.name ? 'on' : ''}`}
                  onMouseEnter={() => setFocus(r.name)} onMouseLeave={() => setFocus(null)}>
                  <td className={`num ${i === 0 ? 'rank-1' : ''}`}>{i + 1}</td>
                  <td style={{ fontWeight: 700 }}>
                    {/* A piece of that player's line, so the chart needs no
                        separate legend to be readable. */}
                    <span className="who">
                      <i className="ty-swatch" style={{ background: colorOf(r.name) }} aria-hidden="true" />
                      <Avatar size={26} name={r.name}>{r.avatar}</Avatar> {r.name}{you && ' (you)'}
                    </span>
                  </td>
                  <td>
                    <span className="ty-mini-toks">
                      {picks.map((p) => { const t = effToken(p.tokenId); return <span key={p.tokenId} title={`${t?.ticker ?? p.tokenId} ${p.pct}%`}><TokenLogo token={t} size={20} /></span> })}
                    </span>
                  </td>
                  <td style={{ textAlign: 'right' }}><Pct v={r.ret} /></td>
                  <td className="num small muted" style={{ textAlign: 'right' }}>{i < paying ? fmtUsd(ty.payouts[i].amount) : '-'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="grid2" style={{ marginTop: 14 }}>
        <div className="card">
          <div className="card-title">Your portfolio</div>
          <YourTokens picks={d.you.picks} startPrices={d.startPrices} prices={live.prices} />
        </div>
        <div className="card">
          <div className="card-title">How it pays</div>
          {ty.payouts.map((p) => (
            <div key={p.place} className="pt-sumrow"><span>{place(p.place)} place</span><span className="num gold">{fmtUsd(p.amount)}</span></div>
          ))}
          <div className="pt-sumrow"><span>Arena fee ({ty.money.pct}%)</span><span className="num">{fmtUsd(ty.money.fee)}</span></div>
          <p className="small muted" style={{ marginTop: 8 }}>
            Settlement uses a time-weighted average price on the server - last-second manipulation doesn't pay.
            Finishing within 0.05pp of the next player splits the combined prize. You can close this tab: the battle keeps running.
          </p>
        </div>
      </div>
    </>
  )
}

/* ---------------- result standings (routed from DuelFlow) ---------------- */
export const TourneyResult = ({ d, user, nav }) => {
  const r = d.result
  const ty = d.tourney
  return (
    <>
      <div className={`result-hero result-${r.outcome === 'win' ? 'win' : 'loss'}`}>
        <div className="eyebrow">${d.stake} tournament · {ty.count} players · {fmtUsd(r.pot)} pot</div>
        <div className="display">{r.prize > 0 ? `${place(r.rank)} place` : `${place(r.rank)} of ${ty.count}`}</div>
        {r.prize > 0
          ? <div className="result-payout gold">+{fmtUsd(r.prize)}</div>
          : <div className="muted" style={{ marginTop: 6 }}>Out of the prizes this time - your return: <Pct v={r.ret} /></div>}
        <div className="small muted" style={{ marginTop: 4 }}>Arena fee {fmtUsd(r.fee)} ({r.feePct}%) · prize pool {fmtUsd(r.prizePool)}</div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 20, flexWrap: 'wrap' }}>
          <button className="btn btn-you btn-lg" onClick={() => { leaveDuelLocal(); nav('/tournaments') }}>Back to tournaments</button>
          <button className="btn btn-lg" onClick={() => { leaveDuelLocal(); nav('/play') }}>To the arena</button>
        </div>
      </div>

      <div className="card" style={{ marginTop: 10, padding: '4px 8px' }}>
        <table className="table ty-board">
          <thead><tr><th style={{ width: 40 }}>#</th><th>Player</th><th style={{ textAlign: 'right' }}>Return</th><th style={{ textAlign: 'right' }}>Prize</th></tr></thead>
          <tbody>
            {r.standings.map((p) => (
              <tr key={p.name} className={p.you ? 'ty-row-you' : ''}>
                <td className={`num ${p.rank === 1 ? 'rank-1' : ''}`}>{p.rank}</td>
                <td style={{ fontWeight: 700 }}>
                  <span className="who"><Avatar size={26} name={p.name}>{p.avatar}</Avatar> {p.name}{p.you && ' (you)'}</span>
                </td>
                <td style={{ textAlign: 'right' }}><Pct v={p.ret} /></td>
                <td className="num gold" style={{ textAlign: 'right' }}>{p.prize > 0 ? fmtUsd(p.prize) : '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

/* ============ dev-only mock preview (never runs in production) ============
   Fills "Recent tournaments" with invented settlements so the layout can be
   judged before the arena has real history. Gated on import.meta.env.DEV AND
   an explicit ?mocktourneys=1 query param, so a prod build can never show it
   and a stray query string on the live site can't trigger it either.
   Deterministic: random numbers would reshuffle the table on every render. */
const MOCK_PREVIEW_ENABLED = import.meta.env.DEV
const MOCK_AT = Date.now() // stamped once, so timestamps don't crawl per render

// rows are [name, return %, prize, rank?] in finishing order - rank defaults to
// position, and is passed explicitly only for a shared place. Pots and fees are
// the real numbers the fee bands produce for that field size, so the money on
// screen is exactly what a real settlement of this shape would pay.
const mockTourney = (minsAgo, stake, pot, fee, rows) => ({
  id: `mock-${stake}-${minsAgo}`, ts: MOCK_AT - minsAgo * 60000,
  tier: `t${stake}`, stake, pot, fee,
  standings: rows.map(([name, ret, prize, rank], i) => ({ name, avatar: null, ret, prize, rank: rank ?? i + 1 })),
})

const MOCK_RECENT = [
  mockTourney(4, 100, 1000, 50, [
    ['VaultQueen', 6.42, 475], ['ShadowByte', 4.18, 285], ['PixelHawk', 3.05, 190], ['NeonWolf', 1.87, 0],
    ['CryptoFox', 0.94, 0], ['IronMask', 0.11, 0], ['GhostRunner', -0.83, 0], ['ZeroChill', -1.55, 0],
    ['MoonPatrol', -2.90, 0], ['BagFumbler', -4.36, 0],
  ]),
  mockTourney(11, 10, 100, 8, [
    ['NeonWolf', 5.21, 46], ['RugSurvivor', 3.77, 27.6], ['DegenDuchess', 2.44, 18.4], ['ShadowByte', 1.02, 0],
    ['SilentQuant', 0.55, 0], ['AlphaLeak', -0.12, 0], ['MoonPatrol', -0.98, 0], ['ZeroChill', -1.74, 0],
    ['ExitLiquidity', -3.21, 0], ['BagFumbler', -5.08, 0],
  ]),
  mockTourney(19, 50, 400, 24, [
    ['GhostRunner', 7.88, 263.2], ['PixelHawk', 5.02, 112.8], ['CryptoFox', 2.19, 0], ['IronMask', 0.76, 0],
    ['VaultQueen', -0.34, 0], ['SilentQuant', -1.61, 0], ['AlphaLeak', -2.87, 0], ['ExitLiquidity', -6.12, 0],
  ]),
  mockTourney(27, 100, 600, 36, [
    ['ShadowByte', 3.94, 564], ['NeonWolf', 2.11, 0], ['ZeroChill', 0.88, 0], ['MoonPatrol', -0.42, 0],
    ['IronMask', -1.99, 0], ['BagFumbler', -3.51, 0],
  ]),
  mockTourney(36, 10, 70, 7, [
    ['PixelHawk', 4.66, 44.1], ['DegenDuchess', 3.90, 18.9], ['RugSurvivor', 1.23, 0], ['AlphaLeak', 0.05, 0],
    ['SilentQuant', -0.77, 0], ['ExitLiquidity', -2.14, 0], ['MoonPatrol', -3.98, 0],
  ]),
  // a real tie: two portfolios inside the 0.05pp draw band share 1st+2nd
  mockTourney(48, 50, 500, 30, [
    ['VaultQueen', 6.13, 188, 1], ['CryptoFox', 6.10, 188, 1], ['GhostRunner', 2.88, 94, 3], ['ShadowByte', 1.44, 0, 4],
    ['NeonWolf', 0.62, 0, 5], ['PixelHawk', -0.20, 0, 6], ['IronMask', -1.12, 0, 7], ['ZeroChill', -2.33, 0, 8],
    ['DegenDuchess', -3.75, 0, 9], ['ExitLiquidity', -5.41, 0, 10],
  ]),
  mockTourney(62, 10, 50, 5, [
    ['SilentQuant', 2.77, 45], ['MoonPatrol', 1.19, 0], ['RugSurvivor', -0.31, 0], ['BagFumbler', -1.88, 0],
    ['AlphaLeak', -4.02, 0],
  ]),
  mockTourney(78, 100, 900, 45, [
    ['PixelHawk', 8.31, 427.5], ['VaultQueen', 4.95, 256.5], ['ShadowByte', 3.12, 171], ['GhostRunner', 1.67, 0],
    ['NeonWolf', 0.43, 0], ['CryptoFox', -0.55, 0], ['ZeroChill', -1.90, 0], ['IronMask', -3.44, 0],
    ['ExitLiquidity', -7.06, 0],
  ]),
  mockTourney(101, 50, 350, 21, [
    ['RugSurvivor', 5.44, 230.3], ['DegenDuchess', 2.06, 98.7], ['PixelHawk', 0.91, 0], ['SilentQuant', -0.18, 0],
    ['MoonPatrol', -1.35, 0], ['AlphaLeak', -2.77, 0], ['BagFumbler', -4.60, 0],
  ]),
  mockTourney(134, 10, 60, 6, [
    ['NeonWolf', 3.28, 54], ['ShadowByte', 1.55, 0], ['CryptoFox', 0.27, 0], ['IronMask', -0.99, 0],
    ['ZeroChill', -2.41, 0], ['ExitLiquidity', -5.13, 0],
  ]),
]

/* ---------------- the tournaments screen ---------------- */
export default function Tournaments({ nav }) {
  const app = useApp()
  const [recent, setRecent] = useState(null)
  const [poolTab, setPoolTab] = useState(null)
  const isMockPreview = MOCK_PREVIEW_ENABLED && new URLSearchParams(window.location.search).get('mocktourneys') === '1'

  useEffect(() => {
    if (isMockPreview) { refreshTourneys().catch(() => {}); setRecent(MOCK_RECENT); return }
    refreshTourneys().then((r) => setRecent(r.recent)).catch(() => setRecent([]))
    const t = setInterval(() => { api('/api/tournaments').then((r) => setRecent(r.recent)).catch(() => {}) }, 30000)
    return () => clearInterval(t)
  }, [isMockPreview])

  const lobbies = app.tourneys || []
  const pools = [...new Set(lobbies.map((l) => l.pool))] // server order
  const myLobby = app.user ? lobbies.find((l) => l.players.some((p) => p.name === app.user.name)) : null
  const inAnyLobby = !!myLobby
  const activePool = poolTab || myLobby?.pool || pools[0]
  const shown = lobbies.filter((l) => l.pool === activePool)
  const waitingIn = (pool) => lobbies.filter((l) => l.pool === pool).reduce((a, l) => a + l.count, 0)
  const activeTourneyDuel = app.duel?.tourney && !['done', 'cancelled'].includes(app.duel.phase)

  return (
    <Section eyebrow="Up to 10 enter · top portfolios get paid" title="Tournaments">
      {activeTourneyDuel && (
        <div className="notice" style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ flex: 1 }}><b>Your tournament is {app.duel.phase === 'picking' ? 'in the pick phase' : 'live'}.</b></span>
          <button className="btn btn-gold" onClick={() => nav('/duel')}>Return to it</button>
        </div>
      )}

      <div className="ty-how">
        <div className="eyebrow">How tournaments work</div>
        <div className="ty-steps">
          <span className="ty-step">{lobbies[0]?.min ?? 5} players minimum</span>
          <span className="ty-step-arrow">→</span>
          <span className="ty-step">Countdown begins</span>
          <span className="ty-step-arrow">→</span>
          <span className="ty-step">Up to {lobbies[0]?.max ?? 10} enter</span>
          <span className="ty-step-arrow">→</span>
          <span className="ty-step">Best portfolios get paid</span>
        </div>
        {/* The payout ladder used to be spelled out here too. Every card
            already carries it per place ("Unlocks at 7 players"), against that
            card's own money - saying it twice, once in the abstract, was the
            weaker of the two. */}
      </div>

      {lobbies.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 40 }}><p className="muted">Loading tournaments…</p></div>
      ) : (
        <>
          {/* One pool → no tab to choose; the bar returns by itself if the
              server ever fields a second pool again. */}
          {pools.length > 1 && (
            <div className="tabs">
              {pools.map((p) => (
                <button key={p} className={`ty-pooltab ${activePool === p ? 'on' : ''}`} onClick={() => setPoolTab(p)}>
                  <TokenLogo token={poolMark({ id: p, label: poolLabel(p) })} size={16} />
                  {poolLabel(p)}{waitingIn(p) > 0 && <span className="num"> · {waitingIn(p)} waiting</span>}
                </button>
              ))}
            </div>
          )}
          <div className="grid3">
            {shown.map((l) => <TierCard key={l.tier + l.pool} l={l} user={app.user} inAnyLobby={inAnyLobby || !!activeTourneyDuel} />)}
          </div>
        </>
      )}

      <div className="section-head" style={{ marginTop: 30 }}>
        <div>
          <div className="eyebrow">Latest settlements</div>
          <h2 className="section-title" style={{ fontSize: 24 }}>Recent tournaments</h2>
        </div>
      </div>
      {isMockPreview && (
        <p className="small" style={{ marginBottom: 10, color: '#ffc94d' }}>
          Layout preview - every settlement below is invented. Drop <b>?mocktourneys=1</b> from the URL for the real list.
        </p>
      )}
      {!recent || recent.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 30 }}>
          <p className="muted">{recent ? 'No tournaments settled yet - be in the first one.' : 'Loading…'}</p>
        </div>
      ) : (
        <div className="card" style={{ padding: '4px 8px' }}>
          <table className="table">
            <thead><tr><th>When</th><th>Table</th><th>Pot</th><th>Winner</th><th style={{ textAlign: 'right' }}>Took</th></tr></thead>
            <tbody>
              {recent.map((t) => {
                const w = t.standings[0]
                // A settlement can have more than one winner - two portfolios
                // inside the draw band share first place. Naming one of them
                // and their half of the prize would read as an outright win.
                const shared = t.standings.filter((p) => p.rank === 1).length
                return (
                  <tr key={t.id}>
                    <td className="small muted">{timeAgo(t.ts)}</td>
                    <td className="num">${t.stake} · {t.standings.length} players</td>
                    <td className="num">{fmtUsd(t.pot)}</td>
                    <td style={{ fontWeight: 700 }}>
                      {w ? (
                        <span className="who">
                          <Avatar size={24} name={w.name}>{w.avatar}</Avatar> {w.name} <Pct v={w.ret} />
                          {shared > 1 && <span className="small muted">+{shared - 1} tied</span>}
                        </span>
                      ) : '-'}
                    </td>
                    <td className="num gold" style={{ textAlign: 'right' }}>
                      {w ? fmtUsd(w.prize) : '-'}
                      {shared > 1 && <div className="small muted">each</div>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  )
}
