// Screenshot the LIVE app so the design can be looked at, not guessed at:
// registers a throwaway player and captures each surface at desktop and phone
// width, against the real book the running server is serving.
//
// (It no longer plays a training battle - that was only ever needed to get past
// the training gate, which was removed on 31 Jul 2026 - and the 'Launch App'
// click below is a vestige of the landing page that no longer exists; it fails
// silently and costs nothing.)
//
// For a DETERMINISTIC pass against a fixture book on an isolated server, use
// scripts/ui-shots.mjs instead.
//
// Usage: node scripts/shots.mjs        (needs `npm run dev` + `npm run server`)

import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const APP = process.env.SHOT_URL || 'http://localhost:5173'
const OUT = process.env.SHOT_DIR || 'scripts/shots'
mkdirSync(OUT, { recursive: true })

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 960, deviceScaleFactor: 1 })

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (name) => {
  await wait(700)
  await page.screenshot({ path: `${OUT}/${name}.png` })
  console.log('shot:', name)
}
const clickText = async (text) => {
  const hit = await page.evaluate((t) => {
    const el = [...document.querySelectorAll('button, a')].find((e) => e.textContent.trim().toLowerCase().includes(t.toLowerCase()))
    if (el) { el.click(); return true }
    return false
  }, text)
  await wait(500)
  return hit
}

await page.goto(APP, { waitUntil: 'networkidle2' })
await shot('01-landing')

// register through the real flow so every screen is seen the way a player sees it
await clickText('Launch App')
await wait(900)
await page.evaluate(() => {
  const el = [...document.querySelectorAll('button, a')].find((e) => /create an account/i.test(e.textContent))
  if (el) el.click()
})
await wait(600)
const name = 'look' + Math.floor(Math.random() * 100000)
const inputs = await page.$$('input')
if (inputs.length >= 2) {
  await inputs[0].type(name)
  await inputs[1].type('hunter22222')
  await page.keyboard.press('Enter')
  await wait(2200)
}
await shot('02-home')

for (const [route, label] of [['#/play', '03-play'], ['#/tokens', '04-tokens'], ['#/wallet', '05-wallet'], ['#/leaderboard', '06-leaderboard']]) {
  await page.goto(APP + '/' + route, { waitUntil: 'networkidle2' })
  // The token charts show only real prices now, so give the websocket a few
  // seconds to build a real history before capturing the tokens page.
  if (label === '04-tokens') await wait(8000)
  await shot(label)
}

// phone
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 })
await page.goto(APP, { waitUntil: 'networkidle2' })
await shot('07-phone-landing')
await page.goto(APP + '/#/play', { waitUntil: 'networkidle2' })
await shot('08-phone-play')

await browser.close()
console.log('done →', OUT)
