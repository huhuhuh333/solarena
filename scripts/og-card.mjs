// The link preview: public/og.jpg.
//
// These are the first thing anyone sees of the arena - the image X, Telegram and
// Discord unfurl before a single word of the site loads - and until now they
// were a mystery: two files with no source, built by hand three days before
// launch. One of them was 40% a render of the TRAINING BOT, which is the face
// of the only mode where nothing is at stake.
//
// So they are drawn here instead, with cardkit.js - the same tokens, the same
// -8deg lean, the same horizon and grain as the battle share card.
// One family, one source of truth, and a palette change lands on all of them.
//
//   npm run og
//
// Typographic on purpose (owner's call, 6 Aug 2026): a card that says what the
// arena is, in the arena's own voice, rather than a stock render competing with
// its own wordmark.

import puppeteer from 'puppeteer-core'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const CHROME = process.env.HOOD_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const W = 1200, H = 630              // the size every unfurler crops from

// Baked in rather than linked. The page is built with setContent, so its origin
// is about:blank, and a file:// font request from there is refused however many
// --allow-file-access flags Chrome is given. A data: URI has no origin to argue
// with, and 90 KB of woff2 is nothing for a build step.
const font = (p) => 'data:font/woff2;base64,' + readFileSync(resolve(p)).toString('base64')
const FONTS = {
  anton: font('node_modules/@fontsource/anton/files/anton-latin-400-normal.woff2'),
  inter400: font('node_modules/@fontsource/inter/files/inter-latin-400-normal.woff2'),
  inter600: font('node_modules/@fontsource/inter/files/inter-latin-600-normal.woff2'),
  inter700: font('node_modules/@fontsource/inter/files/inter-latin-700-normal.woff2'),
}

// cardkit is an ES module; injected whole so the drawing code below sits in the
// same module scope and can simply use its exports as ordinary consts.
const KIT = readFileSync('src/components/cardkit.js', 'utf8')

const CARDS = [
  {
    out: 'public/og.jpg',
    word: 'ARENA', accent: 'phos', glow: 'rgba(153,69,255,0.55)',
    line1: 'Pick your coins.', line2: 'Beat your opponent. Take the pool.',
    chips: ['1v1 battles', 'Free to play', 'Solana memecoins'],
    // No address: the site has no fixed domain yet, and a stale one on the
    // card is worse than none. Put it back here once there is one.
    footer: 'Free play credits - no wallet, no deposit.',
  },
]

const draw = `
const card = window.__card
const cv = document.getElementById('c')
const x = setupCard(cv, ${W}, ${H})
const A = TOKENS[card.accent]

// --- the room: panel ground, one frozen frame of the sky, the horizon hairline
x.fillStyle = TOKENS.bg
x.fillRect(0, 0, ${W}, ${H})
skyLobes(x, ${W}, ${H}, [
  [0.16, 0.10, 0.52, 'rgba(153,69,255,0.13)'],
  [0.92, 0.86, 0.60, 'rgba(20,241,149,0.06)'],
])
horizon(x, ${W}, 'rgba(153,69,255,0.6)', 'rgba(20,241,149,0.4)')

// --- the wordmark, sized to FILL the frame rather than to sit in a corner.
// A block hugging the left of a 1200-wide card leaves half of it empty, and
// empty here reads as unfinished rather than as air. Poster type earns its
// presence from size - which is also the only way Anton, a single 400 weight,
// is meant to be used.
const PAD = 76
const size = fitFont(x, 'SOL' + card.word, ${W} - PAD * 2, 196, 96, (s) => \`400 \${s}px Anton, sans-serif\`)
wordmark(x, card.word, A, card.glow, PAD, 268, size)

// --- what the arena is, in two lines that never wrap by accident
x.textAlign = 'left'
x.fillStyle = TOKENS.text
x.font = '700 46px Inter, sans-serif'
x.fillText(card.line1, PAD, 372)
x.fillStyle = TOKENS.muted
x.font = '400 38px Inter, sans-serif'
x.fillText(card.line2, PAD, 428)

// --- three facts, as the site's only curve
let cx = PAD
for (const label of card.chips) {
  cx += chip(x, label, cx, 480, 48, { color: TOKENS.text, font: '600 22px Inter, sans-serif' }) + 14
}

// --- the last, quietest line, where the eye lands after the sentence
x.fillStyle = TOKENS.muted
x.font = '600 26px Inter, sans-serif'
x.fillText(card.footer, PAD, 586)

grain(x, 11)
window.__done = true
`

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--allow-file-access-from-files'],
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
})

for (const card of CARDS) {
  const page = await browser.newPage()
  page.on('pageerror', (e) => { console.error('[og] page error:', String(e)); process.exitCode = 1 })

  await page.setContent(`<!doctype html><html><head><style>
    @font-face { font-family: Anton; src: url('${FONTS.anton}') format('woff2'); font-weight: 400; }
    @font-face { font-family: Inter; src: url('${FONTS.inter400}') format('woff2'); font-weight: 400; }
    @font-face { font-family: Inter; src: url('${FONTS.inter600}') format('woff2'); font-weight: 600; }
    @font-face { font-family: Inter; src: url('${FONTS.inter700}') format('woff2'); font-weight: 700; }
    html, body { margin: 0; background: #0c0f0d; }
    canvas { display: block; width: ${W}px; height: ${H}px; }
  </style></head><body><canvas id="c"></canvas></body></html>`, { waitUntil: 'load' })

  // Canvas takes no part in font loading - it asks for a face and gets whatever
  // is ready. Anton arriving late is how a card ships in Arial.
  await page.evaluate(async () => {
    await Promise.all([
      document.fonts.load('400 118px Anton'),
      document.fonts.load('700 40px Inter'),
      document.fonts.load('600 20px Inter'),
      document.fonts.load('400 34px Inter'),
    ])
    await document.fonts.ready
  })

  await page.evaluate((c) => { window.__card = c }, card)
  await page.addScriptTag({ content: KIT + draw, type: 'module' })
  await page.waitForFunction('window.__done === true', { timeout: 15000 })

  // Straight off the canvas at its full 2x, then down to the unfurled size - the
  // hairlines and the grain survive the trip that way.
  const dataUrl = await page.evaluate((w, h) => {
    const src = document.getElementById('c')
    const out = document.createElement('canvas')
    out.width = w; out.height = h
    const o = out.getContext('2d')
    o.imageSmoothingQuality = 'high'
    o.drawImage(src, 0, 0, w, h)
    return out.toDataURL('image/jpeg', 0.92)
  }, W, H)

  writeFileSync(card.out, Buffer.from(dataUrl.split(',')[1], 'base64'))
  const kb = Math.round(Buffer.from(dataUrl.split(',')[1], 'base64').length / 1024)
  console.log(`[og] ${card.out}  ${W}x${H}  ${kb} KB`)
  await page.close()
}

await browser.close()
console.log('[og] done - preview redrawn from cardkit')
