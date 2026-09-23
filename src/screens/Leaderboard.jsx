import React, { useEffect, useState } from 'react'
import { useApp } from '../engine/store'
import { api } from '../engine/net'
import { fmtUsd } from '../engine/format'
import { Section, Avatar } from '../components/ui'

const BOARDS = [
  { key: 'earned', label: 'Top earnings', value: (p) => p.earned, fmt: (v) => fmtUsd(v), minMatches: 0 },
  { key: 'wins', label: 'Most wins', value: (p) => p.wins, fmt: (v) => v, minMatches: 0 },
  { key: 'winRate', label: 'Best win rate', value: (p) => p.winRate, fmt: (v) => v.toFixed(1) + '%', minMatches: 20 },
  { key: 'streak', label: 'Longest streak', value: (p) => p.bestStreak, fmt: (v) => v, minMatches: 0 },
  { key: 'biggestWin', label: 'Biggest win', value: (p) => p.biggestWin, fmt: (v) => fmtUsd(v), minMatches: 0 },
]

const PERIODS = [
  { key: 'all', label: 'All time' },
  { key: 'week', label: 'This week' },
  { key: 'day', label: 'Last 24h' },
]

/* ============ dev-only mock preview (never runs in production) ============
   Fills the boards with fabricated players so the layout can be judged before
   the arena has real history. Gated on import.meta.env.DEV AND an explicit
   ?mockranks=1 query param, so a prod build can never show it and a stray
   query string on the live site can't trigger it either.
   Deliberately deterministic: random numbers would reshuffle the ranking on
   every render and read as a bug. */
const MOCK_PREVIEW_ENABLED = import.meta.env.DEV

// [name, matches, wins, draws, earned, bestStreak, biggestWin] - losses and win
// rate are derived, so a hand-edited row can never contradict itself. Each of
// the five boards is topped by a different player, which is what makes switching
// tabs worth looking at. avatar null = the monogram a real user without an
// uploaded picture gets.
const mockPlayer = ([name, matches, wins, draws, earned, bestStreak, biggestWin]) => ({
  name, avatar: null, matches, wins, draws, earned, bestStreak, biggestWin,
  losses: matches - wins - draws,
  winRate: matches ? (wins / matches) * 100 : 0,
})

const MOCK_PLAYERS = {
  all: [
    ['ShadowByte', 312, 201, 6, 48750, 14, 4820],
    ['VaultQueen', 268, 172, 4, 39200, 11, 9500],
    ['NeonWolf', 401, 233, 9, 33100, 9, 3600],
    ['GhostRunner', 154, 108, 2, 27400, 19, 5200],
    ['CryptoFox', 220, 131, 5, 19850, 8, 2750],
    ['PixelHawk', 96, 71, 1, 15600, 12, 6100],
    ['IronMask', 187, 104, 7, 12300, 7, 1900],
    ['ZeroChill', 143, 79, 3, 9450, 6, 2400],
    ['RugSurvivor', 512, 268, 14, 7300, 10, 1500],
    ['MoonPatrol', 88, 47, 2, 4100, 5, 1250],
    ['DegenDuchess', 133, 68, 4, 2850, 7, 980],
    ['SilentQuant', 74, 39, 1, 1420, 6, 1600],
    ['AlphaLeak', 61, 30, 2, -640, 4, 1100],
    ['BagFumbler', 205, 88, 6, -3200, 3, 720],
    ['ExitLiquidity', 178, 66, 5, -8900, 3, 450],
  ].map(mockPlayer),
  week: [
    ['NeonWolf', 47, 31, 1, 6200, 9, 1800],
    ['ShadowByte', 39, 24, 0, 4850, 7, 2100],
    ['PixelHawk', 22, 16, 1, 3400, 8, 1450],
    ['GhostRunner', 31, 19, 2, 2900, 6, 900],
    ['VaultQueen', 28, 16, 1, 1750, 5, 3200],
    ['ZeroChill', 44, 21, 3, -420, 4, 650],
    ['DegenDuchess', 26, 12, 1, -1100, 3, 540],
    ['ExitLiquidity', 35, 13, 2, -2600, 2, 300],
  ].map(mockPlayer),
  // Under 20 battles here, so the win-rate board visibly thins out - that is the
  // minMatches rule working, not an empty board.
  day: [
    ['GhostRunner', 24, 17, 0, 1250, 7, 480],
    ['NeonWolf', 21, 13, 1, 890, 5, 620],
    ['ShadowByte', 18, 11, 0, 640, 4, 350],
    ['MoonPatrol', 26, 14, 2, 210, 4, 300],
    ['SilentQuant', 12, 5, 1, -180, 2, 260],
  ].map(mockPlayer),
}

