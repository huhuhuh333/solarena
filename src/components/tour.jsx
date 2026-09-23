// The first ninety seconds of a stranger's visit.
//
// Each card SHOWS its idea before it says it - stakes colliding into a pot,
// allocation bars filling to a hundred, money going out and coming back. A
// tutorial that only describes the product is a page of text with a Next
// button on it.
//
// Rules it holds itself to:
//   - Four steps, one sentence each. Every line that could be cut was cut.
//   - Skip is on screen from the first frame, never behind a corner ✕, and
//     Escape does the same.
//   - Nothing invented that could be mistaken for real: the coins come from the
//     live book.
//   - Seen once, ever, per browser.

import React, { useEffect, useState } from 'react'
import { useApp, allTokens } from '../engine/store'
import { TokenLogo } from './ui'

// The key predates the retirement of Predict (23 Sep 2026), when there were two
// tours; kept as it was so nobody who already saw this one sees it again.
const KEY = 'hood_tour_arena_v1'

export const tourSeen = () => { try { return !!localStorage.getItem(KEY) } catch { return true } }
export const markSeen = () => { try { localStorage.setItem(KEY, String(Date.now())) } catch { /* private mode */ } }

// Lets the Rules page put it back on screen for anyone who skipped; the shell
// reopens it on the spot, so replaying costs no reload.
let opener = null
export const onTourOpen = (fn) => { opener = fn; return () => { opener = null } }
export const replayTour = () => {
  try { localStorage.removeItem(KEY) } catch { /* private mode */ }
  opener?.()
}

/* ================= stages ================= */

// Two stakes meet, a pot forms, and one person leaves with it. The fee is real
// and named in the copy - but it is not the headline, because it is not what a
// player is deciding about.
const StagePot = () => (
  <div className="tx tx-pot">
    <div className="tx-pot-top">
      <span className="tx-stake tx-l">$50</span>
      <span className="tx-plus">+</span>
      <span className="tx-stake tx-r">$50</span>
    </div>
    <div className="tx-pot-bar"><i /></div>
    <div className="tx-slam">WINNER<br />TAKES ALL</div>
  </div>
)

// Three coins out of the live book at a real allocation, filling to 100. Falls
// back to blank rows before the book has loaded - never to invented coins.
const SPLIT = [40, 35, 25]
const StagePicks = () => {
  const book = allTokens().filter((t) => t.category === 'verified').slice(0, 3)
  const rows = book.length === 3 ? book : [null, null, null]
  return (
    <div className="tx tx-picks">
      {rows.map((t, i) => (
        <div className="tx-pick" key={t?.id ?? i} style={{ animationDelay: `${0.06 + i * 0.09}s` }}>
          {t ? <TokenLogo token={t} size={26} /> : <span className="tx-pick-blank" />}
          <span className="tx-pick-tick">{t?.ticker ?? '-'}</span>
          <span className="tx-pick-bar">
            <i style={{ width: `${SPLIT[i]}%`, animationDelay: `${0.22 + i * 0.09}s` }} />
          </span>
          <span className="tx-pick-pct num">{SPLIT[i]}%</span>
        </div>
      ))}
      <div className="tx-total"><span>total</span><b className="num">100%</b></div>
    </div>
  )
}

// The other two ways into a battle.
const StageMore = () => (
  <div className="tx tx-tables">
    <div className="tx-t">
      <span className="tx-t-k">Tournaments</span>
      <span className="tx-seats">
        {Array.from({ length: 10 }, (_, n) => (
          <i key={n} className={n < 7 ? 'took' : ''} style={{ animationDelay: `${0.1 + n * 0.06}s` }} />
        ))}
      </span>
      <span className="tx-t-v">Up to ten enter one battle. The top portfolios get paid.</span>
    </div>
    <div className="tx-t">
      <span className="tx-t-k">Challenge</span>
      {/* The real host, not a typed one: this line teaches the shape of a
          challenge link, so a hardcoded domain here goes stale the day the
          site moves and quietly teaches the wrong thing. */}
      <span className="tx-link"><i />{location.host}/challenge/…</span>
      <span className="tx-t-v">Send a private link and pick your own opponent.</span>
    </div>
  </div>
)

