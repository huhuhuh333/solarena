// Multiplayer tournaments: 5-10 players, one Classic battle, the top of the
// field takes the pot. Server-authoritative like duels - lobbies are the
// matchmaking queues' bigger sibling, and settlement runs the same TWAP math
// portfolioReturn gives a 1v1, just ranked across the whole field.
//
// The house never holds a position here: Classic buys nothing, the N entries
// settle against each other, so a 10-player pot is exactly as safe for the
// treasury as a 1v1 - the only house money is the fee, taken from the pot.
//
// Lobby rules (owner-agreed):
//   - the lobby stands open; below MIN_PLAYERS nothing happens and nobody waits
//   - the moment the MIN-th player joins, a COUNTDOWN starts; at zero the
//     tournament starts with whoever is in. Filling to MAX starts it instantly.
//   - Leave is a full refund at any point before the battle starts. Dropping
//     below MIN stops the clock; it restarts when the field refills.
//   - pick phase is simultaneous (PICK_SECONDS). Not locking in time refunds
//     the entry and drops the player; if that leaves fewer than MIN, the whole
//     tournament cancels and refunds everyone.
//   - one battle start for everyone in the same tick: identical start prices.
//
// Payouts scale with the field, so a 5-man tournament is winner-take-all and a
// full table pays three places. Ties within DRAW_THRESHOLD share the combined
// prize of the positions they span - the 1v1 "draw splits" rule, generalized.

import { randomUUID } from 'node:crypto'
import { onTick, simTime, getPrice, twap, portfolioReturn, getFeedStatus } from './market.js'
import { PICK_SECONDS, DRAW_THRESHOLD, FEED_LOSS_VOID_SECS, feeFor, validatePicks, validateConfig } from './rules.js'
import {
  db, txn, creditLike, lockStake, releaseLock, getLock, lockPlan, adminLog,
} from './db.js'
import { ensureFunded, payoutWinnings } from './wallet.js'

export const MIN_PLAYERS = Number(process.env.HOOD_TOURNEY_MIN) || 5
export const MAX_PLAYERS = Number(process.env.HOOD_TOURNEY_MAX) || 10
export const COUNTDOWN_SECS = Number(process.env.HOOD_TOURNEY_COUNTDOWN) || 180

// Three stakes, and every stake's table exists once per battle pool - a
// tournament is one battle, and one battle plays inside one pool. Duration is
// FIXED per table (players never choose it; a shared battle needs one clock).
export const TOURNEY_TIERS = [
  { tier: 't10', stake: 10, duration: 300 },
  { tier: 't50', stake: 50, duration: 300 },
  { tier: 't100', stake: 100, duration: 300 },
]
// Solana Memes only - the arena's one battle pool. A pool whose token list can't
// field a battle right now (e.g. before the ingest has 3 eligible coins at this
// duration) reports itself `blocked` with the reason instead of taking anyone's
// money.
export const TOURNEY_POOLS = ['sol']

// Which places pay, by field size. Winner-take-all is the owner's call for the
// small field (1-in-5 odds carries it); a full table pays three places because
// nine straight $100 losses before a first win drives players out.
export const payoutSpec = (n) => (n >= 9 ? [50, 30, 20] : n >= 7 ? [70, 30] : [100])

// The fee band is chosen by the POT, not the entry: ten $50 entries make a
// $500 pot, and $500 pays the $500 rate. Keying by entry would charge a $50
// tournament the 10% micro-stakes rate - backwards for the biggest tables.
export const tourneyMoney = (n, stake) => {
  const pot = Math.round(n * stake * 100) / 100
  const { pct } = feeFor(pot)
  const fee = Math.round(pot * pct) / 100
  return { pot, pct, fee, prizePool: Math.round((pot - fee) * 100) / 100 }
}

// Preview table shown in lobbies and the pick phase: [{place, amount}].
export const payoutTable = (n, stake) => {
  const { prizePool } = tourneyMoney(n, stake)
  return payoutSpec(n).map((pct, i) => ({ place: i + 1, amount: Math.round(prizePool * pct) / 100 }))
}

