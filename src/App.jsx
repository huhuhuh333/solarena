import React, { useEffect, useRef, useState } from 'react'
import { nav, parseRoute, listenRoute } from './engine/route'
import { useApp, mutate, allTokens, markNotifsSeen } from './engine/store'
import { clearFlash, acceptChallenge, doLogout, refreshNotifs, refreshDms, dmThread, dmSend, supportThread, supportSend } from './engine/net'
import { poolLabel } from './engine/tokens'
import { fmtUsd, fmtPrice, durLabel, timeAgo } from './engine/format'
import { getPrice, dayChange } from './engine/prices'
import { Avatar, FeedBadge, NumFlash, useMarket } from './components/ui'
import Play from './screens/Play'
import DuelFlow from './screens/DuelFlow'
import PickTerminal from './screens/PickTerminal'
import Tokens from './screens/Tokens'
import TokenDetail from './screens/TokenDetail'
import Leaderboard from './screens/Leaderboard'
import History, { MatchDetail } from './screens/History'
import Profile from './screens/Profile'
import Wallet from './screens/Wallet'
import Training from './screens/Training'
import Tournaments from './screens/Tournaments'
import Board from './screens/Board'
import { ChallengeCreate, ChallengeAccept } from './screens/Challenge'
import Admin from './screens/Admin'
import Auth from './screens/Auth'
import Tour, { tourSeen, onTourOpen, markSeen as markTourSeen } from './components/tour'
import Rules from './screens/Rules'
import Terms from './screens/Terms'
import Privacy from './screens/Privacy'

const useRoute = () => {
  const [route, setRoute] = useState(parseRoute)
  useEffect(() => listenRoute(setRoute), [])
  return route
}

const SCREENS = {
  play: Play,
  duel: DuelFlow,
  tokens: Tokens,
  token: TokenDetail,
  leaderboard: Leaderboard,
  history: History,
  match: MatchDetail,
  profile: Profile,
  wallet: Wallet,
  training: Training,
  tournaments: Tournaments,
  board: Board,
  'challenge-new': ChallengeCreate,
  challenge: ChallengeAccept,
  admin: Admin,
  login: Auth,
  rules: Rules,
  terms: Terms,
  privacy: Privacy,
}

// Screens that need an account. Everything else is public browsing - the arena
// setup included: a visitor may configure a battle down to the last detail and
// is asked to create a profile only when they try to enter one (Play.jsx).
const PROTECTED = new Set(['duel', 'history', 'profile', 'wallet', 'training', 'tournaments', 'challenge-new', 'challenge', 'admin'])
// Account-only, but still listed for guests (owner, 23 Sep 2026): clicking one
// is the guest asking to sign in, so it shows the login card.
const GUEST_LISTED = new Set(['tournaments', 'training', 'history'])
const guestHides = (to) => PROTECTED.has(to) && !GUEST_LISTED.has(to)

/* One product: the arena. (Predict lived beside it until 23 Sep 2026 and was
   retired by the owner - old /predict links are redirected by the server.) */
const NAV = [
  { to: 'play', label: 'Battle' },
  // Right after Battle: it is the answer when Battle finds nobody, and a
  // visitor should see that tables are waiting before they see an empty
  // queue. One word, because eight full labels wrap the bar onto two rows.
  { to: 'board', label: 'Board' },
  { to: 'tokens', label: 'Tokens' },
  { to: 'leaderboard', label: 'Ranks' },
  { to: 'tournaments', label: 'Tournaments' },
  { to: 'training', label: 'Training' },
  { to: 'history', label: 'History' },
]

