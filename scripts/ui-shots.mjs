// Visual check: boots its OWN server on a fixture book and screenshots the main
// screens, logged in, so a UI change can be LOOKED at rather than assumed. The
// e2e suite proves behaviour; this proves layout - it is how the clipped status
// badge and the one-pool battlefield banner were caught.
//
// Deterministic by design: same five tokens every run, no network, no real
// database. scripts/shots.mjs is the other half of the pair - same idea against
// the LIVE app and its real book, plus phone width.
//
// Shots land in scripts/shots/ui/.
//
// Usage: npm run build && node scripts/ui-shots.mjs

import puppeteer from 'puppeteer-core'
import { spawn } from 'node:child_process'
import { rmSync, mkdirSync } from 'node:fs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 8795
const BASE = `http://localhost:${PORT}`
const SHOTS = process.env.SHOT_DIR || 'scripts/shots/ui'
const DB_DIR = 'server/data/ui-shots'

mkdirSync(SHOTS, { recursive: true })
rmSync(DB_DIR, { recursive: true, force: true })
mkdirSync(DB_DIR, { recursive: true })

const FIXTURES = [
  { id: 'RHA', ticker: 'RHA', name: 'Robo Alpha', pool: 'sol', category: 'verified', maxStake: 1000, base: 1.25, vol: 'high', dynamic: true, liquidity: 500000, volume24: 250000, txns24: { buys: 900, sells: 700 }, ageHours: 40 },
  { id: 'RHB', ticker: 'RHB', name: 'Robo Beta', pool: 'sol', category: 'verified', maxStake: 1000, base: 0.031, vol: 'high', dynamic: true, liquidity: 400000, volume24: 200000, txns24: { buys: 700, sells: 500 }, ageHours: 20 },
  { id: 'RHC', ticker: 'RHC', name: 'Robo Gamma', pool: 'sol', category: 'verified', maxStake: 1000, base: 42, vol: 'high', dynamic: true, liquidity: 300000, volume24: 150000, txns24: { buys: 400, sells: 300 }, ageHours: 8 },
  { id: 'RHD', ticker: 'RHD', name: 'Robo Delta', pool: 'sol', category: 'degen', maxStake: 100, base: 0.0007, vol: 'insane', dynamic: true, liquidity: 40000, volume24: 20000, txns24: { buys: 120, sells: 90 }, ageHours: 3 },
  { id: 'RHE', ticker: 'RHE', name: 'Robo Epsilon', pool: 'sol', category: 'fresh', maxStake: 0, base: 3.6, vol: 'high', dynamic: true, liquidity: 3000, volume24: 400, txns24: { buys: 9, sells: 5 }, ageHours: 1 },
]

const server = spawn(process.execPath, ['server/index.js'], {
  env: {
    ...process.env,
    HOOD_PORT: String(PORT),
    HOOD_DB: `${DB_DIR}/test.db`,
    HOOD_ADMIN_PASS: 'testadmin123',
    HOOD_RAILS: 'off',
    HOOD_FIXTURE_TOKENS: JSON.stringify(FIXTURES),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stderr.on('data', (d) => process.stderr.write('[server!] ' + d))

for (let i = 0; i < 50; i++) {
  try { const r = await fetch(BASE + '/api/health'); if (r.ok) break } catch { /* booting */ }
  await new Promise((r) => setTimeout(r, 200))
}

const reg = await fetch(BASE + '/api/register', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'shotter', password: 'hunter22222' }),
}).then((r) => r.json())

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--window-size=1400,1200'],
  defaultViewport: { width: 1400, height: 1200 },
})
const page = await browser.newPage()
page.on('pageerror', (e) => console.error('[pageerror]', String(e)))
page.on('console', (m) => { if (m.type() === 'error') console.error('[console]', m.text()) })

// The session token has to be in place BEFORE the app boots, and hash-only
// navigation never re-boots it - so seed it on every document and reload.
await page.evaluateOnNewDocument((t) => localStorage.setItem('hood_token', t), reg.token)

const shoot = async (hash, name, full = true) => {
  await page.goto(BASE + '/#' + hash, { waitUntil: 'networkidle0' })
  await page.reload({ waitUntil: 'networkidle0' })
  await new Promise((r) => setTimeout(r, 1500))
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: full })
  console.log('shot:', name)
}

await shoot('/play', 'play')
await shoot('/tokens', 'tokens')
await shoot('/training', 'training')
await shoot('/challenge-new', 'challenge')
await shoot('/tournaments', 'tournaments')
await shoot('/rules', 'rules')

// The support widget: opened, with something typed in it, over a real screen.
await shoot('/play', 'play')
await page.evaluate(() => document.querySelector('.sup-btn')?.click())
await new Promise((r) => setTimeout(r, 600))
await page.type('.sup-compose textarea', 'My $50 deposit on Robinhood never showed up in my balance.')
await new Promise((r) => setTimeout(r, 400))
await page.screenshot({ path: `${SHOTS}/support-widget.png` })
console.log('shot: support-widget')

// …and the other side of it: the same message waiting in the admin panel.
const post = (path, token, body) => fetch(BASE + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
  body: JSON.stringify(body),
}).then((r) => r.json())

await post('/api/support', reg.token, { body: 'My $50 deposit on Robinhood never showed up in my balance. Sent it about 20 minutes ago.' })
const adminTok = (await (await fetch(BASE + '/api/login', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'admin', password: 'testadmin123' }),
})).json()).token
await page.evaluateOnNewDocument((t) => localStorage.setItem('hood_token', t), adminTok)
await page.goto(BASE + '/#/admin', { waitUntil: 'networkidle0' })
await page.reload({ waitUntil: 'networkidle0' })
await new Promise((r) => setTimeout(r, 1200))
await page.evaluate(() => [...document.querySelectorAll('.tabs button')].find((b) => b.textContent.trim() === 'Support')?.click())
await new Promise((r) => setTimeout(r, 900))
await page.evaluate(() => document.querySelector('.sd-row')?.click())
await new Promise((r) => setTimeout(r, 900))
await page.screenshot({ path: `${SHOTS}/support-admin.png` })
console.log('shot: support-admin')

await browser.close()
server.kill()
setTimeout(() => { try { rmSync(DB_DIR, { recursive: true, force: true }) } catch { /* wal */ } process.exit(0) }, 500)