// Group indices of `rets` (any order) into ranked tie-groups, best first.
// Consecutive players (sorted desc) within `threshold` pp chain into one group
// - the same "too close to call" band that makes a 1v1 a draw.
export const rankGroups = (rets, threshold = DRAW_THRESHOLD) => {
  const order = rets.map((r, i) => i).sort((a, b) => rets[b] - rets[a])
  const groups = []
  for (const i of order) {
    const g = groups[groups.length - 1]
    if (g && rets[g[g.length - 1]] - rets[i] < threshold) g.push(i)
    else groups.push([i])
  }
  return groups
}

// Prize per player index. A tie-group spanning positions p..p+size-1 shares the
// sum of those positions' prizes equally. Cent-rounding leftovers go to the
// best-placed player so the total paid is exactly the prize pool.
export const prizesFor = (groups, spec, prizePool) => {
  const n = groups.reduce((a, g) => a + g.length, 0)
  const prizes = new Array(n).fill(0)
  const ranks = new Array(n).fill(0)
  let pos = 0
  for (const g of groups) {
    let sharePct = 0
    for (let k = pos; k < pos + g.length && k < spec.length; k++) sharePct += spec[k]
    const each = Math.round((sharePct / 100) * prizePool / g.length * 100) / 100
    for (const i of g) { prizes[i] = each; ranks[i] = pos + 1 } // ties share the best position
    pos += g.length
  }
  const paid = prizes.reduce((a, x) => a + x, 0)
  const leftover = Math.round((prizePool - paid) * 100) / 100
  if (leftover !== 0) {
    const top = groups[0][0]
    prizes[top] = Math.round((prizes[top] + leftover) * 100) / 100
  }
  return { prizes, ranks }
}

// The field size at which each place STARTS paying (1st from MIN, 2nd from 7,
// 3rd from 9 with the default spec) - computed from payoutSpec so the client
// can say "2nd place pays from 7 players" without re-implementing the rules.
export const PLACES_FROM = (() => {
  const out = []
  for (let n = MIN_PLAYERS; n <= MAX_PLAYERS; n++) {
    const len = payoutSpec(n).length
    for (let p = out.length; p < len; p++) out.push(n)
  }
  return out
})()

const ev = (t, msg) => t.events.push({ ts: Date.now(), msg })

export class TourneyManager {
  constructor(hub, { pushWallet = () => {}, broadcast = () => {} } = {}) {
    this.hub = hub
    this.pushWallet = pushWallet
    this.broadcast = broadcast
    this.lobbies = new Map()     // "tier|pool" -> lobby (phase 'lobby')
    this.active = new Map()      // id -> tournament (picking/live/done/cancelled)
    this.userTourney = new Map() // userId -> tourney/lobby id (until settled)
    for (const pool of TOURNEY_POOLS) {
      for (const def of TOURNEY_TIERS) this.lobbies.set(`${def.tier}|${pool}`, this.freshLobby(def, pool))
    }
    onTick(() => this.tick())
  }

  // Coins in a running or picking tournament - the price feed refreshes these first.
  hotTokenIds() {
    const ids = new Set()
    for (const t of this.active.values()) {
      if (t.phase !== 'live' && t.phase !== 'picking') continue
      for (const p of t.players) for (const x of p.picks || []) ids.add(x.tokenId)
    }
    return ids
  }

  anyLive() {
    for (const t of this.active.values()) if (t.phase === 'live') return true
    return false
  }

  freshLobby(def, pool) {
    return {
      id: randomUUID().slice(0, 13),
      tier: def.tier, stake: def.stake, pool, duration: def.duration,
      allowedIds: def.allowedIds || null,
      phase: 'lobby', players: [], countdownEnd: null,
      pickLeft: null, startPrices: null, startSim: null, endsAt: null,
      feedAtStart: null, feedLost: 0, result: null, events: [], doneAt: null,
    }
  }

  cfgOf(t) {
    return { mode: 'classic', stake: t.stake, duration: t.duration, pool: t.pool, allowedIds: t.allowedIds, training: false }
  }

  byUser(userId) {
    const id = this.userTourney.get(userId)
    if (!id) return null
    for (const l of this.lobbies.values()) if (l.id === id) return l
    return this.active.get(id) || null
  }

