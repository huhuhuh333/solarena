// The open board, end to end - and above all the one claim it exists for:
// a posted table starts a real battle while its author is OFFLINE.
//
// Everything runs against a real server over the real API and the real socket,
// because the interesting failures live exactly where those meet: the stake
// lock, the pre-locked portfolio, and the pick phase that must now be waiting
// on one person instead of two.
//
// Usage: npm run test:board
import { WebSocket } from 'ws'
import { spawn } from 'node:child_process'
import { rmSync, mkdirSync } from 'node:fs'

const PORT = 8802
const BASE = `http://localhost:${PORT}`
const DIR = 'server/data/board-test'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

const FIXTURES = ['A', 'B', 'C', 'D', 'E'].map((k, i) => ({
  id: 'RH' + k, ticker: 'RH' + k, name: 'Robo ' + k, pool: 'sol', category: 'verified',
  maxStake: 10000, base: 1 + i, vol: 'high', dynamic: true,
  liquidity: 500000, volume24: 250000, txns24: { buys: 900, sells: 700 }, ageHours: 40,
}))

const server = spawn(process.execPath, ['server/index.js'], {
  env: {
    ...process.env, HOOD_PORT: String(PORT), HOOD_DB: `${DIR}/t.db`,
    HOOD_ADMIN_PASS: 'testadmin123', HOOD_RAILS: 'off', HOOD_TOKENSOURCE: 'off',
    HOOD_FIXTURE_TOKENS: JSON.stringify(FIXTURES),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stderr.on('data', (d) => process.stderr.write('[server!] ' + d))
for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break } catch { /* booting */ } await wait(200) }

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' - ' + extra : ''}`) }
}
const post = (path, body, token) => fetch(BASE + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
  body: JSON.stringify(body || {}),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }))
const get = (path, token) => fetch(BASE + path, { headers: token ? { authorization: 'Bearer ' + token } : {} }).then((r) => r.json())
const reg = (name) => post('/api/register', { name, password: 'hunter22222' }).then((r) => r.body)

console.log('\nopen board - a table that plays without you\n')

const poster = await reg('poster')
const taker = await reg('taker')
const PICKS = [{ tokenId: 'RHA', pct: 50 }, { tokenId: 'RHB', pct: 30 }, { tokenId: 'RHC', pct: 20 }]

// ---- posting ----
const bad = await post('/api/challenges', { mode: 'classic', stake: 100, duration: 300, pool: 'sol', listed: true }, poster.token)
ok('a board posting without picks is refused', bad.status === 400, JSON.stringify(bad.body))

const badSplit = await post('/api/challenges', {
  mode: 'classic', stake: 100, duration: 300, pool: 'sol', listed: true,
  picks: [{ tokenId: 'RHA', pct: 50 }, { tokenId: 'RHB', pct: 30 }, { tokenId: 'RHC', pct: 15 }],
}, poster.token)
ok('picks are validated with the same rules as the pick phase', badSplit.status === 400, JSON.stringify(badSplit.body))

const made = await post('/api/challenges', { mode: 'classic', stake: 100, duration: 300, pool: 'sol', listed: true, picks: PICKS }, poster.token)
ok('a valid table posts', made.status === 200 && made.body.listed === true, JSON.stringify(made.body))
const code = made.body.code

const board = await get('/api/challenges')
ok('it appears on the public board with no token at all', board.open.some((c) => c.code === code))
const entry = board.open.find((c) => c.code === code)
ok('the board never serves the portfolio', entry && !('picks' in entry) && !('preset' in entry), JSON.stringify(entry))
ok('it carries the poster and their record', entry?.from?.name === 'poster' && entry.record, JSON.stringify(entry?.record))
ok('it stands far longer than a private link', entry.expires - entry.created > 6 * 3600000,
  `${((entry.expires - entry.created) / 3600000).toFixed(1)}h`)

const mineView = await get('/api/challenges', poster.token)
ok('the poster sees it marked as their own', mineView.open.find((c) => c.code === code)?.mine === true)
ok('everyone else does not', board.open.find((c) => c.code === code)?.mine === false)

const bal = await get('/api/me', poster.token)
ok('the stake is held, not spent', Math.abs(bal.balance - 9900) < 0.01, `balance ${bal.balance}`)

// ---- the whole point: the poster is not here ----
// No socket was ever opened for them, so the server has never seen them online.
const wsTaker = new WebSocket(`${BASE.replace('http', 'ws')}/ws?token=${taker.token}`)
const seen = []
wsTaker.on('message', (raw) => { try { seen.push(JSON.parse(String(raw))) } catch { /* ignore */ } })
await new Promise((r) => wsTaker.on('open', r))
await wait(400)

wsTaker.send(JSON.stringify({ type: 'challenge.accept', code }))
await wait(1500)

const err = seen.find((m) => m.type === 'error')
ok('accepting an offline poster is NOT refused', !err, err?.msg)
const state = seen.filter((m) => m.type === 'duel.state').pop()
ok('a real battle exists', !!state, 'no duel.state arrived')
ok('it is in the pick phase', state?.duel?.phase === 'picking', state?.duel?.phase)
ok('the taker still has to pick', state?.duel?.you?.locked === false)
ok('the poster is already locked in', state?.duel?.opp?.locked === true, JSON.stringify(state?.duel?.opp))
ok('the poster\'s coins are hidden from the taker', !state?.duel?.opp?.picks, JSON.stringify(state?.duel?.opp?.picks))

const gone = await get('/api/challenges')
ok('the table leaves the board once taken', !gone.open.some((c) => c.code === code))

// ---- the battle actually runs ----
wsTaker.send(JSON.stringify({ type: 'duel.lock', picks: [{ tokenId: 'RHC', pct: 40 }, { tokenId: 'RHD', pct: 35 }, { tokenId: 'RHE', pct: 25 }] }))
await wait(2500)
const live = seen.filter((m) => m.type === 'duel.state').pop()
ok('both locked → the battle starts with the poster absent', ['live', 'checking'].includes(live?.duel?.phase), live?.duel?.phase)

// ---- a private link still needs its author present ----
// A fresh account: `poster` is in a battle by now, and one stake lock per
// player means they could not open a second table anyway.
const linker = await reg('linker')
const priv = await post('/api/challenges', { mode: 'classic', stake: 100, duration: 300, pool: 'sol' }, linker.token)
ok('a private link posts without picks', priv.status === 200 && !priv.body.listed, JSON.stringify(priv.body))
const privBoard = await get('/api/challenges')
ok('and it does NOT appear on the public board', !privBoard.open.some((c) => c.code === priv.body.code))

const third = await reg('third')
const wsThird = new WebSocket(`${BASE.replace('http', 'ws')}/ws?token=${third.token}`)
const seen3 = []
wsThird.on('message', (raw) => { try { seen3.push(JSON.parse(String(raw))) } catch { /* ignore */ } })
await new Promise((r) => wsThird.on('open', r))
wsThird.send(JSON.stringify({ type: 'challenge.accept', code: priv.body.code }))
await wait(1200)
ok('a private link is still refused while its author is offline',
  seen3.some((m) => m.type === 'error' && /not online/i.test(m.msg || '')),
  JSON.stringify(seen3.filter((m) => m.type === 'error').map((m) => m.msg)))

// ---- the board and the queue are one pool ----
//
// The bug this closes: a player searching at $50/5m could spin forever while a
// $50/5m table sat on the board an inch away. Both directions are checked, and
// so is the thing that must NOT happen - merging tables that are not the same
// offer.

const sock = async (token) => {
  const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws?token=${token}`)
  const msgs = []
  ws.on('message', (raw) => { try { msgs.push(JSON.parse(String(raw))) } catch { /* ignore */ } })
  await new Promise((r) => ws.on('open', r))
  await wait(300)
  return { ws, msgs, send: (m) => ws.send(JSON.stringify(m)), last: (t) => msgs.filter((m) => m.type === t).pop() }
}
const TERMS = { mode: 'classic', stake: 50, duration: 300, pool: 'sol' }

