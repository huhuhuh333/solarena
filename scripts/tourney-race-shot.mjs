// Screenshot the LIVE tournament screen - the one page no other shot script can
// reach, because it only exists while five people are mid-battle.
//
// Boots its own server on a fixture book, registers five players, walks them
// through join → lock → live over websockets, then photographs the race from
// one player's seat. Everything is real server state: the same TourneyManager,
// the same tick, the same chart the browser draws for a paying field.
//
// Shots land in scripts/shots/race/.
//
// Usage: npm run build && node scripts/tourney-race-shot.mjs
import puppeteer from 'puppeteer-core'
import { WebSocket } from 'ws'
import { spawn } from 'node:child_process'
import { rmSync, mkdirSync } from 'node:fs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 8796
const BASE = `http://localhost:${PORT}`
const SHOTS = process.env.SHOT_DIR || 'scripts/shots/race'
const DB_DIR = 'server/data/race-shot'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

mkdirSync(SHOTS, { recursive: true })
rmSync(DB_DIR, { recursive: true, force: true })
mkdirSync(DB_DIR, { recursive: true })

// Volatile on purpose: a chart of five flat lines proves nothing.
const FIXTURES = [
  { id: 'RHA', ticker: 'RHA', name: 'Robo Alpha', pool: 'sol', category: 'verified', maxStake: 1000, base: 1.25, vol: 'insane', dynamic: true, liquidity: 500000, volume24: 250000, txns24: { buys: 900, sells: 700 }, ageHours: 40 },
  { id: 'RHB', ticker: 'RHB', name: 'Robo Beta', pool: 'sol', category: 'verified', maxStake: 1000, base: 0.031, vol: 'insane', dynamic: true, liquidity: 400000, volume24: 200000, txns24: { buys: 700, sells: 500 }, ageHours: 20 },
  { id: 'RHC', ticker: 'RHC', name: 'Robo Gamma', pool: 'sol', category: 'verified', maxStake: 1000, base: 42, vol: 'insane', dynamic: true, liquidity: 300000, volume24: 150000, txns24: { buys: 400, sells: 300 }, ageHours: 8 },
  { id: 'RHD', ticker: 'RHD', name: 'Robo Delta', pool: 'sol', category: 'verified', maxStake: 1000, base: 0.0007, vol: 'insane', dynamic: true, liquidity: 240000, volume24: 120000, txns24: { buys: 320, sells: 290 }, ageHours: 3 },
  { id: 'RHE', ticker: 'RHE', name: 'Robo Epsilon', pool: 'sol', category: 'verified', maxStake: 1000, base: 3.6, vol: 'insane', dynamic: true, liquidity: 180000, volume24: 90000, txns24: { buys: 240, sells: 210 }, ageHours: 6 },
]

// A different basket each, so the lines have somewhere different to go.
const BASKETS = [
  [['RHA', 50], ['RHB', 30], ['RHC', 20]],
  [['RHC', 60], ['RHD', 20], ['RHE', 20]],
  [['RHB', 34], ['RHD', 33], ['RHE', 33]],
  [['RHA', 20], ['RHC', 20], ['RHE', 60]],
  [['RHD', 45], ['RHA', 35], ['RHB', 20]],
  [['RHE', 50], ['RHB', 25], ['RHC', 25]],
  [['RHB', 70], ['RHA', 15], ['RHD', 15]],
  [['RHC', 34], ['RHA', 33], ['RHD', 33]],
  [['RHD', 60], ['RHE', 25], ['RHB', 15]],
  [['RHE', 40], ['RHC', 40], ['RHA', 20]],
]
// `--n 10` photographs the worst case: a full table, ten lines at once.
const nArg = process.argv.indexOf('--n')
const N = Math.min(10, Math.max(5, nArg > -1 ? Number(process.argv[nArg + 1]) : 5))
const PLAYERS = ['Avery', 'CryptoWolf', 'NoxTrader', 'RugSurvivor', 'MilaK',
  'DeadCatBounce', 'Zerk', 'PaperHandz', 'TheGrinder', 'VaultQueen'].slice(0, N)

