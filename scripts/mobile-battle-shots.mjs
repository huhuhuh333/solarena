// Mobile screenshots of the GAME screens: training setup, pick terminal, live
// duel, result. A fresh account, phone viewport, real UI clicks.
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'

const B = 'http://127.0.0.1:8787'
const OUT = 'C:/Users/WIN11/AppData/Local/Temp/claude/C--Users-WIN11-Desktop-hoodarena/c4317a04-5900-4528-930f-a94dddcf8287/scratchpad/shots-mobile'
mkdirSync(OUT, { recursive: true })

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new', args: ['--no-sandbox'],
})
const page = await browser.newPage()
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true })

const name = 'mob_' + Math.floor(Math.random() * 90000 + 10000)
const reg = await (await fetch(B + '/api/register', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name, password: 'hunter22222' }),
})).json()

await page.goto(B + '/', { waitUntil: 'domcontentloaded' })
await page.evaluate((t) => {
  localStorage.setItem('hood_token', t)
  localStorage.setItem('hood_tour_arena_v1', '1')
}, reg.token)

const clickText = async (sel, text) => {
  const ok = await page.evaluate((sel, text) => {
    const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim().toLowerCase().includes(text.toLowerCase()))
    if (el) { el.click(); return true }
    return false
  }, sel, text)
  if (!ok) throw new Error(`not found: ${sel} "${text}"`)
}
const waitText = (t, timeout = 25000) =>
  page.waitForFunction((t) => document.body.innerText.toLowerCase().includes(t.toLowerCase()), { timeout }, t)
const overflow = () => page.evaluate(() => {
  const w = document.documentElement.scrollWidth - document.documentElement.clientWidth
  return w > 1 ? w : 0
})
const shot = async (n) => {
  await page.screenshot({ path: `${OUT}/${n}.png`, fullPage: true })
  console.log(n.padEnd(18), (await overflow()) ? `OVERFLOW +${await overflow()}px` : 'ok')
}

await page.goto(B + '/training', { waitUntil: 'networkidle2' })
await waitText('Free training arena')
await shot('training-setup')
await clickText('button', 'Start Training Battle')
await waitText('Your picks', 25000)
await new Promise((r) => setTimeout(r, 1500))
await shot('pick-terminal')

// The list is LIVE - rows re-sort under the cursor every tick - so grab three
// tickers once and then click each BY NAME, the way the e2e does.
const names = await page.evaluate(() =>
  [...document.querySelectorAll('.pt-row .pt-tok-name')].slice(0, 3).map((e) => e.textContent.trim()))
console.log('picking:', names.join(', '))
for (const tk of names) {
  await page.evaluate((tk) => {
    const row = [...document.querySelectorAll('.pt-row')].find((r) => r.querySelector('.pt-tok-name')?.textContent.trim() === tk)
    row?.querySelector('.pt-add')?.click()
  }, tk)
  await new Promise((r) => setTimeout(r, 300))
}
await page.waitForFunction(() => document.querySelectorAll('.pt-slot:not(.pt-slot-empty)').length === 3, { timeout: 8000 })
await shot('pick-filled')
await clickText('button', 'Lock Picks')
await waitText('confirm your portfolio', 8000)
await shot('pick-confirm')
await clickText('button', 'Confirm')
await waitText('LIVE', 20000)
await new Promise((r) => setTimeout(r, 4000))
await shot('duel-live')

await browser.close()
console.log('done - account', name)
