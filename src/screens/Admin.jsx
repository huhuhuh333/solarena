// The operator's console.
//
// One person runs this arena, alone, sometimes at 3am, sometimes because
// something is wrong. So the panel is built around ONE question - does anything
// need me right now? - and answers it before anything else loads a table.
//
// Three ideas hold the whole screen together:
//
//   1. The verdict comes first. A lamp and a sentence, at the top, always. Green
//      means you can close the laptop. Amber means there is a queue. Red means
//      something is stopped. Everything else on the page is detail
//      behind that one line.
//   2. The work counts itself. Every section that can hold a decision carries a
//      live badge, so triage happens in the nav - you never open a tab to find
//      out whether it was worth opening.
//   3. Money decisions arm before they fire. Nothing irreversible happens on a
//      single click, and nothing uses a browser dialog: the confirmation states
//      what will happen, in place, in the arena's own voice.
//
// Anton is deliberately absent. It is the arena's poster face and belongs on a
// share card, not on a control surface - headings here are small, wide-tracked
// Space Grotesk, the way equipment is labelled.

import React, { useEffect, useRef, useState } from 'react'
import { useApp } from '../engine/store'
import { api, loadPublic } from '../engine/net'
import { TOKENS, CATEGORY } from '../engine/tokens'
import { fmtUsd, timeAgo, STAKES } from '../engine/format'
import { TokenLogo } from '../components/ui'

const NAV = [
  { slug: '', label: 'Overview' },
  { slug: 'support', label: 'Support', group: 'Waiting on you', count: 'support' },
  { slug: 'battles', label: 'Battles', group: 'Live now', count: 'battles', quiet: true },
  { slug: 'players', label: 'Players', group: 'Live now' },
  { slug: 'arena', label: 'Arena rules', group: 'Setup' },
  { slug: 'tokens', label: 'Tokens', group: 'Setup' },
  { slug: 'log', label: 'Log', group: 'Record' },
]

/* A control that will not fire on one click. The armed state says what is about
   to happen rather than asking "are you sure" - the sentence IS the safeguard. */
const Danger = ({ label, warning, confirm = 'Yes, do it', onConfirm, disabled, tone = 'danger' }) => {
  const [armed, setArmed] = useState(false)
  useEffect(() => { if (!armed) return undefined; const t = setTimeout(() => setArmed(false), 8000); return () => clearTimeout(t) }, [armed])
  if (!armed) {
    return <button className={`adm-btn is-${tone}`} disabled={disabled} onClick={() => setArmed(true)}>{label}</button>
  }
  return (
    <span className="adm-arm">
      <span className="adm-arm-txt">{warning}</span>
      <button className={`adm-btn is-${tone}`} disabled={disabled} onClick={() => { setArmed(false); onConfirm() }}>{confirm}</button>
      <button className="adm-btn is-ghost" onClick={() => setArmed(false)}>Keep it</button>
    </span>
  )
}

const Stat = ({ v, l, tone, hint }) => (
  <div className="adm-stat">
    <div className={`adm-stat-v${tone ? ' is-' + tone : ''}`}>{v}</div>
    <div className="adm-stat-l">{l}</div>
    {hint && <div className="adm-stat-h">{hint}</div>}
  </div>
)

const Panel = ({ title, note, right, children, flush }) => (
  <section className="adm-panel">
    {(title || right) && (
      <header className="adm-panel-h">
        <h3>{title}</h3>
        {right}
      </header>
    )}
    {note && <p className="adm-note">{note}</p>}
    <div className={flush ? 'adm-panel-b is-flush' : 'adm-panel-b'}>{children}</div>
  </section>
)

const Empty = ({ children }) => <p className="adm-empty">{children}</p>

/* ---------------- support ----------------
   Conversations on the left, the thread on the right. Owns its own thread
   polling because a reply can land while you are reading it. */