  playerOf(t, userId) { return t.players.find((p) => p.userId === userId) || null }

  // ---- lobby ----

  // Async for the same reason joining a duel queue is: the entry fee is
  // collected from the player's own wallet on-chain before they are in the field.
  async join(user, tier, pool) {
    const lobby = this.lobbies.get(`${tier}|${pool}`)
    if (!lobby) return { error: 'No such tournament.' }
    // No training gate - see duel.js joinQueue.
    if (this.userTourney.has(user.id)) return { error: 'You are already in a tournament.' }
    const bad = validateConfig(this.cfgOf(lobby))
    if (bad) return { error: bad }
    if (lobby.players.length >= MAX_PLAYERS) return { error: 'This tournament is full - a fresh lobby opens the moment it starts.' }

    // The entry must be standing in their balance before they take a seat.
    const funded = await ensureFunded(user.id, lobby.stake, null)
    if (funded.error) return funded

    // The check above is awaited: the lobby may have filled or started, and
    // they may have entered something else from another tab. Refuse rather
    // than overfill.
    if (this.userTourney.has(user.id)) return { error: 'You are already in a tournament.' }
    if (lobby.phase !== 'lobby' || lobby.players.length >= MAX_PLAYERS) {
      return { error: 'That tournament just started - the collected entry is in your balance, and the next lobby is open.' }
    }

    // The lock is the whole gate: one per user, so anyone queued, in a battle
    // or in another tournament is refused here with their money untouched.
    const lock = lockStake(user.id, lobby.stake, 'tourney:' + lobby.id)
    if (!lock.ok) return { error: lock.why }

    lobby.players.push({ userId: user.id, name: user.name, avatar: user.avatar, picks: null, locked: false, banner: null })
    this.userTourney.set(user.id, lobby.id)
    ev(lobby, `${user.name} joined (${lobby.players.length}/${MAX_PLAYERS})`)
    if (lobby.players.length >= MAX_PLAYERS) {
      this.startPicking(lobby)
    } else if (lobby.players.length >= MIN_PLAYERS && !lobby.countdownEnd) {
      lobby.countdownEnd = simTime() + COUNTDOWN_SECS
      ev(lobby, `Field reached ${MIN_PLAYERS} - starting in ${COUNTDOWN_SECS}s unless it empties`)
    }
    this.pushWallet(user.id)
    this.broadcastLobbies()
    return { ok: true }
  }

  // Leave with a full refund - any time in the lobby, and during the pick
  // phase too (same deal as not locking, just immediate).
  leave(userId, { silent = false } = {}) {
    const t = this.byUser(userId)
    if (!t) return { error: 'You are not in a tournament.' }
    if (t.phase === 'live') return { error: 'The battle is running - your portfolio rides to the end.' }
    if (['done', 'cancelled'].includes(t.phase)) { this.userTourney.delete(userId); return { ok: true } }

    const p = this.playerOf(t, userId)
    t.players = t.players.filter((x) => x.userId !== userId)
    this.userTourney.delete(userId)
    releaseLock(userId, { refund: true, note: `Left the $${t.stake} tournament - entry refunded` })
    ev(t, `${p?.name || 'A player'} left (${t.players.length} remain)`)
    this.pushWallet(userId)

    if (t.phase === 'lobby') {
      if (t.players.length < MIN_PLAYERS && t.countdownEnd) {
        t.countdownEnd = null
        ev(t, `Field dropped below ${MIN_PLAYERS} - countdown stopped`)
      }
    } else if (t.phase === 'picking') {
      if (!silent) this.hub.send(userId, { type: 'duel.cancelled', duelId: t.id, reason: 'You left the tournament - entry refunded.' })
      if (t.players.length < MIN_PLAYERS) {
        this.cancelTourney(t, `Too few players left in the pick phase (${t.players.length}/${MIN_PLAYERS}) - tournament cancelled, all entries refunded.`)
      } else if (t.players.every((x) => x.locked)) {
        this.beginBattle(t)
      } else {
        this.pushStates(t)
      }
    }
    this.broadcastLobbies()
    return { ok: true }
  }

