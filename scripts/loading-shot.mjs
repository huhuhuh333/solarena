// Photograph the two screens a player sees while WAITING: the boot layer that
// covers the blank gap before the bundle arrives, and the matchmaking search.
//
// Both are hard to catch by hand - the boot screen is gone in a few hundred
// milliseconds on localhost, and the search only exists while a real stake is
// held in a real queue. So this throttles the network to make the first one
// stand still, and joins an actual queue over a websocket for the second.
//
// Shots land in scripts/shots/loading/.
//
// Usage: npm run build && node scripts/loading-shot.mjs
import puppeteer from 'puppeteer-core'
import { spawn } from 'node:child_process'
import { rmSync, mkdirSync } from 'node:fs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 8798
const BASE = `http://localhost:${PORT}`
const SHOTS = process.env.SHOT_DIR || 'scripts/shots/loading'
const DB_DIR = 'server/data/loading-shot'
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
  body: JSON.stringify({ name: 'waiter', password: 'hunter22222' }),
}).then((r) => r.json())

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--window-size=1400,950'], defaultViewport: { width: 1400, height: 950 },
})

const fresh = async (w = 1400, h = 950) => {
  const ctx = await browser.createBrowserContext()
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.error('[pageerror]', String(e)))
  page.on('console', (m) => { if (m.type() === 'error') console.error('[console]', m.text()) })
  await page.setViewport({ width: w, height: h })
  await page.emulateMediaFeatures([
    { name: 'prefers-reduced-motion', value: 'no-preference' },
    { name: 'prefers-color-scheme', value: 'dark' },
  ])
  // Tours would sit on top of everything we came here to look at.
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('hood_tour_arena_v1', '1')
  })
  return { ctx, page }
}

/* ---------- 1: the boot layer ---------- */
// Throttled hard, so the gap this covers is wide enough to photograph. It is
// the same gap a real visitor on a bad connection sits in.
for (const [label, hash] of [['boot-arena', '/#/play']]) {
  const { ctx, page } = await fresh()
  // Hold the bundle back so the boot layer stays on screen to be photographed.
  // This is the real thing, not a mock: it is exactly what a visitor sees for
  // as long as the JS takes to arrive, which on a cold mobile connection is
  // seconds, not the 200ms it takes on localhost.
  //
  // Throttling the DOCUMENT instead (the first attempt) made the page settle
  // mid-parse, so the shot caught a half-built boot layer and the wordmark
  // looked broken when it was fine - a bug in this script, not in it.
  await page.setRequestInterception(true)
  page.on('request', (r) => (/\/assets\/.*\.js$/.test(r.url()) ? r.abort() : r.continue()))
  await page.goto(BASE + hash, { waitUntil: 'domcontentloaded' }).catch(() => {})
  await wait(900)
  const seen = await page.evaluate(() => {
    const b = document.getElementById('boot')
    return {
      hash: location.hash,
      word: b?.querySelector('.bw')?.textContent,
      accent: getComputedStyle(document.documentElement).getPropertyValue('--boot-accent').trim(),
      // The white flash this replaces: the canvas must be dark from frame one.
      canvas: getComputedStyle(document.body).backgroundColor,
      reactMounted: !!document.getElementById('root').firstChild,
      inlineScripts: [...document.querySelectorAll('script:not([src])')].length,
    }
  })
  console.log(`${label}:`, JSON.stringify(seen))
  await page.screenshot({ path: `${SHOTS}/${label}.png` })
  await page.close(); await ctx.close()
}

/* ---------- 2: the boot layer actually goes away ---------- */
{
  const { ctx, page } = await fresh()
  await page.evaluateOnNewDocument((t) => localStorage.setItem('hood_token', t), reg.token)
  await page.goto(BASE + '/#/play', { waitUntil: 'networkidle0' })
  await wait(1500)
  const after = await page.evaluate(() => ({
    bootGone: !document.getElementById('boot'),
    appMounted: !!document.querySelector('.shell'),
    // The ambient sky is a body::before at z-index:-1, which only shows while
    // <html> has NO background of its own. The boot layer's stylesheet once
    // painted html, and that silently wiped the sky on both products - so the
    // check is not "does it look right" but "is html still bare".
    htmlBg: getComputedStyle(document.documentElement).backgroundColor,
    skyPainted: getComputedStyle(document.body, '::before').backgroundImage.includes('gradient'),
  }))
  console.log('handover:', JSON.stringify(after))
  await page.close(); await ctx.close()
}

