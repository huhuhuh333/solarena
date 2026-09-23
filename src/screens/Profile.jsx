import React, { useEffect, useState } from 'react'
import { useApp, effToken } from '../engine/store'
import { api, refreshMe, refreshHistory, doLogout } from '../engine/net'
import { fmtUsd, timeAgo } from '../engine/format'
import { Section, Pct, TokenLogo } from '../components/ui'
import { IdentityCard } from '../components/identity'

const StatBlock = ({ title, s }) => (
  <div className="card">
    <div className="card-title">{title}</div>
    <div className="stat-tiles">
      <div className="stat-tile"><div className="stat-v">{s.matches}</div><div className="stat-l">Battles</div></div>
      <div className="stat-tile"><div className="stat-v">{s.wins}<span className="muted">/{s.losses}</span></div><div className="stat-l">W / L</div></div>
      <div className="stat-tile"><div className="stat-v">{s.matches ? ((s.wins / s.matches) * 100).toFixed(0) : 0}%</div><div className="stat-l">Win rate</div></div>
      <div className="stat-tile"><div className={`stat-v ${s.earned > 0 ? 'up' : s.earned < 0 ? 'down' : ''}`}>{fmtUsd(s.earned)}</div><div className="stat-l">Net won</div></div>
      <div className="stat-tile"><div className="stat-v gold">{fmtUsd(s.biggestWin)}</div><div className="stat-l">Biggest win</div></div>
      <div className="stat-tile"><div className="stat-v">{s.streak}</div><div className="stat-l">Streak (best {s.bestStreak})</div></div>
    </div>
  </div>
)

// Tournaments score differently: a title is rank 1 of a field, and 2nd/3rd
// still pay - so "in the money" is the fair middle ground between W and L.
const TourneyStatBlock = ({ s }) => (
  <div className="card">
    <div className="card-title">Tournaments</div>
    <div className="stat-tiles">
      <div className="stat-tile"><div className="stat-v">{s.matches}</div><div className="stat-l">Played</div></div>
      <div className="stat-tile"><div className="stat-v">{s.wins}</div><div className="stat-l">Titles</div></div>
      <div className="stat-tile"><div className="stat-v">{s.wins + (s.paid || 0)}</div><div className="stat-l">In the money</div></div>
      <div className="stat-tile"><div className={`stat-v ${s.earned > 0 ? 'up' : s.earned < 0 ? 'down' : ''}`}>{fmtUsd(s.earned)}</div><div className="stat-l">Net won</div></div>
      <div className="stat-tile"><div className="stat-v gold">{fmtUsd(s.biggestWin)}</div><div className="stat-l">Biggest prize</div></div>
      <div className="stat-tile"><div className="stat-v">{s.streak}</div><div className="stat-l">Title streak (best {s.bestStreak})</div></div>
    </div>
  </div>
)

export default function Profile({ nav }) {
  const app = useApp()
  const [rank, setRank] = useState(null)

  useEffect(() => {
    refreshMe().catch(() => {})
    refreshHistory().catch(() => {})
    api('/api/leaderboard').then((r) => {
      const sorted = [...r.players].sort((a, b) => b.earned - a.earned)
      const i = sorted.findIndex((p) => p.name === app.user.name)
      setRank(i >= 0 ? i + 1 : null)
    }).catch(() => {})
  }, [])

  // best tokens across matches
  const tokenScore = {}
  for (const m of app.matches) for (const p of m.youTokens || []) {
    tokenScore[p.tokenId] = (tokenScore[p.tokenId] || 0) + p.ret * (p.pct / 100)
  }
  const bestTokens = Object.entries(tokenScore).sort((a, b) => b[1] - a[1]).slice(0, 3)

  return (
    <div className="pf-page">
      <Section eyebrow="Public profile" title="Your fighter card">
        <div className="grid2">
          <IdentityCard badge={rank
            ? <span className="cat-badge cat-degen" title="Leaderboard position by earnings">🏅 Rank #{rank} by earnings</span>
            : <span className="cat-badge cat-suspended sm">Unranked</span>} />
          <div className="card">
            <div className="card-title">Best tokens</div>
            {bestTokens.length === 0
              ? <p className="small muted">Play some battles - your most profitable picks will show up here.</p>
              : bestTokens.map(([id, score]) => {
                  const t = effToken(id)
                  return (
                    <div key={id} className="big-win-row">
                      {t && <TokenLogo token={t} size={24} />}
                      <span style={{ fontWeight: 700, flex: 1 }}>{t?.ticker ?? id}</span>
                      <Pct v={score} /><span className="small muted">weighted contribution</span>
                    </div>
                  )
                })}
            <hr className="divider" />
            <div className="card-title">Last public battles</div>
            {app.matches.slice(0, 5).map((m) => (
              <div key={m.id} className="big-win-row" style={{ cursor: 'pointer' }} onClick={() => nav('/match/' + m.id)}>
                <span className={`mode-pill mode-${m.training ? 'training' : m.tourney ? 'classic' : m.mode}`}>{m.training ? 'trn' : m.tourney ? 'tourney' : m.mode}</span>
                <span style={{ flex: 1 }}>{m.tourney ? <>#{m.tourney.rank} of <b>{m.tourney.players}</b></> : <>vs <b>{m.opp.name}</b></>}</span>
                <span className={m.outcome === 'win' ? 'up' : m.outcome === 'loss' ? 'down' : 'muted'} style={{ fontWeight: 700 }}>{m.outcome.toUpperCase()}</span>
                <span className="small muted">{timeAgo(m.ts)}</span>
              </div>
            ))}
            {app.matches.length === 0 && <p className="small muted">Nothing yet.</p>}
          </div>
        </div>
      </Section>

      <Section eyebrow="Every arena is scored separately" title="Arena stats">
        <div className="grid2">
          <StatBlock title="Classic Arena" s={app.stats.classic} />
          <StatBlock title="Live Arena" s={app.stats.live} />
          <TourneyStatBlock s={app.stats.tourney || { matches: 0, wins: 0, paid: 0, earned: 0, biggestWin: 0, streak: 0, bestStreak: 0 }} />
          <StatBlock title="Training" s={app.stats.training} />
        </div>
      </Section>

      {/* The way out lives on the page about the account. On phones the top
          bar has no room for an Exit button, and this is where anyone would
          look for it anyway. */}
      <div className="pf-logout">
        <button className="btn btn-sm btn-ghost" onClick={() => { doLogout(); nav('/') }}>Log out</button>
      </div>
    </div>
  )
}