console.log('\n  - searching meets the board -')

// Direction 1: the table is already posted, the searcher arrives after it.
const bPost = await reg('board_a')
const bSeek = await reg('seek_a')
const listing = await post('/api/challenges', { ...TERMS, listed: true, picks: PICKS }, bPost.token)
ok('a $50/5m table is on the board', listing.status === 200, JSON.stringify(listing.body))

const seek = await sock(bSeek.token)
seek.send({ type: 'queue.join', ...TERMS })
await wait(1500)
const merged = seek.last('duel.state')
ok('searching the same terms takes the posted table instead of queueing',
  merged?.duel?.phase === 'picking', merged?.duel?.phase || 'still searching')
ok('the poster arrives already locked in', merged?.duel?.opp?.locked === true, JSON.stringify(merged?.duel?.opp))
ok('the searcher still picks for themselves', merged?.duel?.you?.locked === false)
ok('and the table is off the board',
  !(await get('/api/challenges')).open.some((c) => c.code === listing.body.code))

// Direction 2: the searcher is already waiting, the table is posted after them.
const qWait = await reg('seek_b')
const qPost = await reg('board_b')
const waiter = await sock(qWait.token)
waiter.send({ type: 'queue.join', ...TERMS })
await wait(800)
ok('a player is queued with an empty board', !waiter.last('duel.state'))

