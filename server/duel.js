// Server-authoritative duels: matchmaking queues, duel rooms, settlement.
// Picks live only in server memory until both players lock - a client never
// sees the opponent's portfolio before battle start, and settlement math runs
// on server prices with a DB transaction for every payout.

import { randomUUID } from 'node:crypto'
import { onTick, simTime, getPrice, twapAt, portfolioReturn, getFeedStatus } from './market.js'
import { venueCapacityUsd } from './venue.js'
import {
  PICK_SECONDS, DRAW_THRESHOLD, SWAP_COST, FEED_LOSS_VOID_SECS, QUEUE_OFFER_SECS,
  feeFor, validatePicks, validateConfig, allowedTokenIds, effToken, priceImpactFor,
} from './rules.js'
import { botPicks } from '../src/engine/players.js'
import {
  db, txn, creditLike, creditTokens, lockStake, relabelLock, releaseLock, getLock, lockPlan,
  chainFunds, holdingsOf, holdingsOwed, saveBasket, clearBaskets, getUser, getUserByName, adminLog,
  balanceOf, balanceCoinOf, ledgerPriceUsd, resettleLock,
} from './db.js'
import { hedgeShortfallUsd, kickHedger } from './hedger.js'
import { payoutWinnings, ensureFunded } from './wallet.js'
import { poolFund } from '../src/engine/tokens.js'

const ev = (room, msg) => room.events.push({ ts: Date.now(), msg })

// The coins one entry bought, in token amounts fixed at battle-start prices.
// The hedger buys exactly this and the winner is paid exactly this - one
// formula, so what the treasury holds can never drift from what it owes.
// Each slice pays its estimated market impact up front, like a DEX order: a
// $5,000 slice into a thin book is owed fewer coins, because that is what
// $5,000 actually buys there. The charge stays with the house as the buffer
// that absorbs the real fill - which is what lets ANY size be playable.
// Percentages on the wire: four decimals is finer than any screen shows and
// keeps the per-trade micro-series from bloating a message sent every second.
const round4 = (n) => Math.round(n * 1e4) / 1e4

const basketOf = (room, picks, entryNet) => {
  const out = {}
  for (const pick of picks || []) {
    const p0 = room.startPrices?.[pick.tokenId]
    if (!(p0 > 0)) continue
    const sliceUsd = entryNet * pick.pct / 100
    const eff = sliceUsd * (1 - priceImpactFor(pick.tokenId, sliceUsd))
    out[pick.tokenId] = (out[pick.tokenId] || 0) + eff / p0
  }
  return out
}

// The arena bot's one face, everywhere it fights (public/bot.png - the client
// Avatar renders any rooted path as an image).
const BOT_AVATARS = ['/bot.png']

export const statsFor = (userId) => {
  const rows = db.prepare(`
    SELECT training, outcome_a, user_a, user_b FROM matches WHERE user_a = ? OR user_b = ?
  `).all(userId, userId)
  const out = { wins: 0, losses: 0, draws: 0, matches: 0 }
  for (const r of rows) {
    if (r.training) continue
    const mine = r.user_a === userId ? r.outcome_a : r.outcome_a === 'win' ? 'loss' : r.outcome_a === 'loss' ? 'win' : 'draw'
    out.matches++
    if (mine === 'win') out.wins++
    else if (mine === 'loss') out.losses++
    else out.draws++
  }
  return out
}

export class DuelManager {
  constructor(hub) {
    this.hub = hub               // { send(userId, msg) }
    this.rooms = new Map()       // roomId -> room
    this.userRoom = new Map()    // userId -> roomId (active rooms only)
    this.queues = new Map()      // "mode|stake|duration" -> [{userId,name,avatar}]
    onTick(() => this.tick())
  }

  // Coins in a running or picking battle - the price feed refreshes these first.
  hotTokenIds() {
    const ids = new Set()
    for (const r of this.rooms.values()) {
      if (r.phase !== 'live' && r.phase !== 'picking') continue
      for (const p of r.players) for (const x of p.picks || []) ids.add(x.tokenId)
    }
    return ids
  }

  anyLive() {
    for (const r of this.rooms.values()) if (r.phase === 'live') return true
    return false
  }

  // Net token exposure implied by open Live-Arena battles, in TOKEN AMOUNTS
  // fixed at each battle's start prices (so market moves cause no churn).
  // `exceptId` lets a settlement ask "what does everyone ELSE still need" while
  // its own room is still counted as live.
  liveExposure(exceptId = null) {
    const out = {}
    for (const room of this.rooms.values()) {
      if (room.id === exceptId || room.phase !== 'live' || room.cfg.training || room.cfg.mode !== 'live') continue
      const entryNet = (room.cfg.stake - room.fee / 2) * (1 - SWAP_COST)
      for (const p of room.players) {
        for (const [tokenId, amount] of Object.entries(basketOf(room, p.picks, entryNet))) {
          out[tokenId] = (out[tokenId] || 0) + amount
        }
      }
    }
    return out
  }

  // Dollars the treasury must be able to hold on a pool's chain for every Live
  // battle already open or forming there. Both players' stakes count: Live pays
  // the winner both portfolios, so the treasury mirrors both.
  liveCommittedUsd(pool) {
    let usd = 0
    for (const room of this.rooms.values()) {
      if (room.cfg.training || room.cfg.mode !== 'live' || room.cfg.pool !== pool) continue
      if (!['picking', 'live'].includes(room.phase)) continue
      usd += room.cfg.stake * room.players.length
    }
    return usd
  }

  // ---- queueing ----

  queueKey(cfg) { return `${cfg.mode}|${cfg.stake}|${cfg.duration}|${cfg.pool}` }