const SupportDesk = ({ threads, reload }) => {
  const [openId, setOpenId] = useState(null)
  const [thread, setThread] = useState(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const listRef = useRef(null)

  const loadThread = (id) => api('/api/admin/support/' + id)
    .then((t) => { setThread(t); reload() })   // opening marks it read
    .catch((e) => setError(e.message))

  useEffect(() => {
    if (!openId) return undefined
    const t = setInterval(() => api('/api/admin/support/' + openId).then(setThread).catch(() => {}), 12000)
    return () => clearInterval(t)
  }, [openId])
  useEffect(() => { if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight }, [thread])

  const reply = async () => {
    const body = draft.trim()
    if (!body || busy || !openId) return
    setBusy(true); setError(null)
    try { await api('/api/admin/support/' + openId, { method: 'POST', body: { body } }); setDraft(''); loadThread(openId) }
    catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  if (!threads) return <Empty>Loading the desk…</Empty>

  return (
    <div className="adm-support">
      <div className="adm-panel adm-threads">
        <header className="adm-panel-h">
          <h3>Conversations</h3>
          {threads.unreadTotal > 0 && <span className="adm-pill is-warn">{threads.unreadTotal} unread</span>}
        </header>
        <div className="adm-panel-b is-flush">
          {threads.threads.length === 0
            ? <Empty>Nobody has written in. Messages from the support window land here.</Empty>
            : threads.threads.map((t) => (
              <button key={t.userId} className={`adm-thread${openId === t.userId ? ' is-on' : ''}`}
                onClick={() => { setOpenId(t.userId); setThread(null); setError(null); loadThread(t.userId) }}>
                <span className="adm-thread-top">
                  <b>{t.name}</b>
                  {t.unread > 0 && <span className="adm-dot">{t.unread}</span>}
                  {t.blocked && <span className="adm-pill is-danger">blocked</span>}
                  <span className="adm-thread-ago">{timeAgo(t.lastTs)}</span>
                </span>
                <span className="adm-thread-last">{t.lastFromAdmin ? 'You: ' : ''}{t.last}</span>
              </button>
            ))}
        </div>
      </div>

      <div className="adm-panel adm-convo">
        {!openId ? (
          <div className="adm-panel-b"><Empty>Pick a conversation to read it and answer.</Empty></div>
        ) : !thread ? (
          <div className="adm-panel-b"><Empty>Loading…</Empty></div>
        ) : (
          <>
            <header className="adm-panel-h">
              <h3>{thread.player.name}</h3>
              <span className="adm-panel-sub">balance {fmtUsd(thread.player.balance)}</span>
            </header>
            <div className="adm-msgs" ref={listRef}>
              {thread.messages.map((m, i) => (
                <div key={i} className={`adm-msg${m.fromAdmin ? ' is-mine' : ''}`}>
                  <span className="adm-bubble">{m.body}</span>
                  <span className="adm-msg-ts">{m.fromAdmin ? 'You' : thread.player.name} · {timeAgo(m.ts)}</span>
                </div>
              ))}
            </div>
            {error && <div className="adm-alert is-danger">{error}</div>}
            <div className="adm-compose">
              <textarea value={draft} rows={2} maxLength={1000} placeholder={`Reply to ${thread.player.name}…`}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); reply() } }}
                onChange={(e) => { setDraft(e.target.value); setError(null) }} />
              <button className="adm-btn is-go" disabled={!draft.trim() || busy} onClick={reply}>{busy ? '…' : 'Send reply'}</button>
            </div>
            <p className="adm-hint">Arrives in their support window instantly if they are online, behind its badge if not.</p>
          </>
        )}
      </div>
    </div>
  )
}

/* A refund is a number, so it gets a number field - not a browser prompt that
   cannot show what the money is for or who it goes to. */
const RefundBox = ({ player, onSend }) => {
  const [open, setOpen] = useState(false)
  const [amt, setAmt] = useState('')
  const [note, setNote] = useState('')
  const n = Number(amt)
  if (!open) return <button className="adm-btn" onClick={() => setOpen(true)}>Refund…</button>
  return (
    <span className="adm-refund">
      <input type="number" min="0" step="0.01" value={amt} autoFocus placeholder="0.00"
        onChange={(e) => setAmt(e.target.value)} />
      <input type="text" value={note} maxLength={80} placeholder="what it is for"
        onChange={(e) => setNote(e.target.value)} />
      <button className="adm-btn is-go" disabled={!(n > 0)}
        onClick={() => { onSend(n, note.trim() || 'Support refund'); setOpen(false); setAmt(''); setNote('') }}>
        Credit {n > 0 ? fmtUsd(n) : '-'} to {player}
      </button>
      <button className="adm-btn is-ghost" onClick={() => setOpen(false)}>Cancel</button>
    </span>
  )
}

