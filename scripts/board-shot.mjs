// The open board, empty and full.
//
// The empty state matters more than the full one here: on a young arena it is
// the page most visitors meet first, and it is the whole reason the board
// exists - so it has to read as an invitation, not as an apology.
//
// Shots land in scripts/shots/board/.
import puppeteer from 'puppeteer-core'
import { spawn } from 'node:child_process'
import { rmSync, mkdirSync } from 'node:fs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 8803
const BASE = `http://localhost:${PORT}`
const SHOTS = process.env.SHOT_DIR || 'scripts/shots/board'
const DIR = 'server/data/board-shot'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
mkdirSync(SHOTS, { recursive: true }); rmSync(DIR, { recursive: true, force: true }); mkdirSync(DIR, { recursive: true })

// Enough of a book that the reused terminal list is judged the way a player
// meets it - scrolling, sorted, filterable - rather than as five rows.
const TICKERS = ['STONKBROKER', 'CASHCAT', 'HOODRAT', 'PIPEDOG', 'MOONPATROL', 'SESTRI', 'JPORK', 'TENDIES',
  'VIRTUAL', 'FRONG', 'SHOOTER', 'WOOF', 'WALLET', 'RETIRE', 'SPONKS', 'CATCALL', 'CIAO', 'IMAGINE',
  'YOLO', 'NINEHOOD', 'MUMU', 'LILUNI', 'APES', 'WISHBONE', 'DERP', 'JUGGERNAUT', 'CHEESE', 'MEOWSHI']
const FIXTURES = TICKERS.map((t, i) => ({
  id: 'RH' + i, ticker: t, name: t + ' Coin', pool: 'sol', category: i % 7 === 6 ? 'degen' : 'verified',
  maxStake: 10000, base: [1.25, 0.031, 42, 0.0007, 3.6][i % 5] * (1 + i / 9), vol: 'high', dynamic: true,
  liquidity: 90000 + i * 41000, volume24: 40000 + i * 23000,
  txns24: { buys: 300 + i * 37, sells: 250 + i * 29 }, ageHours: 6 + i * 11,
  marketCap: 900000 + i * 640000, holders: 400 + i * 130,
}))

const server = spawn(process.execPath, ['server/index.js'], {
  env: {
    ...process.env, HOOD_PORT: String(PORT), HOOD_DB: `${DIR}/t.db`,
    HOOD_ADMIN_PASS: 'testadmin123', HOOD_RAILS: 'off', HOOD_TOKENSOURCE: 'off',
    HOOD_FIXTURE_TOKENS: JSON.stringify(FIXTURES),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stderr.on('data', (d) => process.stderr.write('[s] ' + d))
for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break } catch { /* booting */ } await wait(200) }

const post = (p, b, t) => fetch(BASE + p, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(t ? { authorization: 'Bearer ' + t } : {}) }, body: JSON.stringify(b),
}).then((r) => r.json())
const reg = (n) => post('/api/register', { name: n, password: 'hunter22222' })

const me = await reg('jadijaid')

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--window-size=1400,1000'], defaultViewport: { width: 1400, height: 1000 },
})
const page = await browser.newPage()
page.on('pageerror', (e) => console.error('[pageerror]', String(e)))
page.on('console', (m) => { if (m.type() === 'error') console.error('[console]', m.text()) })
await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }])
await page.evaluateOnNewDocument((t) => {
  localStorage.setItem('hood_token', t)
  localStorage.setItem('hood_tour_arena_v1', '1')
}, me.token)

const shoot = async (name) => {
  await page.goto(BASE + '/#/board', { waitUntil: 'networkidle0' })
  await page.reload({ waitUntil: 'networkidle0' })
  await wait(1600)
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true })
  console.log(`${name}:`, JSON.stringify(await page.evaluate(() => ({
    rows: document.querySelectorAll('.bd-t:not(.is-ghost)').length,
    empty: !!document.querySelector('.bd-empty'),
    seals: document.querySelectorAll('.bd-seal').length,
    tape: document.querySelector('.bd-tape')?.innerText.replace(/\n/g, ' '),
    // Distinct top offsets among the nav links - the only reading that says
    // "the bar wrapped". Dividing the topbar's height by a nominal row height
    // rounded 1.37 back down to 1 and reported a wrap as fine.
    navRows: new Set([...document.querySelectorAll('.nav a')].map((a) => Math.round(a.getBoundingClientRect().top))).size,
    navNeeds: Math.ceil([...document.querySelectorAll('.nav a')].reduce((w, a) => w + a.getBoundingClientRect().width, 0)),
    navHas: Math.ceil(document.querySelector('.nav').getBoundingClientRect().width),
    rightW: Math.ceil(document.querySelector('.topbar-right').getBoundingClientRect().width),
    heading: document.querySelector('.bd-empty h2')?.textContent
      || [...document.querySelectorAll('.bd-t:not(.is-ghost) .bd-t-who b')].map((b) => b.textContent).join(', '),
  }))))
}

await shoot('empty')