  // Async because the stake is collected from the player's own wallet on-chain
  // before they are allowed into the queue. Pulling at queue time rather than at
  // match time is deliberate: by the time two players meet, both stakes are
  // already in the treasury, so a battle can never start half-paid.
  async joinQueue(user, cfg) {
    cfg = { mode: cfg.mode, stake: Number(cfg.stake), duration: Number(cfg.duration), pool: cfg.pool, training: false }
    const bad = validateConfig(cfg)
    if (bad) return { error: bad }
    // No training gate: a player may walk in and put money on a table on their
    // first visit (owner's call, 31 Jul 2026). `training_done` is still
    // recorded - it drives the "new here?" nudge and the admin user list - but
    // it stops NOTHING.
    if (this.userRoom.has(user.id)) return { error: 'You already have an active battle.' }
    if (this.inQueue(user.id)) return { error: 'You are already searching for an opponent.' }

    // Live is only affordable while the treasury holds the same basket, and on a
    // chain nobody deposits to that basket is bought with pre-positioned float.
    // When the float is fully committed the honest answer is "not right now" -
    // opening the battle anyway would mean owing real dollars against nothing.
    if (cfg.mode === 'live') {
      const cap = venueCapacityUsd(cfg.pool)
      if (Number.isFinite(cap) && this.liveCommittedUsd(cfg.pool) + cfg.stake * 2 > cap) {
        return { error: 'Live Arena on this pool is at hedging capacity right now - try a smaller stake, Classic, or again in a few minutes.' }
      }
    }
    // Classic takes any dollar; Live spends only what is already on that pool's
    // chain, because that is the money the treasury will actually hedge with.
    const fund = cfg.mode === 'live' ? poolFund(cfg.pool) : null

    // Is the stake standing in their arena balance? Custodial: nothing is
    // pulled from anywhere, an empty balance is a refusal that says "deposit".
    const funded = await ensureFunded(user.id, cfg.stake, fund)
    if (funded.error) return funded

    // The check above is awaited, so the world may have moved while it ran: the
    // player could have joined elsewhere from another tab. Re-check before
    // locking rather than entering them twice.
    if (this.userRoom.has(user.id) || this.inQueue(user.id)) {
      return { error: 'You already have an active battle.' }
    }

    const lock = lockStake(user.id, cfg.stake, 'queue', fund)
    if (!lock.ok) return { error: lock.why }

    const key = this.queueKey(cfg)
    const q = this.queues.get(key) || []
    const waiting = q.shift()
    if (waiting) {
      if (q.length) this.queues.set(key, q); else this.queues.delete(key)
      const other = getUser(waiting.userId)
      this.createRoom(cfg, [other, user], 'auto-match')
      this.pushWallet(user.id)
      return { ok: true }
    }
    // Nobody standing in the queue - but a table posted on the open board is
    // somebody waiting on exactly these terms who left their portfolio behind
    // instead of their browser open. The queue is served first (owner's call,
    // 2 Aug 2026): the player staring at a spinner is the one actually being
    // kept waiting, and a board posting has twelve hours to be taken.
    const listing = this.boardListingFor(cfg, user.id)
    if (listing && this.startFromBoard(listing, user)) {
      this.pushWallet(user.id)
      return { ok: true }
    }
    q.push({ userId: user.id, name: user.name, avatar: user.avatar, since: simTime(), offered: new Set() })
    this.queues.set(key, q)
    this.pushWallet(user.id)
    return { ok: true }
  }

  // ---- matching down to the nearest stake ----
  //
  // Sixteen stakes × four durations is a lot of separate queues even with one
  // battlefield, and a $150 table can sit empty while someone waits at $100. After a
  // while the arena offers the bigger spender the nearest smaller opponent -
  // ALWAYS downward, never up, so nobody is ever pulled into a battle larger
  // than the one they walked in for. Accepting drops both to the smaller stake
  // and the difference goes straight back where it came from.

  queueEntryOf(userId) {
    for (const [key, q] of this.queues) {
      const i = q.findIndex((x) => x.userId === userId)
      if (i >= 0) return { key, q, i, entry: q[i], cfg: this.cfgFromKey(key) }
    }
    return null
  }

  cfgFromKey(key) {
    const [mode, stake, duration, pool] = key.split('|')
    return { mode, stake: Number(stake), duration: Number(duration), pool, training: false }
  }

  // The best smaller-stake opponent waiting on otherwise identical terms.
  nearestSmallerMatch(cfg, userId, skip = new Set()) {
    let best = null
    for (const [key, q] of this.queues) {
      const other = this.cfgFromKey(key)
      if (other.mode !== cfg.mode || other.duration !== cfg.duration || other.pool !== cfg.pool) continue
      if (!(other.stake < cfg.stake)) continue
      for (const e of q) {
        if (e.userId === userId || skip.has(e.userId)) continue
        if (!best || other.stake > best.cfg.stake) best = { cfg: other, entry: e, key }
      }
    }
    return best
  }

  // Called on the queue tick: anyone waiting long enough gets asked once per
  // candidate. The offer never moves their money - it is a question.
  offerNearest(userId) {
    const mine = this.queueEntryOf(userId)
    if (!mine) return
    const cand = this.nearestSmallerMatch(mine.cfg, userId, mine.entry.offered)
    if (!cand) return
    mine.entry.offered.add(cand.entry.userId)
    mine.entry.pendingOffer = { userId: cand.entry.userId, name: cand.entry.name, stake: cand.cfg.stake, at: simTime() }
    this.hub.send(userId, {
      type: 'queue.offer',
      opponent: { name: cand.entry.name, avatar: cand.entry.avatar },
      yourStake: mine.cfg.stake,
      theirStake: cand.cfg.stake,
      // Say the number plainly: this is the whole deal being proposed.
      text: `Nobody has taken your $${mine.cfg.stake} table. ${cand.entry.name} is waiting at $${cand.cfg.stake}. Fight them for $${cand.cfg.stake}? Your stake drops to $${cand.cfg.stake} and the difference goes back to your balance.`,
    })
  }

