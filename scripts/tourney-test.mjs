// Tournament test. Two layers:
//   1. unit - payout spec, pot fee bands, tie-group ranking and prize splits
//      (pure functions, no server)
//   2. integration - a real spawned server and six real ws players: lobby
//      countdown, leave-refund, below-min clock stop, no-lock refund, one
//      shared battle start, live board, settlement and exact wallet math.
//
// Usage: node scripts/tourney-test.mjs

import { spawn } from 'node:child_process'
import { rmSync, mkdirSync } from 'node:fs'
import WebSocket from 'ws'

const PORT = 8793
const BASE = `http://localhost:${PORT}`
const DB_DIR = 'server/data/tourney-test'

const log = (...a) => console.log('[tourney]', ...a)
const fail = (msg) => { console.error('[FAIL]', msg); process.exitCode = 1 }
const assert = (cond, msg) => { if (!cond) fail(msg); else log('ok:', msg) }
const near = (a, b, eps = 0.011) => Math.abs(a - b) < eps
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- unit: pure math (fresh throwaway DB so rules.js can read settings) ----
rmSync(DB_DIR, { recursive: true, force: true })
mkdirSync(DB_DIR, { recursive: true })
process.env.HOOD_DB = `${DB_DIR}/unit.db`

const { payoutSpec, tourneyMoney, payoutTable, rankGroups, prizesFor, MIN_PLAYERS, MAX_PLAYERS } = await import('../server/tourney.js')

assert(MIN_PLAYERS === 5 && MAX_PLAYERS === 10, 'field is 5-10 players')
assert(JSON.stringify(payoutSpec(5)) === '[100]' && JSON.stringify(payoutSpec(6)) === '[100]', '5-6 players → winner takes all')
assert(JSON.stringify(payoutSpec(7)) === '[70,30]' && JSON.stringify(payoutSpec(8)) === '[70,30]', '7-8 players → 70/30')
assert(JSON.stringify(payoutSpec(9)) === '[50,30,20]' && JSON.stringify(payoutSpec(10)) === '[50,30,20]', '9-10 players → 50/30/20')

// fee band by POT, not by entry
let m = tourneyMoney(10, 10)
assert(m.pot === 100 && m.pct === 8 && m.fee === 8 && m.prizePool === 92, 'ten $10 entries → $100 pot pays the $100 band (8%)')
m = tourneyMoney(5, 10)
assert(m.pot === 50 && m.pct === 10 && m.fee === 5 && m.prizePool === 45, 'five $10 entries → $50 pot pays the micro band (10%)')
m = tourneyMoney(10, 50)
assert(m.pot === 500 && m.pct === 6 && m.fee === 30 && m.prizePool === 470, 'ten $50 entries → $500 pot pays 6%')
m = tourneyMoney(10, 100)
assert(m.pot === 1000 && m.pct === 5 && m.fee === 50 && m.prizePool === 950, 'ten $100 entries → $1000 pot pays 5%')
assert(JSON.stringify(payoutTable(10, 100)) === JSON.stringify([
  { place: 1, amount: 475 }, { place: 2, amount: 285 }, { place: 3, amount: 190 },
]), 'full $100 table pays 475 / 285 / 190')

// ranking: distinct, tied, and chained-tie fields
assert(JSON.stringify(rankGroups([5, 3, 1])) === '[[0],[1],[2]]', 'distinct returns rank alone')
assert(JSON.stringify(rankGroups([3, 5, 4.96])) === '[[1,2],[0]]', 'two within 0.05pp share a group (any input order)')
assert(JSON.stringify(rankGroups([5, 4.96, 4.93])) === '[[0,1,2]]', 'consecutive near-ties chain into one group')

