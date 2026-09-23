// Training is sparring: you against the house bot, free, instantly, any time.
// So the page is a FIGHT CARD - your corner, the bot's corner, and the terms
// of the bout in the middle - not a settings form with a bullet list.

import React, { useEffect, useState } from 'react'
import { useApp } from '../engine/store'
import { trainingStart, api } from '../engine/net'
import { DURATIONS } from '../engine/format'
import { POOLS } from '../engine/tokens'
import { Section, Avatar } from '../components/ui'

const FACTS = [
  ['Real prices', 'The same live feed money battles settle on. The only thing simulated here is the stake.'],
  ['Wider token list', 'Fresh Launch memecoins are pickable in training - try them before they earn a ranked badge.'],
  ['Separate ledger', 'Training results feed their own leaderboard. Your ranked record never sees them.'],
]

const BOT_STYLE = {
  easy: 'spreads its money flat over three random coins - a pure dartboard',
  normal: 'locks a legal 3-token portfolio and fights to the bell',
  hard: 'backs the day’s top movers and concentrates its stack',
}

export default function Training({ nav }) {
  const app = useApp()
  const [duration, setDuration] = useState(300)
  // One battlefield (Solana Memes) - nothing to select, the id still travels
  // with the training config.
  const battlePool = POOLS[0].id
  const [level, setLevel] = useState('normal')
  const [board, setBoard] = useState(null)
  const [rank, setRank] = useState(null)

  useEffect(() => {
    api('/api/leaderboard?board=training').then((r) => {
      const full = r.players
        .filter((p) => p.matches >= 1)
        .sort((a, b) => b.wins - a.wins || b.matches - a.matches)
      setBoard(full.slice(0, 8))
      const i = app.user ? full.findIndex((p) => p.name === app.user.name) : -1
      setRank(i >= 0 ? i + 1 : null)
    }).catch(() => setBoard([]))
  }, [])

  const rec = app.stats.training
  const start = () => { trainingStart({ duration, pool: battlePool, difficulty: level }); nav('/duel') }

  return (
    <Section eyebrow="No stake · no payout · the gym never closes" title="Free training arena">
      <div className="tr-page">
      {!app.trainingDone && (
        <div className="tr-unlock">
          <span className="tr-unlock-mark">🥊</span>
          <span><b>A full battle against the house - same coins, same live prices, no stake.</b> Nothing here is required before you play for money; it is the cheapest way to learn the terminal.</span>
        </div>
      )}

      {/* ---- the fight card ---- */}
      <div className="card tr-card">
        <div className="tr-corner tr-corner-you">
          <span className="tr-tag">Your corner</span>
          <Avatar size={78} tone="you" name={app.user.name}>{app.user.avatar}</Avatar>
          <span className="tr-name">{app.user.name}</span>
          <span className="tr-rec num">{rec.wins}W · {rec.losses}L{rec.draws > 0 ? ` · ${rec.draws}D` : ''}</span>
          <span className="small muted">training record</span>
          <span className="tr-info">{rank ? `Training rank #${rank}` : 'Unranked - win a round to get on the board'}</span>
        </div>

        <div className="tr-mid">
          <div className="tr-vs" aria-hidden="true">VS</div>
          <div className="tr-label">Battlefield - Solana Memes, Fresh Launches included</div>
          <div className="tr-label">Duration</div>
          <div className="seg">
            {DURATIONS.slice(0, 3).map((d) => (
              <button key={d.secs} className={duration === d.secs ? 'on' : ''} onClick={() => setDuration(d.secs)}>{d.label}</button>
            ))}
          </div>
          <button className="btn btn-lg btn-block tr-start" style={{ marginTop: 6 }} onClick={start}>
            Start Training Battle
          </button>
          <p className="small muted" style={{ margin: 0, textAlign: 'center' }}>
            The bot takes the ring instantly - no queue, no waiting.
          </p>
        </div>

        <div className="tr-corner tr-corner-opp">
          <span className="tr-tag">The house corner</span>
          <Avatar size={78} tone="opp">/bot.png</Avatar>
          <span className="tr-name">Arena Bot</span>
          <span className="tr-rec tr-ready num">always ready</span>
          <span className="tr-info">Difficulty</span>
          <div className="seg tr-diff">
            {['easy', 'normal', 'hard'].map((lv) => (
              <button key={lv} className={level === lv ? 'on' : ''} onClick={() => setLevel(lv)}>
                {lv[0].toUpperCase() + lv.slice(1)}
              </button>
            ))}
          </div>
          <span className="small muted">{BOT_STYLE[level]}</span>
        </div>
      </div>

      {app.trainingDone && (
        <p className="small muted" style={{ marginTop: 10 }}>✔ You have fought here before - training stays free, forever, as often as you like.</p>
      )}

      {/* ---- what the gym gives you ---- */}
      <div className="grid3 tr-facts">
        {FACTS.map(([h, body]) => (
          <div key={h} className="card tr-fact">
            <div className="tr-fact-h">{h}</div>
            <p className="small muted" style={{ margin: 0 }}>{body}</p>
          </div>
        ))}
      </div>

      {/* ---- training leaderboard ---- */}
      <div className="section-head" style={{ marginTop: 30 }}>
        <div>
          <div className="eyebrow">Kept fully separate from ranked results</div>
          <h2 className="section-title" style={{ fontSize: 24 }}>Training leaderboard</h2>
        </div>
      </div>
      {board === null ? (
        <div className="card" style={{ textAlign: 'center', padding: 30 }}><p className="muted">Loading…</p></div>
      ) : board.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 30 }}>
          <p className="muted">Nobody on the board yet - your first training battle could put you here.</p>
        </div>
      ) : (
        <div className="card" style={{ padding: '4px 8px' }}>
          <table className="table">
            <thead><tr><th style={{ width: 40 }}>#</th><th>Fighter</th><th>Wins</th><th>Rounds</th><th style={{ textAlign: 'right' }}>Win rate</th></tr></thead>
            <tbody>
              {board.map((p, i) => {
                const you = app.user && p.name === app.user.name
                return (
                  <tr key={p.name} className={you ? 'ty-row-you' : ''}>
                    <td className={`num ${i === 0 ? 'rank-1' : ''}`}>{i + 1}</td>
                    <td style={{ fontWeight: 700 }}>
                      <span className="who"><Avatar size={26} name={p.name}>{p.avatar}</Avatar> {p.name}{you && ' (you)'}</span>
                    </td>
                    <td className="num up">{p.wins}</td>
                    <td className="num">{p.matches}</td>
                    <td className="num" style={{ textAlign: 'right' }}>{p.matches ? Math.round((p.wins / p.matches) * 100) : 0}%</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      </div>
    </Section>
  )
}