  acceptNearest(userId, accept) {
    const mine = this.queueEntryOf(userId)
    if (!mine?.entry.pendingOffer) return { error: 'That offer is no longer on the table.' }
    const offer = mine.entry.pendingOffer
    mine.entry.pendingOffer = null
    if (!accept) return { ok: true, declined: true }

    // The opponent may have matched with someone else while the popup was open.
    const theirs = this.queueEntryOf(offer.userId)
    if (!theirs || theirs.cfg.stake !== offer.stake) {
      this.hub.send(userId, { type: 'queue.offerGone', reason: 'That player just found a battle. Still searching…' })
      return { ok: true, gone: true }
    }

    const cfg = { ...theirs.cfg }
    const back = mine.cfg.stake - cfg.stake

    // Take both out of their queues first: no half-matched state.
    mine.q.splice(mine.i, 1); if (!mine.q.length) this.queues.delete(mine.key)
    const t = this.queueEntryOf(offer.userId)
    if (t) { t.q.splice(t.i, 1); if (!t.q.length) this.queues.delete(t.key) }

    // Hand back the part of the stake this battle no longer needs, onto exactly
    // the chain it was taken from - the same rule a refund follows. The lock's
    // coin and plan shrink by the same share, so a later refund of what remains
    // still returns exactly what is still held.
    if (back > 0) {
      const lock = getLock(userId)
      const plan = lockPlan(lock)
      const ratio = back / lock.amount
      const scaled = plan ? plan.map((p) => ({ ...p, amount: p.amount * ratio })) : null
      const kept = plan ? plan.map((p) => ({ ...p, amount: p.amount * (1 - ratio) })) : null
      creditLike(userId, back, 'refund', `Matched down to a $${cfg.stake} battle - $${back} returned`, scaled)
      db.prepare('UPDATE stake_locks SET amount = ?, coin = coin * ?, plan = ? WHERE user_id = ?')
        .run(cfg.stake, 1 - ratio, kept ? JSON.stringify(kept) : null, userId)
      this.pushWallet(userId)
    }

    this.createRoom(cfg, [getUser(userId), getUser(offer.userId)], 'stake-matched')
    return { ok: true, stake: cfg.stake }
  }

  leaveQueue(userId, { silent = false } = {}) {
    for (const [key, q] of this.queues) {
      const i = q.findIndex((x) => x.userId === userId)
      if (i >= 0) {
        q.splice(i, 1)
        if (!q.length) this.queues.delete(key)
        releaseLock(userId, { refund: true, note: 'Left matchmaking - stake refunded' })
        this.pushWallet(userId)
        if (!silent) this.hub.send(userId, { type: 'queue.left' })
        return true
      }
    }
    return false
  }

  inQueue(userId) {
    for (const q of this.queues.values()) if (q.some((x) => x.userId === userId)) return true
    return false
  }

  // ---- the open board is the queue's other half ----
  //
  // A posted table and a queue entry are the same offer written two ways: the
  // same mode, stake, duration and battlefield, one of them having committed a
  // portfolio and walked away rather than keeping a browser open. They used to
  // be two pools that never met, so a $100/15m searcher could spin forever while
  // a $100/15m table sat on the board an inch away. Now either one closes on the
  // other, in both directions.
  //
  // The terms have to match exactly. A Live table and a Classic one at the same
  // price are different products, and the queue's "match down to the nearest
  // smaller stake" is deliberately NOT extended here: that offer is a question
  // put to a player, and the author of a board posting is not around to answer
  // it - their picks and their money are already sized and locked.

  boardListingFor(cfg, userId) {
    const rows = db.prepare(`SELECT * FROM challenges
                             WHERE status = 'open' AND listed = 1 AND picks IS NOT NULL
                               AND expires > ? AND from_user != ?
                               AND mode = ? AND stake = ? AND duration = ? AND pool IS ?`)
      .all(Date.now(), userId, cfg.mode, cfg.stake, cfg.duration, cfg.pool ?? null)
    // Oldest first - the board is a queue too, and the table that has waited
    // longest goes first. An author who is somehow already in a battle is
    // skipped rather than failed: their listing is stale, which is nobody's
    // problem but the sweep's.
    rows.sort((a, b) => a.created - b.created)
    return rows.find((c) => !this.userRoom.has(c.from_user)) || null
  }

  // Both stakes are already locked - the author's when they posted, the
  // opponent's on their way into the queue - so this only has to claim the
  // table exactly once. The conditional UPDATE is that claim: if two players
  // reach the same listing in the same instant, one of them gets a room and the
  // other falls through to waiting, which is the safe direction to be wrong in.
  startFromBoard(listing, opponent) {
    const claimed = db.prepare(`UPDATE challenges SET status = 'used' WHERE code = ? AND status = 'open'`).run(listing.code)
    if (!claimed.changes) return null
    const creator = getUser(listing.from_user)
    if (!creator) return null
    // The posting locked COIN, maybe days ago. The battle charges dollars NOW:
    // exact coin back, stake re-taken at today's price - so the poster's money
    // floated with ETH the whole wait, exactly like a balance. If their coin
    // fell and no longer covers the table, the listing dies with the refund
    // standing rather than starting a battle one side has not fully paid for.
    const fund = listing.mode === 'live' ? poolFund(listing.pool) : null
    const re = resettleLock(listing.from_user, listing.stake, fund)
    if (!re.ok) {
      db.prepare(`UPDATE challenges SET status = 'cancelled' WHERE code = ?`).run(listing.code)
      adminLog('system', `Board table ${listing.code} cancelled at match time - the poster's re-priced stake no longer covers $${listing.stake}; their coin was returned in full`)
      this.pushWallet(listing.from_user)
      this.hub.broadcast?.({ type: 'board.changed' })
      return null
    }
    const cfg = { mode: listing.mode, stake: listing.stake, duration: listing.duration, pool: listing.pool, training: false }
    let preset = null
    try { preset = JSON.parse(listing.picks) } catch { /* validated when posted; a corrupt row just runs a normal pick phase */ }
    const room = this.createRoom(cfg, [creator, opponent], 'board auto-match', preset ? { [creator.id]: preset } : null)
    this.hub.broadcast?.({ type: 'board.changed' })
    return room
  }