const server = spawn(process.execPath, ['server/index.js'], {
  env: {
    ...process.env,
    HOOD_PORT: String(PORT),
    HOOD_DB: `${DB_DIR}/test.db`,
    HOOD_ADMIN_PASS: 'testadmin123',
    HOOD_RAILS: 'off',
    HOOD_TOKENSOURCE: 'off',
    // `--lobby` needs a countdown long enough to film; everything else wants
    // the 180s default out of the way.
    HOOD_TOURNEY_COUNTDOWN: process.argv.includes('--lobby') ? '45' : '3',
    HOOD_FIXTURE_TOKENS: JSON.stringify(FIXTURES),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stderr.on('data', (d) => process.stderr.write('[server!] ' + d))

for (let i = 0; i < 60; i++) {
  try { const r = await fetch(BASE + '/api/health'); if (r.ok) break } catch { /* booting */ }
  await wait(200)
}

const post = (path, body) => fetch(BASE + path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then((r) => r.json())

// Register the field. Testnet signupCredit is $1000, so the $10 entry is
// covered by the server itself - no second writer on the database.
const tokens = []
for (const name of PLAYERS) {
  const r = await post('/api/register', { name, password: 'hunter22222' })
  if (!r.token) throw new Error(`register ${name}: ${r.error}`)
  tokens.push(r.token)
}
console.log(`registered ${tokens.length} players`)

// ---- lobby mode: is the countdown bar actually draining, or stepping? ----
// The bar is written from the browser's own frame loop between server
// messages, so the proof is in the SAMPLES: hundreds of distinct widths with
// tiny gaps between them. A bar driven straight off the server reads as a
// handful of distinct widths with second-sized jumps and long flat stretches.
if (process.argv.includes('--lobby')) {
  const seats = PLAYERS.map((name, i) => {
    const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws?token=${tokens[i]}`)
    ws.on('open', () => ws.send(JSON.stringify({ type: 'tourney.join', tier: 't10', pool: 'sol' })))
    return ws
  })
  // A sixth account that never sits down - the board is public, and an
  // observer keeps the field at exactly the five that start the clock.
  const watcher = await post('/api/register', { name: 'Watcher', password: 'hunter22222' })
  await wait(4000)

  const br = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--window-size=1500,1250'], defaultViewport: { width: 1500, height: 1250 },
  })
  const pg = await br.newPage()
  pg.on('pageerror', (e) => console.error('[pageerror]', String(e)))
  await pg.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }])
  await pg.evaluateOnNewDocument((t) => localStorage.setItem('hood_token', t), watcher.token)
  await pg.goto(BASE + '/#/tournaments', { waitUntil: 'networkidle0' })
  await pg.reload({ waitUntil: 'networkidle0' })
  await pg.waitForSelector('.ty-drain i', { timeout: 15000 })

  const samples = await pg.evaluate(() => new Promise((done) => {
    const out = []
    const bar = document.querySelector('.ty-drain i')
    const t = setInterval(() => {
      out.push([performance.now(), bar.getBoundingClientRect().width])
      if (out.length >= 120) { clearInterval(t); done(out) }
    }, 100)
  }))

  const widths = samples.map(([, w]) => w)
  const deltas = widths.slice(1).map((w, i) => widths[i] - w)
  const flat = deltas.filter((d) => Math.abs(d) < 0.01).length
  console.log(JSON.stringify({
    samples: widths.length,
    distinctWidths: new Set(widths.map((w) => w.toFixed(2))).size,
    flatFrames: flat,
    biggestStepPx: Math.max(...deltas).toFixed(3),
    medianStepPx: deltas.slice().sort((a, b) => a - b)[Math.floor(deltas.length / 2)].toFixed(3),
    monotonic: deltas.every((d) => d >= -0.01),
    spanPx: (widths[0] - widths[widths.length - 1]).toFixed(1),
  }, null, 1))

  await pg.screenshot({ path: `${SHOTS}/lobby-countdown.png`, fullPage: true })
  await br.close()
  for (const ws of seats) ws.close()
  server.kill()
  // Exit here rather than scheduling it: this file is one top-level script, and
  // falling through would open a second set of sockets against a dead server.
  await wait(500)
  try { rmSync(DB_DIR, { recursive: true, force: true }) } catch { /* wal */ }
  process.exit(0)
}

let livePhase = false
PLAYERS.forEach((name, i) => {
  const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws?token=${tokens[i]}`)
  // The server pushes a fresh snapshot every time ANY player locks, so without
  // this latch a player fires their lock once per teammate and the extras land
  // after the phase has already flipped.
  let sent = false
  ws.on('open', () => ws.send(JSON.stringify({ type: 'tourney.join', tier: 't10', pool: 'sol' })))
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw))
    if (m.type === 'error') console.error(`  ${name}: ${m.msg}`)
    if (m.type === 'duel.state' && m.duel?.phase === 'picking' && !sent) {
      sent = true
      ws.send(JSON.stringify({ type: 'duel.lock', picks: BASKETS[i].map(([tokenId, pct]) => ({ tokenId, pct })) }))
    }
    if (m.type === 'duel.state' && m.duel?.phase === 'live') livePhase = true
  })
})

