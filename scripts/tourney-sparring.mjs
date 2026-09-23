// Sparring partners for a tournament lobby.
//
// A tournament needs MIN_PLAYERS before anything happens, which makes the whole
// screen untestable by one person. This fills the empty chairs with accounts
// that go through the SAME doors a human does - /api/register, a real
// websocket, tourney.join, duel.lock - so nothing about the tournament is
// faked. The server cannot tell these apart from players, because they aren't
// different: same stake lock, same pick validation, same TWAP settlement, same
// payout. Only the hands on the keyboard are missing.
//
// The one thing done out-of-band is the balance: sparring accounts have no
// wallet to pull a stake from, so their entry money is credited straight into
// the DB before they knock. Real players fund themselves on-chain.
//
// Usage:
//   node scripts/tourney-sparring.mjs                 # 4 players into the $10 table
//   node scripts/tourney-sparring.mjs --tier t100 --n 9
//   node scripts/tourney-sparring.mjs --leave         # pull them all back out
//
// Leaves them sitting in the lobby: you join from the browser as the 5th and
// the countdown starts. They lock their picks the moment the pick phase opens,
// so the battle waits only on you.
import { WebSocket } from 'ws'
import { db, credit, getUserByName, balanceOf } from '../server/db.js'

// Second writer on a database the firehose never stops writing to. WAL allows
// exactly one writer at a time, so without this the first credit() lands on a
// swap batch and dies instantly with "database is locked" - wait for the lane
// instead of giving up on it.
db.exec('PRAGMA busy_timeout = 20000')

const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k)
  return i > -1 ? process.argv[i + 1] : d
}
const has = (k) => process.argv.includes('--' + k)

const API = arg('api', 'http://localhost:8787')
const TIER = arg('tier', 't10')
const POOL = arg('pool', 'sol')
const N = Number(arg('n', 4))
const PASS = 'sparring-partner-1337'
const NAMES = ['CryptoWolf', 'Avery', 'NoxTrader', 'RugSurvivor', 'Mila_K', 'DeadCatBounce', 'Zerk', 'PaperHandz', 'TheGrinder']

const post = async (path, body, token) => {
  const r = await fetch(API + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body || {}),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error || `${path} -> HTTP ${r.status}`)
  return j
}

// Register once, log in ever after. The name is the identity; a re-run reuses
// the same accounts so the leaderboard doesn't fill with one-off ghosts.
const account = async (name) => {
  try { return await post('/api/login', { name, password: PASS }) } catch { /* first run */ }
  return post('/api/register', { name, password: PASS })
}

