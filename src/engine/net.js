// Network layer: REST + websocket client for the SolArena server.
// The server owns all game state; this module mirrors it into the store.
// Same-origin everywhere: vite proxies /api and /ws to :8787 in dev, and in
// production the server serves the built frontend itself.

import { getState, mutate, setToken } from './store'
import { applyServerTick, setFeedStatus, applyServerPrices } from './prices'
import { nav } from './route'

const authHeaders = () => {
  const t = getState().auth.token
  return t ? { authorization: 'Bearer ' + t } : {}
}

export const api = async (path, { method = 'GET', body } = {}) => {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new NetError(data.error || `Request failed (${res.status})`, res.status)
  return data
}

export class NetError extends Error {
  constructor(msg, status) { super(msg); this.status = status }
}

// ---- websocket ----
let ws = null
let retryTimer = null
let retryDelay = 1000
let wantConnection = false

const wsUrl = () => {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}/ws?token=${getState().auth.token}`
}

const connectWs = () => {
  if (!wantConnection || !getState().auth.token) return
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
  mutate((s) => { s.conn = 'connecting' })
  ws = new WebSocket(wsUrl())

  ws.onopen = () => {
    retryDelay = 1000
    mutate((s) => { s.conn = 'online' })
    send({ type: 'market.sub' })
  }

  ws.onmessage = (e) => {
    let msg
    try { msg = JSON.parse(e.data) } catch { return }
    handleMessage(msg)
  }

  ws.onclose = (e) => {
    mutate((s) => { s.conn = 'offline' })
    if (e.code === 4001 || e.code === 4003) { // bad token / blocked - don't hammer
      wantConnection = false
      if (e.code === 4001) doLogoutLocal()
      return
    }
    if (wantConnection) {
      clearTimeout(retryTimer)
      retryTimer = setTimeout(connectWs, retryDelay)
      retryDelay = Math.min(retryDelay * 2, 15000)
    }
  }

  ws.onerror = () => { try { ws.close() } catch { /* ignore */ } }
}

const send = (msg) => {
  if (ws && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(msg)); return true }
  return false
}

// ---- message handling ----

const mapDone = (snap) => ({
  // shape a finished server duel into the match-record shape the screens use
  id: snap.id, ts: Date.now(), mode: snap.mode, training: snap.training,
  stake: snap.stake, duration: snap.duration, feePct: snap.feePct,
  fee: snap.fee, pool: snap.pool, battlePool: snap.battlePool || null,
  opp: { name: snap.opp.name, avatar: snap.opp.avatar },
  ...snap.result,
  events: snap.events,
})

const handleMessage = (msg) => {
  switch (msg.type) {
    case 'hello': {
      mutate((s) => {
        s.user = msg.user
        s.wallet.balance = msg.balance
        if (msg.balanceCoin != null) s.wallet.balanceCoin = msg.balanceCoin
        if (msg.coinUsd) s.wallet.coinUsd = msg.coinUsd
        if (msg.funds) s.wallet.funds = msg.funds
        s.trainingDone = msg.trainingDone
        s.feed = msg.feed
        if (msg.tourneys) s.tourneys = msg.tourneys
        if (msg.duel) s.duel = { ...msg.duel, live: liveInit(msg.duel) }
        else if (msg.inQueue) { /* keep searching stub if we have one */ }
        else if (s.duel && !['done', 'cancelled'].includes(s.duel.phase) && s.duel.phase !== 'searching') s.duel = null
      })
      setFeedStatus(msg.feed)
      break
    }
    case 'wallet': {
      // A balance that moved without a battle behind it is a deposit landing or
      // a withdrawal resolving - both are things the feed should already know.
      const before = getState().wallet.balance
      mutate((s) => {
        s.wallet.balance = msg.balance
        if (msg.balanceCoin != null) s.wallet.balanceCoin = msg.balanceCoin
        if (msg.coinUsd) s.wallet.coinUsd = msg.coinUsd
        if (msg.funds) s.wallet.funds = msg.funds
      })
      if (Math.abs(msg.balance - before) > 0.004) refreshNotifs().catch(() => {})
      break
    }
    case 'queue.status': {
      mutate((s) => {
        s.queueSearching = msg.searching
        if (s.duel?.phase === 'searching') s.duel.playersSearching = msg.searching
      })
      break
    }
    case 'queue.left': {
      mutate((s) => { if (s.duel?.phase === 'searching') s.duel = null; s.queueOffer = null })
      break
    }
    // Nobody at your number - the arena proposes the nearest smaller table.
    case 'queue.offer': {
      mutate((s) => { s.queueOffer = msg })
      break
    }
    case 'queue.offerGone': {
      mutate((s) => { s.queueOffer = null })
      break
    }
    case 'duel.state': {
      const wasPicking = getState().duel?.id === msg.duel.id && getState().duel?.phase === 'picking'
      mutate((s) => {
        const prevLive = s.duel?.id === msg.duel.id ? s.duel.live : null
        s.duel = { ...msg.duel, live: msg.duel.phase === 'live' ? (prevLive || liveInit(msg.duel)) : null }
      })
      // A tournament's pick phase starts while the player is anywhere in the
      // app (the lobby countdown ran without them watching) - pull them in.
      // Money is locked and the clock is running; this is the one moment where
      // yanking the screen is what the player wants.
      if (msg.duel.tourney && msg.duel.phase === 'picking' && !wasPicking && !location.pathname.startsWith('/duel')) {
        nav('/duel')
      }
      // A settled tournament changed the stats and the history - a duel does
      // this via duel.done, tournaments arrive as a state push.
      if (msg.duel.tourney && msg.duel.phase === 'done') {
        refreshMe().catch(() => {})
        refreshNotifs().catch(() => {})
      }
      break
    }
    case 'duel.tick': {
      mutate((s) => {
        if (s.duel?.id !== msg.duelId) return
        // The server owns the truth; the local countdown only smooths the gaps
        // between its ticks. Take the lower of the two so a late tick can
        // never make the clock jump BACKWARDS - a rewinding timer reads as a
        // bug even when the number is right.
        const local = s.duel.live?.remaining
        const remaining = Number.isFinite(local) ? Math.min(local, msg.remaining) : msg.remaining
        s.duel.live = {
          remaining, prices: msg.prices, retYou: msg.retYou, retOpp: msg.retOpp,
          // Every trade that landed inside the last second, already turned into
          // both players' returns by the server. Carries `msAgo` so the chart
          // can place each one between the per-second points instead of
          // drawing a staircase. Purely for drawing - the scoreboard and the
          // settlement still read the tick's own numbers.
          micro: msg.micro || null, at: Date.now(),
        }
        s.feed = msg.feed
      })
      break
    }
    case 'tourney.lobbies': {
      mutate((s) => { s.tourneys = msg.lobbies })
      break
    }
    // Somebody posted a table or took one. A counter rather than the payload:
    // the board is public and cheap to re-read, and pushing every listing to
    // every socket would send the whole board to people who are not looking at
    // it.
    case 'board.changed': {
      mutate((s) => { s.boardTick = (s.boardTick || 0) + 1 })
      break
    }
    case 'tourney.tick': {
      mutate((s) => {
        if (s.duel?.id !== msg.id) return
        s.duel.live = { remaining: msg.remaining, prices: msg.prices, rows: msg.rows }
        s.feed = msg.feed
      })
      break
    }
    case 'duel.done': {
      const match = mapDone(msg.duel)
      mutate((s) => {
        s.duel = { ...msg.duel, live: null }
        s.matches = [match, ...s.matches.filter((m) => m.id !== match.id)].slice(0, 60)
        if (match.training) s.trainingDone = true
      })
      refreshMe().catch(() => {})
      if (!match.training) refreshNotifs().catch(() => {})
      break
    }
    case 'duel.cancelled': {
      mutate((s) => { s.duel = { phase: 'cancelled', banner: msg.reason, byAdmin: msg.byAdmin } })
      break
    }
    case 'dm': {
      // The ping lets an OPEN thread append instantly; the summary refresh
      // keeps the envelope badge honest everywhere else.
      mutate((s) => { s.dmPing = { from: msg.from, avatar: msg.avatar, body: msg.body, ts: msg.ts } })
      refreshDms().catch(() => {})
      break
    }
    case 'support': {
      // An open widget appends it instantly; the badge covers every other screen.
      mutate((s) => { s.supportPing = { body: msg.body, ts: msg.ts }; s.support = { unread: (s.support.unread || 0) + 1 } })
      break
    }
    case 'challenge.incoming': {
      mutate((s) => { s.incomingChallenge = { code: msg.code, from: msg.from, mode: msg.mode, stake: msg.stake, duration: msg.duration, pool: msg.pool, expires: msg.expires } })
      break
    }
    case 'challenge.expired': {
      mutate((s) => { s.flash = 'Your challenge expired - stake refunded.' })
      break
    }
    case 'market.tick': {
      applyServerTick(msg.prices)
      if (getState().feed !== msg.feed) mutate((s) => { s.feed = msg.feed })
      setFeedStatus(msg.feed)
      break
    }
    case 'error': {
      mutate((s) => {
        if (msg.re === 'duel.lock' && s.duel) s.duel.banner = msg.msg
        else if (['queue.join', 'training.start', 'challenge.accept'].includes(msg.re)) {
          if (s.duel?.phase === 'searching') s.duel = null
          s.flash = msg.msg
        } else s.flash = msg.msg // tourney.join / tourney.leave land here too
      })
      break
    }
    default: break
  }
}

const liveInit = (snap) => (snap.phase === 'live'
  ? { remaining: snap.remaining ?? snap.duration, prices: { ...snap.startPrices }, retYou: 0, retOpp: 0 }
  : null)

// Smooth countdowns between server messages.
//
// The live clock used to move ONLY when a server tick arrived, so any hiccup -
// a busy event loop, a slow network moment - showed up as a frozen timer in
// the middle of a battle. Measured on our own server before the fix: gaps of
// up to six seconds. The countdown now runs locally every second and every
// server tick RESYNCS it, so the display is smooth while the server stays the
// only authority on how much time is actually left.
setInterval(() => {
  const s = getState()
  if (s.duel?.phase === 'picking' && s.duel.pickLeft > 0) mutate((x) => { x.duel.pickLeft-- })
  if (s.duel?.phase === 'live' && s.duel.live?.remaining > 0) {
    mutate((x) => { x.duel.live.remaining = Math.max(0, x.duel.live.remaining - 1) })
  }
}, 1000)

// Token stats (mcap, liquidity, txns, socials, new listings) refresh - prices
// themselves stream over the websocket every second.
setInterval(() => { if (!document.hidden) loadPublic().catch(() => {}) }, 15000)

// ---- auth flows ----

export const initNet = async () => {
  loadPublic().catch(() => {})
  const token = getState().auth.token
  if (!token) { mutate((s) => { s.auth.ready = true }); return }
  try {
    const me = await api('/api/me')
    mutate((s) => {
      s.user = me.user
      s.wallet.balance = me.balance
      if (me.balanceCoin != null) s.wallet.balanceCoin = me.balanceCoin
      if (me.coinUsd) s.wallet.coinUsd = me.coinUsd
      s.stats = me.stats
      s.trainingDone = me.trainingDone
      s.auth.ready = true
    })
    wantConnection = true
    connectWs()
    refreshNotifs().catch(() => {})
    refreshDms().catch(() => {})
    refreshSupport().catch(() => {})
  } catch (e) {
    if (e.status === 401) setToken(null)
    mutate((s) => { s.auth.ready = true })
  }
}

// ?charts=embed / ?charts=lw - a per-browser override so both engines can be
// compared without touching the server.
const chartOverride = () => {
  try {
    const v = new URLSearchParams(location.search).get('charts')
    return v === 'embed' || v === 'lw' ? v : null
  } catch { return null }
}

export const loadPublic = async () => {
  const [cfg, toks] = await Promise.all([api('/api/config'), api('/api/tokens')])
  mutate((s) => {
    s.config = {
      feeTiers: cfg.feeTiers, classicPaused: cfg.classicPaused, livePaused: cfg.livePaused,
      liveMaxStake: cfg.liveMaxStake ?? 1000,
      stakes: cfg.stakes || [], hedgeMinUsd: cfg.hedgeMinUsd ?? 1,
      // Which chart engine draws: 'lw' (ours, from our own candle service) or
      // 'embed' (the DexScreener iframe, the way it was). The server decides;
      // ?charts= in the URL overrides it for one browser.
      charts: chartOverride() || cfg.charts || 'lw',
    }
    s.tokensEff = toks.tokens
    s.feed = toks.feed
  })
  // The list carries the server's live price per token, so this both seeds
  // tokens the client has never seen and corrects the ones it seeded from the
  // catalog. Without it the bottom strip simulated its own prices whenever no
  // websocket was feeding it - which is every visitor who is not logged in.
  applyServerPrices(toks.tokens.map((t) => ({
    id: t.id, price: t.base, day: t.change24 ?? t.priceChange?.h24 ?? null, real: !t.sim,
  })))
}

export const doLogin = async (name, password) => {
  const r = await api('/api/login', { method: 'POST', body: { name, password } })
  applyAuth(r)
}

export const doRegister = async (name, password) => {
  const r = await api('/api/register', { method: 'POST', body: { name, password } })
  applyAuth(r)
}

const applyAuth = (r) => {
  setToken(r.token)
  mutate((s) => {
    s.user = r.user
    s.wallet.balance = r.balance
    if (r.balanceCoin != null) s.wallet.balanceCoin = r.balanceCoin
    if (r.coinUsd) s.wallet.coinUsd = r.coinUsd
    s.trainingDone = r.trainingDone
    s.auth.ready = true
    s.matches = []
  })
  wantConnection = true
  connectWs()
  refreshMe().catch(() => {})
  refreshNotifs().catch(() => {})
  refreshDms().catch(() => {})
  refreshSupport().catch(() => {})
}

const doLogoutLocal = () => {
  setToken(null)
  mutate((s) => {
    s.user = null
    s.wallet = { balance: 0, balanceCoin: 0, coinUsd: 0, funds: {}, txs: [] }
    s.matches = []
    s.duel = null
    s.trainingDone = false
    s.conn = 'offline'
  })
}

export const doLogout = async () => {
  wantConnection = false
  try { await api('/api/logout', { method: 'POST' }) } catch { /* best effort */ }
  try { ws?.close() } catch { /* ignore */ }
  doLogoutLocal()
}

// ---- data refreshers ----

export const refreshMe = async () => {
  const me = await api('/api/me')
  mutate((s) => {
    s.user = me.user
    s.wallet.balance = me.balance
    if (me.balanceCoin != null) s.wallet.balanceCoin = me.balanceCoin
    if (me.coinUsd) s.wallet.coinUsd = me.coinUsd
    s.stats = me.stats
    s.trainingDone = me.trainingDone
  })
}

export const refreshWallet = async () => {
  const w = await api('/api/wallet')
  mutate((s) => {
    s.wallet = {
      balance: w.balance,
      balanceCoin: w.balanceCoin || 0,
      coinUsd: w.coinUsd || 0,
      funds: w.funds || {},
      txs: w.txs,
    }
  })
}

export const refreshHistory = async () => {
  const h = await api('/api/history')
  mutate((s) => { s.matches = h.matches })
}

export const refreshNotifs = async () => {
  const r = await api('/api/notifications')
  mutate((s) => { s.notifs = r.notifications })
}

// ---- direct messages ----
export const refreshDms = async () => {
  const r = await api('/api/messages')
  mutate((s) => { s.dms = r })
}
export const dmThread = (name) => api('/api/messages/' + encodeURIComponent(name))
export const dmSend = (name, body) => api('/api/messages/' + encodeURIComponent(name), { method: 'POST', body: { body } })

// ---- support ----
// The player's line to the house. `refreshSupport` is the badge only; the thread
// is pulled when the widget opens, and opening it marks the replies read.
export const refreshSupport = async () => {
  const r = await api('/api/support/unread')
  mutate((s) => { s.support = { unread: r.unread } })
}
export const supportThread = async () => {
  const r = await api('/api/support')
  mutate((s) => { s.support = { unread: 0 } }) // the GET marked them read server-side
  return r
}
export const supportSend = (body) => api('/api/support', { method: 'POST', body: { body } })

// ---- game actions ----

export const queueJoin = (cfg) => {
  mutate((s) => {
    s.duel = {
      phase: 'searching', mode: cfg.mode, stake: cfg.stake, duration: cfg.duration,
      battlePool: cfg.pool || null,
      training: false, playersSearching: Math.max(1, s.queueSearching),
    }
  })
  send({ type: 'queue.join', ...cfg })
}

// Answer the "take a smaller table?" question. Declining just keeps you queued
// at your own number; the arena may offer a different opponent later.
export const queueOfferReply = (accept) => {
  mutate((s) => { s.queueOffer = null })
  send({ type: 'queue.offerReply', accept })
}

export const trainingStart = (opts = {}) => {
  mutate((s) => {
    s.duel = {
      phase: 'searching', mode: 'classic', stake: 0, duration: opts.duration || 300,
      battlePool: opts.pool || null,
      training: true, opponentName: opts.opponentName || null, playersSearching: 1,
    }
  })
  send({ type: 'training.start', ...opts })
}

export const lockPicks = (picks) => { send({ type: 'duel.lock', picks }) }

// ---- tournaments ----
export const tourneyJoin = (tier, pool) => { send({ type: 'tourney.join', tier, pool }) }
export const tourneyLeave = () => { send({ type: 'tourney.leave' }) }
export const refreshTourneys = async () => {
  const r = await api('/api/tournaments')
  mutate((s) => { s.tourneys = r.lobbies })
  return r
}

export const duelCancel = () => {
  const d = getState().duel
  if (!d) return
  if (d.phase === 'searching') {
    send({ type: 'queue.leave' })
    mutate((s) => { if (s.duel?.phase === 'searching') s.duel = null })
  } else send({ type: 'duel.cancel' })
}

export const leaveDuelLocal = () => mutate((s) => { s.duel = null })

export const acceptChallenge = (code) => {
  mutate((s) => {
    s.incomingChallenge = null
    if (!s.duel) s.duel = { phase: 'searching', mode: 'classic', stake: 0, duration: 300, training: false, playersSearching: 1, opponentName: 'your challenger' }
  })
  send({ type: 'challenge.accept', code })
}

export const clearFlash = () => mutate((s) => { s.flash = null })

export const isOnline = () => getState().conn === 'online'
