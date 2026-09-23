// Global app state fed by the server (see net.js). The server owns wallets,
// stats, matches, the active duel and tournaments; this store is the
// client-side mirror. localStorage keeps only the session token.

import { useSyncExternalStore } from 'react'
import { TOKENS, tokenById } from './tokens'
import { FEE_PCT_DEFAULT } from './format'

const TOKEN_KEY = 'hood_token'
// Only the "you've seen up to here" mark lives locally - the notifications
// themselves are rebuilt from the server, so they follow the account, not the
// browser.
const SEEN_KEY = 'hood_notif_seen'

const emptyStats = () => ({ matches: 0, wins: 0, losses: 0, draws: 0, earned: 0, biggestWin: 0, streak: 0, bestStreak: 0 })

let state = {
  auth: {
    token: (() => { try { return localStorage.getItem(TOKEN_KEY) } catch { return null } })(),
    ready: false,          // true once /api/me resolved (or there was no token)
    error: null,
  },
  conn: 'offline',         // 'offline' | 'connecting' | 'online'
  user: null,              // { name, avatar, bio, isAdmin }
  // balance is dollars at the current SOL price; balanceCoin is the SOL actually
  // held. The wallet screen shows both so a price move never reads as a bug.
  wallet: { balance: 0, balanceCoin: 0, coinUsd: 0, funds: {}, txs: [] },
  stats: { classic: emptyStats(), live: emptyStats(), training: emptyStats(), tourney: { ...emptyStats(), paid: 0 } },
  matches: [],
  trainingDone: false,
  duel: null,              // server snapshot of the active battle (or a local 'searching' stub)
  queueSearching: 0,
  queueOffer: null,        // { opponent, yourStake, theirStake, text } - match down to a smaller table?
  incomingChallenge: null, // { code, from, mode, stake, duration, expires }
  notifs: [],              // server-built feed: deposits, payouts, results
  dms: { conversations: [], unreadTotal: 0 }, // direct messages, server-owned
  dmPing: null,            // last live-delivered message ({from, body, ts}) - open threads append it
  support: { unread: 0 },  // replies from the arena the player hasn't read
  supportPing: null,       // last live-delivered reply ({body, ts}) - an open widget appends it
  notifSeen: (() => { try { return Number(localStorage.getItem(SEEN_KEY)) || 0 } catch { return 0 } })(),
  tourneys: null,          // public tournament lobby board from the server
  tokensEff: null,         // effective token list from the server (admin overrides applied)
  config: { feeTiers: { ...FEE_PCT_DEFAULT }, classicPaused: false, livePaused: false, liveMaxStake: 1000 },
  feed: 'sim',
}

let version = 0
const listeners = new Set()
const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn) }
const getVersion = () => version

export const emit = () => { version++; listeners.forEach((fn) => fn()) }

export const mutate = (fn) => { fn(state); emit() }

export const markNotifsSeen = () => {
  const newest = state.notifs[0]?.ts || Date.now()
  state.notifSeen = Math.max(state.notifSeen, newest)
  try { localStorage.setItem(SEEN_KEY, String(state.notifSeen)) } catch { /* ignore */ }
  emit()
}

export const setToken = (token) => {
  state.auth.token = token
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch { /* ignore */ }
  emit()
}

export const getState = () => state
export const useApp = () => { useSyncExternalStore(subscribe, getVersion); return state }

// ---- token view (server-effective list when available) ----
export const effToken = (id) => {
  if (state.tokensEff) {
    const t = state.tokensEff.find((x) => x.id === id)
    if (t) return t
  }
  return tokenById(id)
}
export const allTokens = () => (state.tokensEff && state.tokensEff.length ? state.tokensEff : TOKENS)