// A board with real postings from real accounts, each with its own stake,
// clock and record.
const SEED = [
  ['CryptoWolf', 100, 900, ['RH0', 'RH1', 'RH2']],
  ['Avery', 10, 300, ['RH2', 'RH3', 'RH4']],
  ['NoxTrader', 500, 3600, ['RH1', 'RH4', 'RH0']],
  ['RugSurvivor', 50, 300, ['RH3', 'RH0', 'RH2']],
  ['MilaK', 1000, 900, ['RH4', 'RH2', 'RH1']],
]
for (const [name, stake, duration, ids] of SEED) {
  const u = await reg(name)
  const r = await post('/api/challenges', {
    mode: 'classic', stake, duration, pool: 'sol', listed: true,
    picks: ids.map((tokenId, i) => ({ tokenId, pct: [50, 30, 20][i] })),
  }, u.token)
  if (r.error) console.error(`seed ${name}: ${r.error}`)
}
// …and one of the viewer's own, so the "your tables" split is visible too.
await post('/api/challenges', {
  mode: 'classic', stake: 100, duration: 300, pool: 'sol', listed: true,
  picks: [['RH0', 50], ['RH2', 30], ['RH4', 20]].map(([tokenId, pct]) => ({ tokenId, pct })),
}, me.token)

await shoot('full')

// Hover: the row lights its rule, the seal brightens, and the take button
// fills. A still frame cannot show it, so it gets its own frame.
await page.goto(BASE + '/#/board', { waitUntil: 'networkidle0' })
await wait(1400)
await page.hover('.bd-t:not(.is-mine)')
await wait(500)
console.log('hover:', JSON.stringify(await page.evaluate(() => {
  const row = document.querySelector('.bd-t:not(.is-mine)')
  const btn = row.querySelector('.bd-take')
  return { takeBg: getComputedStyle(btn).backgroundColor, rule: getComputedStyle(row, '::before').backgroundColor }
})))
await page.screenshot({ path: `${SHOTS}/hover.png` })

// The posting form, where the trade that makes all of this work is made: your
// three coins lock now so the battle can run without you.
await page.goto(BASE + '/#/challenge-new', { waitUntil: 'networkidle0' })
await page.reload({ waitUntil: 'networkidle0' })
await wait(1500)
await page.screenshot({ path: `${SHOTS}/post-empty.png`, fullPage: true })
// The book here is the pick terminal's, so the check is that the whole book
// arrived - not a capped grid - and that the + button builds a portfolio.
console.log('book:', JSON.stringify(await page.evaluate(() => ({
  rows: document.querySelectorAll('.pt-rows .pt-row').length,
  hasSearch: !!document.querySelector('.pt-search input'),
  tabs: [...document.querySelectorAll('.pt-tabs button')].map((b) => b.textContent),
  // Clicking a coin has to show it. The list arrived without the inspector at
  // first, which asked people to stake $100 on coins they could not look at.
  inspector: !!document.querySelector('.pt-mid'),
  inspecting: document.querySelector('.pt-mid-name')?.textContent,
  chart: !!document.querySelector('.pt-mid canvas, .pt-mid iframe, .pt-mid svg'),
  timeframes: [...document.querySelectorAll('.pt-tf button')].map((b) => b.textContent),
}))))
// …and clicking a different row has to move it.
await page.evaluate(() => document.querySelectorAll('.pt-rows .pt-row')[3]?.click())
await wait(900)
console.log('after click:', JSON.stringify(await page.evaluate(() => ({
  inspecting: document.querySelector('.pt-mid-name')?.textContent,
  chart: !!document.querySelector('.pt-mid canvas, .pt-mid iframe, .pt-mid svg'),
  stats: [...document.querySelectorAll('.pt-dstats label')].map((l) => l.textContent).slice(0, 4),
}))))
await page.screenshot({ path: `${SHOTS}/post-inspect.png`, fullPage: true })
// Re-queried each time: adding a coin re-renders the list, so element handles
// grabbed up front go stale and only the first click lands.
// Clicked through the DOM, not with the mouse: the price ticker is fixed to
// the bottom of the viewport and puppeteer refuses to click anything it covers.
for (let i = 0; i < 8; i++) {
  const done = await page.evaluate(() => {
    if (document.querySelectorAll('.chw-row').length >= 3) return true
    const b = document.querySelector('.pt-add:not(.rm):not([disabled])')
    if (!b) return true
    b.click()
    return false
  })
  if (done) break
  await wait(320)
}
await wait(500)
console.log('post form:', JSON.stringify(await page.evaluate(() => {
  const cta = [...document.querySelectorAll('.btn-block')].pop()
  return {
    chosen: [...document.querySelectorAll('.chw-row b')].map((b) => b.textContent),
    weights: [...document.querySelectorAll('.chw-pct')].map((b) => b.textContent),
    total: document.querySelector('.chw-total b')?.textContent,
    totalOk: !!document.querySelector('.chw-total.ok'),
    cta: cta?.textContent,
    ctaEnabled: !cta?.disabled,
  }
})))
await page.screenshot({ path: `${SHOTS}/post-picked.png`, fullPage: true })

await page.setViewport({ width: 420, height: 900 })
await shoot('phone')

await browser.close(); server.kill(); await wait(500)
try { rmSync(DIR, { recursive: true, force: true }) } catch { /* wal */ }
process.exit(0)