// ---- the phone's spine ----
//
// On a phone, navigation lives under the thumb, not in a strip of desktop links
// under the logo. Four destinations and a drawer for the rest. Desktop never
// sees any of this - the whole apparatus is display:none above 600px.
//
// The ︎ variation selector keeps the glyphs as text, not as the coloured
// emoji iOS would otherwise substitute into the UI.
const MOBILE_TABS = [
  { to: 'play', icon: '⚔︎', label: 'Battle' },
  { to: 'board', icon: '▦', label: 'Board' },
  { to: 'tokens', icon: '⬡', label: 'Tokens' },
  { to: 'wallet', icon: '$', label: 'Balance' },
]
const MOBILE_MORE = [
  { to: 'leaderboard', label: 'Ranks' },
  { to: 'tournaments', label: 'Tournaments' },
  { to: 'training', label: 'Training' },
  { to: 'history', label: 'History' },
  { to: 'rules', label: 'Rules & Safety' },
]

// A guest sees what they can open, plus the few account pages worth showing
// off (GUEST_LISTED) - those ask them to sign in. On the phone the
// Balance tab becomes the Sign in button.
const GUEST_TAB = { to: 'login', icon: '→', label: 'Sign in' }

const MobileTabBar = ({ screen, duelActive, moreOpen, onMore, guest }) => (
  <nav className="mtab" aria-label="Primary">
    {MOBILE_TABS.map((t) => (guest && guestHides(t.to) ? GUEST_TAB : t)).map((t) => {
      // A running battle takes over the Battle tab: it pulses, reads LIVE and
      // goes straight back to the fight.
      const live = t.to === 'play' && duelActive
      const active = live ? screen === 'duel' : screen === t.to
      return (
        <a key={t.to} href={live ? '/duel' : '/' + t.to}
          className={`mtab-i${active ? ' on' : ''}${live ? ' live' : ''}`}>
          <span className="mtab-ic" aria-hidden="true">{t.icon}</span>
          <span>{live ? 'LIVE' : t.label}</span>
        </a>
      )
    })}
    <button type="button" className={`mtab-i${moreOpen ? ' on' : ''}`} onClick={onMore}>
      <span className="mtab-ic" aria-hidden="true">⋯</span>
      <span>More</span>
    </button>
  </nav>
)

const MoreSheet = ({ onClose, guest }) => (
  <div className="msheet-wrap" onClick={onClose}>
    <div className="msheet" role="dialog" aria-label="More" onClick={(e) => e.stopPropagation()}>
      <div className="msheet-grab" aria-hidden="true" />
      {MOBILE_MORE.filter((m) => !guest || !guestHides(m.to)).map((m) => (
        <a key={m.to} className="msheet-row" href={'/' + m.to} onClick={onClose}>{m.label}</a>
      ))}
    </div>
  </div>
)

const Flash = ({ msg }) => {
  useEffect(() => {
    const t = setTimeout(clearFlash, 6000)
    return () => clearTimeout(t)
  }, [msg])
  return (
    <div className="flash notice notice-danger" onClick={clearFlash} role="alert">
      {msg} <span className="small muted">(dismiss)</span>
    </div>
  )
}

const clearIncoming = () => mutate((s) => { s.incomingChallenge = null })

// What happened while you weren't looking. The list is rebuilt by the server
// from real records - deposits, payouts, settled battles - so it is the same
// on every device and survives a reload; only the "seen up to here" mark is
// local. Opening the panel marks everything read.
const NOTIF_ICON = { deposit: '↓', withdraw: '↑', win: '🏆', battle: '⚔' }

// Drawn rather than typed: the emoji bell renders as a different picture on
// every OS and never matches the hairline geometry around it. This one takes
// currentColor, so the button alone decides whether it reads quiet or live.
const BellIcon = () => (
  <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor"
    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M17.6 10a5.6 5.6 0 1 0-11.2 0c0 4.3-2 6.2-2 6.2h15.2s-2-1.9-2-6.2" />
    <path d="M13.9 19.4a2.1 2.1 0 0 1-3.8 0" />
  </svg>
)

