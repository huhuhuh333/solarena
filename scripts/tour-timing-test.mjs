// WHEN does the once-per-browser intro open?
//
// It must never land on top of something the visitor came here to do. Two
// moments hold it back - a battle in progress, and a challenge page, because
// that visitor followed a link to take ONE specific table and their first
// screen has to be the table. The intro is deferred, not lost: it opens on the
// result screen once the fight is behind them.
//
// This is the only coverage of that rule: scripts/e2e.mjs deliberately marks
// the intro as seen, because it is a real modal and swallows the one real mouse
// click that test makes (the notification bell).
//
// Every case gets its OWN browser context, so each is a first-ever visit.
//
// Usage: npm run test:tour
import puppeteer from 'puppeteer-core'
import { spawn } from 'node:child_process'
import { rmSync, mkdirSync } from 'node:fs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 8813
const BASE = `http://localhost:${PORT}`
const DIR = 'server/data/tour-timing'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

const FIXTURES = ['A', 'B', 'C'].map((k, i) => ({
  id: 'RH' + k, ticker: 'RH' + k, name: 'Robo ' + k, pool: 'sol', category: 'verified',
  maxStake: 10000, base: 1 + i, vol: 'high', dynamic: true,
  liquidity: 500000, volume24: 250000, txns24: { buys: 900, sells: 700 }, ageHours: 40,
}))

const server = spawn(process.execPath, ['server/index.js'], {
  env: {
    ...process.env, HOOD_PORT: String(PORT), HOOD_DB: `${DIR}/t.db`,
    HOOD_SPEED: '20', // a 5-minute battle settles in 15 real seconds
    HOOD_ADMIN_PASS: 'testadmin123', HOOD_RAILS: 'off', HOOD_TOKENSOURCE: 'off',
    HOOD_FIXTURE_TOKENS: JSON.stringify(FIXTURES),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stderr.on('data', (d) => { const s = String(d); if (!/bigint|WALLET_SEED|ADMIN_PASS|custody chain/.test(s)) process.stderr.write('[srv!] ' + s) })
for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break } catch { /* booting */ } await wait(200) }

const post = (p, b, t) => fetch(BASE + p, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(t ? { authorization: 'Bearer ' + t } : {}) },
  body: JSON.stringify(b),
}).then((r) => r.json())

const host = await post('/api/register', { name: 'tour_host', password: 'hunter22222' })
const visitor = await post('/api/register', { name: 'tour_visitor', password: 'hunter22222' })
const made = await post('/api/challenges', {
  mode: 'classic', stake: 100, duration: 300, pool: 'sol', listed: true,
  picks: [{ tokenId: 'RHA', pct: 50 }, { tokenId: 'RHB', pct: 30 }, { tokenId: 'RHC', pct: 20 }],
}, host.token)

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', args: ['--no-sandbox'],
  defaultViewport: { width: 1400, height: 950 },
})

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`) } else { fail++; console.log(`  FAIL ${name}${extra ? ' - ' + extra : ''}`) }
}
const tourUp = (page) => page.evaluate(() => !!document.querySelector('.tour-back'))
const click = (page, re) => page.evaluate((src) => {
  const el = [...document.querySelectorAll('button')].find((b) => new RegExp(src, 'i').test(b.textContent))
  if (!el) return false
  el.click()
  return true
}, re.source)

const visit = async (hash, token) => {
  const ctx = await browser.createBrowserContext()
  const page = await ctx.newPage()
  if (token) await page.evaluateOnNewDocument((t) => localStorage.setItem('hood_token', t), token)
  await page.goto(BASE + '/' + hash, { waitUntil: 'networkidle0' })
  await wait(2200)
  return { page, ctx }
}

console.log('\nwhen the intro opens\n')

const a = await visit('#/play', visitor.token)
ok('a normal arrival gets it straight away', await tourUp(a.page))
await a.ctx.close()

const b = await visit(`#/challenge/${made.code}`, visitor.token)
ok('a challenge link does NOT - the table is what they came for', !(await tourUp(b.page)))
await b.ctx.close()

const c = await visit(`#/challenge/${made.code}`, null)
ok('…nor while a signed-out visitor is asked to register first', !(await tourUp(c.page)))
await c.ctx.close()

// The whole journey: link → accept → fight → result.
const d = await visit(`#/challenge/${made.code}`, visitor.token)
ok('still nothing on the challenge screen', !(await tourUp(d.page)))

ok('the challenge can be accepted', await click(d.page, /accept the challenge/))
// Routing moved off the hash (3 Aug 2026): in-app navigation lands on a real
// path now. The visit() URLs above stay hash-form on purpose - they prove the
// legacy-link shim - but an assertion about WHERE the app went reads pathname.
await d.page.waitForFunction(() => location.pathname.startsWith('/duel'), { timeout: 15000 })
await d.page.waitForSelector('.pt-row', { timeout: 20000 })
ok('none while the battle is being fought', !(await tourUp(d.page)))

for (const t of ['RHA', 'RHB', 'RHC']) {
  await d.page.evaluate((tk) => {
    const row = [...document.querySelectorAll('.pt-row')].find((r) => r.querySelector('.pt-tok-name')?.textContent.trim() === tk)
    const btn = row?.querySelector('.pt-add')
    if (btn && !btn.disabled) btn.click()
  }, t)
  await wait(180)
}
await d.page.waitForFunction(() => document.querySelectorAll('.pt-slot:not(.pt-slot-empty)').length === 3, { timeout: 10000 })
ok('three coins picked', true)
await click(d.page, /lock picks/)
await d.page.waitForFunction(() => /confirm your portfolio/i.test(document.body.innerText), { timeout: 10000 })
// The button reads "🔒 CONFIRM & LOCK PORTFOLIO" - match on contains, never on
// a leading word, or an emoji in front of it silently skips the click and the
// battle dies of pick-time-expired instead of settling.
ok('the portfolio is confirmed', await click(d.page, /confirm/))

const settled = await d.page.waitForFunction(
  () => /victory|defeat|draw/i.test(document.body.innerText), { timeout: 120000 },
).then(() => true).catch(() => false)
const end = await d.page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 160))
ok('the battle runs to a real result', settled && !/cancelled/i.test(end), end)

await wait(1800)
ok('and THEN the intro opens - once the fight is behind them', await tourUp(d.page))
await d.ctx.close()

await browser.close()
server.kill()
await wait(600)
try { rmSync(DIR, { recursive: true, force: true }) } catch { /* wal */ }
console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