  // The mirror direction: a table posted onto a board while somebody is already
  // standing in the queue on those exact terms should start now, not sit there
  // for twelve hours. Returns the room, or null if nobody was waiting.
  matchListingToQueue(listing) {
    if (!listing || listing.status !== 'open' || !listing.listed || !listing.picks) return null
    const key = this.queueKey({ mode: listing.mode, stake: listing.stake, duration: listing.duration, pool: listing.pool })
    const q = this.queues.get(key)
    if (!q?.length) return null
    // Longest wait first (the queue is already in join order), never the author,
    // and never someone a room has already claimed.
    const i = q.findIndex((e) => e.userId !== listing.from_user && !this.userRoom.has(e.userId))
    if (i < 0) return null
    const entry = q[i]
    const opponent = getUser(entry.userId)
    if (!opponent) return null
    q.splice(i, 1)
    if (!q.length) this.queues.delete(key)
    const room = this.startFromBoard(listing, opponent)
    if (!room) {
      // The listing went in the instant between those two statements. Put them
      // back where they were: dropping a player out of matchmaking with a locked
      // stake and no battle is the one outcome this must never produce.
      q.splice(i, 0, entry)
      this.queues.set(key, q)
      return null
    }
    return room
  }

  // ---- training vs bot ----

  startTraining(user, opts = {}) {
    const cfg = {
      mode: 'classic', stake: 0, duration: Number(opts.duration) || 300, training: true,
      pool: typeof opts.pool === 'string' ? opts.pool : null,
      allowedIds: Array.isArray(opts.allowedIds) ? opts.allowedIds.filter((x) => typeof x === 'string') : null,
      // How the bot builds its portfolio (easy/normal/hard) - never how prices move.
      botLevel: ['easy', 'normal', 'hard'].includes(opts.difficulty) ? opts.difficulty : 'normal',
    }
    const bad = validateConfig(cfg)
    if (bad) return { error: bad }
    if (this.userRoom.has(user.id)) return { error: 'You already have an active battle.' }
    const lock = lockStake(user.id, 0, 'training')
    if (!lock.ok) return { error: lock.why }
    const botName = typeof opts.opponentName === 'string' && opts.opponentName ? opts.opponentName.slice(0, 24) : 'ArenaBot_' + Math.floor(100 + Math.random() * 900)
    const bot = { bot: true, name: botName, avatar: BOT_AVATARS[Math.floor(Math.random() * BOT_AVATARS.length)] }
    this.createRoom(cfg, [user, bot], 'training')
    return { ok: true }
  }

  // ---- rooms ----

  // `presetPicks` is { userId: picks } for a side that committed its portfolio
  // before the battle existed - a challenge taken off the open board, where the
  // author is not required to be here. Their side arrives already locked, so
  // the pick phase is only ever waiting on the person who just sat down.
  createRoom(cfg, pair, source, presetPicks = null) {
    const money = cfg.training ? { pct: 0, pool: 0, fee: 0, prize: 0 } : feeFor(cfg.stake)
    const room = {
      id: randomUUID().slice(0, 13),
      cfg, source,
      feePct: money.pct, pool: money.pool, fee: money.fee, prize: money.prize,
      phase: 'picking',
      pickLeft: PICK_SECONDS,
      players: pair.map((p) => p.bot
        ? { bot: true, userId: null, name: p.name, avatar: p.avatar, picks: null, locked: false, banner: null,
            lockAt: 5 + Math.floor(Math.random() * 15), stats: { wins: 0, losses: 0 } }
        : { bot: false, userId: p.id, name: p.name, avatar: p.avatar, picks: null, locked: false, banner: null,
            stats: statsFor(p.id) }),
      checks: null, checkIdx: 0,
      startPrices: null, startSim: null, endsAt: null,
      feedAtStart: null, feedLost: 0,
      result: null, events: [], doneAt: null,
    }
    ev(room, `Battle created - $${cfg.stake} ${cfg.mode}${cfg.training ? ' (training)' : ''} · ${source}`)
    ev(room, `Matched: ${room.players[0].name} vs ${room.players[1].name} - pick phase (${PICK_SECONDS}s)`)
    if (presetPicks) {
      for (const p of room.players) {
        const pre = !p.bot && presetPicks[p.userId]
        if (!pre) continue
        p.picks = pre.map((x) => ({ tokenId: x.tokenId, pct: Math.round(x.pct) }))
        p.locked = true
        ev(room, `${p.name} locked in when the challenge was posted (picks stay hidden)`)
      }
    }
    this.rooms.set(room.id, room)
    for (const p of room.players) {
      if (p.bot) continue
      this.userRoom.set(p.userId, room.id)
      relabelLock(p.userId, 'room:' + room.id)
    }
    this.pushState(room)
    return room
  }

  roomOf(userId) {
    const id = this.userRoom.get(userId)
    return id ? this.rooms.get(id) : null
  }

  sideOf(room, userId) {
    return room.players.findIndex((p) => !p.bot && p.userId === userId)
  }

  // Personalized view: opponent picks stay hidden until the battle is running.
  snapshotFor(room, idx) {
    const me = room.players[idx]
    const opp = room.players[1 - idx]
    const revealed = ['live', 'done'].includes(room.phase)
    return {
      id: room.id,
      mode: room.cfg.mode, stake: room.cfg.stake, duration: room.cfg.duration,
      training: !!room.cfg.training,
      battlePool: room.cfg.pool || null, // token category ("pool" is the money pool below)
      allowedIds: room.cfg.allowedIds || null,
      feePct: room.feePct, pool: room.pool, fee: room.fee, prize: room.prize,
      phase: room.phase, pickLeft: room.pickLeft, banner: me.banner,
      you: { picks: me.picks, locked: me.locked },
      opp: {
        name: opp.name, avatar: opp.avatar, locked: opp.locked,
        record: `${opp.stats.wins}W · ${opp.stats.losses}L`,
        picks: revealed ? opp.picks : null,
      },
      checks: room.checks,
      startPrices: room.startPrices,
      remaining: room.phase === 'live' ? Math.max(0, room.endsAt - simTime()) : null,
      result: room.phase === 'done' ? this.resultFor(room, idx) : null,
      events: room.events,
    }
  }