const Notifications = () => {
  const app = useApp()
  const [open, setOpen] = useState(false)
  const unread = app.notifs.filter((n) => n.ts > app.notifSeen).length

  useEffect(() => {
    if (!open) return
    // the envelope's wrapper reuses this styling family - a click there is
    // OUTSIDE this panel, so exclude it or the two panels stack up
    const close = (e) => { if (!e.target.closest('.nt-wrap:not(.dm-wrap)')) setOpen(false) }
    const esc = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('click', close)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('click', close); document.removeEventListener('keydown', esc) }
  }, [open])

  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next) { refreshNotifs().catch(() => {}); markNotifsSeen() }
  }

  return (
    <div className="nt-wrap">
      <button className={`nt-bell ${unread ? 'has' : ''}`} onClick={toggle}
        aria-label={unread ? `Notifications - ${unread} new` : 'Notifications'}>
        <BellIcon />
        {unread > 0 && <span className="nt-dot">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && (
        <div className="nt-panel">
          <div className="nt-head">Notifications</div>
          {app.notifs.length === 0 ? (
            <p className="small muted nt-empty">Nothing yet. Battle results and rewards land here.</p>
          ) : app.notifs.map((n) => (
            <a key={n.id} className="nt-row" href={n.href} onClick={() => setOpen(false)}>
              <span className={`nt-ico nt-${n.kind}`}>{NOTIF_ICON[n.kind] || '·'}</span>
              <span className="nt-txt">
                <span className="nt-title">{n.title}</span>
                <span className="nt-body">{n.body}</span>
              </span>
              <span className="nt-ago">{timeAgo(n.ts)}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  )
}

// The exchange-floor strip along the bottom: real tickers, real prices, real
// moves from the same feed battles settle on - nothing staged. Two identical
// halves scroll by half their width, which is what makes the loop seamless.
const Ticker = () => {
  useMarket()
  // The 60 busiest playable coins by real 24h volume. The line-up re-forms only
  // when the token LIST itself changes (server list arriving, new ingests) -
  // never on a price tick, so items don't shuffle mid-scroll. Prices and moves
  // inside it stay live.
  const all = allTokens()
  const [ids, setIds] = useState([])
  useEffect(() => {
    // Wash-resistant "busiest": reported volume counts only up to 40× the
    // pool's liquidity. Clone-spam tokens report $10M of fake volume on a
    // $15k pool - real markets never sustain that ratio, so the cap mutes
    // them without touching any honest coin.
    const vol = (t) => {
      const liq = t.reachableLiquidity ?? t.liquidity ?? 0
      return Math.min(t.vol24 ?? t.volume24 ?? 0, liq * 40)
    }
    setIds(all
      .filter((t) => t.category === 'verified' || t.category === 'degen')
      .sort((a, b) => vol(b) - vol(a))
      .slice(0, 60)
      .map((t) => t.id))
  }, [all.length])
  const byId = new Map(all.map((t) => [t.id, t]))
  const toks = ids.map((id) => byId.get(id)).filter(Boolean)
  if (toks.length < 4) return null
  const half = toks.map((t) => {
    const d = Number.isFinite(t.priceChange?.h24) ? t.priceChange.h24 : dayChange(t.id)
    return (
      <span className="tk-item" key={t.id}>
        <b>{t.ticker}</b>
        <span className="tk-price num">{fmtPrice(getPrice(t.id))}</span>
        <span className={`num ${d >= 0 ? 'tk-up' : 'tk-down'}`}>{d >= 0 ? '+' : ''}{(d ?? 0).toFixed(2)}%</span>
      </span>
    )
  })
  return (
    <div className="ticker" aria-hidden="true">
      {/* Speed scales with the line-up so 60 coins roll as fast per-coin as 20. */}
      <div className="tk-track" style={{ animationDuration: `${toks.length * 3}s` }}>
        <div className="tk-half">{half}</div>
        <div className="tk-half">{half}</div>
      </div>
    </div>
  )
}

const IncomingChallenge = ({ c }) => (
  <div className="flash notice notice-info" role="alert">
    <b>{c.from.name}</b> challenges you: ${c.stake} {c.mode}
    {poolLabel(c.pool) && <> · {poolLabel(c.pool)}</>} · {durLabel(c.duration)}
    <span style={{ display: 'inline-flex', gap: 8, marginLeft: 10 }}>
      <button className="btn btn-sm btn-gold" onClick={() => { acceptChallenge(c.code); nav('/duel') }}>Accept</button>
      <button className="btn btn-sm" onClick={clearIncoming}>Ignore</button>
    </span>
  </div>
)

const EnvelopeIcon = () => (
  <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor"
    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="5.5" width="18" height="13" rx="1.5" />
    <path d="m4 7 8 6 8-6" />
  </svg>
)

// Player-to-player messages. The server owns every thread (they follow the
// account, not the browser); the socket only makes delivery instant. One
// panel, two views: conversations, and the open thread with its composer.
const Messages = () => {
  const app = useApp()
  const [open, setOpen] = useState(false)
  const [thread, setThread] = useState(null) // fighter name whose thread is open
  const [msgs, setMsgs] = useState([])
  const [draft, setDraft] = useState('')
  const [newTo, setNewTo] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const listRef = useRef(null)
  const unread = app.dms.unreadTotal

  useEffect(() => {
    if (!open) return
    const close = (e) => { if (!e.target.closest('.dm-wrap')) setOpen(false) }
    const esc = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('click', close)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('click', close); document.removeEventListener('keydown', esc) }
  }, [open])

  // A live message for the thread on screen appends instantly - and the GET
  // marks it read so the badge doesn't claim it's still waiting.
  useEffect(() => {
    if (!app.dmPing || !open || thread !== app.dmPing.from) return
    setMsgs((m) => [...m, { mine: false, body: app.dmPing.body, ts: app.dmPing.ts }])
    dmThread(app.dmPing.from).then(() => refreshDms()).catch(() => {})
  }, [app.dmPing])

  useEffect(() => { if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight }, [msgs, thread, open])

  const toggle = () => {
    const next = !open
    setOpen(next)
    setError(null)
    if (next) { setThread(null); refreshDms().catch(() => {}) }
  }

  const openThread = async (name) => {
    setError(null)
    setThread(name)
    setMsgs([])
    try {
      const t = await dmThread(name)
      setMsgs(t.messages)
      refreshDms().catch(() => {}) // opening is reading
    } catch (e) { setError(e.message) }
  }

  const send = async () => {
    const body = draft.trim()
    if (!body || busy) return
    setBusy(true)
    setError(null)
    try {
      const r = await dmSend(thread, body)
      setMsgs((m) => [...m, { mine: true, body, ts: r.ts }])
      setDraft('')
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  return (
    <div className="nt-wrap dm-wrap">
      <button className={`nt-bell ${unread ? 'has' : ''}`} onClick={toggle}
        aria-label={unread ? `Messages - ${unread} new` : 'Messages'}>
        <EnvelopeIcon />
        {unread > 0 && <span className="nt-dot">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && (
        <div className="nt-panel">
          {thread === null ? (
            <>
              <div className="nt-head">Messages</div>
              <div className="dm-new">
                <input type="text" value={newTo} placeholder="message a fighter by name…"
                  onKeyDown={(e) => { if (e.key === 'Enter' && newTo.trim()) openThread(newTo.trim()) }}
                  onChange={(e) => { setNewTo(e.target.value); setError(null) }} />
                <button className="btn btn-sm" disabled={!newTo.trim()} onClick={() => openThread(newTo.trim())}>Open</button>
              </div>
              {error && <p className="small nt-empty" style={{ color: 'var(--down)' }}>{error}</p>}
              {app.dms.conversations.length === 0 && !error && (
                <p className="small muted nt-empty">No conversations yet - call out an opponent by name.</p>
              )}
              {app.dms.conversations.map((c) => (
                <button key={c.name} className="nt-row dm-convo" onClick={() => openThread(c.name)}>
                  <Avatar size={26} name={c.name}>{c.avatar}</Avatar>
                  <span className="nt-txt">
                    <span className="nt-title">{c.name}{c.unread > 0 && <span className="dm-unread">{c.unread}</span>}</span>
                    <span className="nt-body dm-last">{c.lastMine ? 'You: ' : ''}{c.last}</span>
                  </span>
                  <span className="nt-ago">{timeAgo(c.lastTs)}</span>
                </button>
              ))}
            </>
          ) : (
            <>
              <div className="dm-thread-head">
                <button className="btn-link" onClick={() => { setThread(null); refreshDms().catch(() => {}) }}>‹ Back</button>
                <span className="nt-title">{thread}</span>
              </div>
              <div className="dm-thread" ref={listRef}>
                {msgs.length === 0 && !error && <p className="small muted" style={{ textAlign: 'center', margin: '20px 0' }}>Say something - {thread} sees it instantly if they're online.</p>}
                {error && <p className="small" style={{ color: 'var(--down)', textAlign: 'center' }}>{error}</p>}
                {msgs.map((m, i) => (
                  <div key={i} className={`dm-msg ${m.mine ? 'mine' : ''}`}>
                    <span className="dm-bubble">{m.body}</span>
                    <span className="dm-ts">{timeAgo(m.ts)}</span>
                  </div>
                ))}
              </div>
              <div className="dm-compose">
                <input type="text" value={draft} maxLength={500} placeholder="write a message…" autoFocus
                  onKeyDown={(e) => { if (e.key === 'Enter') send() }}
                  onChange={(e) => { setDraft(e.target.value); setError(null) }} />
                <button className="btn btn-sm btn-gold" disabled={!draft.trim() || busy} onClick={send}>Send</button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/* ---------------- support: the corner button ----------------
   A player who is stuck should not have to find a page for it, so this rides
   every screen from the bottom-right corner. What they write lands in the admin
   panel as a thread, and the reply comes back into this same window - live over
   the socket if they are on the site, behind the badge if they are not.

   Signed-out visitors get the button too. They cannot open a thread (a reply
   needs somebody to reply TO), so it points them at an account and at the
   Telegram channel, which is the honest answer instead of a dead button. */
const SupportIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.9 9.9 0 0 1-3.9-.8L3 21l1.9-4.6A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4Z" />
  </svg>
)

const Support = () => {
  const app = useApp()
  const [open, setOpen] = useState(false)
  const [msgs, setMsgs] = useState([])
  const [draft, setDraft] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const listRef = useRef(null)
  const unread = app.support?.unread || 0

  // A reply arriving while the window is open appends without a refetch.
  useEffect(() => {
    if (!app.supportPing || !open) return
    setMsgs((m) => [...m, { mine: false, body: app.supportPing.body, ts: app.supportPing.ts }])
    supportThread().catch(() => {}) // reading it is marking it read
  }, [app.supportPing])

  useEffect(() => { if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight }, [msgs, open])

  useEffect(() => {
    if (!open) return
    const esc = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [open])

  const toggle = async () => {
    const next = !open
    setOpen(next)
    setError(null)
    if (next && app.user && !loaded) {
      try {
        const t = await supportThread()
        setMsgs(t.messages)
        setLoaded(true)
      } catch (e) { setError(e.message) }
    } else if (next && app.user) {
      supportThread().then((t) => setMsgs(t.messages)).catch(() => {})
    }
  }

  const send = async () => {
    const body = draft.trim()
    if (!body || busy) return
    setBusy(true)
    setError(null)
    try {
      const r = await supportSend(body)
      setMsgs((m) => [...m, { mine: true, body, ts: r.ts }])
      setDraft('')
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  return (
    <div className={`sup-wrap ${open ? 'open' : ''}`}>
      {open && (
        <div className="sup-panel" role="dialog" aria-label="Support">
          <div className="sup-head">
            <span>
              <b>Support</b>
              <span className="sup-sub">{app.user ? 'The arena team reads every message.' : 'We answer here.'}</span>
            </span>
            <button className="sup-x" onClick={() => setOpen(false)} aria-label="Close support">✕</button>
          </div>

          {!app.user ? (
            <div className="sup-guest">
              <p className="small muted">
                Support runs as a conversation, so it needs an account to answer into -
                log in and the button here becomes a thread with the arena.
              </p>
              <div className="sup-guest-actions">
                <a className="btn btn-sm btn-gold" href="/login">Log in or sign up</a>
                <a className="btn btn-sm" href={SOCIALS[1].href} target="_blank" rel="noopener noreferrer">Ask on Telegram</a>
              </div>
            </div>
          ) : (
            <>
              <div className="sup-thread" ref={listRef}>
                {msgs.length === 0 && (
                  <p className="small muted sup-empty">
                    Tell us what went wrong - a battle, a tournament, a coin that looks off.
                    Include what you were doing when it happened and we will pick it up from here.
                  </p>
                )}
                {msgs.map((m, i) => (
                  <div key={i} className={`sup-msg ${m.mine ? 'mine' : ''}`}>
                    {!m.mine && <span className="sup-who">SolArena</span>}
                    <span className="sup-bubble">{m.body}</span>
                    <span className="sup-ts">{timeAgo(m.ts)}</span>
                  </div>
                ))}
              </div>
              {error && <p className="small sup-err">{error}</p>}
              <div className="sup-compose">
                <textarea value={draft} maxLength={1000} rows={2} placeholder="describe the problem…" autoFocus
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
                  onChange={(e) => { setDraft(e.target.value); setError(null) }} />
                <button className="btn btn-sm btn-gold" disabled={!draft.trim() || busy} onClick={send}>
                  {busy ? '…' : 'Send'}
                </button>
              </div>
            </>
          )}
        </div>
      )}
      <button className={`sup-btn ${unread ? 'has' : ''}`} onClick={toggle}
        aria-label={unread ? `Support - ${unread} new reply` : 'Support'}>
        <SupportIcon />
        <span className="sup-btn-txt">Support</span>
        {unread > 0 && <span className="sup-dot">{unread > 9 ? '9+' : unread}</span>}
      </button>
    </div>
  )
}

// Where the arena lives outside the arena.
//
// In the topbar rather than the footer, because the footer is deliberately on the
// profile page only - a community link nobody walks past is a community link
// nobody clicks. Shown to signed-out visitors too: they are exactly the people
// worth putting in front of the Telegram channel.
//
// Marks are inline SVG rather than emoji or a CDN icon font: they inherit the
// current colour, stay crisp at any size, and add no external request.
export const SOCIALS = [
  {
    name: 'X',
    href: 'https://x.com/SolArenaFun',
    path: 'M18.9 2H22l-6.8 7.8L23 22h-6.3l-4.9-6.4L6.1 22H3l7.3-8.3L2.4 2h6.5l4.4 5.8L18.9 2Zm-1.1 18h1.7L8.3 3.8H6.5L17.8 20Z',
  },
  {
    name: 'Telegram',
    href: 'https://t.me/hoodarenalive',
    path: 'M21.9 4.3 18.7 19c-.2 1.1-.9 1.3-1.8.8l-5-3.7-2.4 2.3c-.3.3-.5.5-1 .5l.4-5 9.2-8.3c.4-.4-.1-.6-.6-.2L6.2 12.5l-4.9-1.5c-1-.3-1.1-1 .2-1.5l19.2-7.4c.9-.3 1.6.2 1.3 1.5l-.1.7Z',
  },
]

const Socials = () => (
  <span className="socials">
    {SOCIALS.map((s) => (
      <a
        key={s.name}
        className="social-link"
        href={s.href}
        target="_blank"
        // noopener: the opened page must not get a handle on this window.
        rel="noopener noreferrer"
        title={`SolArena on ${s.name}`}
        aria-label={`SolArena on ${s.name}`}
      >
        <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true">
          <path d={s.path} />
        </svg>
      </a>
    ))}
  </span>
)

export default function App() {
  const { screen: raw, params } = useRoute()
  const app = useApp()
  const playableNow = app.wallet.balance
  // No landing page: opening the site drops you straight into the arena, the
  // way every trading front-end this competes with does. An unknown route lands
  // there too rather than on a dead end.
  const screen = raw === '' || !SCREENS[raw] ? 'play' : raw
  const guest = !app.user
  // A guest on an account-only page: an invite link (challenge) still asks
  // them to sign in, since that is what they came to do; anything else goes
  // back to Battle instead of throwing a login card at them.
  const asksLogin = screen === 'challenge' || GUEST_LISTED.has(screen)
  const needsAuth = PROTECTED.has(screen) && guest && asksLogin
  const bounceGuest = PROTECTED.has(screen) && guest && !asksLogin
  useEffect(() => { if (bounceGuest && app.auth.ready) nav('/play') }, [bounceGuest, app.auth.ready])
  const duelActive = app.duel && !['done', 'cancelled'].includes(app.duel.phase)

  // The phone drawer. Closes itself on any navigation - a sheet left open over
  // a page you just chose reads as the page failing to load.
  const [moreOpen, setMoreOpen] = useState(false)
  useEffect(() => { setMoreOpen(false) }, [screen, params[0]])

  // Tab title follows the screen. Crawlers get theirs from the server-injected
  // <title>; this is for the humans' tab bar and history, so client-side
  // navigation doesn't leave every entry reading the same.
  useEffect(() => {
    const t = {
      play: 'Battle', board: 'Challenge Board', tokens: 'Tokens', token: 'Token',
      leaderboard: 'Leaderboard', tournaments: 'Tournaments', training: 'Training',
      history: 'Battle History',
      wallet: 'Wallet', profile: 'Profile', duel: 'Live Battle', match: 'Battle Log',
      rules: 'Rules & Safety', terms: 'Terms of Service',
      privacy: 'Privacy Policy', login: 'Log in',
    }[screen]
    document.title = t ? `${t} - SolArena` : 'SolArena - Pick your coins. Beat your opponent. Take the pool.'
  }, [screen])

  // The intro, once per browser.
  //
  // Two moments hold it back, both for the same reason - it must never land on
  // top of something the visitor came here to do:
  //   • while a battle is running: money is on the table and the clock is real
  //   • on a challenge page: that visitor followed a link to take ONE specific
  //     table. Their first screen has to be the challenge, not a slideshow.
  //     Registration counts too, since a challenge is account-only and the
  //     route stays 'challenge' while the auth card is up.
  //
  // The intro is not lost, only deferred: accepting sends them to the duel,
  // where the battle suppresses it, and it opens on the result screen once the
  // fight is behind them - which is when it can finally be read as "here is
  // what you just did, and what else is here". If the challenge turns out to be
  // gone and they browse off to any other screen, it opens there instead.
  const [toured, setToured] = useState(() => tourSeen())
  // Signed-in players never get it on their own (owner, 23 Sep 2026) - only a
  // guest's first visit, or someone who asks for it again (`forced`).
  const [forced, setForced] = useState(false)
  useEffect(() => { if (app.user) markTourSeen() }, [app.user])
  const showTour = (forced || (!toured && !app.user)) && !duelActive && screen !== 'challenge' && app.auth.ready
  useEffect(() => onTourOpen(() => { setForced(true); setToured(false) }), [])

  // Hand the screen over from the boot layer. It fades rather than vanishing -
  // a hard cut at this size reads as a flicker - and is removed afterwards so
  // a fixed, full-viewport element is not left sitting over the app forever.
  useEffect(() => {
    if (!app.auth.ready) return undefined
    const boot = document.getElementById('boot')
    if (!boot) return undefined
    boot.classList.add('done')
    const t = setTimeout(() => boot.remove(), 500)
    return () => clearTimeout(t)
  }, [app.auth.ready])

  // Nothing to draw while auth is still in flight: the boot screen in
  // index.html is already covering the viewport, and it has been since the
  // first paint - long before this bundle existed. Rendering a second
  // loading state here would only make the two cross-fade into each other.
  if (!app.auth.ready) return null


  // The pick phase takes over the whole viewport as a trading terminal.
  if (app.user && screen === 'duel' && app.duel?.phase === 'picking') {
    return <PickTerminal nav={nav} />
  }
  const Screen = needsAuth ? Auth : bounceGuest ? () => null : SCREENS[screen]

  return (
    <div className="shell">
      {/* Ambient chrome: searchlight beams behind the page, film grain over
          everything. The rotating sky itself lives on body::before. */}
      <div className="bg-beams" aria-hidden="true" />
      <div className="bg-noise" aria-hidden="true" />
      <header className="topbar">
        <a className="logo" href="/play">SOL<em>ARENA</em></a>
        <nav className="nav">
          {NAV.filter((item) => !guest || !guestHides(item.to)).map((item) => (
            <a key={item.to} href={'/' + item.to} className={screen === item.to ? 'active' : ''}>{item.label}</a>
          ))}
          {duelActive && (
            <a href="/duel" className={screen === 'duel' ? 'active' : ''} style={{ color: 'var(--you)' }}>
              ⚔ LIVE
            </a>
          )}
        </nav>
        <div className="topbar-right">
          <Socials />
          <FeedBadge />
          {app.user ? (
            <>
              <Messages />
              <Notifications />
              {/* What they can put on a table right now, not what our ledger
                  happens to be holding. Those are the same number on a custodial
                  rail and very different ones here: a player with an approved
                  wallet, or money in the escrow contract, has everything to play
                  with and nothing in our ledger until a battle starts. Showing
                  the ledger meant the header read $0.00 while the Play screen
                  correctly said they could enter. */}
              <a className="balance-chip" href="/wallet"><NumFlash value={playableNow}>{fmtUsd(playableNow)}</NumFlash></a>
              <a href="/profile" title={app.user.name}>
                <Avatar size={36} name={app.user.name}>{app.user.avatar}</Avatar>
              </a>
              {app.user.isAdmin && <a href="/admin" title="Admin panel" className="muted" style={{ fontSize: 18 }}>⚙</a>}
              {/* Hidden on phones (see styles): the same action lives on the
                  Profile page, where a thumb actually goes looking for it. */}
              <button className="btn btn-sm btn-ghost topbar-exit" title="Log out" onClick={() => { doLogout(); nav('/') }}>Exit</button>
            </>
          ) : (
            <a className="btn btn-sm btn-gold" href="/login">Sign in</a>
          )}
        </div>
      </header>

      {app.flash && <Flash msg={app.flash} />}
      {app.incomingChallenge && <IncomingChallenge c={app.incomingChallenge} />}

      {/* Keyed by route so a page change remounts the content and the CSS
          entry stagger plays again. */}
      <main key={screen + '/' + (params[0] || '')}>
        <Screen nav={nav} params={params} />
      </main>

      {/* One footer, on the profile page only (owner's call): every other
          screen ends at its own content, with the price strip under it. The
          legal pages live here - they used to hang off the landing page that
          no longer exists. */}
      {screen === 'profile' && (
        <footer className="footer">
          <span>Two players. Same stake. Three tokens. One winner.</span>
          <span>Play responsibly - only stake what you can afford to lose.</span>
          <span className="footer-legal">
            <a href="/rules">Rules &amp; Safety</a>
            <a href="/terms">Terms of Service</a>
            <a href="/privacy">Privacy Policy</a>
            {SOCIALS.map((s) => (
              <a key={s.name} href={s.href} target="_blank" rel="noopener noreferrer">{s.name}</a>
            ))}
          </span>
        </footer>
      )}
      <Ticker />
      {/* Rides every screen except the pick terminal, which takes the whole
          viewport for 90 seconds and has no room for a chat window. */}
      <Support />
      {showTour && <Tour onClose={() => { setToured(true); setForced(false) }} />}
      {/* Phones only (display:none above 600px). The duel screen keeps the
          whole viewport - mid-battle, the game IS the navigation. */}
      {screen !== 'duel' && (
        <MobileTabBar screen={screen} guest={guest}
          duelActive={duelActive} moreOpen={moreOpen} onMore={() => setMoreOpen((v) => !v)} />
      )}
      {moreOpen && <MoreSheet guest={guest} onClose={() => setMoreOpen(false)} />}
    </div>
  )
}