const main = async () => {
  const { lobbies } = await fetch(API + '/api/tournaments').then((r) => r.json())
  const table = lobbies.find((l) => l.tier === TIER && l.pool === POOL)
  if (!table) throw new Error(`No ${TIER}|${POOL} table. Tiers: ${lobbies.map((l) => l.tier).join(', ')}`)
  if (table.blocked) throw new Error(`That table can't run right now: ${table.blocked}`)

  const { tokens } = await fetch(API + '/api/tokens').then((r) => r.json())
  // Fresh Launches are free-battles-only until they earn Degen status, and a
  // coin whose maxStake is under the entry is refused at lock time - filter
  // both here rather than discovering it one rejected basket at a time.
  const book = tokens.filter((t) => t.pool === POOL && t.category !== 'fresh' && (t.maxStake ?? 0) >= table.stake)
  if (book.length < 3) throw new Error(`Only ${book.length} tokens in the ${POOL} pool clear a $${table.stake} entry.`)

  const names = NAMES.slice(0, N)
  console.log(`${has('leave') ? 'Pulling' : 'Seating'} ${names.length} sparring partners · $${table.stake} table · ${table.count}/${table.max} seats taken\n`)

  // One entry buys one tournament, so a partner who never gets topped up sits
  // out the third run. Keep a float and refill it whenever it dips.
  const fund = (name) => {
    const u = getUserByName(name)
    if (balanceOf(u.id) >= table.stake) return false
    credit(u.id, table.stake * 10, 'deposit', 'Sparring float (test account)')
    return true
  }

  const live = []
  for (const [i, name] of names.entries()) {
    const { token } = await account(name)
    if (fund(name)) console.log(`  ${name.padEnd(14)} funded → $${balanceOf(getUserByName(name).id)}`)

    const ws = new WebSocket(`${API.replace(/^http/, 'ws')}/ws?token=${token}`)
    live.push({ name, ws })

    // Stagger the joins so the lobby fills the way a real one does, and so the
    // countdown banner is visible rather than instant.
    const takeSeat = (delay) => setTimeout(() => {
      fund(name)
      ws.send(JSON.stringify({ type: 'tourney.join', tier: TIER, pool: POOL }))
    }, delay)

    ws.on('open', () => {
      if (has('leave')) ws.send(JSON.stringify({ type: 'tourney.leave' }))
      else takeSeat(i * 900)
    })

    ws.on('message', (raw) => {
      let m
      try { m = JSON.parse(String(raw)) } catch { return }

      if (m.type === 'error') { console.log(`  ${name.padEnd(14)} refused: ${m.msg}`); return }

      if (m.type === 'duel.state' && m.duel?.phase === 'picking' && !m.duel.you?.locked) {
        // Three coins at random, whole percents totalling 100. Degen coins cap
        // at 50% and 34 is under that, so any three in the book are legal.
        const pool = [...book].sort(() => Math.random() - 0.5).slice(0, 3)
        const picks = pool.map((t, k) => ({ tokenId: t.id, pct: k === 0 ? 34 : 33 }))
        ws.send(JSON.stringify({ type: 'duel.lock', picks }))
        console.log(`  ${name.padEnd(14)} locked ${pool.map((t) => t.ticker).join('/')}`)
      }

      if (m.type === 'duel.state' && m.duel?.phase === 'live' && !live.find((x) => x.name === name).said) {
        live.find((x) => x.name === name).said = true
        if (name === names[0]) console.log(`\n  ⚔  battle live - ${m.duel.tourney.count} players, $${m.duel.tourney.money.pot} pot, ${m.duel.duration}s\n`)
      }

      if (m.type === 'duel.state' && m.duel?.phase === 'done' && name === names[0]) {
        console.log('\n  final standings:')
        for (const s of m.duel.result.standings) {
          console.log(`   #${s.rank}  ${String(s.name).padEnd(14)} ${s.ret >= 0 ? '+' : ''}${s.ret.toFixed(2)}%   ${s.prize > 0 ? '$' + s.prize : '-'}`)
        }
        console.log('')
      }

      // The tournament they were in is over, so their seat is gone. Sit back
      // down - otherwise the table empties after one run and testing the next
      // thing means restarting this script. The re-entry is staggered again so
      // the lobby refills the way a real one does.
      if (m.type === 'duel.state' && ['done', 'cancelled'].includes(m.duel?.phase) && !has('leave')) {
        const seat = live.find((x) => x.name === name)
        seat.said = false
        if (!seat.reseat) {
          seat.reseat = true
          setTimeout(() => { seat.reseat = false; takeSeat(names.indexOf(name) * 900) }, 6000)
          if (name === names[0]) console.log('  re-seating the field for the next one…\n')
        }
      }

      if (m.type === 'duel.cancelled') console.log(`  ${name.padEnd(14)} out: ${m.reason}`)
    })

    ws.on('close', (code) => { if (code === 4001) console.log(`  ${name.padEnd(14)} auth rejected`) })
  }

  if (has('leave')) {
    setTimeout(() => { for (const p of live) p.ws.close(); console.log('\nSeats freed, entries refunded.'); process.exit(0) }, 2500)
    return
  }

  setTimeout(async () => {
    const { lobbies: after } = await fetch(API + '/api/tournaments').then((r) => r.json())
    const t = after.find((l) => l.tier === TIER && l.pool === POOL)
    console.log(`\nLobby now ${t.count}/${t.max}${t.countdownLeft != null ? ` · countdown ${t.countdownLeft}s` : ` · needs ${t.min - t.count} more to start the clock`}`)
    console.log(`Open http://localhost:5173/#/tournaments and take the last seat.`)
    console.log(`(Ctrl+C here frees the seats and refunds - they stay in only while this runs.)\n`)
  }, N * 900 + 1500)
}

// A closed socket is a player who closed the tab: the lobby refunds and frees
// the seat by itself, which is exactly what should happen on Ctrl+C.
process.on('SIGINT', () => { console.log('\nreleasing seats…'); setTimeout(() => process.exit(0), 600) })

main().catch((e) => { console.error('sparring failed:', e.message); process.exit(1) })