  pushState(room) {
    room.players.forEach((p, i) => {
      if (!p.bot) this.hub.send(p.userId, { type: 'duel.state', duel: this.snapshotFor(room, i) })
    })
  }

  pushWallet(userId) {
    const u = getUser(userId)
    if (!u) return
    this.hub.send(userId, {
      type: 'wallet',
      balance: balanceOf(userId),
      balanceCoin: balanceCoinOf(userId),
      coinUsd: ledgerPriceUsd(),
      funds: chainFunds(userId),
    })
  }

  // ---- player actions ----

  lockPicks(userId, picks) {
    const room = this.roomOf(userId)
    if (!room || room.phase !== 'picking') return { error: 'No active pick phase.' }
    const idx = this.sideOf(room, userId)
    const err = validatePicks(picks, room.cfg)
    if (err) return { error: err }
    const me = room.players[idx]
    me.picks = picks.map((p) => ({ tokenId: p.tokenId, pct: Math.round(p.pct) }))
    me.locked = true
    me.banner = null
    ev(room, `${me.name} locked in (picks stay hidden)`)
    this.maybeAdvanceFromPicking(room)
    this.pushState(room)
    return { ok: true }
  }

  cancelByPlayer(userId) {
    const room = this.roomOf(userId)
    if (!room) {
      // maybe still in queue
      return this.leaveQueue(userId) ? { ok: true } : { error: 'Nothing to cancel.' }
    }
    if (!['picking', 'checking'].includes(room.phase)) return { error: 'The battle is already running.' }
    this.cancelRoom(room, `${room.players[this.sideOf(room, userId)].name} left during pick phase - no penalty, stakes refunded.`)
    return { ok: true }
  }

  // ---- lifecycle internals ----

  maybeAdvanceFromPicking(room) {
    if (!room.players.every((p) => p.locked)) return
    if (room.cfg.mode === 'live' && !room.cfg.training) this.startChecking(room)
    else this.beginBattle(room)
  }

  startChecking(room) {
    const ids = [...new Set(room.players.flatMap((p) => p.picks.map((x) => x.tokenId)))]
    room.checks = ids.map((id) => ({ tokenId: id, status: 'pending' }))
    room.checkIdx = 0
    room.phase = 'checking'
    ev(room, 'Pre-battle token verification started')
    this.pushState(room)
  }

  runCheckStep(room) {
    if (room.checkIdx >= room.checks.length) {
      const failed = room.checks.filter((c) => c.status === 'fail')
      if (!failed.length) { ev(room, 'Pre-battle token verification passed'); this.beginBattle(room); return }
      const failedIds = failed.map((f) => f.tokenId)
      ev(room, `Pre-battle check failed: ${failedIds.join(', ')}`)
      let anyRepick = false
      for (const p of room.players) {
        if (!p.picks.some((x) => failedIds.includes(x.tokenId))) continue
        if (p.bot) {
          const pool = allowedTokenIds(room.cfg).filter((id) => !failedIds.includes(id))
          p.picks = botPicks(pool, room.cfg.botLevel, effToken)
        } else {
          p.locked = false
          p.picks = p.picks.filter((x) => !failedIds.includes(x.tokenId))
          p.banner = `Pre-battle check failed: ${failedIds.join(', ')} can no longer be traded safely. Replace it or cancel for a full refund.`
          anyRepick = true
        }
      }
      if (anyRepick) {
        room.phase = 'picking'
        room.pickLeft = PICK_SECONDS
        room.checks = null
        this.pushState(room)
      } else {
        this.startChecking(room)
      }
      return
    }
    const c = room.checks[room.checkIdx]
    const t = effToken(c.tokenId)
    // Optional-chained on purpose: a token record arriving without its safety
    // block is a data fault, and a data fault must fail this check, not throw
    // out of the tick loop and take every running battle down with it.
    const s = t?.safety
    const bad = !t || !s || t.paused || t.category === 'suspended' || t.category === 'ineligible' ||
      !s.tradable || s.honeypot || !s.liquidityOk
    c.status = bad ? 'fail' : 'pass'
    room.checkIdx++
    this.pushState(room)
  }

  beginBattle(room) {
    const prices = {}
    const ids = new Set(room.players.flatMap((p) => p.picks.map((x) => x.tokenId)))
    for (const id of ids) prices[id] = getPrice(id) // same tick for both players
    room.startPrices = prices
    room.startSim = simTime()
    room.endsAt = simTime() + room.cfg.duration
    room.feedAtStart = getFeedStatus()
    room.feedLost = 0
    room.phase = 'live'
    // Write down what the treasury is about to be holding for each player, so a
    // restart hands back coins instead of cash it would have to sell for.
    if (room.cfg.mode === 'live' && !room.cfg.training) {
      const entryNet = (room.cfg.stake - room.fee / 2) * (1 - SWAP_COST)
      for (const p of room.players) {
        if (!p.bot) saveBasket(p.userId, room.id, basketOf(room, p.picks, entryNet))
      }
    }
    ev(room, `Battle started - start prices locked for both players (${[...ids].join(', ')})`)
    this.pushState(room)
    // Buy the baskets NOW, not on the next 30s tick - every second between the
    // locked start prices and the real fill is price gap the reserve eats.
    if (room.cfg.mode === 'live' && !room.cfg.training) kickHedger()
  }