/* ---------- 2b: the boot CSS must leave the background untouched ----------
   A/B against the page itself: read every background-bearing surface, then
   DELETE the boot stylesheet out of the document and read them again. If the
   two readings differ, the boot layer is still reaching into the app's paint
   - which is exactly how `html, body { background }` silently wiped the
   ambient sky on both products.

   Reduced motion is on so the beams hold still, and the pixel sample is a
   patch of pure background with no content in it, so two screenshots of an
   unchanged page are byte-identical. */
const SURFACES = ['html', 'body', '.bg-beams', '.shell']
const readBg = () => {
  const out = {}
  for (const sel of ['html', 'body', '.bg-beams', '.shell']) {
    const el = sel === 'html' ? document.documentElement : document.querySelector(sel)
    if (!el) { out[sel] = null; continue }
    for (const pseudo of [null, '::before', '::after']) {
      const s = getComputedStyle(el, pseudo)
      out[`${sel}${pseudo || ''}`] = [s.backgroundColor, s.backgroundImage, s.opacity, s.zIndex].join(' | ')
    }
  }
  return out
}

for (const [label, hash] of [['arena', '/#/play']]) {
  const { ctx, page } = await fresh()
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
  await page.evaluateOnNewDocument((t) => localStorage.setItem('hood_token', t), reg.token)
  await page.goto(BASE + hash, { waitUntil: 'networkidle0' })
  await wait(1600)

  const clip = { x: 0, y: 300, width: 240, height: 320 } // pure background, no content
  const before = await page.evaluate(readBg)
  const pixBefore = await page.screenshot({ clip })

  const removed = await page.evaluate(() => {
    const s = [...document.querySelectorAll('style')].find((x) => x.textContent.includes('#boot'))
    if (!s) return false
    s.remove()
    return true
  })
  await wait(400)
  const after = await page.evaluate(readBg)
  const pixAfter = await page.screenshot({ clip })

  const same = JSON.stringify(before) === JSON.stringify(after)
  const pixSame = Buffer.compare(pixBefore, pixAfter) === 0
  console.log(`bg-unchanged ${label}: bootCssFound=${removed} computedIdentical=${same} pixelsIdentical=${pixSame}`)
  if (!same) {
    for (const k of Object.keys(before)) {
      if (before[k] !== after[k]) console.log(`   ${k}\n     with boot css: ${before[k]}\n     without:       ${after[k]}`)
    }
  }
  console.log(`   sky ${label}: html=${before.html.split(' | ')[0]} bodyBefore=${before['body::before'].slice(0, 78)}…`)
  await page.close(); await ctx.close()
}

/* ---------- 3: the search ---------- */
// A real queue join over a real websocket: the stake is collected, the row is
// in matchmaking, and the screen is the one a paying player would be looking at.
const searchShot = async (label, w, h) => {
  const { ctx, page } = await fresh(w, h)
  await page.evaluateOnNewDocument((t) => localStorage.setItem('hood_token', t), reg.token)
  await page.goto(BASE + '/#/play', { waitUntil: 'networkidle0' })
  await page.reload({ waitUntil: 'networkidle0' })
  await wait(1400)
  // The real "Find an opponent" button, on the real paid path - a training
  // battle would NOT do: it builds its room immediately and lands in the pick
  // phase, so it never passes through this screen at all. Testnet signup
  // credit covers the stake, so no wallet is involved.
  // The arena makes you tick the "I understand" box before it takes money;
  // without it launch() only sets an error and the queue is never joined.
  await page.click('.ack input')
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /find an opponent/i.test(x.textContent))
    if (!b) throw new Error('no queue button on the play screen')
    b.click()
  })
  await page.waitForSelector('.mm-radar', { timeout: 15000 })
  await wait(4200) // let the elapsed clock reach a non-zero reading
  const seen = await page.evaluate(() => ({
    title: document.querySelector('.mm-title')?.textContent,
    rows: [...document.querySelectorAll('.mm-row')].map((r) => r.innerText.replace(/\n/g, ' ')),
    stats: [...document.querySelectorAll('.mm-stats span')].map((s) => s.innerText.replace(/\n/g, ' ')),
    rings: document.querySelectorAll('.mm-ring').length,
    sweep: !!document.querySelector('.mm-sweep'),
  }))
  console.log(`${label}:`, JSON.stringify(seen))
  await page.screenshot({ path: `${SHOTS}/${label}.png`, fullPage: true })
  await page.close(); await ctx.close()
}
await searchShot('search', 1400, 950)
await searchShot('search-phone', 420, 900)

await browser.close()
server.kill()
await wait(500)
try { rmSync(DB_DIR, { recursive: true, force: true }) } catch { /* wal */ }
process.exit(0)
