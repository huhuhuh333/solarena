import React, { useEffect, useState } from 'react'
import { useApp, effToken } from '../engine/store'
import { refreshHistory, api } from '../engine/net'
import { fmtUsd, fmtPrice, timeAgo, durLabel } from '../engine/format'
import { Section, Pct, Avatar, TokenLogo } from '../components/ui'
import { ResultView } from './DuelFlow'

const place = (n) => (n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`)

// Who you were actually up against in a tournament.
//
// This cell used to be a 🏟 emoji and the word "field" - which rendered as a
// different picture on every OS (a flat grey slab on Windows) and sat next to
// 1v1 rows that show a real opponent's face. The field IS the opponent, so it
// gets the same treatment: the faces, overlapped, best finishers first.
const FieldFaces = ({ standings, players, me }) => {
  const others = standings.filter((p) => p.name !== me)
  const shown = others.slice(0, 3)
  return (
    <span className="who fld">
      <span className="fld-stack">
        {shown.map((p, i) => (
          <span className="fld-face" key={p.name} style={{ zIndex: shown.length - i }} title={`${place(p.rank)} - ${p.name}`}>
            <Avatar size={24} name={p.name}>{p.avatar}</Avatar>
          </span>
        ))}
        {others.length > shown.length && <span className="fld-more num">+{others.length - shown.length}</span>}
      </span>
      <span>Field of {players}</span>
    </span>
  )
}

// A settled tournament from the viewer's seat: standings + their own lineup.
const TourneyHistDetail = ({ m, user, nav }) => {
  const ty = m.tourney
  return (
    <>
      <div className={`result-hero result-${m.payout > 0 ? 'win' : 'loss'}`}>
        <div className="eyebrow">${m.stake} tournament · {ty.players} players · {fmtUsd(ty.pot)} pot · {durLabel(m.duration)}</div>
        <div className="display">{place(ty.rank)} of {ty.players}</div>
        {m.payout > 0
          ? <div className="result-payout gold">+{fmtUsd(m.payout)}</div>
          : <div className="muted" style={{ marginTop: 6 }}>Out of the prizes - return: <Pct v={m.retYou} /></div>}
        <div className="small muted" style={{ marginTop: 4 }}>Arena fee {fmtUsd(ty.fee)} ({ty.feePct}%)</div>
      </div>

      <div className="grid2" style={{ marginTop: 10 }}>
        <div className="card" style={{ padding: '4px 8px' }}>
          <table className="table ty-board">
            <thead><tr><th style={{ width: 40 }}>#</th><th>Player</th><th style={{ textAlign: 'right' }}>Return</th><th style={{ textAlign: 'right' }}>Prize</th></tr></thead>
            <tbody>
              {ty.standings.map((p) => {
                const you = user && p.name === user.name
                return (
                  <tr key={p.name} className={you ? 'ty-row-you' : ''}>
                    <td className={`num ${p.rank === 1 ? 'rank-1' : ''}`}>{p.rank}</td>
                    <td style={{ fontWeight: 700 }}>
                      <span className="who"><Avatar size={24} name={p.name}>{p.avatar}</Avatar> {p.name}{you && ' (you)'}</span>
                    </td>
                    <td style={{ textAlign: 'right' }}><Pct v={p.ret} /></td>
                    <td className="num gold" style={{ textAlign: 'right' }}>{p.prize > 0 ? fmtUsd(p.prize) : '-'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <div className="card">
          <div className="card-title">The lineup this seat played</div>
          <table className="table">
            <thead><tr><th>Token</th><th>Alloc</th><th>Start</th><th>End</th><th>Result</th></tr></thead>
            <tbody>
              {(m.youTokens || []).map((p) => {
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
      </div>

      {m.events?.length > 0 && (
        <details className="card timeline" style={{ marginTop: 14 }}>
          <summary>Tournament timeline · {m.events.length} events</summary>
          {m.events.map((e, i) => (
            <div key={i} className="big-win-row">
              <span className="small muted num" style={{ width: 86 }}>{new Date(e.ts).toLocaleTimeString()}</span>
              <span style={{ flex: 1 }}>{e.msg}</span>
            </div>
          ))}
        </details>
      )}
    </>
  )
}

export const MatchDetail = ({ nav, params }) => {
  const app = useApp()
  const local = app.matches.find((m) => m.id === params[0])
  const [fetched, setFetched] = useState(null)
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    if (local) return
    api('/api/match/' + params[0])
      .then((r) => setFetched(r.match))
      .catch(() => setMissing(true))
  }, [params[0], local])
  const match = local || fetched
  if (missing) return <div className="mm-wrap"><h2 className="display" style={{ fontSize: 30 }}>Match not found</h2></div>
  if (!match) return <div className="mm-wrap"><p className="muted">Loading match…</p></div>
  return (
    <>
      {match.tourney
        ? <TourneyHistDetail m={match} user={app.user} nav={nav} />
        : <ResultView match={match} user={app.user || { name: match.youName || 'Player', avatar: '🔥' }} nav={nav} />}
      <button className="btn" style={{ marginTop: 16 }} onClick={() => nav('/history')}>← Match history</button>
    </>
  )
}

export default function History({ nav }) {
  const app = useApp()
  const [filter, setFilter] = useState('all')
  useEffect(() => { refreshHistory().catch(() => {}) }, [])
  const list = app.matches.filter((m) =>
    filter === 'all' ? true
      : filter === 'training' ? m.training
        : filter === 'tourney' ? !!m.tourney
          : !m.training && !m.tourney && m.mode === filter)

  return (
    <Section eyebrow="Your record" title="Match history">
      <div className="tabs">
        {[['all', 'All'], ['classic', 'Classic'], ['live', 'Live'], ['tourney', 'Tournaments'], ['training', 'Training']].map(([f, label]) => (
          <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>{label}</button>
        ))}
      </div>
      {list.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <p className="muted" style={{ marginBottom: 14 }}>No battles here yet. Your history starts with your first fight.</p>
          <button className="btn btn-gold" onClick={() => nav('/play')}>Enter the arena</button>
        </div>
      ) : (
        <div className="card" style={{ padding: '4px 8px' }}>
          <table className="table">
            <thead><tr><th>When</th><th>Type</th><th>Opponent</th><th>You</th><th>Them</th><th>Result</th><th style={{ textAlign: 'right' }}>Payout</th></tr></thead>
            <tbody>
              {list.map((m) => (
                <tr key={m.id} style={{ cursor: 'pointer' }} onClick={() => nav('/match/' + m.id)}>
                  <td className="muted">{timeAgo(m.ts)}</td>
                  <td>
                    <span className={`mode-pill mode-${m.training ? 'training' : m.tourney ? 'classic' : m.mode}`}>
                      {m.training ? 'training' : m.tourney ? `$${m.stake} tourney` : `$${m.stake} ${m.mode}`}
                    </span>{' '}
                    <span className="muted small">{durLabel(m.duration)}</span>
                  </td>
                  {m.tourney ? (
                    <>
                      <td style={{ fontWeight: 700 }}>
                        <FieldFaces standings={m.tourney.standings} players={m.tourney.players} me={app.user?.name} />
                      </td>
                      <td><Pct v={m.retYou} /></td>
                      <td>{m.tourney.standings[0] ? <Pct v={m.tourney.standings[0].ret} /> : '-'}</td>
                      <td className={m.payout > 0 ? 'up' : 'down'} style={{ fontWeight: 700, textTransform: 'uppercase' }}>
                        {m.tourney.rank === 1 ? 'WIN' : place(m.tourney.rank)}
                      </td>
                    </>
                  ) : (
                    <>
                      <td style={{ fontWeight: 700 }}>
                        <span className="who"><Avatar size={24} name={m.opp.name}>{m.opp.avatar}</Avatar> {m.opp.name}</span>
                      </td>
                      <td><Pct v={m.retYou} /></td>
                      <td><Pct v={m.retOpp} /></td>
                      <td className={m.outcome === 'win' ? 'up' : m.outcome === 'loss' ? 'down' : 'muted'} style={{ fontWeight: 700, textTransform: 'uppercase' }}>{m.outcome}</td>
                    </>
                  )}
                  <td className="num" style={{ textAlign: 'right' }}>{m.payout > 0 ? fmtUsd(m.payout) : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  )
}
