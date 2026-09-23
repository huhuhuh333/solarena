import React, { useEffect, useState } from 'react'
import { useApp, effToken, allTokens } from '../engine/store'
import { api, acceptChallenge } from '../engine/net'
import { feeFor } from '../engine/duel'
import { POOLS, poolById, poolLabel, marketScore } from '../engine/tokens'
import { STAKES, DURATIONS, fmtUsd, durLabel } from '../engine/format'
import { Section, Avatar, TokenLogo } from '../components/ui'
import { poolMark } from '../engine/marks'
// The pick phase's own instrument, reused rather than reimplemented.
import { TokenList, Detail, loadFavs, saveFavs, equalSplit, allocWith } from './PickTerminal'

const linkFor = (code) => `${location.origin}/challenge/${code}`

// Posting a table means committing a portfolio, and that is the same decision a
// player makes in the pick phase - so it is made with the same instrument. This
// is the pick terminal's own token list, imported rather than reimplemented:
// the whole book with search, Trending / New / Gainers / Volume / Favourites,
// the liquidity and market-cap filters, live prices and the same + button.
//
// The first version here was a bespoke grid capped at sixty coins. It looked
// like a different product and it hid 95% of the book.
const BoardPicker = ({ picked, setPicked, alloc, setAlloc, cfg }) => {
  const [favs, setFavs] = useState(loadFavs)
  const [selectedId, setSelectedId] = useState(null)
  const [tf, setTf] = useState('15m')
  const toggleFav = (id) => setFavs((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); saveFavs(n); return n })

  // Open on the busiest coin in the pool rather than on "select a token to
  // inspect it". Committing a portfolio starts with looking at a chart, and an
  // empty pane on a form reads as something that failed to load.
  const book = allTokens()
  useEffect(() => {
    if (selectedId) return
    const first = book.filter((t) => t.pool === cfg.pool).sort((a, b) => marketScore(b) - marketScore(a))[0]
    if (first) setSelectedId(first.id)
  }, [book.length, cfg.pool, selectedId])

  const add = (id, on) => {
    if (on) {
      if (picked.includes(id) || picked.length >= 3) return
      const next = [...picked, id]
      setPicked(next)
      setAlloc(equalSplit(next))
      setSelectedId(id)
    } else {
      const next = picked.filter((x) => x !== id)
      setPicked(next)
      setAlloc(equalSplit(next))
    }
  }

  const total = picked.reduce((a, id) => a + (alloc[id] || 0), 0)
  // Same rule as the pick terminal, from the same function: moving one slice
  // takes it out of the others. A table posted at 148% would have been rejected
  // at submit, after the player had already chosen everything.
  const maxFor = (id) => { const t = effToken(id); return (!cfg?.training && t?.category === 'degen') ? 50 : 100 }
  const setPct = (id, v) => setAlloc((a) => allocWith(a, picked, id, v, maxFor))

  return (
    <div className="ch-picker-wrap">
      {/* Two panes, the same two the terminal opens with: the book, and the coin
          you are looking at. Bringing the list over without the chart meant
          clicking a row did nothing - you were asked to stake $100 on three
          coins you could not look at. */}
      <div className="ch-picker">
        <TokenList cfg={cfg} pool={cfg.pool} favs={favs} toggleFav={toggleFav}
          selectedId={selectedId} onSelect={setSelectedId} onAdd={add} sel={picked} tf={tf} />
        <Detail token={selectedId ? effToken(selectedId) : null} cfg={cfg}
          inPortfolio={picked.includes(selectedId)} onAdd={add} tf={tf} setTf={setTf} />
      </div>

      <div className="chw">
        <div className="chw-head">
          <span className="eyebrow">Your portfolio - {picked.length}/3</span>
          {picked.length > 0 && (
            <button className="chw-even" onClick={() => setAlloc(equalSplit(picked))}>Even split</button>
          )}
        </div>
        {picked.length === 0 ? (
          <p className="chw-none">Add three coins from the book above. They lock when you post.</p>
        ) : (
          <>
            {picked.map((id) => {
              const t = effToken(id)
              return (
                <div className="chw-row" key={id}>
                  <TokenLogo token={t} size={26} />
                  <b>{t?.ticker ?? id}</b>
                  <input type="range" min="1" max="100" value={alloc[id] ?? 0} onChange={(e) => setPct(id, Number(e.target.value))} />
                  <span className="chw-pct num">{alloc[id] ?? 0}%</span>
                  <button className="chw-x" onClick={() => add(id, false)} title="Remove">−</button>
                </div>
              )
            })}
            <div className={`chw-total ${total === 100 ? 'ok' : ''}`}>
              <span>Allocated</span><b className="num">{total}%</b>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export const ChallengeCreate = ({ nav }) => {
  const app = useApp()
  const [mode, setMode] = useState('classic')
  // One battlefield (Solana Memes) - the challenge still records it.
  const battlePool = POOLS[0].id
  const [stake, setStake] = useState(100)
  const [duration, setDuration] = useState(900)
  const [target, setTarget] = useState('')
  const [created, setCreated] = useState(null) // { code, expires, listed }
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  // Public by default: the board is the answer to an empty arena, and a link
  // nobody is waiting for helps nobody.
  const [listed, setListed] = useState(true)
  const [picked, setPicked] = useState([])
  const [alloc, setAlloc] = useState({})

  const cfg = { mode, stake, duration, pool: battlePool, training: false, charts: app.config?.charts }
  const onBoard = listed && !target.trim()
  const allocTotal = picked.reduce((a, id) => a + (alloc[id] || 0), 0)
  const portfolioReady = picked.length === 3 && allocTotal === 100

  const create = async () => {
    setError(null)
    setBusy(true)
    try {
      const r = await api('/api/challenges', {
        method: 'POST',
        body: {
          mode, stake, duration, pool: battlePool,
          target: target.trim() || undefined,
          listed: onBoard,
          picks: onBoard ? picked.map((tokenId) => ({ tokenId, pct: alloc[tokenId] })) : undefined,
        },
      })
      setCreated(r)
      setCopied(false)
      // Somebody was already searching on exactly these terms, so the server
      // paired them off instead of listing the table. There is nothing to share
      // and nothing to wait for - the battle is running, with the portfolio
      // just committed already locked in.
      if (r.matched) return nav('/duel')
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const cancel = async () => {
    if (!created) return
    try { await api(`/api/challenges/${created.code}/cancel`, { method: 'POST' }) } catch { /* already gone */ }
    setCreated(null)
  }

  const msg = `I challenged you to a $${stake} ${mode === 'classic' ? 'Classic' : 'Live'} Battle on SolArena - ${poolById(battlePool).label} only. Pick 3 coins and prove you can beat me. ${created ? linkFor(created.code) : ''}`

  return (
    <Section
      eyebrow={onBoard ? 'Set it up, walk away, get told who took it' : 'Send it to a friend - or an enemy'}
      title={onBoard ? 'Post a table' : 'Private challenge'}
    >
      <div className="grid2 ch-page">
        <div className="card">
          <div className="field"><label>Arena</label>
            <div className="seg">
              <button className={mode === 'classic' ? 'on' : ''} onClick={() => setMode('classic')}>Classic<span className="seg-sub">fixed prize</span></button>
              <button className={mode === 'live' ? 'on' : ''} onClick={() => setMode('live')}>Live<span className="seg-sub">coin payout</span></button>
            </div>
          </div>
          <div className="field"><label>Battlefield</label>
            <div className="ch-pool" style={{ alignSelf: 'flex-start' }}>
              <TokenLogo token={poolMark(poolById(battlePool))} size={18} />
              {poolById(battlePool).label}
            </div>
          </div>
          <div className="field"><label>Stake per player</label>
            <div className="seg">{STAKES.map((s) => <button key={s} className={stake === s ? 'on' : ''} onClick={() => setStake(s)}>${s}</button>)}</div>
          </div>
          <div className="field"><label>Duration</label>
            <div className="seg">{DURATIONS.map((d) => <button key={d.secs} className={duration === d.secs ? 'on' : ''} onClick={() => setDuration(d.secs)}>{d.label}</button>)}</div>
          </div>
          <div className="field"><label>Who can take it</label>
            <div className="seg">
              <button className={onBoard ? 'on' : ''} onClick={() => { setListed(true); setTarget('') }}>
                Open board<span className="seg-sub">anyone, any time</span>
              </button>
              <button className={!onBoard ? 'on' : ''} onClick={() => setListed(false)}>
                Private link<span className="seg-sub">whoever you send it to</span>
              </button>
            </div>
          </div>
          {!onBoard && (
            <div className="field"><label>Challenge a specific player (optional)</label>
              <input type="text" value={target} placeholder="exact fighter name - leave empty for an open link"
                onChange={(e) => { setTarget(e.target.value); setError(null) }} />
            </div>
          )}
          <p className="small muted" style={{ marginTop: 10 }}>
            Winner takes {mode === 'classic' ? fmtUsd(feeFor(stake).prize) + ' (fixed)' : 'the final combined value of both portfolios'}. Fee: {feeFor(stake).pct}%.
            Your stake is locked when you post and refunded if you cancel or it expires
            ({onBoard ? '12 hours' : '30 min'}).
          </p>
          {error && <div className="notice notice-danger" style={{ marginTop: 8 }}>{error}</div>}
          {/* The board's post button lives under the book, where the last
              decision is actually made. A private link has no book, so its
              button stays here. */}
          {!onBoard && (
            <button className="btn btn-you btn-lg btn-block" style={{ marginTop: 12 }}
              disabled={busy || !!created} onClick={create}>
              {created ? 'Challenge is live' : busy ? '…' : target.trim() ? `Challenge ${target.trim()}` : 'Create challenge link'}
            </button>
          )}
        </div>

        <div>
          {created?.listed ? (
            <div className="card">
              <div className="card-title">Your table is on the board</div>
              <p className="small" style={{ marginBottom: 10 }}>
                It stands for twelve hours. The first player who takes it fights you for the pool -
                you do not need to be here for it, and you'll find the result in your history and
                notifications.
              </p>
              <div className="notice" style={{ wordBreak: 'break-all', fontFamily: 'var(--mono)', fontSize: 12.5 }}>{linkFor(created.code)}</div>
              <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
                <button className="btn btn-gold" onClick={() => nav('/board')}>See the board</button>
                <button className="btn" onClick={() => { navigator.clipboard?.writeText(msg); setCopied(true) }}>
                  {copied ? 'Copied ✓' : 'Copy the link too'}
                </button>
                <button className="btn btn-danger" onClick={cancel}>Take it down (refund)</button>
              </div>
            </div>
          ) : created ? (
            <div className="card">
              <div className="card-title">Your challenge is live</div>
              {target.trim() && <p className="small" style={{ marginBottom: 8 }}>⚡ <b>{target.trim()}</b> gets an instant notification if they're online - the link below works too.</p>}
              <div className="notice" style={{ wordBreak: 'break-all', fontFamily: 'var(--mono)', fontSize: 12.5 }}>{linkFor(created.code)}</div>
              <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
                <button className="btn btn-gold" onClick={() => { navigator.clipboard?.writeText(msg); setCopied(true) }}>
                  {copied ? 'Copied ✓' : 'Copy invite message'}
                </button>
                <button className="btn btn-danger" onClick={cancel}>Cancel (refund stake)</button>
              </div>
              <hr className="divider" />
              <p className="small muted">Valid until {new Date(created.expires).toLocaleTimeString()}. Stay online - the battle starts the moment your opponent accepts.</p>
            </div>
          ) : onBoard ? (
            <div className="card ch-explain">
              <div className="card-title">Why the board works</div>
              <ol className="ch-steps">
                <li><b>You lock three coins and leave.</b> Nothing else is asked of you.</li>
                <li><b>Your table sits on the board for twelve hours</b>, with your stake held - not spent.</li>
                <li><b>Somebody takes it.</b> They pick their own three, and the battle runs there and then.</li>
                <li><b>You find out afterwards</b> - notification, history, and the money either way.</li>
              </ol>
              <hr className="divider" />
              <p className="small muted">
                No queue, no waiting for two people to be awake at once. That is the whole idea:
                the arena stops needing a crowd to be worth opening.
              </p>
            </div>
          ) : (
            <div className="card ch-explain">
              <div className="card-title">A link you send yourself</div>
              <p className="muted">
                Whoever opens it sees who challenged them, the arena, the stake and how long it is
                valid. When they accept, the battle starts for real - you against them.
              </p>
              <hr className="divider" />
              <p className="small muted">
                A private link needs you online when it is accepted, because you still have to pick.
                Post to the board instead if you would rather set it up and walk away.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* The book gets the full page, the way it does in the pick terminal.
          Boxed into a form column its container query drops half the columns,
          and choosing a coin is the decision this page is actually about. */}
      {onBoard && !created && (
        <section className="ch-book">
          <div className="ch-book-h">
            <span className="eyebrow">Lock three coins</span>
            <span className="small muted">
              They lock now - that is what lets the battle run without you. Whoever takes the table
              picks theirs at that moment, and neither side sees the other's until the clock starts.
            </span>
          </div>
          <BoardPicker picked={picked} setPicked={setPicked} alloc={alloc} setAlloc={setAlloc} cfg={cfg} />
          {error && <div className="notice notice-danger" style={{ marginTop: 12 }}>{error}</div>}
          <button className="btn btn-you btn-lg btn-block ch-post" disabled={busy || !portfolioReady} onClick={create}>
            {busy ? '…'
              : picked.length < 3 ? `Pick ${3 - picked.length} more coin${picked.length === 2 ? '' : 's'}`
                : allocTotal !== 100 ? `Allocation must total 100% - it's ${allocTotal}%`
                  : `Post the table - $${stake}`}
          </button>
        </section>
      )}
    </Section>
  )
}

export const ChallengeAccept = ({ nav, params }) => {
  const app = useApp()
  const [info, setInfo] = useState(null)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    api('/api/challenges/' + params[0])
      .then((r) => setInfo(r.challenge))
      .catch(() => setMissing(true))
  }, [params[0]])

  if (missing) {
    return (
      <div className="mm-wrap">
        <h2 className="display" style={{ fontSize: 32 }}>Challenge not found</h2>
        <p className="muted" style={{ margin: '10px 0 20px' }}>The link may have expired, or the battle already happened.</p>
        <button className="btn btn-gold btn-lg" onClick={() => nav('/challenge-new')}>Create your own challenge</button>
      </div>
    )
  }
  if (!info) return <div className="mm-wrap"><p className="muted">Loading challenge…</p></div>

  const dead = info.status !== 'open' || info.expires < Date.now()
  const accept = () => {
    acceptChallenge(info.code)
    nav('/duel')
  }

  return (
    <div className="mm-wrap">
      <Avatar size={72} tone="you" name={info.from.name}>{info.from.avatar}</Avatar>
      <h2 className="display" style={{ fontSize: 36, margin: '14px 0 6px' }}>{info.from.name} challenged you</h2>
      <p className="muted">"I challenged you to a ${info.stake} {info.mode === 'classic' ? 'Classic' : 'Live'} Battle. Pick 3 coins and prove you can beat me."</p>
      <div className="vs-row" style={{ justifyContent: 'center', gap: 18, margin: '18px 0', flexWrap: 'wrap' }}>
        <span className={`mode-pill mode-${info.mode}`}>{info.mode}</span>
        {poolLabel(info.pool) && (
          <span className="ch-pool">
            <TokenLogo token={poolMark({ id: info.pool, label: poolLabel(info.pool) })} size={18} />
            {poolLabel(info.pool)}
          </span>
        )}
        <span className="num">${info.stake} each</span>
        <span className="num">{durLabel(info.duration)}</span>
        <span className="small muted">{dead ? 'NO LONGER OPEN' : `valid until ${new Date(info.expires).toLocaleTimeString()}`}</span>
      </div>
      {dead ? (
        <div className="notice notice-danger" style={{ maxWidth: 420, margin: '0 auto' }}>
          This challenge is {info.status === 'used' ? 'already played' : 'no longer open'}.
        </div>
      ) : !info.standing && !info.creatorOnline ? (
        // Only a private link needs them here: a board table already carries
        // their locked portfolio, so their being away changes nothing.
        <div className="notice notice-info" style={{ maxWidth: 420, margin: '0 auto' }}>
          {info.from.name} is offline right now. A private challenge can only start while both players are online - try again in a bit.
        </div>
      ) : (
        <>
          <button className="btn btn-you btn-lg" onClick={accept}>Accept the challenge - ${info.stake} on the line</button>
          {info.standing && (
            <p className="small muted" style={{ marginTop: 10 }}>
              {info.from.name} locked their three coins when they posted this. You pick yours now,
              and the battle starts whether they are online or not.
            </p>
          )}
        </>
      )}
    </div>
  )
}