const StageMoney = () => (
  <div className="tx tx-flow">
    <span className="tx-node">Sign up</span>
    <span className="tx-leg"><em>free</em><span className="tx-wire"><i /></span></span>
    <span className="tx-node on">Play credits</span>
    <span className="tx-leg"><em>battle</em><span className="tx-wire"><i style={{ animationDelay: '0.9s' }} /></span></span>
    <span className="tx-node">Leaderboard</span>
  </div>
)

const STEPS = [
  {
    // The stage already slams "WINNER TAKES ALL"; the headline sets it up
    // rather than saying it twice.
    title: 'Two stakes, one pot.',
    body: 'Both players pay the same entry. When the clock runs out, the better portfolio takes the whole pot - minus the arena\'s fee, and nothing else.',
    stage: StagePot,
  },
  {
    title: 'Three coins. Your weights.',
    body: 'Pick three from the arena\'s list and decide how much of your stake rides on each. Nobody sees them until the battle starts.',
    stage: StagePicks,
  },
  {
    title: 'Not only one opponent.',
    body: 'Two more ways into a battle, on the same account and the same balance.',
    stage: StageMore,
  },
  {
    title: 'Free to play.',
    body: 'Every account starts with free play credits - no wallet, no deposit, no real money. Play as much as you like - run short and the arena tops you up. Battles settle on a time-weighted average price - a spike in the last seconds buys nothing.',
    stage: StageMoney,
  },
]

export default function Tour({ onClose }) {
  const app = useApp()
  const [i, setI] = useState(0)
  const step = STEPS[i]
  const last = i === STEPS.length - 1

  const done = () => { markSeen(); onClose() }
  const next = () => (last ? done() : setI((n) => n + 1))
  const back = () => setI((n) => Math.max(0, n - 1))

  useEffect(() => {
    const key = (e) => {
      if (e.key === 'Escape') done()
      else if (e.key === 'ArrowRight' || e.key === 'Enter') next()
      else if (e.key === 'ArrowLeft') back()
    }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [i, last])

  // A tour is a modal: the page behind it must not scroll away underneath.
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  const Stage = step.stage

  return (
    <div className="tour-back" role="dialog" aria-modal="true" aria-label="How SolArena works">
      <div className="tour">
        {/* A story rail rather than dots: it reads as "how far in am I" at a
            glance, and doubles as a way back to any step. */}
        <div className="tour-rail">
          {STEPS.map((s, n) => (
            <button key={s.title} className={`${n === i ? 'on' : ''} ${n < i ? 'past' : ''}`}
              onClick={() => setI(n)} aria-label={`Step ${n + 1}: ${s.title}`} />
          ))}
        </div>

        <div className="tour-head">
          <span className="tour-brand">SOL<em>ARENA</em></span>
          <button className="tour-skip" onClick={done}>Skip</button>
        </div>

        {/* Keyed on the step so every entrance animation replays. */}
        <div className="tour-stage" key={`s${i}`}><Stage /></div>

        <div className="tour-body" key={`b${i}`}>
          <h2 className="tour-title">{step.title}</h2>
          <p className="tour-copy">{step.body}</p>
        </div>

        <div className="tour-foot">
          <button className="tour-prev" onClick={back} disabled={i === 0}>Back</button>
          <span className="tour-count num">{i + 1}<span>/{STEPS.length}</span></span>
          {last ? (
            // Everyone lands on the arena itself (owner, 23 Sep 2026): a guest
            // browses first and signs in from the navbar when they want to.
            <a className="btn btn-gold tour-go" href="/play" onClick={done}>
              Enter the arena
            </a>
          ) : (
            <button className="btn btn-gold tour-go" onClick={next}>Next</button>
          )}
        </div>
      </div>
    </div>
  )
}
