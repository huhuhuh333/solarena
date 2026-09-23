// Photograph the first-visit tour, every step, signed out and signed in.
//
// The tour only ever appears once per browser, which makes it the easiest
// thing on the site to ship broken: you see it during the change and never
// again. This boots its own server on a fixture book and walks all four cards
// with a fresh localStorage each time.
//
// Shots land in scripts/shots/tour/.
//
// Usage: npm run build && node scripts/tour-shot.mjs
import puppeteer from 'puppeteer-core'
import { spawn } from 'node:child_process'
import { rmSync, mkdirSync } from 'node:fs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 8797
const BASE = `http://localhost:${PORT}`
const SHOTS = process.env.SHOT_DIR || 'scripts/shots/tour'
const DB_DIR = 'server/data/tour-shot'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

mkdirSync(SHOTS, { recursive: true })
rmSync(DB_DIR, { recursive: true, force: true })
mkdirSync(DB_DIR, { recursive: true })

const FIXTURES = [
  { id: 'RHA', ticker: 'STONKBROKER', name: 'StonkBroker', pool: 'sol', category: 'verified', maxStake: 1000, base: 1.25, vol: 'high', dynamic: true, liquidity: 500000, volume24: 250000, txns24: { buys: 900, sells: 700 }, ageHours: 40 },
  { id: 'RHB', ticker: 'CASHCAT', name: 'Cash Cat', pool: 'sol', category: 'verified', maxStake: 1000, base: 0.031, vol: 'high', dynamic: true, liquidity: 400000, volume24: 200000, txns24: { buys: 700, sells: 500 }, ageHours: 20 },
  { id: 'RHC', ticker: 'HOODRAT', name: 'Hoodrat', pool: 'sol', category: 'verified', maxStake: 1000, base: 42, vol: 'high', dynamic: true, liquidity: 300000, volume24: 150000, txns24: { buys: 400, sells: 300 }, ageHours: 8 },
]

const server = spawn(process.execPath, ['server/index.js'], {
  env: {
    ...process.env,
    HOOD_PORT: String(PORT), HOOD_DB: `${DB_DIR}/test.db`,
    HOOD_ADMIN_PASS: 'testadmin123', HOOD_RAILS: 'off', HOOD_TOKENSOURCE: 'off',
    HOOD_FIXTURE_TOKENS: JSON.stringify(FIXTURES),
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
  body: JSON.stringify({ name: 'newcomer', password: 'hunter22222' }),
}).then((r) => r.json())

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--window-size=1400,900'], defaultViewport: { width: 1400, height: 900 },
})

const walk = async (label, token, { width = 1400, height = 900, route = '/#/play' } = {}) => {
  // An isolated browser context, not a cleared one. Clearing from
  // evaluateOnNewDocument would also fire on every reload - which silently
  // wipes the "already seen" flag and makes the skip test unfalsifiable.
  const ctx = await browser.createBrowserContext()
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.error('[pageerror]', String(e)))
  page.on('console', (m) => { if (m.type() === 'error') console.error('[console]', m.text()) })
  await page.setViewport({ width, height })
  await page.emulateMediaFeatures([
    { name: 'prefers-reduced-motion', value: 'no-preference' },
    { name: 'prefers-color-scheme', value: 'dark' },
  ])
  if (token) await page.evaluateOnNewDocument((t) => localStorage.setItem('hood_token', t), token)
  await page.goto(BASE + route, { waitUntil: 'networkidle0' })
  await page.reload({ waitUntil: 'networkidle0' })
  await page.waitForSelector('.tour', { timeout: 10000 })

  const words = []
  for (let n = 1; n <= 4; n++) {
    // Long enough for every stage animation to land - the slam on step 1 is
    // the slowest at ~1.25s, and a screenshot taken mid-flight judges nothing.
    await wait(1700)
    const state = await page.evaluate(() => ({
      step: document.querySelector('.tour-count')?.textContent,
      title: document.querySelector('.tour-title')?.textContent,
      cta: document.querySelector('.tour-go')?.textContent,
      skip: !!document.querySelector('.tour-skip'),
      scrollLocked: getComputedStyle(document.body).overflow === 'hidden',
      // Allocation bars must end up at DIFFERENT widths. They didn't once: a
      // width-based keyframe outranked the inline per-coin width and drew all
      // three full, which no screenshot-free check would ever have caught.
      barWidths: [...document.querySelectorAll('.tx-pick-bar i')]
        .map((b) => Math.round(b.getBoundingClientRect().width)),
      brand: document.querySelector('.tour-brand')?.textContent,
      accent: getComputedStyle(document.querySelector('.tour-brand em')).color,
      text: document.querySelector('.tour')?.innerText ?? '',
    }))
    words.push(state.text)
    const { text, ...shown } = state
    console.log(`${label} ${n}:`, JSON.stringify(shown))
    await page.screenshot({ path: `${SHOTS}/${label}-${n}.png` })
    if (n < 4) await page.click('.tour-go')
  }

  // Predict was retired on 23 Sep 2026; the intro must not advertise it.
  const leak = words.filter((w) => /predict/i.test(w))
  console.log(`${label} retired product mentioned: ${leak.length > 0}`)

  // Skip must actually end it, and must stay ended across a reload.
  await page.reload({ waitUntil: 'networkidle0' })
  await page.waitForSelector('.tour', { timeout: 10000 })
  await page.click('.tour-skip')
  await wait(400)
  const gone = await page.evaluate(() => !document.querySelector('.tour'))
  await page.reload({ waitUntil: 'networkidle0' })
  await wait(1200)
  const stayedGone = await page.evaluate(() => !document.querySelector('.tour'))
  console.log(`${label} skip: closes=${gone} staysClosed=${stayedGone}`)
  await page.close()
  await ctx.close()
}

await walk('out', null)
await walk('in', reg.token)
await walk('phone', null, { width: 420, height: 860 })

// The way back in. Someone who skipped and then went looking for the rules is
// exactly the person who wants the intro again - so the button there has to
// work without a reload, and has to survive one.
{
  const ctx = await browser.createBrowserContext()
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.error('[pageerror]', String(e)))
  await page.setViewport({ width: 1400, height: 900 })
  await page.evaluateOnNewDocument((t) => localStorage.setItem('hood_token', t), reg.token)
  await page.goto(BASE + '/#/play', { waitUntil: 'networkidle0' })
  await page.reload({ waitUntil: 'networkidle0' })
  await page.waitForSelector('.tour', { timeout: 10000 })
  await page.click('.tour-skip')
  await wait(400)

  await page.goto(BASE + '/#/rules', { waitUntil: 'networkidle0' })
  await wait(900)
  await page.screenshot({ path: `${SHOTS}/replay-button.png` })
  const found = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.rul-toc button')].find((x) => /replay/i.test(x.textContent))
    if (b) b.click()
    return !!b
  })
  await wait(500)
  const reopened = await page.evaluate(() => !!document.querySelector('.tour'))
  await page.screenshot({ path: `${SHOTS}/replay-open.png` })
  console.log(`replay: buttonOnRules=${found} reopensTour=${reopened}`)
  await page.close()
  await ctx.close()
}

await browser.close()
server.kill()
await wait(500)
try { rmSync(DB_DIR, { recursive: true, force: true }) } catch { /* wal */ }
process.exit(0)