  // A fully closed browser walks out of the LOBBY only (money back, seat
  // freed), exactly like the matchmaking queue on last-tab-close. From the
  // pick phase on they keep their seat: the pick deadline already handles a
  // player who never comes back, and a locked portfolio needs nobody present.
  leaveLobbyOnClose(userId) {
    const t = this.byUser(userId)
    if (t?.phase === 'lobby') this.leave(userId, { silent: true })
  }

  // ---- pick phase ----

  startPicking(lobby) {
    const def = TOURNEY_TIERS.find((d) => d.tier === lobby.tier)
    this.lobbies.set(`${lobby.tier}|${lobby.pool}`, this.freshLobby(def, lobby.pool)) // the table's door stays open
    lobby.phase = 'picking'
    lobby.countdownEnd = null
    lobby.pickLeft = PICK_SECONDS
    this.active.set(lobby.id, lobby)
    ev(lobby, `Tournament started with ${lobby.players.length} players - pick phase (${PICK_SECONDS}s)`)
    db.prepare(`INSERT INTO tourneys (id, ts, tier, stake, pool, duration, status) VALUES (?, ?, ?, ?, ?, ?, 'picking')`)
      .run(lobby.id, Date.now(), lobby.tier, lobby.stake, lobby.pool, lobby.duration)
    this.pushStates(lobby)
    this.broadcastLobbies()
  }

  lockPicks(userId, picks) {
    const t = this.byUser(userId)
    if (!t || t.phase !== 'picking') return { error: 'No active pick phase.' }
    const me = this.playerOf(t, userId)
    const err = validatePicks(picks, this.cfgOf(t))
    if (err) return { error: err }
    me.picks = picks.map((p) => ({ tokenId: p.tokenId, pct: Math.round(p.pct) }))
    me.locked = true
    me.banner = null
    ev(t, `${me.name} locked in (picks stay hidden)`)
    if (t.players.every((p) => p.locked)) this.beginBattle(t)
    else this.pushStates(t)
    this.broadcastLobbies()
    return { ok: true }
  }

  // Pick deadline: whoever didn't lock is refunded out - nine players must
  // never be held hostage by one empty chair.
  endPicking(t) {
    const out = t.players.filter((p) => !p.locked)
    for (const p of out) {
      t.players = t.players.filter((x) => x.userId !== p.userId)
      this.userTourney.delete(p.userId)
      releaseLock(p.userId, { refund: true, note: `Didn't lock picks in time - $${t.stake} tournament entry refunded` })
      this.hub.send(p.userId, { type: 'duel.cancelled', duelId: t.id, reason: 'Pick time expired before you locked in - your entry was refunded.' })
      this.pushWallet(p.userId)
      ev(t, `${p.name} didn't lock in time - refunded out`)
    }
    if (t.players.length < MIN_PLAYERS) {
      this.cancelTourney(t, `Only ${t.players.length} of the needed ${MIN_PLAYERS} players locked in - tournament cancelled, all entries refunded.`)
    } else {
      this.beginBattle(t)
    }
  }

  // ---- battle ----

  beginBattle(t) {
    const prices = {}
    const ids = new Set(t.players.flatMap((p) => p.picks.map((x) => x.tokenId)))
    for (const id of ids) prices[id] = getPrice(id) // one tick, every player
    t.startPrices = prices
    t.startSim = simTime()
    t.endsAt = simTime() + t.duration
    t.feedAtStart = getFeedStatus()
    t.feedLost = 0
    t.phase = 'live'
    // The pot is FINAL here: whoever is still in when prices lock is the field.
    const n = t.players.length
    ev(t, `Battle started - ${n} players, $${tourneyMoney(n, t.stake).pot} pot, start prices locked (${[...ids].join(', ')})`)
    db.prepare(`UPDATE tourneys SET status = 'live' WHERE id = ?`).run(t.id)
    this.pushStates(t)
    this.broadcastLobbies()
  }

