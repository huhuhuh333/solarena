// The open board: tables somebody put money on and walked away from.
//
// Design thesis - this is a room full of OPPONENTS, so it is rendered in the
// opponent's colour. The arena's palette has meant one thing since the first
// commit: phosphor is you, acid is them. Every table here belongs to somebody
// else, so the page is acid, and the only phosphor on it is your own button
// and your own standing tables. Nothing else on the site can be that colour
// and mean that, which is why the board could not be mistaken for another page.
//
// The signature is the SEAL. A posted table carries its author's three coins,
// locked, and the client genuinely does not have them - the API refuses to
// serve picks. So the row shows three struck slabs where a portfolio would be.
// It is not decoration standing in for missing data; it IS the missing data,
// which is the whole tension of taking a table: you are betting against a hand
// you cannot see.
//
// Money is set in the poster face. Anton has had exactly two jobs on this site,
// the wordmark and the VS slam, and this is the third - justified because the
// board's only job is to make standing offers feel like challenges, and that
// is the voice the arena challenges in.

import React, { useEffect, useMemo, useState } from 'react'
import { useApp } from '../engine/store'
import { api, acceptChallenge } from '../engine/net'
import { feeFor } from '../engine/duel'
import { fmtUsd, durLabel, timeAgo } from '../engine/format'
import { Avatar } from '../components/ui'

const money = (n) => (n % 1 === 0 ? '$' + n.toLocaleString('en-US') : fmtUsd(n))

// Time LEFT, not an expiry stamp: "4h left" is a reason to act, "closes 03:41"
// is homework. Minutes come off one rounded total - flooring the hour and
// rounding the remainder separately prints "11h 60m".
const leftLabel = (ms) => {
  if (ms <= 0) return 'closing'
  const mins = Math.round(ms / 60000)
  const h = Math.floor(mins / 60)
  return h > 0 ? `${h}h ${mins % 60}m left` : `${mins}m left`
}

const recordOf = (r) => (r?.played ? `${r.won}-${r.played - r.won}` : 'no record yet')

const SORTS = [
  { key: 'new', label: 'Newest', fn: (a, b) => b.created - a.created },
  { key: 'big', label: 'Biggest', fn: (a, b) => b.stake - a.stake },
  { key: 'end', label: 'Ending soon', fn: (a, b) => a.expires - b.expires },
]

// Three slabs, struck through, in the opponent's colour. No lock, no eye, no
// question mark - the strike is the idea, and it carries the arena's skew so it
// reads as part of this product rather than an icon borrowed from another one.
const Seal = () => (
  <span className="bd-seal" aria-label="Three coins, sealed until the battle starts">
    <i /><i /><i />
    <em>3 coins sealed</em>
  </span>
)

const Table = ({ c, user, onTake, onDrop, busy }) => (
  <article className={`bd-t ${c.mine ? 'is-mine' : ''}`}>
    <span className="bd-t-who">
      <Avatar size={38} name={c.from.name} tone={c.mine ? 'you' : undefined}>{c.from.avatar}</Avatar>
      <span>
        <b>{c.from.name}</b>
        <span className="bd-t-sub">
          {c.mine ? 'your table' : recordOf(c.record)} · posted {timeAgo(c.created)}
        </span>
      </span>
    </span>

    <span className="bd-t-terms">
      <b>{durLabel(c.duration)}</b>
      <span className="bd-t-sub">{c.mode === 'live' ? 'Live Arena' : 'Classic'}</span>
    </span>

    <Seal />

    <span className="bd-t-money">
      <b className="bd-t-stake">{money(c.stake)}</b>
      <span className="bd-t-sub">stake each</span>
    </span>

    <span className="bd-t-money bd-t-win">
      <b className="bd-t-stake">{c.mode === 'classic' ? money(feeFor(c.stake).prize) : 'both books'}</b>
      <span className="bd-t-sub">winner takes</span>
    </span>

    <span className="bd-t-act">
      {c.mine ? (
        <button className="bd-drop" onClick={() => onDrop(c)} disabled={busy}>Take it down</button>
      ) : (
        <button className="bd-take" disabled={!user || busy} onClick={() => onTake(c)}>
          {user ? 'Take this table' : 'Log in to take it'}
        </button>
      )}
      <span className="bd-t-left">{leftLabel(c.expires - Date.now())}</span>
    </span>
  </article>
)