export default function Leaderboard() {
  const app = useApp()
  const [board, setBoard] = useState(BOARDS[0])
  const [period, setPeriod] = useState(PERIODS[0])
  const [players, setPlayers] = useState(null)
  const isMockPreview = MOCK_PREVIEW_ENABLED && new URLSearchParams(window.location.search).get('mockranks') === '1'

  useEffect(() => {
    if (isMockPreview) { setPlayers(MOCK_PLAYERS[period.key] || []); return }
    setPlayers(null)
    api(`/api/leaderboard?period=${period.key}`)
      .then((r) => setPlayers(r.players))
      .catch(() => setPlayers([]))
  }, [period.key, isMockPreview])

  const rows = (players || [])
    .filter((p) => p.matches >= board.minMatches)
    .sort((a, b) => board.value(b) - board.value(a))
    .slice(0, 15)

  return (
    <Section eyebrow="Who runs the arena" title="Leaderboard">
      <div className="tabs">
        {BOARDS.map((b) => (
          <button key={b.key} className={board.key === b.key ? 'on' : ''} onClick={() => setBoard(b)}>{b.label}</button>
        ))}
      </div>
      <div className="tabs">
        {PERIODS.map((p) => (
          <button key={p.key} className={period.key === p.key ? 'on' : ''} onClick={() => setPeriod(p)}>{p.label}</button>
        ))}
      </div>
      {isMockPreview && (
        <p className="small" style={{ marginBottom: 10, color: '#ffc94d' }}>
          Layout preview - every player below is invented. Drop <b>?mockranks=1</b> from the URL for the real board.
        </p>
      )}
      {board.minMatches > 0 && (
        <p className="small muted" style={{ marginBottom: 10 }}>Requires at least {board.minMatches} battles - one lucky win doesn't make a champion.</p>
      )}
      {players === null ? (
        <div className="card" style={{ textAlign: 'center', padding: 40 }}><p className="muted">Loading rankings…</p></div>
      ) : rows.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <p className="muted">Nobody qualifies for this board yet. The arena is young - every battle you play is history in the making.</p>
        </div>
      ) : (
        <div className="card" style={{ padding: '4px 8px' }}>
          <table className="table">
            <thead><tr><th style={{ width: 40 }}>#</th><th>Player</th><th>Battles</th><th>W / L</th><th style={{ textAlign: 'right' }}>{board.label}</th></tr></thead>
            <tbody>
              {rows.map((p, i) => {
                const isYou = app.user && p.name === app.user.name
                return (
                  <tr key={p.name} style={isYou ? { background: '#ffc94d0d' } : undefined}>
                    <td className={`num ${i === 0 ? 'rank-1' : ''}`}>{i + 1}</td>
                    <td style={{ fontWeight: 700 }}>
                      <span className="who"><Avatar size={26} name={p.name}>{p.avatar}</Avatar> {p.name}{isYou && ' (you)'}</span>
                    </td>
                    <td className="num">{p.matches}</td>
                    <td className="num">{p.wins} / {p.losses}</td>
                    <td className="num" style={{ textAlign: 'right' }}>{board.fmt(board.value(p) || 0)}</td>
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