for (let i = 0; i < 200 && !livePhase; i++) await wait(250)
if (!livePhase) { console.error('never reached the live phase'); server.kill(); process.exit(1) }
console.log('battle live - photographing from Avery\'s seat')

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--window-size=1500,1250'],
  defaultViewport: { width: 1500, height: 1250 },
})
const page = await browser.newPage()
page.on('pageerror', (e) => console.error('[pageerror]', String(e)))
page.on('console', (m) => { if (m.type() === 'error') console.error('[console]', m.text()) })
// Headless Chrome reports prefers-reduced-motion: reduce, which freezes every
// transition on the page and makes a live screen look like a dead one.
await page.emulateMediaFeatures([
  { name: 'prefers-reduced-motion', value: 'no-preference' },
  { name: 'prefers-color-scheme', value: 'dark' },
])
await page.evaluateOnNewDocument((t) => localStorage.setItem('hood_token', t), tokens[0])
await page.goto(BASE + '/#/duel', { waitUntil: 'networkidle0' })
await page.reload({ waitUntil: 'networkidle0' })

// Three moments: the first seconds (does the empty state read?), a minute in
// (do five lines separate?), and later still (does a long series stay legible?).
const t0 = Date.now()
const PLAN = process.env.SHOT_AT
  ? process.env.SHOT_AT.split(',').map((s, i) => [`t${i}`, Number(s)])
  : [['early', 4], ['mid', 45], ['late', 100]]
for (const [label, at] of PLAN) {
  await wait(Math.max(0, t0 + at * 1000 - Date.now()))
  await page.screenshot({ path: `${SHOTS}/race-${label}.png`, fullPage: true })
  const state = await page.evaluate(() => ({
    lines: document.querySelectorAll('.ty-race-line').length,
    dots: document.querySelectorAll('.ty-race-dot').length,
    swatches: document.querySelectorAll('.ty-swatch').length,
    waiting: !!document.querySelector('.ty-race-wait'),
    clock: document.querySelector('.duel-clock')?.textContent ?? '?',
    rets: [...document.querySelectorAll('.ty-board tbody tr')].map((tr) => tr.querySelector('td:nth-child(4)')?.textContent),
  }))
  console.log(`shot ${label} @${at}s:`, JSON.stringify(state))
}

// …and the same race with one player picked out of the pack.
await page.hover('.ty-board tbody tr:nth-child(3)')
await wait(600)
await page.screenshot({ path: `${SHOTS}/race-focus.png`, fullPage: true })
console.log('shot focus:', JSON.stringify(await page.evaluate(() => ({
  framed: !!document.querySelector('.ty-race.focused'),
  lines: [...document.querySelectorAll('.ty-race-line')].map((p) => {
    const s = getComputedStyle(p)
    return { cls: p.getAttribute('class').trim(), op: s.opacity, w: s.strokeWidth, stroke: s.stroke }
  }),
}), null, 1)))

await browser.close()
server.kill()
setTimeout(() => { try { rmSync(DB_DIR, { recursive: true, force: true }) } catch { /* wal */ } process.exit(0) }, 500)
