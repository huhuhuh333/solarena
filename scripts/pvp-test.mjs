// Real PvP integration test: spawns the server, registers two players,
// runs training for both, then a real head-to-head $100 classic battle over
// websockets, then a private challenge. Verifies hidden picks, identical start
// prices, complementary outcomes and exact payout math in the DB.
//
// Usage: node scripts/pvp-test.mjs

import { spawn } from 'node:child_process'
import { rmSync, mkdirSync } from 'node:fs'
import WebSocket from 'ws'

const PORT = 8791
const BASE = `http://localhost:${PORT}`
const DB_DIR = 'server/data/pvp-test'

const log = (...a) => console.log('[pvp]', ...a)
const fail = (msg) => { console.error('[FAIL]', msg); process.exitCode = 1 }
const assert = (cond, msg) => { if (!cond) fail(msg); else log('ok:', msg) }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

rmSync(DB_DIR, { recursive: true, force: true })
mkdirSync(DB_DIR, { recursive: true })

// The arena carries no curated tokens (RH-only, 100% live-ingested), and with
// HOOD_RAILS=off there is no ingest either - so the test injects its own book.
// Five Verified Robinhood-pool coins to fight with, plus one token wearing a
// removed pool's id ('eth') to prove cross-pool picks still get refused.
const FIXTURES = [
  { id: 'RHA', ticker: 'RHA', name: 'Robo Alpha', pool: 'sol', category: 'verified', maxStake: 1000, base: 1.25, vol: 'high', dynamic: true, liquidity: 500000, volume24: 250000 },
  { id: 'RHB', ticker: 'RHB', name: 'Robo Beta', pool: 'sol', category: 'verified', maxStake: 1000, base: 0.031, vol: 'high', dynamic: true, liquidity: 400000, volume24: 200000 },
  { id: 'RHC', ticker: 'RHC', name: 'Robo Gamma', pool: 'sol', category: 'verified', maxStake: 1000, base: 42, vol: 'high', dynamic: true, liquidity: 300000, volume24: 150000 },
  { id: 'RHD', ticker: 'RHD', name: 'Robo Delta', pool: 'sol', category: 'verified', maxStake: 1000, base: 0.0007, vol: 'insane', dynamic: true, liquidity: 200000, volume24: 100000 },
  { id: 'RHE', ticker: 'RHE', name: 'Robo Epsilon', pool: 'sol', category: 'verified', maxStake: 1000, base: 3.6, vol: 'high', dynamic: true, liquidity: 150000, volume24: 90000 },
  { id: 'GHOST', ticker: 'GHOST', name: 'Ghost of Robinhood', pool: 'eth', category: 'verified', maxStake: 1000, base: 1.0, vol: 'high', dynamic: true, liquidity: 100000, volume24: 50000 },
]

