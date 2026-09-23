// Full-stack e2e: spawns the real server (serving the built frontend), then
// drives TWO separate browser sessions through registration, training and a
// real head-to-head $100 battle against each other - clicking the actual UI.
//
// Usage: npm run build && node scripts/e2e.mjs

import puppeteer from 'puppeteer-core'
import { spawn } from 'node:child_process'
import { rmSync, mkdirSync } from 'node:fs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 8790
const BASE = `http://localhost:${PORT}`
const SHOTS = process.env.SHOT_DIR || 'scripts/shots'
const DB_DIR = 'server/data/e2e-test'
const log = (...a) => console.log('[e2e]', ...a)

mkdirSync(SHOTS, { recursive: true })
rmSync(DB_DIR, { recursive: true, force: true })
mkdirSync(DB_DIR, { recursive: true })

// No curated tokens and no ingest with rails off - the UI needs a book to
// render, so the test injects one. GHOST wears the retired 'eth' pool id and
// must never be offered inside a Solana battle.
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
    HOOD_SPEED: '20', // 5-min battle = 15s real: long enough to reload mid-battle, short enough to test
    HOOD_ADMIN_PASS: 'testadmin123',
    HOOD_RAILS: 'off', // no live RPC polling inside tests
    HOOD_FIXTURE_TOKENS: JSON.stringify(FIXTURES),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stdout.on('data', (d) => process.stdout.write('[server] ' + d))
server.stderr.on('data', (d) => process.stderr.write('[server!] ' + d))

for (let i = 0; i < 50; i++) {
  try { const r = await fetch(BASE + '/api/health'); if (r.ok) break } catch { /* booting */ }
  await new Promise((r) => setTimeout(r, 200))
  if (i === 49) throw new Error('server never came up')
}
log('server is up (serving dist/)')

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--window-size=1400,950'],
  defaultViewport: { width: 1400, height: 950 },
})