// prizes: clean case, tie split, and cent-exact totals
let p = prizesFor([[0], [1], [2], [3], [4]], [50, 30, 20], 950)
assert(JSON.stringify(p.prizes) === '[475,285,190,0,0]' && JSON.stringify(p.ranks) === '[1,2,3,4,5]', 'distinct field → 475/285/190, places 4-5 unpaid')
p = prizesFor([[0, 1], [2], [3], [4]], [50, 30, 20], 950)
assert(p.prizes[0] === 380 && p.prizes[1] === 380 && p.prizes[2] === 190, 'tie for 1st splits (50+30)/2 → $380 each, 3rd keeps $190')
assert(p.ranks[0] === 1 && p.ranks[1] === 1 && p.ranks[2] === 3, 'both tied players are rank 1, next is rank 3')
p = prizesFor([[0], [1], [2]], [50, 30, 20], 92)
assert(near(p.prizes[0], 46) && near(p.prizes[1], 27.6) && near(p.prizes[2], 18.4), '$92 pool splits 46 / 27.60 / 18.40')
p = prizesFor([[0, 1, 2]], [50, 30, 20], 100)
const sum3 = p.prizes.reduce((a, x) => a + x, 0)
assert(near(sum3, 100) && near(p.prizes[1], 33.33), 'three-way tie over all places: thirds, cent leftover to the top')
p = prizesFor([[0], [1], [2], [3], [4], [5], [6]], [70, 30], 230)
assert(near(p.prizes[0], 161) && near(p.prizes[1], 69) && p.prizes[2] === 0, 'seven-player 70/30 → $161 / $69')

// ---- integration: real server, six real players ----
// (unit.db stays open in THIS process - Windows won't let us delete it here;
// the top-of-file rmSync clears it on the next run, and the spawned server
// gets its own test.db)
// No curated tokens and no ingest with rails off - the test injects its own
// Robinhood-pool book. Seven Verified coins (the pick rotation needs that many
// distinct ids) plus GHOST, a token wearing the removed 'eth' pool id, to
// prove cross-pool picks still get refused.
const FIXTURES = [
  { id: 'RHA', ticker: 'RHA', name: 'Robo Alpha', pool: 'sol', category: 'verified', maxStake: 1000, base: 1.25, vol: 'high', dynamic: true, liquidity: 500000, volume24: 250000 },
  { id: 'RHB', ticker: 'RHB', name: 'Robo Beta', pool: 'sol', category: 'verified', maxStake: 1000, base: 0.031, vol: 'high', dynamic: true, liquidity: 400000, volume24: 200000 },
  { id: 'RHC', ticker: 'RHC', name: 'Robo Gamma', pool: 'sol', category: 'verified', maxStake: 1000, base: 42, vol: 'high', dynamic: true, liquidity: 300000, volume24: 150000 },
  { id: 'RHD', ticker: 'RHD', name: 'Robo Delta', pool: 'sol', category: 'verified', maxStake: 1000, base: 0.0007, vol: 'insane', dynamic: true, liquidity: 200000, volume24: 100000 },
  { id: 'RHE', ticker: 'RHE', name: 'Robo Epsilon', pool: 'sol', category: 'verified', maxStake: 1000, base: 3.6, vol: 'high', dynamic: true, liquidity: 150000, volume24: 90000 },
  { id: 'RHF', ticker: 'RHF', name: 'Robo Zeta', pool: 'sol', category: 'verified', maxStake: 1000, base: 0.52, vol: 'high', dynamic: true, liquidity: 120000, volume24: 70000 },
  { id: 'RHG', ticker: 'RHG', name: 'Robo Eta', pool: 'sol', category: 'verified', maxStake: 1000, base: 7.7, vol: 'high', dynamic: true, liquidity: 110000, volume24: 60000 },
  { id: 'GHOST', ticker: 'GHOST', name: 'Ghost of Robinhood', pool: 'eth', category: 'verified', maxStake: 1000, base: 1.0, vol: 'high', dynamic: true, liquidity: 100000, volume24: 50000 },
]