export default function Board({ nav }) {
  const app = useApp()
  const [open, setOpen] = useState(null)
  const [sort, setSort] = useState('new')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const load = () => api('/api/challenges').then((r) => setOpen(r.open)).catch(() => setOpen([]))
  useEffect(() => {
    load()
    const t = setInterval(load, 20000)
    return () => clearInterval(t)
  }, [])
  // The server pings when a table is posted or taken, so the board stays honest
  // without being polled hard.
  useEffect(() => { if (app.boardTick) load() }, [app.boardTick])

  const take = (c) => { setError(null); setBusy(true); acceptChallenge(c.code); nav('/duel') }
  const drop = async (c) => {
    setError(null)
    setBusy(true)
    try { await api(`/api/challenges/${c.code}/cancel`, { method: 'POST' }); await load() } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  const rows = useMemo(() => [...(open || [])].sort(SORTS.find((s) => s.key === sort).fn), [open, sort])
  const mine = rows.filter((c) => c.mine)
  const theirs = rows.filter((c) => !c.mine)

  // A market summary rather than a stat block: what a trader would want to know
  // before scanning - how much is standing, and the range they can enter at.
  const committed = rows.reduce((a, c) => a + c.stake, 0)
  const lo = rows.length ? Math.min(...rows.map((c) => c.stake)) : 0
  const hi = rows.length ? Math.max(...rows.map((c) => c.stake)) : 0

  return (
    <div className="bd">
      <header className="bd-head">
        <div>
          <span className="bd-eyebrow">Money already on the table</span>
          <h1 className="bd-title">Open board</h1>
          {rows.length > 0 && (
            <p className="bd-tape num">
              <b>{rows.length}</b> standing
              <i /> <b>{money(committed)}</b> committed
              <i /> {lo === hi ? <>all at <b>{money(lo)}</b></> : <>from <b>{money(lo)}</b> to <b>{money(hi)}</b></>}
            </p>
          )}
        </div>
        <button className="bd-post" onClick={() => nav('/challenge-new')}>Post a table</button>
      </header>

      <p className="bd-lede">
        Every table belongs to a player who locked three coins and left. Take one and you pick yours
        on the spot - the battle runs whether they are online or not.
      </p>

      {error && <div className="notice notice-danger" style={{ marginBottom: 14 }}>{error}</div>}

      {open === null ? (
        <div className="bd-quiet">Reading the board…</div>
      ) : rows.length === 0 ? (
        // The page most visitors meet first on a young arena, so it teaches the
        // format instead of apologising for being empty: a ghost of a real row,
        // with the seal already in place.
        <section className="bd-empty">
          <article className="bd-t is-ghost" aria-hidden="true">
            <span className="bd-t-who">
              <span className="bd-ghost-face" />
              <span><b>-</b><span className="bd-t-sub">nobody yet</span></span>
            </span>
            <span className="bd-t-terms"><b>-</b><span className="bd-t-sub">Classic</span></span>
            <Seal />
            <span className="bd-t-money"><b className="bd-t-stake">-</b><span className="bd-t-sub">stake each</span></span>
            <span className="bd-t-money bd-t-win"><b className="bd-t-stake">-</b><span className="bd-t-sub">winner takes</span></span>
            <span className="bd-t-act"><span className="bd-ghost-btn" /></span>
          </article>
          <h2>Nothing is standing. Post the first table.</h2>
          <p>
            Set a stake, lock three coins, walk away. Your table holds this spot for twelve hours and
            the first player to take it fights you for the pool. Neither of you has to be here at the
            same time.
          </p>
          <button className="bd-post bd-post-lg" onClick={() => nav('/challenge-new')}>Post the first table</button>
        </section>
      ) : (
        <>
          <div className="bd-sorts" role="tablist" aria-label="Sort the board">
            {SORTS.map((s) => (
              <button key={s.key} role="tab" aria-selected={sort === s.key}
                className={sort === s.key ? 'on' : ''} onClick={() => setSort(s.key)}>{s.label}</button>
            ))}
          </div>

          {mine.length > 0 && (
            <section className="bd-band">
              <h2 className="bd-band-h">Yours, waiting for a taker</h2>
              <div className="bd-list">
                {mine.map((c, i) => (
                  <div key={c.code} style={{ '--i': i }}><Table c={c} user={app.user} onTake={take} onDrop={drop} busy={busy} /></div>
                ))}
              </div>
            </section>
          )}

          <section className="bd-band">
            {mine.length > 0 && <h2 className="bd-band-h">Open to you</h2>}
            {theirs.length === 0 ? (
              <div className="bd-quiet">Only your own tables are standing. They hold for twelve hours.</div>
            ) : (
              <div className="bd-list">
                {theirs.map((c, i) => (
                  <div key={c.code} style={{ '--i': i }}><Table c={c} user={app.user} onTake={take} onDrop={drop} busy={busy} /></div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
}