  settle(t) {
    const endPrice = (id) => twap(id)
    const rets = t.players.map((p) => portfolioReturn(p.picks, t.startPrices, endPrice))
    const n = t.players.length
    const groups = rankGroups(rets)
    const spec = payoutSpec(n)
    const { pot, pct, fee, prizePool } = tourneyMoney(n, t.stake)
    const { prizes, ranks } = prizesFor(groups, spec, prizePool)

    const perToken = (picks) => picks.map((p) => {
      const p0 = t.startPrices[p.tokenId]
      const p1 = endPrice(p.tokenId)
      return { ...p, start: p0, end: p1, ret: p0 > 0 ? ((p1 - p0) / p0) * 100 : 0 }
    })

    t.players.forEach((p, i) => {
      p.ret = rets[i]
      p.rank = ranks[i]
      p.prize = prizes[i]
      p.tokens = perToken(p.picks)
    })
    const standings = [...t.players].sort((a, b) => a.rank - b.rank || b.ret - a.ret)
    t.result = { pot, feePct: pct, fee, prizePool, endedAt: Date.now() }
    t.phase = 'done'
    t.doneAt = Date.now()
    ev(t, `Settled via 30-reading TWAP - ${standings.map((p) => `${p.name} ${p.ret.toFixed(2)}%`).join(' · ')}`)

    const flagged = rets.some((r) => Math.abs(r) > 25)
    txn(() => {
      const ins = db.prepare(`INSERT INTO tourney_players (tourney_id, user_id, name, avatar, picks, ret, rank, prize, outcome)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      for (const p of t.players) {
        const fundPlan = lockPlan(getLock(p.userId))
        releaseLock(p.userId) // the entry was consumed by the tournament
        if (p.prize > 0) {
          const shared = t.players.filter((x) => x.rank === p.rank).length > 1
          const why = `Placed #${p.rank} of ${n} in the $${t.stake} tournament - ${shared ? 'shared ' : ''}prize from the $${pot} pot`
          creditLike(p.userId, p.prize, 'win', why, fundPlan)
          // Straight back to the wallet the entry came from, in the same assets.
          payoutWinnings(p.userId, p.prize, fundPlan, why, `t:${p.userId}:${t.id}`)
        }
        // `picks` stores the per-token breakdown WITH start/end prices - the
        // same rows a 1v1 result table shows - so the history detail can
        // replay the run without the room in memory.
        ins.run(t.id, p.userId, p.name, p.avatar, JSON.stringify(p.tokens), p.ret, p.rank, p.prize, p.prize > 0 ? 'placed' : 'lost')
      }
      db.prepare(`UPDATE tourneys SET status = 'done', settled = ?, pot = ?, fee = ?, fee_pct = ?, data = ? WHERE id = ?`)
        .run(Date.now(), pot, fee, pct, JSON.stringify({
          standings: standings.map((p) => ({ name: p.name, avatar: p.avatar, ret: p.ret, rank: p.rank, prize: p.prize })),
          events: t.events, feedAtStart: t.feedAtStart, startPrices: t.startPrices,
        }), t.id)
    })