export default function Admin({ nav, params }) {
  const app = useApp()
  const here = (params?.[0] || '').toLowerCase()
  const section = NAV.some((n) => n.slug === here) ? here : ''

  const [ov, setOv] = useState(null)
  const [rails, setRails] = useState(null)
  const [support, setSupport] = useState(null)
  const [error, setError] = useState(null)
  const [savedAt, setSavedAt] = useState(0)

  const reload = () => {
    api('/api/admin/overview').then(setOv).catch((e) => setError(e.message))
    api('/api/admin/rails').then(setRails).catch(() => {})
    api('/api/admin/support').then(setSupport).catch(() => {})
  }
  const isAdmin = !!app.user?.isAdmin
  useEffect(() => { if (isAdmin) reload() }, [isAdmin])
  // The queues fill on their own schedule, not when you open the panel.
  useEffect(() => {
    if (!isAdmin) return undefined
    const t = setInterval(() => {
      api('/api/admin/support').then(setSupport).catch(() => {})
      api('/api/admin/rails').then(setRails).catch(() => {})
    }, 20000)
    return () => clearInterval(t)
  }, [isAdmin])

  if (!isAdmin) {
    return (
      <div className="adm-gate">
        <h2>Admin panel</h2>
        <p>This area needs an admin account. Log in with one and come back.</p>
      </div>
    )
  }
  if (error && !ov) return <div className="adm-wrap"><div className="adm-alert is-danger">{error}</div></div>
  if (!ov) return <div className="adm-wrap"><Empty>Reading the arena…</Empty></div>

  const act = async (path, body) => {
    setError(null)
    try {
      await api(path, { method: 'POST', body })
      setSavedAt(Date.now())
      reload()
      loadPublic().catch(() => {}) // keep the public config in step
    } catch (e) { setError(e.message) }
  }

  const S = ov.settings
  const counts = {
    support: support?.unreadTotal || 0,
    battles: ov.activeRooms.length,
  }
  const stopped = S.classicPaused || S.livePaused
  const jobs = []
  if (counts.support) jobs.push({ to: 'support', n: counts.support, what: `unread message${counts.support === 1 ? '' : 's'}` })
  const tone = stopped ? 'danger' : jobs.length ? 'warn' : 'ok'

  const go = (slug) => nav('/admin' + (slug ? '/' + slug : ''))

  return (
    <div className="adm-wrap">
      <header className="adm-head">
        <div>
          <span className="adm-eyebrow">Arena operations</span>
          <h1>Admin</h1>
        </div>
        <div className="adm-head-r">
          {savedAt > 0 && <span className="adm-saved">Saved</span>}
          <button className="adm-btn" onClick={reload}>Refresh</button>
        </div>
      </header>

      {error && <div className="adm-alert is-danger">{error}</div>}

      {/* The verdict. First thing on the page, on every section, because the
          answer to "does anything need me" must never require a click. */}
      <div className={`adm-verdict is-${tone}`}>
        <span className="adm-lamp" aria-hidden="true" />
        <div className="adm-verdict-b">
          <h2>
            {stopped ? 'The arena is paused'
              : jobs.length === 0 ? 'Nothing needs you'
                : `${jobs.reduce((a, j) => a + j.n, 0)} thing${jobs.reduce((a, j) => a + j.n, 0) === 1 ? '' : 's'} need${jobs.reduce((a, j) => a + j.n, 0) === 1 ? 's' : ''} you`}
          </h2>
          <p className="adm-verdict-sub">
            {S.classicPaused && <b>Classic is paused. </b>}
            {S.livePaused && <b>Live is paused. </b>}
            {!stopped && 'Both arenas running. '}
            Free play - balances are play credits.
          </p>
          {jobs.length > 0 && (
            <ul className="adm-jobs">
              {jobs.map((j) => (
                <li key={j.to}>
                  <button onClick={() => go(j.to)}>
                    <b>{j.n}</b>
                    <span className="adm-job-w">{j.what}</span>
                    {j.money && <span className="adm-job-m">{j.money}</span>}
                    <span className="adm-job-go" aria-hidden="true">→</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <nav className="adm-nav" aria-label="Admin sections">
        {NAV.map((n, i) => {
          const c = n.count ? counts[n.count] : 0
          const newGroup = n.group && NAV[i - 1]?.group !== n.group
          return (
            <React.Fragment key={n.slug || 'overview'}>
              {newGroup && <span className="adm-nav-g">{n.group}</span>}
              <button className={section === n.slug ? 'is-on' : ''} onClick={() => go(n.slug)}>
                {n.label}
                {c > 0 && <span className={`adm-nav-c${n.quiet ? ' is-quiet' : ''}`}>{c}</span>}
              </button>
            </React.Fragment>
          )
        })}
      </nav>

      {section === '' && (
        <>
          <Panel title="Right now">
            <div className="adm-stats">
              <Stat v={counts.battles} l="Battles running" />
              <Stat v={ov.activeTourneys?.length ?? 0} l="Tournaments" />
              <Stat v={ov.users.length} l="Players" hint="newest 100" />
              <Stat v={rails?.tokenSource?.count?.toLocaleString() ?? '-'} l="Tokens tradable" />
            </div>
          </Panel>

          {rails?.hedge && (
            <Panel
              title="Hedge book"
              note={`The treasury mirrors open Live exposure on ${rails.hedge.venue}, rebalancing once drift passes ${fmtUsd(rails.hedge.thresholdUsd)}.`}
            >
              {rails.hedge.positions.length === 0 ? <Empty>No open Live exposure right now.</Empty> : rails.hedge.positions.map((p) => (
                <div key={p.token} className="adm-row is-tight">
                  <span className="adm-row-name">{p.token}</span>
                  <span className="adm-row-mid">target {p.targetAmount.toPrecision(4)} · held {p.heldAmount.toPrecision(4)} ({fmtUsd(p.heldUsd)})</span>
                  <span className={`adm-status is-${Math.abs(p.driftUsd) < 10 ? 'ok' : 'warn'}`}>drift {fmtUsd(p.driftUsd)}</span>
                </div>
              ))}
              {rails.hedge.trades.length > 0 && (
                <div className="adm-scroll" style={{ marginTop: 10 }}>
                  {rails.hedge.trades.map((t, i) => (
                    <div key={i} className="adm-row is-tight">
                      <span className={`adm-status is-${t.side === 'buy' ? 'ok' : 'danger'}`}>{t.side}</span>
                      <span className="adm-row-mid">{t.token} · {fmtUsd(t.usd)} @ {t.price.toPrecision(5)}</span>
                      <span className="adm-row-ago">{t.venue} · {timeAgo(t.ts)}</span>
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          )}
        </>
      )}

      {section === 'support' && <SupportDesk threads={support} reload={reload} />}

      {section === 'battles' && (
        <>
          <Panel title={`${ov.activeRooms.length} battle${ov.activeRooms.length === 1 ? '' : 's'} running`} flush>
            {ov.activeRooms.length === 0
              ? <Empty>Nothing running. Live battles appear here while they are being fought.</Empty>
              : ov.activeRooms.map((r) => (
                <div key={r.id} className="adm-row">
                  <span className={`adm-mode is-${r.training ? 'training' : r.mode}`}>{r.training ? 'training' : `$${r.stake} ${r.mode}`}</span>
                  <span className="adm-row-mid"><b>{r.players.join('  vs  ')}</b></span>
                  <span className="adm-row-ago">{r.phase}{r.remaining != null && ` · ${r.remaining}s left`}</span>
                  <span className="adm-row-act">
                    {!r.training && (
                      <Danger label="Void & refund" confirm="Void this battle"
                        warning="Both players get their stake back and the result is discarded."
                        onConfirm={() => act('/api/admin/void', { roomId: r.id })} />
                    )}
                  </span>
                </div>
              ))}
          </Panel>

          <div className="adm-two">
            <Panel title="Flagged results" note="Any battle where a portfolio moved more than 25% - worth a look, not proof of anything." flush>
              {ov.flagged.length === 0 ? <Empty>Nothing flagged.</Empty> : ov.flagged.map((m) => (
                <div key={m.id} className="adm-row is-tight">
                  <span className="adm-row-mid">{m.name_a} vs {m.name_b}</span>
                  <span className="adm-status is-warn">{m.ret_a?.toFixed(1)}% / {m.ret_b?.toFixed(1)}%</span>
                  <a className="adm-btn is-ghost" href={'/match/' + m.id}>Log</a>
                </div>
              ))}
            </Panel>
            <Panel title="Recent battles" flush>
              {ov.recent.length === 0 ? <Empty>No battles yet.</Empty> : (
                <div className="adm-scroll">
                  {ov.recent.map((m) => (
                    <div key={m.id} className="adm-row is-tight">
                      <span className={`adm-mode is-${m.training ? 'training' : m.mode}`}>{m.training ? 'trn' : `$${m.stake}`}</span>
                      <span className="adm-row-mid">{m.name_a} vs {m.name_b}</span>
                      <span className="adm-row-ago">{timeAgo(m.ts)}</span>
                      <a className="adm-btn is-ghost" href={'/match/' + m.id}>Log</a>
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          </div>
        </>
      )}

      {section === 'players' && (
        <Panel title={`${ov.users.length} player${ov.users.length === 1 ? '' : 's'}`} note="Newest first, capped at 100." flush>
          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead><tr><th>Player</th><th>Balance</th><th>Joined</th><th>Status</th><th className="ta-r">Actions</th></tr></thead>
              <tbody>
                {ov.users.map((u) => (
                  <tr key={u.id}>
                    <td><b>{u.name}</b></td>
                    <td className="adm-num">{fmtUsd(u.balance)}</td>
                    <td className="adm-dim">{timeAgo(u.created)}</td>
                    <td>{u.blocked ? <span className="adm-status is-danger">blocked</span>
                      : u.training_done ? <span className="adm-status is-ok">active</span>
                        : <span className="adm-status">new</span>}</td>
                    <td className="ta-r">
                      <span className="adm-row-act">
                        {String(u.avatar || '').startsWith('/api/avatar/') && (
                          <Danger tone="plain" label="Reset picture" confirm="Remove it"
                            warning="Their uploaded picture is deleted and the default comes back."
                            onConfirm={() => act('/api/admin/avatar-reset', { userId: u.id })} />
                        )}
                        <RefundBox player={u.name} onSend={(amount, note) => act('/api/admin/refund', { name: u.name, amount, note })} />
                        {u.blocked
                          ? <button className="adm-btn" onClick={() => act('/api/admin/block', { name: u.name, blocked: false })}>Unblock</button>
                          : <Danger label="Block" confirm="Block this player"
                            warning={`${u.name} is signed out everywhere and cannot log back in.`}
                            onConfirm={() => act('/api/admin/block', { name: u.name, blocked: true })} />}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {section === 'arena' && (
        <>
          <Panel title="Open for play">
            <div className="adm-set">
              <div className="adm-set-t">
                <b>Classic Arena</b>
                <span>Players settle against each other. The house only takes the fee.</span>
              </div>
              <button className={`adm-btn${S.classicPaused ? ' is-danger' : ''}`}
                onClick={() => act('/api/admin/settings', { classicPaused: !S.classicPaused })}>
                {S.classicPaused ? 'Paused - resume' : 'Running - pause'}
              </button>
            </div>
            <div className="adm-set">
              <div className="adm-set-t">
                <b>Live Arena</b>
                <span>Players keep the coins they pick - a paper book tracks them at live prices.</span>
              </div>
              <button className={`adm-btn${S.livePaused ? ' is-danger' : ''}`}
                onClick={() => act('/api/admin/settings', { livePaused: !S.livePaused })}>
                {S.livePaused ? 'Paused - resume' : 'Running - pause'}
              </button>
            </div>
          </Panel>

          <div className="adm-two">
            <Panel title="Signup credit" note="What a new account starts with, and what a player short of a stake is topped back up to.">
              <div className="adm-choices">
                {[1000, 5000, 10000, 25000].map((v) => (
                  <button key={v} className={`adm-btn${S.signupCredit === v ? ' is-on' : ''}`}
                    onClick={() => act('/api/admin/settings', { signupCredit: v })}>${v}</button>
                ))}
              </div>
            </Panel>

            <Panel title="Live stake ceiling" note="The highest Live table that opens. Raise it as the reserve grows.">
              <div className="adm-choices">
                <select value={rails?.liveMaxStake ?? 10000}
                  onChange={(e) => act('/api/admin/settings', { liveMaxStake: Number(e.target.value) })}>
                  {STAKES.map((v) => <option key={v} value={v}>${v.toLocaleString()}</option>)}
                </select>
              </div>
            </Panel>
          </div>

          {/* Bands, not exact stakes: each key is the SMALLEST stake paying that
              rate, and everything up to the next key pays the same. The rows are
              built from the ladder that is actually stored - a hardcoded list
              silently invented tiers that were never in it. */}
          <Panel
            title="Fee ladder"
            note="Each row is the smallest stake that pays that rate; everything up to the next row pays the same. Shown to players before every entry, and only applied to new battles."
          >
            <div className="adm-tiers">
              {Object.keys(S.feeTiers).map(Number).sort((a, b) => a - b).map((stake) => (
                <label key={stake} className="adm-tier">
                  <span className="adm-tier-s">${stake.toLocaleString()}+</span>
                  <input type="number" min="0" max="100" step="0.5" defaultValue={S.feeTiers[stake]}
                    onBlur={(e) => {
                      const v = Number(e.target.value)
                      if (v === S.feeTiers[stake] || !(v >= 0 && v <= 100)) return
                      act('/api/admin/settings', { feeTiers: { ...S.feeTiers, [stake]: v } })
                    }} />
                  <span className="adm-tier-p">%</span>
                </label>
              ))}
            </div>
          </Panel>
        </>
      )}

      {section === 'tokens' && (
        <Panel title="Curated tokens" note="Overrides for the hand-picked catalogue. The live chain book is not edited here." flush>
          {TOKENS.length === 0 ? <Empty>No curated tokens - the arena runs entirely on the live chain book.</Empty> : (
            <div className="adm-table-wrap">
              <table className="adm-table">
                <thead><tr><th>Token</th><th>Category</th><th>Max stake</th><th>State</th><th className="ta-r" /></tr></thead>
                <tbody>
                  {TOKENS.map((t) => {
                    const o = ov.overrides[t.id] || {}
                    const eff = { ...t, ...o }
                    const edited = Object.keys(o).length > 0
                    return (
                      <tr key={t.id}>
                        <td>
                          <span className="adm-tok"><TokenLogo token={t} size={20} /> <b>{t.ticker}</b>
                            {edited && <span className="adm-pill is-warn">edited</span>}</span>
                        </td>
                        <td>
                          <select value={eff.category} onChange={(e) => act('/api/admin/token/' + t.id, { category: e.target.value })}>
                            {Object.keys(CATEGORY).map((c) => <option key={c} value={c}>{CATEGORY[c].label}</option>)}
                          </select>
                        </td>
                        <td>
                          <select value={eff.maxStake} onChange={(e) => act('/api/admin/token/' + t.id, { maxStake: +e.target.value })}>
                            {[0, 10, 100, 500, 1000].map((v) => <option key={v} value={v}>${v}</option>)}
                          </select>
                        </td>
                        <td>
                          <button className={`adm-btn${eff.paused ? ' is-danger' : ''}`}
                            onClick={() => act('/api/admin/token/' + t.id, { paused: !eff.paused })}>
                            {eff.paused ? 'Paused' : 'Tradable'}
                          </button>
                        </td>
                        <td className="ta-r">
                          {edited && <button className="adm-btn is-ghost" onClick={() => act('/api/admin/token/' + t.id, { clear: true })}>Reset</button>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}

      {section === 'log' && (
        <Panel title="Event log" note="Every action taken in this panel, newest first. Written by the server, not by the browser." flush>
          {ov.log.length === 0 ? <Empty>Nothing recorded yet.</Empty> : (
            <div className="adm-scroll is-tall">
              {ov.log.map((e, i) => (
                <div key={i} className="adm-logrow">
                  <span className="adm-log-t">{new Date(e.ts).toLocaleString()}</span>
                  <span className="adm-log-a">{e.actor}</span>
                  <span className="adm-log-m">{e.msg}</span>
                </div>
              ))}
            </div>
          )}
        </Panel>
      )}
    </div>
  )
}
