// Photograph the history table with both kinds of row in it - a 1v1 and a
// tournament - because the two sit side by side and have to READ as one list.
//
// A real tournament takes five minutes to settle, which is five minutes this
// check does not need: the row is rendered from `tourneys` + `tourney_players`
// through tourneyPerspective(), so a settled row written straight into those
// tables exercises the exact path a real one does. The battle is faked; the
// rendering is not.
//
// Shots land in scripts/shots/history/.
//
// Usage: npm run build && node scripts/history-shot.mjs
import puppeteer from 'puppeteer-core'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { rmSync, mkdirSync } from 'node:fs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 8799
const BASE = `http://localhost:${PORT}`
const SHOTS = process.env.SHOT_DIR || 'scripts/shots/history'
const DB_DIR = 'server/data/history-shot'
const DB = `${DB_DIR}/test.db`
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

mkdirSync(SHOTS, { recursive: true })
rmSync(DB_DIR, { recursive: true, force: true })
mkdirSync(DB_DIR, { recursive: true })

const server = spawn(process.execPath, ['server/index.js'], {
  env: {
    ...process.env,
    HOOD_PORT: String(PORT), HOOD_DB: DB,
    HOOD_ADMIN_PASS: 'testadmin123', HOOD_RAILS: 'off', HOOD_TOKENSOURCE: 'off',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stderr.on('data', (d) => process.stderr.write('[server!] ' + d))
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(BASE + '/api/health'); if (r.ok) break } catch { /* booting */ }
  await wait(200)
}

const reg = await fetch(BASE + '/api/register', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'veteran', password: 'hunter22222' }),
}).then((r) => r.json())

// Second writer on a database the server has open - see the busy_timeout note
// in scripts/tourney-sparring.mjs. Without it the first INSERT dies outright.
const db = new DatabaseSync(DB)
db.exec('PRAGMA busy_timeout = 20000')
const me = db.prepare('SELECT id FROM users WHERE name = ?').get('veteran').id

const FIELDS = [
  { id: 'ty-a', stake: 10, n: 5, myRank: 1, myRet: 6.12, myPrize: 45, pot: 50, fee: 5, ago: 9 },
  { id: 'ty-b', stake: 100, n: 10, myRank: 4, myRet: -1.44, myPrize: 0, pot: 1000, fee: 80, ago: 52 },
]
const NAMES = ['VaultQueen', 'ShadowByte', 'PixelHawk', 'NeonWolf', 'CryptoFox', 'IronMask', 'GhostRunner', 'ZeroChill', 'MoonPatrol']

for (const f of FIELDS) {
  const others = NAMES.slice(0, f.n - 1)
  const standings = []
  let r = 1
  for (const name of others) {
    if (r === f.myRank) r++
    standings.push({ name, avatar: null, ret: 7 - r * 1.3, rank: r, prize: 0 })
    r++
  }
  standings.push({ name: 'veteran', avatar: null, ret: f.myRet, rank: f.myRank, prize: f.myPrize })
  standings.sort((a, b) => a.rank - b.rank)

  const ts = Date.now() - f.ago * 60000
  db.prepare(`INSERT INTO tourneys (id, ts, tier, stake, pool, duration, status, settled, pot, fee, fee_pct, data)
              VALUES (?, ?, ?, ?, 'eth', 300, 'done', ?, ?, ?, ?, ?)`)
    .run(f.id, ts, `t${f.stake}`, f.stake, ts, f.pot, f.fee, Math.round(f.fee / f.pot * 100), JSON.stringify({ standings, events: [] }))
  db.prepare(`INSERT INTO tourney_players (tourney_id, user_id, name, avatar, picks, ret, rank, prize, outcome)
              VALUES (?, ?, 'veteran', NULL, '[]', ?, ?, ?, ?)`)
    .run(f.id, me, f.myRet, f.myRank, f.myPrize, f.myPrize > 0 ? 'placed' : 'lost')
}
db.close()

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--window-size=1400,900'], defaultViewport: { width: 1400, height: 900 },
})
const page = await browser.newPage()
page.on('pageerror', (e) => console.error('[pageerror]', String(e)))
page.on('console', (m) => { if (m.type() === 'error') console.error('[console]', m.text()) })
await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }])
await page.evaluateOnNewDocument((t) => {
  localStorage.setItem('hood_token', t)
  localStorage.setItem('hood_tour_arena_v1', '1')
}, reg.token)
await page.goto(BASE + '/#/history', { waitUntil: 'networkidle0' })
await page.reload({ waitUntil: 'networkidle0' })
await wait(1500)

console.log(JSON.stringify(await page.evaluate(() => ({
  rows: [...document.querySelectorAll('.table tbody tr')].map((tr) => tr.innerText.replace(/\n/g, ' | ')),
  // The whole point: faces instead of a pictogram, and no emoji left in the cell.
  faceStacks: document.querySelectorAll('.fld-stack').length,
  facesPerStack: [...document.querySelectorAll('.fld-stack')].map((s) => s.querySelectorAll('.fld-face').length),
  overflowChips: [...document.querySelectorAll('.fld-more')].map((s) => s.textContent),
  emojiLeft: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(
    [...document.querySelectorAll('.table tbody td:nth-child(3)')].map((t) => t.textContent).join('')),
}), null, 1)))

await page.screenshot({ path: `${SHOTS}/history.png`, fullPage: true })
await browser.close()
server.kill()
await wait(500)
try { rmSync(DB_DIR, { recursive: true, force: true }) } catch { /* wal */ }
process.exit(0)