const errors = []
const mkPage = async (label) => {
  const ctx = await browser.createBrowserContext() // isolated session per player
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(`${label}: ${e}`))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${label}: ${m.text()}`) })
  // Mark the once-per-browser intro as seen. It is a real modal - aria-modal,
  // scroll locked, a backdrop over the whole viewport - so it correctly eats
  // any REAL mouse click aimed at the chrome behind it. Every interaction in
  // this file goes through element.click() in the page and is therefore immune,
  // except the notification bell, which uses page.click(): that one step landed
  // on `.tour-back` instead of the bell and the panel never opened. A fresh
  // context per player means each one meets the intro again, so seed it here
  // rather than at any single call site.
  //
  // The intro shows only when no battle is running, so it stayed invisible
  // through the whole duel and appeared the moment the result screen did -
  // which is why this failed AFTER the share card rather than at the first
  // click of the run.
  await page.evaluateOnNewDocument(() => {
    try {
      localStorage.setItem('hood_tour_arena_v1', '1')
    } catch { /* private mode: the intro will show and only the bell step suffers */ }
  })
  return page
}

const clickText = async (page, selector, text) => {
  const ok = await page.evaluate(({ selector, text }) => {
    const el = [...document.querySelectorAll(selector)].find((b) => b.textContent.trim().toLowerCase().includes(text.toLowerCase()))
    if (el) { el.click(); return true }
    return false
  }, { selector, text })
  if (!ok) throw new Error(`Not found: ${selector} "${text}"`)
}

const waitText = (page, text, timeout = 30000) =>
  page.waitForFunction((t) => document.body.innerText.toLowerCase().includes(t.toLowerCase()), { timeout }, text)

// Drive the pick terminal: click each token's + button, then Lock → Confirm.
const pickTokens = async (page, tokens) => {
  for (const tk of tokens) {
    await page.evaluate((tk) => {
      const row = [...document.querySelectorAll('.pt-row')].find((r) => r.querySelector('.pt-tok-name')?.textContent.trim() === tk)
      const btn = row?.querySelector('.pt-add')
      if (btn && !btn.disabled) btn.click()
    }, tk)
    await new Promise((r) => setTimeout(r, 150))
  }
  await page.waitForFunction(() => document.querySelectorAll('.pt-slot:not(.pt-slot-empty)').length === 3, { timeout: 8000 })
  await clickText(page, 'button', 'Lock Picks')
  // innerText reflects CSS text-transform, so match case-insensitively - a
  // styling change must never be able to fail a behaviour test.
  await waitText(page, 'confirm your portfolio', 8000)
  await clickText(page, 'button', 'Confirm')
}

const register = async (page, name) => {
  await page.goto(BASE + '/#/login', { waitUntil: 'networkidle0' })
  await clickText(page, 'button', 'Create an account')
  await page.type('.auth-card input[type=text]', name)
  await page.type('.auth-card input[type=password]', 'hunter22222')
  await clickText(page, 'button', 'Create account')
  await waitText(page, 'Choose your arena', 10000)
  log(`${name}: registered and logged in`)
}

const runTraining = async (page, name) => {
  await page.goto(BASE + '/#/training', { waitUntil: 'networkidle0' })
  await waitText(page, 'Free training arena')
  await clickText(page, 'button', 'Start Training Battle')
  await waitText(page, 'Your picks', 20000)
  // training defaults to the Robinhood Memes category - picks must come from it
  await pickTokens(page, ['RHA', 'RHB', 'RHC'])
  await waitText(page, 'time-weighted average', 60000)
  log(`${name}: training battle is live`)
  return page
}

// ---- two players ----
const A = await mkPage('alice')
const B = await mkPage('bob')

await register(A, 'alice_e2e')
await register(B, 'bob_e2e')

// training for both, in parallel (two server rooms at once)
await Promise.all([runTraining(A, 'alice'), runTraining(B, 'bob')])

// reload mid-battle: the duel lives on the server and must re-attach
await A.reload({ waitUntil: 'domcontentloaded' })
await waitText(A, 'time-weighted average', 15000)
log('alice: battle survived a reload - server resume works')

await Promise.all([
  waitText(A, 'Back to matchmaking', 120000),
  waitText(B, 'Back to matchmaking', 120000),
])
log('both training battles settled')
await A.screenshot({ path: `${SHOTS}/training-result.png` })

// ---- the real thing: head-to-head PvP through the UI ----
const queueUp = async (page) => {
  await page.goto(BASE + '/#/play', { waitUntil: 'networkidle0' })
  await clickText(page, '.seg button', '5 min')
  await page.evaluate(() => {
    const cb = document.querySelector('.ack input[type=checkbox]')
    if (cb && !cb.checked) cb.click()
  })
  await clickText(page, 'button', 'Find an opponent')
}

await queueUp(A)
await waitText(A, 'Finding your opponent', 10000)
await A.screenshot({ path: `${SHOTS}/searching.png` })
await queueUp(B)

await Promise.all([
  waitText(A, 'Your picks', 15000),
  waitText(B, 'Your picks', 15000),
])
log('players matched with each other')

const aSeesB = await A.evaluate(() => document.body.innerText.toLowerCase().includes('bob_e2e'))
const bSeesA = await B.evaluate(() => document.body.innerText.toLowerCase().includes('alice_e2e'))
if (!aSeesB || !bSeesA) throw new Error('players do not see each other as opponents')
log('both players see the right opponent')

// the battle is in Solana Memes - the token list must not offer tokens from
// a foreign (removed) pool
const gridClean = await A.evaluate(() =>
  ![...document.querySelectorAll('.pt-tok-name')].some((b) => b.textContent.trim() === 'GHOST'))
if (!gridClean) throw new Error('token list leaks tokens from other categories')
log('category isolation verified: a sol battle offers only sol-pool tokens')

await pickTokens(A, ['RHA', 'RHB', 'RHC'])
// bob's header must flip to "Opponent ready", and his own picks panel must stay
// empty - the server never sends alice's picks to him before the battle starts
await B.waitForFunction(() => document.body.innerText.toLowerCase().includes('opponent ready'), { timeout: 10000 })
const bobPicksEmpty = await B.evaluate(() => document.querySelectorAll('.pt-slot:not(.pt-slot-empty)').length === 0)
if (!bobPicksEmpty) throw new Error('opponent picks leaked into bob\'s portfolio!')
log('hidden picks verified: bob sees the lock status, not the portfolio')
await B.screenshot({ path: `${SHOTS}/pick-opponent-locked.png` })

await pickTokens(B, ['RHD', 'RHB', 'RHC'])
await Promise.all([
  waitText(A, 'time-weighted average', 30000),
  waitText(B, 'time-weighted average', 30000),
])
log('PvP battle is LIVE')
await A.screenshot({ path: `${SHOTS}/pvp-live.png` })

// both must see the same battle: bob's RHD visible on alice's screen and alice's RHA on bob's
const crossA = await A.evaluate(() => document.body.innerText.toLowerCase().includes('rhd'))
const crossB = await B.evaluate(() => document.body.innerText.toLowerCase().includes('rha'))
if (!crossA || !crossB) throw new Error('picks not revealed to both players at battle start')

await Promise.all([
  waitText(A, 'Back to matchmaking', 120000),
  waitText(B, 'Back to matchmaking', 120000),
])
const outcomeA = await A.evaluate(() => document.querySelector('.result-hero .display')?.textContent)
const outcomeB = await B.evaluate(() => document.querySelector('.result-hero .display')?.textContent)
log(`PvP settled: alice=${outcomeA} bob=${outcomeB}`)
const okPair = (outcomeA === 'Victory' && outcomeB === 'Defeat') || (outcomeA === 'Defeat' && outcomeB === 'Victory') || (outcomeA === 'Draw' && outcomeB === 'Draw')
if (!okPair) throw new Error(`inconsistent outcomes: ${outcomeA} vs ${outcomeB}`)
await A.screenshot({ path: `${SHOTS}/pvp-result.png` })

// share card renders
await clickText(A, 'button', 'Share result')
await A.waitForSelector('canvas.share-canvas')
await A.screenshot({ path: `${SHOTS}/share.png` })
log('share card rendered')

// history shows both battles
await A.goto(BASE + '/#/history', { waitUntil: 'networkidle0' })
await waitText(A, 'Match history')
const rows = await A.evaluate(() => document.querySelectorAll('.table tbody tr').length)
if (rows < 2) throw new Error('history missing battles')
log('history rows:', rows)

// notifications: the settled money battle must show up in the bell, built from
// the DB record rather than from the socket message that delivered it
await A.goto(BASE + '/#/play', { waitUntil: 'networkidle0' })
// two topbar icons share the button styling - target the bell, not the envelope
await A.waitForSelector('.nt-wrap:not(.dm-wrap) .nt-bell', { timeout: 10000 })
await A.click('.nt-wrap:not(.dm-wrap) .nt-bell')
await A.waitForSelector('.nt-panel .nt-row', { timeout: 10000 })
const notif = await A.evaluate(() => document.querySelector('.nt-panel').innerText.toLowerCase())
if (!/bob_e2e/.test(notif)) throw new Error('battle result missing from notifications: ' + notif.slice(0, 200))
if (!/\$100 classic/.test(notif)) throw new Error('notification lost the battle terms: ' + notif.slice(0, 200))
await A.screenshot({ path: `${SHOTS}/notifications.png` })
log('notifications: settled battle appears in the bell')

// direct messages: alice calls out bob, delivery is instant over the socket,
// bob replies, alice's open thread appends it live - no reloads anywhere
await A.evaluate(() => document.querySelector('.dm-wrap .nt-bell').click())
await A.waitForSelector('.dm-new input', { timeout: 8000 })
await A.type('.dm-new input', 'bob_e2e')
await A.evaluate(() => document.querySelector('.dm-new button').click())
await A.waitForSelector('.dm-compose input', { timeout: 8000 })
await A.type('.dm-compose input', 'gg - rematch?')
await A.keyboard.press('Enter')
await A.waitForFunction(() => document.querySelector('.dm-thread')?.innerText.includes('gg - rematch?'), { timeout: 8000 })

await B.waitForFunction(() => !!document.querySelector('.dm-wrap .nt-dot'), { timeout: 10000 })
await B.evaluate(() => document.querySelector('.dm-wrap .nt-bell').click())
await B.waitForFunction(() => document.querySelector('.nt-panel')?.innerText.includes('alice_e2e'), { timeout: 8000 })
await B.evaluate(() => [...document.querySelectorAll('.dm-convo')].find((r) => r.innerText.includes('alice_e2e')).click())
await B.waitForFunction(() => document.querySelector('.dm-thread')?.innerText.includes('gg - rematch?'), { timeout: 8000 })
await B.type('.dm-compose input', 'any time')
await B.keyboard.press('Enter')

await A.waitForFunction(() => document.querySelector('.dm-thread')?.innerText.includes('any time'), { timeout: 10000 })
await A.screenshot({ path: `${SHOTS}/messages.png` })
await A.keyboard.press('Escape')
log('messages: live two-way thread works, badge lights up for the receiver')

// leaderboard shows the winner
await A.goto(BASE + '/#/leaderboard', { waitUntil: 'networkidle0' })
await waitText(A, 'Leaderboard')
const boardHas = await A.evaluate(() => document.body.innerText.toLowerCase().includes('alice_e2e') || document.body.innerText.toLowerCase().includes('bob_e2e'))
if (!boardHas) throw new Error('leaderboard empty after a real battle')
log('leaderboard lists real players')

// tournaments: the standing lobby renders, joining takes a seat, leaving refunds
await A.goto(BASE + '/#/tournaments', { waitUntil: 'networkidle0' })
await waitText(A, 'Tournaments')
// the one pool (Robinhood) is the default - its tables are open on the fixture book
await clickText(A, 'button', 'Enter for $10')
await waitText(A, 'Leave (full refund)', 10000)
await A.screenshot({ path: `${SHOTS}/tournament-lobby.png` })
await clickText(A, 'button', 'Leave (full refund)')
await waitText(A, 'Enter for $10', 10000)
log('tournament lobby: join locks a seat, leave refunds it')

// admin gate: regular user must be refused
await A.goto(BASE + '/#/admin', { waitUntil: 'networkidle0' })
await waitText(A, 'needs an admin account', 10000)
log('admin gate active for non-admins')

// mobile viewport sanity
await A.setViewport({ width: 390, height: 844 })
await A.goto(BASE + '/#/', { waitUntil: 'networkidle0' })
await A.screenshot({ path: `${SHOTS}/mobile-home.png` })
await A.goto(BASE + '/#/play', { waitUntil: 'networkidle0' })
await A.screenshot({ path: `${SHOTS}/mobile-play.png` })

await browser.close()
server.kill()
setTimeout(() => {
  try { rmSync(DB_DIR, { recursive: true, force: true }) } catch { /* wal */ }
  const fatal = errors.filter((e) => !/favicon|ERR_CONNECTION|WebSocket/.test(e))
  if (fatal.length) { console.error('[e2e] PAGE ERRORS:', fatal); process.exit(1) }
  log('E2E PASSED - two real players fought through the real UI')
  process.exit(0)
}, 500)