    for (const p of t.players) {
      this.userTourney.delete(p.userId)
      this.hub.send(p.userId, { type: 'duel.state', duel: this.snapshotFor(t, p.userId) })
      this.pushWallet(p.userId)
    }
    if (flagged) adminLog('system', `Tournament ${t.id} auto-flagged: extreme return (${rets.map((r) => r.toFixed(1) + '%').join(', ')})`)
    adminLog('system', `Tournament ${t.id} settled - ${n} players, $${pot} pot, $${fee} fee, winner ${standings[0].name}`)
    this.broadcastLobbies()
  }

  cancelTourney(t, reason) {
    if (['done', 'cancelled'].includes(t.phase)) return
    t.phase = 'cancelled'
    t.doneAt = Date.now()
    ev(t, `Tournament cancelled - ${reason}`)
    for (const p of t.players) {
      this.userTourney.delete(p.userId)
      releaseLock(p.userId, { refund: true, note: `Refund: ${reason}` })
      this.hub.send(p.userId, { type: 'duel.cancelled', duelId: t.id, reason })
      this.pushWallet(p.userId)
    }
    t.players = []
    try { db.prepare(`UPDATE tourneys SET status = 'cancelled', data = ? WHERE id = ?`).run(JSON.stringify({ reason, events: t.events }), t.id) } catch { /* never reached DB (still a lobby) */ }
    adminLog('system', `Tournament ${t.id} cancelled - ${reason}`)
    this.broadcastLobbies()
  }

  voidTourney(id, actor) {
    const t = this.active.get(id) || [...this.lobbies.values()].find((l) => l.id === id)
    if (!t || ['done', 'cancelled'].includes(t.phase)) return false
    this.cancelTourney(t, 'Tournament voided by the arena - all entries refunded.')
    adminLog(actor, `Voided tournament ${id}`)
    return true
  }

  // ---- snapshots ----

  // Duel-compatible view for members: the pick phase rides the same PickTerminal
  // as a 1v1 (mode/stake/duration/battlePool/you/pickLeft), with a `tourney`
  // block carrying what a 2-player battle doesn't have - the field.
  snapshotFor(t, userId) {
    const me = this.playerOf(t, userId)
    const n = t.players.length
    const revealed = ['live', 'done'].includes(t.phase)
    const money = tourneyMoney(n, t.stake)
    const table = payoutTable(n, t.stake)
    return {
      id: t.id,
      tourney: {
        tier: t.tier, count: n, lockedCount: t.players.filter((p) => p.locked).length,
        min: MIN_PLAYERS, max: MAX_PLAYERS,
        money, payouts: table,
        players: t.players.map((p) => ({
          name: p.name, avatar: p.avatar, locked: p.locked, you: p.userId === userId,
          ...(revealed ? { picks: p.picks, ret: p.ret ?? null, rank: p.rank ?? null, prize: p.prize ?? null, tokens: p.tokens ?? null } : {}),
        })),
      },
      mode: 'classic', stake: t.stake, duration: t.duration, training: false,
      battlePool: t.pool, allowedIds: t.allowedIds,
      feePct: money.pct, fee: money.fee, pool: money.pot, prize: table[0]?.amount ?? 0,
      phase: t.phase, pickLeft: t.pickLeft, banner: me?.banner ?? null,
      you: { picks: me?.picks ?? null, locked: !!me?.locked },
      opp: null,
      startPrices: t.startPrices,
      remaining: t.phase === 'live' ? Math.max(0, t.endsAt - simTime()) : null,
      result: t.phase === 'done' && me ? {
        ...t.result, rank: me.rank, prize: me.prize, ret: me.ret,
        outcome: me.prize > 0 ? 'win' : 'loss',
        standings: t.players.map((p) => ({ name: p.name, avatar: p.avatar, ret: p.ret, rank: p.rank, prize: p.prize, you: p.userId === userId })).sort((a, b) => a.rank - b.rank || b.ret - a.ret),
      } : null,
      events: t.events,
    }
  }

  pushStates(t) {
    for (const p of t.players) this.hub.send(p.userId, { type: 'duel.state', duel: this.snapshotFor(t, p.userId) })
  }

  // Public lobby board, shown to everyone (Tournaments screen): every pool ×
  // every stake, Robinhood pool first. Prize numbers are computed server-side
  // so the client never re-implements the fee math, and a table whose pool
  // can't currently field a battle carries the reason in `blocked`.
  publicState() {
    const out = []
    for (const pool of TOURNEY_POOLS) {
      for (const def of TOURNEY_TIERS) {
        const l = this.lobbies.get(`${def.tier}|${pool}`)
        const n = l.players.length
        const preview = Math.max(n, MIN_PLAYERS) // an empty lobby still shows what MIN pays
        const running = [...this.active.values()]
          .filter((t) => t.tier === def.tier && t.pool === pool && ['picking', 'live'].includes(t.phase))
          .map((t) => ({
            phase: t.phase, count: t.players.length,
            remaining: t.phase === 'live' ? Math.max(0, Math.round(t.endsAt - simTime())) : null,
          }))
        out.push({
          tier: def.tier, stake: def.stake, pool, duration: def.duration,
          min: MIN_PLAYERS, max: MAX_PLAYERS, count: n,
          players: l.players.map((p) => ({ name: p.name, avatar: p.avatar })),
          countdownLeft: l.countdownEnd ? Math.max(0, Math.round(l.countdownEnd - simTime())) : null,
          countdownTotal: COUNTDOWN_SECS,
          money: tourneyMoney(preview, def.stake), payouts: payoutTable(preview, def.stake),
          moneyFull: tourneyMoney(MAX_PLAYERS, def.stake), payoutsFull: payoutTable(MAX_PLAYERS, def.stake),
          placesFrom: PLACES_FROM,
          blocked: validateConfig(this.cfgOf(l)) || null,
          running,
        })
      }
    }
    return out
  }

  recentResults(limit = 10) {
    return db.prepare(`SELECT id, ts, tier, stake, pot, fee, settled, data FROM tourneys WHERE status = 'done' ORDER BY settled DESC LIMIT ?`)
      .all(limit).map((r) => {
        let standings = []
        try { standings = JSON.parse(r.data).standings || [] } catch { /* keep empty */ }
        return { id: r.id, ts: r.settled || r.ts, tier: r.tier, stake: r.stake, pot: r.pot, fee: r.fee, standings }
      })
  }

  broadcastLobbies() {
    this.broadcast({ type: 'tourney.lobbies', lobbies: this.publicState() })
  }

  activeSummary() {
    return [...this.active.values()]
      .filter((t) => !['done', 'cancelled'].includes(t.phase))
      .map((t) => ({
        id: t.id, tier: t.tier, stake: t.stake, phase: t.phase,
        players: t.players.map((p) => p.name),
        remaining: t.phase === 'live' ? Math.max(0, Math.round(t.endsAt - simTime())) : null,
      }))
  }

  // ---- per-second tick ----

  tick() {
    let anyCountdown = false
    for (const l of this.lobbies.values()) {
      if (!l.countdownEnd) continue
      anyCountdown = true
      if (simTime() >= l.countdownEnd) {
        if (l.players.length >= MIN_PLAYERS) this.startPicking(l)
        else l.countdownEnd = null // belt-and-braces; leave() already clears it
      }
    }
    if (anyCountdown) this.broadcastLobbies() // the clock everyone watches

    for (const t of this.active.values()) {
      if (t.phase === 'picking') {
        t.pickLeft--
        if (t.pickLeft <= 0) this.endPicking(t)
        else if (t.pickLeft % 5 === 0) this.pushStates(t) // keep timers in sync
      } else if (t.phase === 'live') {
        if (t.feedAtStart === 'live') {
          t.feedLost = getFeedStatus() === 'sim' ? t.feedLost + 1 : 0
          if (t.feedLost >= FEED_LOSS_VOID_SECS) {
            this.cancelTourney(t, 'Price source went down during the battle - tournament voided, all entries refunded.')
            continue
          }
        }
        if (simTime() >= t.endsAt) { this.settle(t); continue }
        const ids = [...new Set(t.players.flatMap((p) => p.picks.map((x) => x.tokenId)))]
        const prices = {}
        for (const id of ids) prices[id] = getPrice(id)
        const rows = t.players.map((p) => ({ name: p.name, avatar: p.avatar, ret: portfolioReturn(p.picks, t.startPrices) }))
        for (const p of t.players) {
          this.hub.send(p.userId, {
            type: 'tourney.tick', id: t.id,
            remaining: Math.max(0, t.endsAt - simTime()),
            prices, rows, feed: getFeedStatus(),
          })
        }
      }
    }

    // GC finished tournaments after 10 minutes
    const cutoff = Date.now() - 10 * 60 * 1000
    for (const [id, t] of this.active) {
      if (t.doneAt && t.doneAt < cutoff) this.active.delete(id)
    }
  }
}

// Boot recovery: entries are plain stake locks, so recoverLocks() has already
// refunded every player of an unfinished tournament - this just closes the
// book so the row can't read as still running.
export const recoverTourneys = () => {
  const r = db.prepare(`UPDATE tourneys SET status = 'cancelled' WHERE status IN ('picking', 'live')`).run()
  if (r.changes) adminLog('system', `Closed ${r.changes} unfinished tournament(s) after restart - entries were refunded with the stake locks`)
  return r.changes
}