const server = spawn(process.execPath, ['server/index.js'], {
  env: {
    ...process.env,
    HOOD_PORT: String(PORT),
    HOOD_DB: `${DB_DIR}/test.db`,
    HOOD_SPEED: '60',          // 300s battle ≈ 5s real, 180s lobby clock ≈ 3s real
    HOOD_PICK_SECONDS: '6',    // pick deadline is real seconds - keep the no-lock case fast
    HOOD_ADMIN_PASS: 'testadmin123',
    HOOD_RAILS: 'off',
    HOOD_FIXTURE_TOKENS: JSON.stringify(FIXTURES),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stdout.on('data', (d) => process.stdout.write('[server] ' + d))
server.stderr.on('data', (d) => process.stderr.write('[server!] ' + d))

const api = async (path, { method = 'GET', token, body } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  return { status: res.status, data }
}

class Player {
  constructor(name) { this.name = name; this.token = null; this.ws = null; this.inbox = []; this.cursor = 0 }
  async register() {
    const { status, data } = await api('/api/register', { method: 'POST', body: { name: this.name, password: 'hunter22222' } })
    if (status !== 200) throw new Error(`register ${this.name}: ${JSON.stringify(data)}`)
    this.token = data.token
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://localhost:${PORT}/ws?token=${this.token}`)
      this.ws.on('message', (raw) => this.inbox.push(JSON.parse(String(raw))))
      this.ws.on('open', resolve)
      this.ws.on('error', reject)
    })
  }
  send(msg) { this.ws.send(JSON.stringify(msg)) }
  async waitFor(pred, timeoutMs, what) {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      for (let i = this.cursor; i < this.inbox.length; i++) {
        if (pred(this.inbox[i])) { this.cursor = i + 1; return this.inbox[i] }
      }
      await wait(100)
    }
    throw new Error(`${this.name}: timeout waiting for ${what}`)
  }
  // lobby broadcasts arrive constantly - peek at the latest without consuming
  latestLobbies() {
    for (let i = this.inbox.length - 1; i >= 0; i--) {
      if (this.inbox[i].type === 'tourney.lobbies') return this.inbox[i].lobbies
    }
    return null
  }
  async balance() { return (await api('/api/me', { token: this.token })).data.balance }
}

const runTraining = async (p) => {
  p.send({ type: 'training.start', duration: 300 })
  await p.waitFor((m) => m.type === 'duel.state' && m.duel.phase === 'picking', 15000, 'training picking')
  p.send({ type: 'duel.lock', picks: [{ tokenId: 'RHA', pct: 50 }, { tokenId: 'RHB', pct: 30 }, { tokenId: 'RHC', pct: 20 }] })
  await p.waitFor((m) => m.type === 'duel.done', 90000, 'training done')
}