  cancelRoom(room, reason, { byAdmin = false, actor = 'system' } = {}) {
    if (['done', 'cancelled'].includes(room.phase)) return
    // A battle voided BEFORE it started bought nothing - the stake goes back as
    // money. One voided mid-flight already has both baskets sitting in the
    // treasury, and paying dollars for them would force a sale to cover the
    // refund: the one situation in-kind settlement exists to prevent. So the
    // player gets their own coins back, exactly as in a draw.
    const started = room.phase === 'live' && room.startPrices && room.cfg.mode === 'live' && !room.cfg.training
    const entryNet = started ? (room.cfg.stake - room.fee / 2) * (1 - SWAP_COST) : 0

    // Same question settle() asks: are the coins actually there? A void hands
    // baskets back in kind for the same reason a draw does, and with the same
    // failure mode - crediting coins the venue never bought. Cash refund of the
    // stake is the fallback; the treasury sells whatever partial fills remain.
    let delivered = started
    if (started) {
      const needed = {}
      for (const p of room.players) {
        if (p.bot) continue
        for (const [t, a] of Object.entries(basketOf(room, p.picks, entryNet))) needed[t] = (needed[t] || 0) + a
      }
      const stillOwed = holdingsOwed()
      for (const [t, a] of Object.entries(this.liveExposure(room.id))) stillOwed[t] = (stillOwed[t] || 0) + a
      const short = hedgeShortfallUsd(needed, stillOwed)
      if (short > 0) {
        delivered = false
        adminLog('system', `Duel ${room.id} void: hedge book short ${Number.isFinite(short) ? '$' + short : '(no price)'} of the baskets - stakes refunded in cash instead of coins`)
      }
    }

    room.phase = 'cancelled'
    room.doneAt = Date.now()
    clearBaskets(room.id) // settled here, so recovery must not hand them out again
    ev(room, `Battle cancelled - ${reason}`)
    for (const p of room.players) {
      if (p.bot) continue
      const basket = delivered ? basketOf(room, p.picks, entryNet) : {}
      if (Object.keys(basket).length) {
        releaseLock(p.userId) // stake was already spent on these coins
        for (const [tokenId, amount] of Object.entries(basket)) {
          creditTokens(p.userId, tokenId, amount, `Battle voided - kept your ${amount.toPrecision(6)} ${tokenId}`)
        }
      } else {
        releaseLock(p.userId, { refund: true, note: `Refund: ${reason}` })
      }
      this.userRoom.delete(p.userId)
      this.hub.send(p.userId, {
        type: 'duel.cancelled', duelId: room.id, byAdmin,
        reason: Object.keys(basket).length
          ? `${reason} Your coins were already bought, so you keep them - they are in your wallet.`
          : reason,
      })
      this.pushWallet(p.userId)
    }
    adminLog(actor, `Duel ${room.id} cancelled - ${reason}${delivered ? ' (baskets returned in kind)' : ''}`)
    if (room.cfg.mode === 'live' && !room.cfg.training) kickHedger()
  }

