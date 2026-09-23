// What a player can actually READ. Renders every page in a real browser and
// searches the visible text - not the source, where a retired rail's name can
// sit forever inside a branch that never runs.
//
// Usage: npm run audit:copy   (server must be up on 8787)
import puppeteer from 'puppeteer-core'

const B = process.env.HOOD_URL || 'http://127.0.0.1:8787'
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'

// Every term that names something the arena no longer has. A hit is not always
// a bug - "Robinhood chain" is fine - so each carries what makes it acceptable.
const BANNED = [
  [/\bSolana\b/i, 'Solana rail was retired'],
  [/\bPhantom\b/i, 'Solana wallet, no rail to use it on'],
  [/\bwSOL\b|\bSOL\b(?!ANA)/, 'Solana coin'],
  [/\bSepolia\b|\bdevnet\b/i, 'testnet that is not wired'],
  [/\bUSDG\b|\bUSDC\b/, 'stable retired from the money flow'],
  [/\bstablecoin/i, 'nothing here is a stablecoin any more'],
  [/worthless test coins|sandbox/i, 'the money on this rail is real'],
  [/Blue Chips|Solana Memes/i, 'retired battle pool'],
  [/every dollar names a chain|which chain owes/i, 'multi-chain doctrine'],
  [/\bBase\b(?!\s*(units|64|d on))/, 'Base rail was retired'],
  [/[\u2013\u2014]/, 'long dash - the owner asked for plain hyphens'],
]

const PAGES = [
  '/', '/play', '/wallet', '/rules', '/rules/fees', '/rules/risk', '/terms', '/privacy',
  '/tokens', '/leaderboard', '/history', '/profile', '/achievements', '/tournaments',
  '/board', '/challenge-new',
]

const login = await (await fetch(B + '/api/login', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'admin', password: process.env.HOOD_ADMIN_PASS || 'admin1337' }),
})).json()

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 1000 })
await page.goto(B + '/', { waitUntil: 'domcontentloaded' })
if (login.token) {
  await page.evaluate((t) => {
    localStorage.setItem('hood_token', t)
    localStorage.setItem('hood_tour_arena_v1', '1')
  }, login.token)
}

let findings = 0
for (const path of PAGES) {
  try {
    await page.goto(B + path, { waitUntil: 'networkidle2', timeout: 30000 })
  } catch { /* slow page: read whatever rendered */ }
  await new Promise((r) => setTimeout(r, 1200))
  const text = await page.evaluate(() => document.body?.innerText || '')
  const bad = []
  for (const [re, why] of BANNED) {
    const m = text.match(re)
    if (!m) continue
    // Show the line it sits on, so a false positive is obvious at a glance.
    const line = text.split('\n').find((l) => re.test(l)) || m[0]
    bad.push(`      "${line.trim().slice(0, 96)}"   <- ${why}`)
  }
  if (bad.length) { findings += bad.length; console.log(`\n  ${path}`); bad.forEach((b) => console.log(b)) }
  else console.log(`  ok  ${path}`)
}

await browser.close()
console.log(findings ? `\n${findings} stale phrase(s) on screen` : '\nCOPY CLEAN - nothing retired is readable anywhere')
process.exit(findings ? 1 : 0)
