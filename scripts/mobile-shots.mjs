// Mobile screenshots: every main page at iPhone size, saved to scratchpad/shots.
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'

const B = 'http://127.0.0.1:8787'
const OUT = 'C:/Users/WIN11/AppData/Local/Temp/claude/C--Users-WIN11-Desktop-hoodarena/c4317a04-5900-4528-930f-a94dddcf8287/scratchpad/shots-mobile'
mkdirSync(OUT, { recursive: true })

const PAGES = (process.env.PAGES || '/,/play,/wallet,/tokens,/board,/leaderboard,/rules,/history,/profile,/tournaments,/challenge-new,/achievements')
  .split(',').filter(Boolean)

const login = await (await fetch(B + '/api/login', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'admin', password: 'admin1337' }),
})).json()

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new', args: ['--no-sandbox'],
})
const page = await browser.newPage()
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')
await page.goto(B + '/', { waitUntil: 'domcontentloaded' })
await page.evaluate((t) => {
  localStorage.setItem('hood_token', t)
  localStorage.setItem('hood_tour_arena_v1', '1')
}, login.token)

for (const p of PAGES) {
  try { await page.goto(B + p, { waitUntil: 'networkidle2', timeout: 25000 }) } catch { /* shoot what rendered */ }
  await new Promise((r) => setTimeout(r, 1500))
  const name = p === '/' ? 'home' : p.slice(1).replace(/\//g, '-')
  // Full page: overflow problems live below the fold.
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true })
  // The one number that catches sideways overflow.
  const over = await page.evaluate(() => {
    const w = document.documentElement.scrollWidth - document.documentElement.clientWidth
    if (w <= 1) return null
    // name the widest offenders
    const bad = []
    for (const el of document.querySelectorAll('*')) {
      const r = el.getBoundingClientRect()
      if (r.right > document.documentElement.clientWidth + 2 && r.width > 40) {
        bad.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} w=${Math.round(r.width)} right=${Math.round(r.right)}`)
        if (bad.length >= 5) break
      }
    }
    return { overflowPx: w, offenders: bad }
  })
  console.log(name.padEnd(16), over ? `OVERFLOW +${over.overflowPx}px  ${over.offenders[0] || ''}` : 'ok')
  if (over?.offenders?.length > 1) over.offenders.slice(1).forEach((o) => console.log(''.padEnd(16), '  ' + o))
}
await browser.close()
console.log('\nshots in', OUT)