const posted = await post('/api/challenges', { ...TERMS, listed: true, picks: PICKS }, qPost.token)
ok('posting a table onto a waiting queue reports the match', posted.body.matched === true, JSON.stringify(posted.body))
await wait(1200)
const pulled = waiter.last('duel.state')
ok('the player who was waiting is pulled straight into the battle',
  pulled?.duel?.phase === 'picking', pulled?.duel?.phase || 'still searching')
ok('with the poster locked in on the other side', pulled?.duel?.opp?.locked === true)
ok('the table never reaches the public board',
  !(await get('/api/challenges')).open.some((c) => c.code === posted.body.code))

console.log('\n  - offers that are NOT the same offer -')

// Same money, different clock. Nothing about these two should meet.
const dPost = await reg('board_c')
const dSeek = await reg('seek_c')
const other = await post('/api/challenges', { ...TERMS, duration: 900, listed: true, picks: PICKS }, dPost.token)
const seekD = await sock(dSeek.token)
seekD.send({ type: 'queue.join', ...TERMS })
await wait(1500)
ok('a 15m table is not handed to someone searching for 5m', !seekD.last('duel.state'),
  JSON.stringify(seekD.last('duel.state')?.duel?.cfg))
ok('and it is still sitting on the board',
  (await get('/api/challenges')).open.some((c) => c.code === other.body.code))
seekD.send({ type: 'queue.leave' })
await wait(500)

// Different money, same clock - the queue's own match-down offer is a question
// put to a player, and a board posting has nobody there to answer it.
const eSeek = await reg('seek_d')
const seekE = await sock(eSeek.token)
seekE.send({ type: 'queue.join', ...TERMS, stake: 100, duration: 900 })
await wait(1500)
ok('a $50 table is not handed to someone searching at $100', !seekE.last('duel.state'))
seekE.send({ type: 'queue.leave' })
await wait(500)

// A private link is a named invitation, not a table anybody may be dropped into.
const fPost = await reg('link_a')
const fSeek = await reg('seek_e')
const link = await post('/api/challenges', TERMS, fPost.token)
ok('a private link is created', link.status === 200 && !link.body.listed)
const seekF = await sock(fSeek.token)
seekF.send({ type: 'queue.join', ...TERMS })
await wait(1500)
ok('auto-match never takes a private challenge off somebody', !seekF.last('duel.state'))
const stillOpen = await get(`/api/challenges/${link.body.code}`)
ok('the private link is untouched', stillOpen.challenge.status === 'open', stillOpen.challenge?.status)
seekF.send({ type: 'queue.leave' })
await wait(500)

// The money has to land somewhere real: a merged battle holds both stakes.
const held = await get('/api/me', bPost.token)
ok('the poster\'s stake stayed locked through the merge', Math.abs(held.balance - 9950) < 0.01, `balance ${held.balance}`)
const heldSeeker = await get('/api/me', bSeek.token)
ok('and so did the searcher\'s', Math.abs(heldSeeker.balance - 9950) < 0.01, `balance ${heldSeeker.balance}`)
const refunded = await get('/api/me', dSeek.token)
ok('a searcher who found nothing and left got everything back', Math.abs(refunded.balance - 10000) < 0.01, `balance ${refunded.balance}`)

for (const s of [seek, waiter, seekD, seekE, seekF]) s.ws.close()
wsTaker.close(); wsThird.close()
server.kill()
await wait(600)
try { rmSync(DIR, { recursive: true, force: true }) } catch { /* wal */ }
console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