const main = async () => {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) break } catch { /* booting */ }
    await wait(200)
    if (i === 49) throw new Error('server never came up')
  }
  log('server is up')

  const players = ['t_ana', 't_bora', 't_ceda', 't_dara', 't_eva', 't_fica'].map((n) => new Player(n))
  const [ana, bora, ceda, dara, eva, fica] = players
  // a second field, to prove two tournaments of the SAME tier run concurrently
  const crowd = ['t_goca', 't_hana', 't_iva', 't_jole', 't_kika'].map((n) => new Player(n))
  for (const p of [...players, ...crowd]) { await p.register(); await p.connect(); await p.waitFor((m) => m.type === 'hello', 5000, 'hello') }

  // one $10/$50/$100 table for the arena's one pool (Robinhood)
  const lobT10 = (ls) => ls.find((l) => l.tier === 't10' && l.pool === 'sol')
  const board = ana.latestLobbies() || (await api('/api/tournaments')).data.lobbies
  assert(board?.length === 3, 'three standing tables: 3 stakes × 1 pool (RH-only arena)')
  assert(board.every((l) => l.pool === 'sol') && board.map((l) => l.stake).join(',') === '10,50,100', 'all tables are Solana tables')
  assert(board.every((l) => !l.blocked), 'the fixture book keeps every table open (3+ eligible tokens)')

  // The training gate was REMOVED (owner, 31 Jul 2026): an untrained player can
  // take a tournament seat straight away. Take one, then give it back so the
  // lobby counts below start from zero.
  ana.send({ type: 'tourney.join', tier: 't10', pool: 'sol' })
  await ana.waitFor((m) => m.type === 'tourney.lobbies' && m.lobbies.find((l) => l.tier === 't10' && l.pool === 'sol').count === 1, 5000, 'untrained player seated')
  log('ok: no training gate - an untrained player can enter a tournament')
  ana.send({ type: 'tourney.leave' })
  await ana.waitFor((m) => m.type === 'tourney.lobbies' && m.lobbies.find((l) => l.tier === 't10' && l.pool === 'sol').count === 0, 5000, 'seat given back')

  log('training all eleven players…')
  await Promise.all([...players, ...crowd].map(runTraining))
  assert(await ana.balance() === 1000, 'training left wallets untouched')

  // the removed pools are gone from the board entirely - joining one is
  // refused as an unknown table, not silently mapped anywhere
  ana.send({ type: 'tourney.join', tier: 't10', pool: 'eth' })
  await ana.waitFor((m) => m.type === 'error' && /no such/i.test(m.msg), 5000, 'removed pool refuses entry')
  log('ok: a removed pool has no table to join')

  // join → stake locked; leave → full refund
  ana.send({ type: 'tourney.join', tier: 't10', pool: 'sol' })
  await ana.waitFor((m) => m.type === 'tourney.lobbies' && lobT10(m.lobbies).count === 1, 5000, 'ana in lobby')
  assert(await ana.balance() === 990, 'entry locked $10 on join')
  ana.send({ type: 'queue.join', mode: 'classic', stake: 100, duration: 300, pool: 'sol' })
  await ana.waitFor((m) => m.type === 'error' && /already/i.test(m.msg), 5000, 'queue blocked while in lobby')
  log('ok: a lobby seat blocks 1v1 matchmaking (one stake lock per user)')
  ana.send({ type: 'tourney.join', tier: 't50', pool: 'sol' })
  await ana.waitFor((m) => m.type === 'error' && /already in a tournament/i.test(m.msg), 5000, 'double-join blocked')
  log('ok: one tournament at a time')
  ana.send({ type: 'tourney.leave' })
  await ana.waitFor((m) => m.type === 'tourney.lobbies' && lobT10(m.lobbies).count === 0, 5000, 'ana left')
  assert(await ana.balance() === 1000, 'leaving the lobby refunds in full')

  // five in → countdown; drop below five → clock stops; refill → it restarts
  for (const p of [ana, bora, ceda, dara]) p.send({ type: 'tourney.join', tier: 't10', pool: 'sol' })
  await ana.waitFor((m) => m.type === 'tourney.lobbies' && lobT10(m.lobbies).count === 4, 5000, 'four in')
  assert(lobT10(ana.latestLobbies()).countdownLeft == null, 'no clock below five players')
  eva.send({ type: 'tourney.join', tier: 't10', pool: 'sol' })
  await ana.waitFor((m) => m.type === 'tourney.lobbies' && lobT10(m.lobbies).countdownLeft != null, 5000, 'clock started at five')
  log('ok: fifth player starts the countdown')
  eva.send({ type: 'tourney.leave' })
  await ana.waitFor((m) => m.type === 'tourney.lobbies' && lobT10(m.lobbies).count === 4 && lobT10(m.lobbies).countdownLeft == null, 5000, 'clock stopped')
  log('ok: dropping below five stops the clock')
  eva.send({ type: 'tourney.join', tier: 't10', pool: 'sol' })
  fica.send({ type: 'tourney.join', tier: 't10', pool: 'sol' })
  await ana.waitFor((m) => m.type === 'tourney.lobbies' && lobT10(m.lobbies).count === 6 && lobT10(m.lobbies).countdownLeft != null, 5000, 'six in, clock running')

  // countdown expires (180 sim-secs ≈ 3s at speed 60) → pick phase for all six
  const pickStates = await Promise.all(players.map((p) =>
    p.waitFor((m) => m.type === 'duel.state' && m.duel.phase === 'picking' && m.duel.tourney, 20000, 'pick phase')))
  const tid = pickStates[0].duel.id
  assert(pickStates.every((s) => s.duel.id === tid), 'all six are in the same tournament')
  assert(pickStates.every((s) => s.duel.tourney.count === 6), 'field of six')
  assert(pickStates[0].duel.battlePool === 'sol', 'tournament plays the Solana Memes pool')
  assert(lobT10(ana.latestLobbies()).count === 0, 'a fresh $10 lobby opened the moment the tournament started')

  const picksFor = (i) => {
    const rot = [['RHA', 'RHB', 'RHC'], ['RHB', 'RHD', 'RHA'], ['RHC', 'RHE', 'RHF'], ['RHD', 'RHG', 'RHE'], ['RHF', 'RHA', 'RHG']][i]
    return [{ tokenId: rot[0], pct: 50 }, { tokenId: rot[1], pct: 30 }, { tokenId: rot[2], pct: 20 }]
  }

  // …and that fresh lobby is a real one: while the first field is still
  // picking, a SECOND five fills it and launches a second $10 tournament.
  for (const p of crowd) p.send({ type: 'tourney.join', tier: 't10', pool: 'sol' })
  const pickB = await Promise.all(crowd.map((p) =>
    p.waitFor((m) => m.type === 'duel.state' && m.duel.phase === 'picking' && m.duel.tourney, 20000, 'second field picking')))
  const tidB = pickB[0].duel.id
  assert(tidB !== tid && pickB.every((s) => s.duel.id === tidB), 'the second field is its own tournament')
  const runningNow = lobT10((await api('/api/tournaments')).data.lobbies).running
  assert(runningNow.length === 2, 'two $10 tournaments run at the same time')
  crowd.forEach((p, i) => p.send({ type: 'duel.lock', picks: picksFor(i) }))

  // five lock, fica sleeps through the pick deadline
  // wrong-pool picks refused inside the tournament (GHOST wears the removed
  // 'sol' pool id - the shape of a legacy Solana coin)
  ana.send({ type: 'duel.lock', picks: [{ tokenId: 'GHOST', pct: 50 }, { tokenId: 'RHB', pct: 30 }, { tokenId: 'RHC', pct: 20 }] })
  await ana.waitFor((m) => m.type === 'error' && m.re === 'duel.lock', 5000, 'cross-pool tournament lock rejected')
  log('ok: foreign-pool picks refused in a Solana Memes tournament')
  ;[ana, bora, ceda, dara, eva].forEach((p, i) => p.send({ type: 'duel.lock', picks: picksFor(i) }))

  const cancelled = await fica.waitFor((m) => m.type === 'duel.cancelled', 20000, 'fica refunded out')
  assert(/refunded/i.test(cancelled.reason), 'sleeping through the pick deadline refunds the entry')
  assert(await fica.balance() === 1000, 'fica got the $10 back')

  const liveStates = await Promise.all([ana, bora, ceda, dara, eva].map((p) =>
    p.waitFor((m) => m.type === 'duel.state' && m.duel.phase === 'live' && m.duel.tourney, 20000, 'live')))
  assert(liveStates.every((s) => s.duel.tourney.count === 5), 'battle started with the five who locked')
  assert(liveStates.every((s) => JSON.stringify(s.duel.startPrices) === JSON.stringify(liveStates[0].duel.startPrices)), 'identical start prices for the whole field')
  assert(liveStates[0].duel.tourney.money.pot === 50 && liveStates[0].duel.tourney.money.fee === 5, 'final pot $50, fee $5 (10% band)')
  assert(liveStates[0].duel.tourney.payouts.length === 1, 'five players → winner takes all')
  assert(liveStates[0].duel.tourney.players.every((p) => p.picks?.length === 3), 'everyone sees everyone\'s picks once live')

  const tick = await ana.waitFor((m) => m.type === 'tourney.tick', 10000, 'live board tick')
  assert(tick.rows.length === 5 && tick.rows.every((r) => typeof r.ret === 'number'), 'live board carries all five returns')

  ana.send({ type: 'tourney.leave' })
  await ana.waitFor((m) => m.type === 'error' && /running/i.test(m.msg), 5000, 'no leaving a running battle')
  log('ok: no exit once the battle is running')

  // settlement (300 sim-secs ≈ 5s)
  const doneStates = await Promise.all([ana, bora, ceda, dara, eva].map((p) =>
    p.waitFor((m) => m.type === 'duel.state' && m.duel.phase === 'done' && m.duel.tourney, 60000, 'settled')))
  const results = doneStates.map((s) => s.duel.result)
  const prizeSum = results.reduce((a, r) => a + r.prize, 0)
  assert(near(prizeSum, 45), `prizes paid out sum to the $45 prize pool (got $${prizeSum.toFixed(2)})`)
  // Ties are legitimate: everyone at rank 1 must be within the 0.05pp draw
  // band of the best return, and they split the top evenly.
  const topRet = Math.max(...results.map((r) => r.ret))
  const rank1s = results.filter((r) => r.rank === 1)
  assert(rank1s.length >= 1 && rank1s.every((r) => topRet - r.ret < 0.051), 'rank 1 is the best return (or tied within the draw band)')
  assert(rank1s.every((r) => near(r.prize, prizeSum / rank1s.length)), `the ${rank1s.length} player(s) at rank 1 split the pool evenly`)
  const standings = results[0].standings
  assert(standings.length === 5 && standings.every((p, i) => i === 0 || standings[i - 1].rank <= p.rank), 'standings are ranked for everyone')

  // the second field settles independently, with its own pot
  const doneB = await Promise.all(crowd.map((p) =>
    p.waitFor((m) => m.type === 'duel.state' && m.duel.phase === 'done' && m.duel.tourney, 60000, 'second field settled')))
  const prizeSumB = doneB.reduce((a, s) => a + s.duel.result.prize, 0)
  assert(doneB.every((s) => s.duel.id === tidB), 'second field settled as its own tournament')
  assert(near(prizeSumB, 45), `second tournament paid its own $45 pool (got $${prizeSumB.toFixed(2)})`)

  // wallet conservation across BOTH tournaments: 11×$1000 − two $5 fees = $10,990
  const balances = await Promise.all([...players, ...crowd].map((p) => p.balance()))
  const total = balances.reduce((a, b) => a + b, 0)
  assert(near(total, 10990, 0.05), `the two fees are the only money that left the players (total $${total.toFixed(2)})`)

  // history + profile stats count the tournament
  const anaR = results[0]
  const hist = await api('/api/history', { token: ana.token })
  const trow = hist.data.matches.find((m) => m.tourney)
  assert(trow && trow.id === tid && trow.tourney.players === 5, 'history lists the tournament with the full field')
  assert(near(trow.payout, anaR.prize) && trow.tourney.rank === anaR.rank, 'history row carries this seat\'s rank and prize')
  assert(Array.isArray(trow.youTokens) && trow.youTokens.length === 3 && trow.youTokens.every((t) => t.start > 0 && t.end > 0),
    'history row replays the lineup with start/end prices')

  const meAna = await api('/api/me', { token: ana.token })
  const ts = meAna.data.stats.tourney
  assert(ts.matches === 1, 'profile stats count the tournament')
  assert(near(ts.earned, anaR.prize - 10), 'tournament net = prize − entry')
  const winnerIdx = results.findIndex((r) => r.rank === 1)
  const winnerR = results[winnerIdx]
  const wstats = (await api('/api/me', { token: [ana, bora, ceda, dara, eva][winnerIdx].token })).data.stats.tourney
  assert(wstats.wins === 1 && wstats.streak === 1, 'a title counts as a tournament win with a streak')
  assert(near(wstats.biggestWin, winnerR.prize - 10), 'biggest prize is net of the entry')

  const pub = await api('/api/match/' + tid)
  assert(pub.status === 200 && pub.data.match.tourney?.standings.length === 5, 'tournament match page is public')
  assert(pub.data.match.tourney.rank === 1, 'a non-participant watches from the winner\'s seat')

  // recent results + fresh lobby readiness
  const after = await api('/api/tournaments')
  assert(after.data.recent.length === 2 && after.data.recent.every((r) => r.standings.length === 5), 'both settled tournaments show in recent results')
  const recA = after.data.recent.find((r) => r.id === tid)
  assert(recA && near(recA.standings[0].prize, prizeSum / rank1s.length), 'recent list carries the winner\'s (possibly shared) prize')
  ana.send({ type: 'tourney.join', tier: 't10', pool: 'sol' })
  await ana.waitFor((m) => m.type === 'tourney.lobbies' && lobT10(m.lobbies).count === 1, 5000, 'rejoin after settling')
  log('ok: settled players can enter the next tournament')
  ana.send({ type: 'tourney.leave' })
  await ana.waitFor((m) => m.type === 'tourney.lobbies' && lobT10(m.lobbies).count === 0, 5000, 'left again')

  for (const p of players) p.ws.close()
  log(process.exitCode ? 'FAILURES PRESENT' : 'ALL TOURNAMENT TESTS PASSED')
}

main()
  .catch((e) => { fail(String(e && e.stack || e)) })
  .finally(() => {
    server.kill()
    setTimeout(() => {
      try { rmSync(DB_DIR, { recursive: true, force: true }) } catch { /* wal */ }
      process.exit(process.exitCode || 0)
    }, 500)
  })