const server = spawn(process.execPath, ['server/index.js'], {
  env: {
    ...process.env,
    HOOD_PORT: String(PORT),
    HOOD_DB: `${DB_DIR}/test.db`,
    HOOD_SPEED: '60',
    HOOD_ADMIN_PASS: 'testadmin123',
    HOOD_RAILS: 'off', // no live RPC polling inside tests
    HOOD_FIXTURE_TOKENS: JSON.stringify(FIXTURES),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stdout.on('data', (d) => process.stdout.write('[server] ' + d))
server.stderr.on('data', (d) => process.stderr.write('[server!] ' + d))

const api = async (path, { method = 'GET', token, body } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  return { status: res.status, data }
}

class Player {
  constructor(name) {
    this.name = name
    this.token = null
    this.ws = null
    this.inbox = []
    this.cursor = 0 // messages are consumed in order so stale ones can't satisfy a later wait
  }

  async register() {
    const { status, data } = await api('/api/register', { method: 'POST', body: { name: this.name, password: 'hunter22222' } })
    if (status !== 200) throw new Error(`register ${this.name}: ${JSON.stringify(data)}`)
    this.token = data.token
    return data
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
        if (pred(this.inbox[i])) {
          this.cursor = i + 1
          return this.inbox[i]
        }
      }
      await wait(150)
    }
    throw new Error(`${this.name}: timeout waiting for ${what}`)
  }

  async me() {
    const { data } = await api('/api/me', { token: this.token })
    return data
  }
}

const runTraining = async (p) => {
  p.send({ type: 'training.start', duration: 300 })
  await p.waitFor((m) => m.type === 'duel.state' && m.duel.phase === 'picking', 10000, 'training picking')
  p.send({ type: 'duel.lock', picks: [{ tokenId: 'RHA', pct: 50 }, { tokenId: 'RHB', pct: 30 }, { tokenId: 'RHC', pct: 20 }] })
  await p.waitFor((m) => m.type === 'duel.state' && m.duel.phase === 'live', 40000, 'training live')
  const done = await p.waitFor((m) => m.type === 'duel.done', 60000, 'training done')
  return done
}

const main = async () => {
  // wait for server
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) break } catch { /* not up yet */ }
    await wait(200)
    if (i === 49) throw new Error('server never came up')
  }
  log('server is up')

  const alice = new Player('alice_pvp')
  const bob = new Player('bob_pvp')
  await alice.register()
  await bob.register()
  assert(Math.abs((await alice.me()).balance - 10000) < 0.01, 'signup credit $10k')

  await alice.connect()
  await bob.connect()
  const helloA = await alice.waitFor((m) => m.type === 'hello', 5000, 'hello')
  assert(helloA.user.name === 'alice_pvp' && helloA.trainingDone === false, 'hello carries identity + training record')

  // The training gate was REMOVED (owner, 31 Jul 2026): a player with zero
  // battles behind them may put money on a table immediately. Prove it here,
  // then step back out so the rest of the run starts from a clean wallet.
  alice.send({ type: 'queue.join', mode: 'classic', stake: 100, duration: 300, pool: 'sol' })
  await alice.waitFor((m) => m.type === 'queue.status', 5000, 'untrained player queued')
  log('ok: no training gate - a player who has never fought can queue for real money')
  alice.send({ type: 'queue.leave' })
  await alice.waitFor((m) => m.type === 'queue.left', 5000, 'left the queue again')
  assert(Math.abs((await alice.me()).balance - 10000) < 0.01, 'and stepping out returned the stake in full')

  // both play a training battle (concurrent rooms)
  log('running training battles for both players...')
  const [tA, tB] = await Promise.all([runTraining(alice), runTraining(bob)])
  assert(tA.duel.result && tB.duel.result, 'both training battles settled')
  assert((await alice.me()).trainingDone === true, 'trainingDone set after training')
  assert(Math.abs((await alice.me()).balance - 10000) < 0.01, 'training does not touch the wallet')

  // pool rules on the queue itself
  alice.send({ type: 'queue.join', mode: 'classic', stake: 100, duration: 300 })
  await alice.waitFor((m) => m.type === 'error' && /battlefield/i.test(m.msg), 5000, 'missing pool rejected')
  log('ok: queue.join without a battlefield rejected')
  // No size gate any more: a $1000 RH-memes table OPENS - thin books charge
  // their price impact instead of blocking. Queue up, then step out (refund).
  alice.send({ type: 'queue.join', mode: 'classic', stake: 1000, duration: 300, pool: 'sol' })
  await alice.waitFor((m) => m.type === 'queue.status', 5000, 'eth $1000 queued')
  log('ok: no size gate - the $1000 RH memes table opens (impact is priced, not blocked)')
  alice.send({ type: 'queue.leave' })
  await alice.waitFor((m) => m.type === 'queue.left', 5000, 'left the $1000 queue')
  assert(Math.abs((await alice.me()).balance - 10000) < 0.01, 'stepping out of the queue refunded the full stake')

  // ---- the real thing: PvP head-to-head in the Robinhood Memes category ----
  log('queueing both players for a $100 classic battle (eth)...')
  alice.send({ type: 'queue.join', mode: 'classic', stake: 100, duration: 300, pool: 'sol' })
  await alice.waitFor((m) => m.type === 'queue.status', 5000, 'queue status')
  bob.send({ type: 'queue.join', mode: 'classic', stake: 100, duration: 300, pool: 'sol' })

  const stateA = await alice.waitFor((m) => m.type === 'duel.state' && m.duel.phase === 'picking', 10000, 'match picking A')
  const stateB = await bob.waitFor((m) => m.type === 'duel.state' && m.duel.phase === 'picking', 10000, 'match picking B')
  assert(stateA.duel.opp.name === 'bob_pvp' && stateB.duel.opp.name === 'alice_pvp', 'players matched with each other')
  assert(stateA.duel.id === stateB.duel.id, 'both players in the same room')
  assert(Math.abs((await alice.me()).balance - 9900) < 0.01, 'stake locked on queue join')

  // cross-pool picks must be refused inside a sol battle (GHOST wears the
  // removed 'sol' pool id - the shape of a legacy Solana coin)
  alice.send({ type: 'duel.lock', picks: [{ tokenId: 'GHOST', pct: 50 }, { tokenId: 'RHB', pct: 30 }, { tokenId: 'RHC', pct: 20 }] })
  await alice.waitFor((m) => m.type === 'error' && m.re === 'duel.lock', 5000, 'cross-pool lock rejected')
  log('ok: picking a foreign-pool token inside a Solana Memes battle rejected')

  alice.send({ type: 'duel.lock', picks: [{ tokenId: 'RHA', pct: 50 }, { tokenId: 'RHB', pct: 30 }, { tokenId: 'RHC', pct: 20 }] })
  const lockedSeenByBob = await bob.waitFor((m) => m.type === 'duel.state' && m.duel.opp.locked, 10000, 'opp locked notice')
  assert(lockedSeenByBob.duel.opp.picks === null, 'opponent picks stay HIDDEN until battle start')
  assert(lockedSeenByBob.duel.battlePool === 'sol', 'battle carries its category')

  bob.send({ type: 'duel.lock', picks: [{ tokenId: 'RHD', pct: 40 }, { tokenId: 'RHC', pct: 35 }, { tokenId: 'RHE', pct: 25 }] })
  const liveA = await alice.waitFor((m) => m.type === 'duel.state' && m.duel.phase === 'live', 15000, 'live A')
  const liveB = await bob.waitFor((m) => m.type === 'duel.state' && m.duel.phase === 'live', 15000, 'live B')
  assert(JSON.stringify(liveA.duel.startPrices) === JSON.stringify(liveB.duel.startPrices), 'identical start prices for both players')
  assert(liveA.duel.opp.picks?.length === 3 && liveA.duel.opp.picks[0].tokenId === 'RHD', 'picks revealed at battle start')

  const tick = await alice.waitFor((m) => m.type === 'duel.tick', 10000, 'live tick')
  assert(typeof tick.retYou === 'number' && typeof tick.retOpp === 'number', 'live ticks carry both returns')

  const doneA = await alice.waitFor((m) => m.type === 'duel.done', 60000, 'battle settled A')
  const doneB = await bob.waitFor((m) => m.type === 'duel.done', 60000, 'battle settled B')
  const rA = doneA.duel.result, rB = doneB.duel.result
  log(`result: alice ${rA.retYou.toFixed(3)}% (${rA.outcome}) vs bob ${rB.retYou.toFixed(3)}% (${rB.outcome})`)
  const complement = { win: 'loss', loss: 'win', draw: 'draw' }
  assert(rB.outcome === complement[rA.outcome], 'outcomes are complementary')
  assert(Math.abs(rA.retYou - rB.retOpp) < 1e-9, 'both saw the same returns')

  const balA = (await alice.me()).balance
  const balB = (await bob.me()).balance
  // pre-battle: 10000; stake -100 => 9900; a win returns the pool minus the fee.
  // Free play: reading /api/me lifts anyone under $10k back to it, so a loser
  // (and a draw) reads exactly $10k afterwards.
  // Derived from the LIVE fee schedule, never hardcoded: the tiers have moved
  // before (a $100 table was 10% when this test was written and is 8% now) and
  // a stale constant only fails on the outcomes a draw never exercises.
  const feeCfg = (await api('/api/config')).data.feeTiers
  const bands = Object.keys(feeCfg).map(Number).filter(Number.isFinite).sort((a, b) => a - b)
  const feePct = feeCfg[bands.filter((b) => b <= 100).pop()]
  const fee = Math.round(200 * feePct) / 100
  const prize = Math.round((200 - fee) * 100) / 100
  const expA = (r) => (r.outcome === 'win' ? 9900 + prize : 10000)
  assert(Math.abs(balA - expA(rA)) < 0.01, `alice payout math (${rA.outcome} -> $${expA(rA)}, fee ${feePct}%)`)
  assert(Math.abs(balB - expA(rB)) < 0.01, `bob payout math (${rB.outcome} -> $${expA(rB)}, fee ${feePct}%)`)

  const meA = await alice.me()
  assert(meA.stats.classic.matches === 1, 'classic stats recorded')
  assert(!meA.lock, 'stake lock cleared')

  // history + match detail
  const hist = await api('/api/history', { token: alice.token })
  assert(hist.data.matches.length === 2 && hist.data.matches[0].opp.name === 'bob_pvp', 'history has training + pvp match')
  assert((hist.data.matches[0].events || []).length >= 4, 'match timeline recorded')

  // ---- private challenge flow ----
  log('testing private challenge...')
  const chNoPool = await api('/api/challenges', { method: 'POST', token: alice.token, body: { mode: 'classic', stake: 10, duration: 300 } })
  assert(chNoPool.status === 400, 'challenge without category rejected')
  const ch = await api('/api/challenges', { method: 'POST', token: alice.token, body: { mode: 'classic', stake: 10, duration: 300, pool: 'sol' } })
  assert(ch.status === 200 && ch.data.code, 'challenge created')
  const chInfo = await api('/api/challenges/' + ch.data.code)
  assert(chInfo.data.challenge.pool === 'sol', 'challenge carries its category')
  bob.send({ type: 'challenge.accept', code: ch.data.code })
  const chalA = await alice.waitFor((m) => m.type === 'duel.state' && m.duel.stake === 10 && m.duel.phase === 'picking', 10000, 'challenge room A')
  assert(chalA.duel.opp.name === 'bob_pvp', 'challenge room pairs creator and accepter')
  // both walk away during picking - no-penalty refund
  alice.send({ type: 'duel.cancel' })
  await alice.waitFor((m) => m.type === 'duel.cancelled', 5000, 'challenge cancelled')
  await wait(500)
  assert((await alice.me()).balance === balA, 'challenge stake refunded to creator')
  assert((await bob.me()).balance === balB, 'challenge stake refunded to accepter')

  // ---- validation hardening ----
  bob.send({ type: 'queue.join', mode: 'classic', stake: 7, duration: 300 })
  await bob.waitFor((m) => m.type === 'error' && /stake/i.test(m.msg), 5000, 'invalid stake rejected')
  log('ok: invalid stake rejected')

  // ---- admin ----
  const adm = await api('/api/login', { method: 'POST', body: { name: 'admin', password: 'testadmin123' } })
  assert(adm.status === 200 && adm.data.user.isAdmin, 'admin login')
  const ov = await api('/api/admin/overview', { token: adm.data.token })
  assert(ov.status === 200 && ov.data.users.length >= 3, 'admin overview lists users')
  assert(ov.data.log.length > 0, 'admin log populated')
  const blocked = await api('/api/admin/overview', { token: alice.token })
  assert(blocked.status === 403, 'non-admin denied admin API')

  alice.ws.close(); bob.ws.close()
  log(process.exitCode ? 'FAILURES PRESENT' : 'ALL PVP TESTS PASSED')
}

main()
  .catch((e) => { fail(String(e && e.stack || e)) })
  .finally(() => {
    server.kill()
    setTimeout(() => {
      try { rmSync(DB_DIR, { recursive: true, force: true }) } catch { /* wal handles */ }
      process.exit(process.exitCode || 0)
    }, 500)
  })