  settle(room) {
    // Priced AT the final whistle, not at the moment settlement got a turn on
    // the event loop. Those are the same instant on a quiet server and seconds
    // apart on a busy one - and the difference used to be real money.
    const endPrice = (id) => twapAt(id, room.endsAt)
    const [A, B] = room.players
    const rets = [
      portfolioReturn(A.picks, room.startPrices, endPrice),
      portfolioReturn(B.picks, room.startPrices, endPrice),
    ]
    const diff = rets[0] - rets[1]
    const outcomeA = Math.abs(diff) < DRAW_THRESHOLD ? 'draw' : diff > 0 ? 'win' : 'loss'
    const outcomes = [outcomeA, outcomeA === 'win' ? 'loss' : outcomeA === 'loss' ? 'win' : 'draw']

    const perToken = (picks) => picks.map((p) => {
      const p0 = room.startPrices[p.tokenId]
      const p1 = endPrice(p.tokenId)
      return { ...p, start: p0, end: p1, ret: ((p1 - p0) / p0) * 100 }
    })

    const stake = room.cfg.stake
    const payouts = [0, 0]
    const notes = ['', '']
    const finals = [null, null]
    const costs = [null, null]
    let inKind = false
    let baskets = [{}, {}]

    if (room.cfg.training) {
      notes[0] = notes[1] = 'Training battle - no payout'
    } else if (room.cfg.mode === 'classic') {
      outcomes.forEach((o, i) => {
        if (o === 'win') { payouts[i] = room.prize; notes[i] = `Fixed prize (pool $${room.pool} − fee $${room.fee})` }
        else if (o === 'draw') { payouts[i] = stake; notes[i] = 'Draw - full stake returned, fee waived' }
        else notes[i] = 'Opponent takes the pool'
      })
    } else {
      const entryGross = stake - room.fee / 2
      const entryNet = entryGross * (1 - SWAP_COST)
      const gross = rets.map((r) => entryNet * (1 + r / 100))
      const fin = gross.map((g) => g * (1 - SWAP_COST))
      finals[0] = fin[0]; finals[1] = fin[1]
      costs[0] = entryGross * SWAP_COST + gross[0] * SWAP_COST
      costs[1] = entryGross * SWAP_COST + gross[1] * SWAP_COST
      // Live settles IN KIND when the pool is really traded: the treasury bought
      // both baskets at the start, and the winner takes the coins themselves.
      // Nothing is sold to pay anyone, so no payout depends on an exit still
      // existing - which is the only way a rug stays the picker's problem and
      // never the house's. `payouts` still carries the dollar value for the
      // scoreboard and history; it just isn't what gets credited.
      // "The treasury really is holding these baskets" is a question, not an
      // assumption: a buy can fail, a feed can die, a sub-threshold diff is
      // never traded. So ask the book - everything this settlement hands out,
      // on top of what every other battle and every holder is still owed. If
      // the coins aren't there, paying them out anyway wouldn't make them
      // exist; the cash path below is the honest fallback.
      baskets = room.players.map((p) => basketOf(room, p.picks, entryNet))
      inKind = baskets.every((b) => Object.keys(b).length > 0)
      if (inKind) {
        const needed = {}
        for (const b of baskets) for (const [t, a] of Object.entries(b)) needed[t] = (needed[t] || 0) + a
        const stillOwed = holdingsOwed()
        for (const [t, a] of Object.entries(this.liveExposure(room.id))) stillOwed[t] = (stillOwed[t] || 0) + a
        const short = hedgeShortfallUsd(needed, stillOwed)
        if (short > 0) {
          inKind = false
          ev(room, `Treasury book is short on these coins - settled in cash at final value instead`)
          adminLog('system', `Duel ${room.id}: hedge book short ${Number.isFinite(short) ? '$' + short : '(no price)'} of the baskets owed - settled in CASH, check hedge trades/venue`)
        }
      }
      outcomes.forEach((o, i) => {
        if (o === 'win') { payouts[i] = fin[0] + fin[1]; notes[i] = inKind ? 'Both portfolios, paid in the coins themselves' : 'Final combined value of both portfolios, after swap costs' }
        else if (o === 'draw') { payouts[i] = fin[i]; notes[i] = inKind ? 'Draw - you keep your own coins' : 'Draw - you keep the final value of your own portfolio' }
        else notes[i] = inKind ? 'Opponent takes both portfolios' : 'Opponent takes the final combined value'
      })
    }
    payouts[0] = Math.round(payouts[0] * 100) / 100
    payouts[1] = Math.round(payouts[1] * 100) / 100

    const tokens = [perToken(A.picks), perToken(B.picks)]
    room.result = { rets, outcomes, payouts, notes, finals, costs, tokens, endedAt: Date.now() }
    room.phase = 'done'
    room.doneAt = Date.now()
    clearBaskets(room.id) // paid out below; recovery must not hand them out twice
    ev(room, `Settled via 30-reading TWAP - ${A.name} ${rets[0].toFixed(2)}% vs ${B.name} ${rets[1].toFixed(2)}% (${outcomeA} for ${A.name})`)

    const flagged = Math.abs(rets[0]) > 25 || Math.abs(rets[1]) > 25 ? 1 : 0

    txn(() => {
      room.players.forEach((p, i) => {
        if (p.bot) return
        // Winnings land back on the chains the stake came from, in the same
        // proportion - a Live win on the Robinhood pool is money that exists as
        // USDG there, and saying otherwise would let a player withdraw it
        // somewhere it isn't.
        const fundPlan = lockPlan(getLock(p.userId))
        releaseLock(p.userId) // stake was consumed by the battle
        if (inKind) {
          // Winner takes every coin from both baskets; a draw returns each
          // player their own. The fee was already taken in stablecoin at entry,
          // so what moves here is purely the players' coins.
          const won = outcomes[i] === 'win' ? [baskets[0], baskets[1]]
            : outcomes[i] === 'draw' ? [baskets[i]] : []
          for (const basket of won) {
            for (const [tokenId, amount] of Object.entries(basket)) {
              creditTokens(p.userId, tokenId, amount,
                outcomes[i] === 'draw'
                  ? `Draw in $${stake} live battle - kept ${amount.toPrecision(6)} ${tokenId}`
                  : `Won $${stake} live battle vs ${room.players[1 - i].name} - received ${amount.toPrecision(6)} ${tokenId}`)
            }
          }
        } else if (payouts[i] > 0) {
          const why = outcomes[i] === 'draw'
            ? `Draw in $${stake} ${room.cfg.mode} battle`
            : `Won $${stake} ${room.cfg.mode} battle vs ${room.players[1 - i].name}`
          creditLike(p.userId, payouts[i], outcomes[i] === 'draw' ? 'refund' : 'win', why, fundPlan)
          // Winnings stay as arena balance; this only records the lockdown
          // state. A training battle has nothing to record.
          if (!room.cfg.training) payoutWinnings(p.userId, payouts[i], fundPlan, why)
        }
        if (room.cfg.training) {
          db.prepare('UPDATE users SET training_done = 1 WHERE id = ?').run(p.userId)
        }
      })
      db.prepare(`
        INSERT INTO matches (id, ts, mode, stake, duration, training, tournament_id,
          user_a, user_b, name_a, name_b, ret_a, ret_b, outcome_a, payout_a, payout_b,
          fee, pool, flagged, data)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        room.id, Date.now(), room.cfg.mode, stake, room.cfg.duration,
        room.cfg.training ? 1 : 0, null, // tournament results live in their own tables now
        A.bot ? null : A.userId, B.bot ? null : B.userId, A.name, B.name,
        rets[0], rets[1], outcomeA, payouts[0], payouts[1],
        room.fee, room.pool, flagged,
        JSON.stringify({
          tokensA: tokens[0], tokensB: tokens[1],
          finals, costs, notes, feePct: room.feePct, pool: room.cfg.pool || null,
          avatarA: A.avatar, avatarB: B.avatar,
          events: room.events, feedAtStart: room.feedAtStart,
          // Mid-battle standing, captured by the tick loop: [retA, retB] at the
          // 75% mark, and whether each player trailed inside the final 10%.
          // Comeback achievements derive from THIS, never from memory of a room.
          clutch: { at75: room.clutch75 || null, trailedLate: room.trailedLate || [false, false] },
        }),
      )
    })

    room.players.forEach((p, i) => {
      if (p.bot) return
      this.userRoom.delete(p.userId)
      this.hub.send(p.userId, { type: 'duel.done', duel: this.snapshotFor(room, i) })
      this.pushWallet(p.userId)
    })
    if (flagged) adminLog('system', `Match ${room.id} auto-flagged: extreme return (${rets[0].toFixed(1)}% / ${rets[1].toFixed(1)}%)`)
    // Exposure just dropped (cash settlement frees the whole basket; in-kind
    // moves it to holdingsOwed) - let the book adjust right away.
    if (room.cfg.mode === 'live' && !room.cfg.training) kickHedger()
  }

  resultFor(room, idx) {
    const r = room.result
    if (!r) return null
    return {
      outcome: r.outcomes[idx],
      retYou: r.rets[idx], retOpp: r.rets[1 - idx], diff: r.rets[idx] - r.rets[1 - idx],
      payout: r.payouts[idx], payoutNote: r.notes[idx],
      youTokens: r.tokens[idx], oppTokens: r.tokens[1 - idx],
      finalYou: r.finals[idx], finalOpp: r.finals[1 - idx],
      costYou: r.costs[idx], costOpp: r.costs[1 - idx],
      endedAt: r.endedAt, matchId: room.id,
    }
  }

  // ---- per-second tick ----

  tick() {
    // queue status for everyone waiting
    for (const [key, q] of this.queues) {
      const total = [...this.queues.values()].reduce((a, x) => a + x.length, 0)
      for (const e of q) this.hub.send(e.userId, { type: 'queue.status', searching: total, key })
    }

    // Waited long enough with nobody at your number? Ask whether they'd take
    // the nearest smaller table instead. Snapshot the list first: answering
    // happens over the API, but a fresh join could still land mid-sweep.
    for (const e of [...this.queues.values()].flat()) {
      if (e.pendingOffer || simTime() - e.since < QUEUE_OFFER_SECS) continue
      if (e.lastOffer != null && simTime() - e.lastOffer < QUEUE_OFFER_SECS) continue
      e.lastOffer = simTime()
      this.offerNearest(e.userId)
    }

    for (const room of this.rooms.values()) {
      switch (room.phase) {
        case 'picking': {
          room.pickLeft--
          for (const p of room.players) {
            if (p.bot && !p.locked && PICK_SECONDS - room.pickLeft >= p.lockAt) {
              p.picks = botPicks(allowedTokenIds(room.cfg), room.cfg.botLevel, effToken)
              p.locked = true
              ev(room, `${p.name} locked in (picks stay hidden)`)
              this.maybeAdvanceFromPicking(room)
            }
          }
          if (room.phase !== 'picking') { this.pushState(room); break }
          if (room.pickLeft <= 0) {
            for (const p of room.players) {
              if (p.bot && !p.locked) { p.picks = botPicks(allowedTokenIds(room.cfg), room.cfg.botLevel, effToken); p.locked = true }
            }
            if (room.players.every((p) => p.locked)) this.maybeAdvanceFromPicking(room)
            else this.cancelRoom(room, 'Pick time expired - no penalty, stakes refunded.')
          } else if (room.pickLeft % 5 === 0) {
            this.pushState(room) // keep timers in sync without spamming full state every second
          }
          break
        }
        case 'checking': {
          this.runCheckStep(room)
          break
        }
        case 'live': {
          if (!room.cfg.training && room.feedAtStart === 'live') {
            room.feedLost = getFeedStatus() === 'sim' ? room.feedLost + 1 : 0
            // A flat 90s void window is longer than the shortest battle: a
            // 1-minute match could run start to finish on simulated prices and
            // still pay out real money, because the counter never reached the
            // threshold. Half the duration, capped at the old value - every
            // rung from 5 min up keeps exactly the behaviour it had.
            const voidAfter = Math.min(FEED_LOSS_VOID_SECS, Math.floor(room.cfg.duration / 2))
            if (room.feedLost >= voidAfter) {
              this.cancelRoom(room, 'Price source went down during the battle - match voided, full stakes refunded.')
              break
            }
          }
          if (simTime() >= room.endsAt) { this.settle(room); break }
          const ids = [...new Set(room.players.flatMap((p) => p.picks.map((x) => x.tokenId)))]
          const prices = {}
          for (const id of ids) prices[id] = getPrice(id)
          const rets = room.players.map((p) => portfolioReturn(p.picks, room.startPrices))

          // The clutch record: who stood where at the 75% mark, and whether each
          // player trailed at any point inside the final 10%. Achievements pay
          // for coming from behind, and "behind" has to come from the record -
          // so it is captured here, where the battle actually happens, and
          // written into the match row at settlement. First tick past each
          // boundary wins; at 1x speed that is within a second of the mark.
          const frac = (simTime() - room.startSim) / room.cfg.duration
          if (frac >= 0.75 && !room.clutch75) room.clutch75 = [round4(rets[0]), round4(rets[1])]
          if (frac >= 0.9) {
            if (!room.trailedLate) room.trailedLate = [false, false]
            if (rets[0] < rets[1]) room.trailedLate[0] = true
            else if (rets[1] < rets[0]) room.trailedLate[1] = true
          }

          room.players.forEach((p, i) => {
            if (p.bot) return
            this.hub.send(p.userId, {
              type: 'duel.tick', duelId: room.id,
              remaining: Math.max(0, room.endsAt - simTime()),
              prices, retYou: rets[i], retOpp: rets[1 - i],
              feed: getFeedStatus(),
            })
          })
          break
        }
        default: break
      }
    }

    // GC finished rooms after 10 minutes
    const cutoff = Date.now() - 10 * 60 * 1000
    for (const [id, room] of this.rooms) {
      if (room.doneAt && room.doneAt < cutoff) this.rooms.delete(id)
    }
  }

  // ---- admin ----

  activeRooms() {
    return [...this.rooms.values()]
      .filter((r) => !['done', 'cancelled'].includes(r.phase))
      .map((r) => ({
        id: r.id, mode: r.cfg.mode, stake: r.cfg.stake, duration: r.cfg.duration,
        training: !!r.cfg.training, phase: r.phase,
        players: r.players.map((p) => p.name),
        remaining: r.phase === 'live' ? Math.max(0, Math.round(r.endsAt - simTime())) : null,
      }))
  }

  // One real battle to put on the front page: the biggest one actually running.
  // Public-safe by construction - only rooms already past the pick phase are
  // eligible, so no portfolio is revealed before its owner locked it, and the
  // returns are computed here rather than trusted from a client.
  spotlight() {
    const live = [...this.rooms.values()].filter((r) => r.phase === 'live' && !r.cfg.training && r.startPrices)
    if (!live.length) return null
    const room = live.sort((a, b) => b.cfg.stake - a.cfg.stake)[0]
    const side = (p) => ({
      name: p.name, avatar: p.avatar,
      picks: (p.picks || []).map((x) => ({ tokenId: x.tokenId, pct: x.pct })),
      ret: portfolioReturn(p.picks, room.startPrices, (id) => getPrice(id)),
    })
    return {
      id: room.id, mode: room.cfg.mode, stake: room.cfg.stake, pool: room.pool,
      remaining: Math.max(0, Math.round(room.endsAt - simTime())),
      a: side(room.players[0]), b: side(room.players[1]),
    }
  }

  voidRoom(roomId, actor) {
    const room = this.rooms.get(roomId)
    if (!room || ['done', 'cancelled'].includes(room.phase)) return false
    this.cancelRoom(room, 'Match voided by the arena - full stakes refunded.', { byAdmin: true, actor })
    return true
  }
}
