// The battle share card: a fight poster in the site's own voice, drawn on
// canvas (1000x560, exported at 2x) with a PNG download.
//
// The design is the arena's design system, not a separate one: the black-green
// room (sky lobes, film grain, the horizon hairline), Anton leaning at --skew
// for the slam and the VS, Space Grotesk for labels, Inter for every number.
// The opponent's corner is ACID green - not red - because that is the site's
// whole thesis: two greens pushing against each other, red only where money was
// actually lost. The leadbar is the app's own instrument (ruler ticks, phos
// fill, white notch), carried onto the poster so the margin is drawn, not
// merely written.
//
// Tickers come from effToken, NOT tokenById: `TOKENS` in engine/tokens is a
// permanently empty array since the arena went fully dynamic, so tokenById
// could only ever return undefined and the card printed raw ids - PIPEDOG_5CB6
// instead of PIPEDOG. This is the image players post publicly.
import { effToken } from '../engine/store'
import { fmtPct, fmtUsd } from '../engine/format'
import {
  TOKENS as C, setupCard, skewText, glowOn, glowOff,
  wordmark, horizon, skyLobes, grain, chip,
} from './cardkit'

// A coin that has since left the book has no record to look up. Its id still
// carries the ticker it was built from, so recover that rather than print the
// hash: TICKER_ABCD -> TICKER.
const tickerOf = (tokenId) => {
  const t = effToken(tokenId)
  if (t?.ticker) return t.ticker
  const m = /^(.+)_[0-9A-Fa-f]{4}$/.exec(String(tokenId))
  return m ? m[1] : String(tokenId)
}

const W = 1000, H = 560, M = 56 // margin: the poster breathes at the edges

export const drawShareCard = (canvas, match, userName) => {
  const x = setupCard(canvas, W, H)
  const won = match.outcome === 'win'
  const draw = match.outcome === 'draw'

  // ---- the room ----
  x.fillStyle = C.bg
  x.fillRect(0, 0, W, H)
  skyLobes(x, W, H, [
    [0.26, 0.16, 0.5, won ? 'rgba(153,69,255,0.16)' : 'rgba(153,69,255,0.07)'],
    [0.82, 0.30, 0.42, 'rgba(153,69,255,0.10)'],
    [0.55, 0.95, 0.45, 'rgba(220,31,255,0.05)'],
  ])
  horizon(x, W, 'rgba(153,69,255,0.34)', 'rgba(153,69,255,0.30)')

  // ---- masthead: the wordmark and the table's terms ----
  wordmark(x, 'ARENA', C.phos, 'rgba(153,69,255,0.5)', M, 74, 30)
  x.font = '600 14px "Space Grotesk", sans-serif'
  x.fillStyle = C.muted
  x.textAlign = 'right'
  const terms = match.training
    ? 'TRAINING · NO MONEY ON THIS ONE'
    : `$${match.stake} ${String(match.mode).toUpperCase()} · WINNER TAKES THE POOL`
  x.save(); x.letterSpacing = '2px'; x.fillText(terms, W - M, 72); x.restore()
  x.textAlign = 'left'

  // ---- the slam ----
  // VICTORY glows phosphor; DEFEAT stands in ink - you brag in green and own
  // the L with a straight face; DRAW is the referee's voice.
  x.font = '400 96px Anton, sans-serif'
  x.fillStyle = won ? C.up : draw ? C.muted : C.text
  if (won) glowOn(x, 'rgba(20,241,149,0.45)', 30)
  skewText(x, won ? 'VICTORY' : draw ? 'DRAW' : 'DEFEAT', M + 10, 196)
  glowOff(x)

  // ---- the money, on the slam's own line ----
  // Red appears exactly where money was actually lost, nowhere else.
  x.textAlign = 'right'
  if (!match.training) {
    const big = won ? fmtUsd(match.payout) : draw ? fmtUsd(match.stake) : `−${fmtUsd(match.stake)}`
    const label = won ? 'TAKEN FROM THE POOL' : draw ? 'STAKE BACK, FEE WAIVED' : 'STAKE TAKEN'
    x.font = '700 44px Inter, sans-serif'
    x.fillStyle = won ? C.up : draw ? C.text : C.down
    if (won) glowOn(x, 'rgba(20,241,149,0.35)', 18)
    x.fillText(big, W - M, 168)
    glowOff(x)
    x.font = '600 13px "Space Grotesk", sans-serif'
    x.fillStyle = C.muted
    x.save(); x.letterSpacing = '2px'; x.fillText(label, W - M, 196); x.restore()
  }
  x.textAlign = 'left'

  // ---- the duel row: two corners and the VS slam between them ----
  const rowName = 262, rowRet = 312
  const fitName = (name, maxW) => {
    x.font = '600 19px "Space Grotesk", sans-serif'
    let s = String(name)
    while (x.measureText(s).width > maxW && s.length > 3) s = s.slice(0, -2)
    return s === String(name) ? s : s + '…'
  }
  const half = W / 2 - M - 60

  x.fillStyle = C.muted
  x.font = '600 19px "Space Grotesk", sans-serif'
  x.fillText(fitName(userName, half), M, rowName)
  x.textAlign = 'right'
  x.fillText(fitName(match.opp.name, half), W - M, rowName)
  x.textAlign = 'left'

  // Your return follows the up/down rule; the opponent's PLUS is acid - their
  // corner's own green (site rule: .corner-opp .corner-ret.up) - and their
  // minus is the same burnt red as any lost money.
  x.font = '700 46px Inter, sans-serif'
  x.fillStyle = match.retYou > 0 ? C.up : match.retYou < 0 ? C.down : C.muted
  x.fillText(fmtPct(match.retYou), M, rowRet)
  x.textAlign = 'right'
  x.fillStyle = match.retOpp > 0 ? C.acid : match.retOpp < 0 ? C.down : C.muted
  x.fillText(fmtPct(match.retOpp), W - M, rowRet)
  x.textAlign = 'left'

  // The VS - Anton's second job on the site, and its second job here.
  x.font = '400 34px Anton, sans-serif'
  x.fillStyle = C.phos
  glowOn(x, 'rgba(153,69,255,0.4)', 12)
  skewText(x, 'VS', W / 2, rowRet - 6, { align: 'center' })
  glowOff(x)

  // ---- the leadbar: the margin, drawn ----
  // Faithful to .leadbar: hairline border, corner-tinted field, ruler ticks,
  // phos fill with glow, white notch. The app's live bar maps 1pp = 10% shift,
  // tuned for mid-fight margins; a SETTLED battle's margin is routinely 5pp+,
  // which pins that mapping to the edge and turns the instrument into a solid
  // stripe. The card halves the gain and never quite reaches the wall, so the
  // notch always reads as a needle, not a border.
  const by = 344, bh = 16, bx = M, bw = W - 2 * M
  const shift = Math.max(-42, Math.min(42, (match.retYou - match.retOpp) * 5))
  const notchX = bx + bw * (0.5 + shift / 100)
  const field = x.createLinearGradient(bx, 0, bx + bw, 0)
  field.addColorStop(0, 'rgba(153,69,255,0.08)')
  field.addColorStop(0.45, '#0b0a0d')
  field.addColorStop(0.55, '#0b0a0d')
  field.addColorStop(1, 'rgba(220,31,255,0.08)')
  x.fillStyle = field
  x.fillRect(bx, by, bw, bh)
  const fill = x.createLinearGradient(bx, 0, notchX, 0)
  fill.addColorStop(0, 'rgba(153,69,255,0.35)')
  fill.addColorStop(1, C.phos)
  x.fillStyle = fill
  glowOn(x, 'rgba(153,69,255,0.45)', 14)
  x.fillRect(bx, by, Math.max(0, notchX - bx), bh)
  glowOff(x)
  x.strokeStyle = 'rgba(134,126,140,0.16)'
  x.lineWidth = 1
  for (let tx = bx + 9; tx < bx + bw; tx += 9) {
    x.beginPath(); x.moveTo(tx + 0.5, by); x.lineTo(tx + 0.5, by + bh); x.stroke()
  }
  x.strokeStyle = C.line
  x.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1)
  x.fillStyle = C.text
  x.fillRect(notchX - 1.5, by - 6, 3, bh + 12)

  // ---- the lineup, as chips (the site's only curve) ----
  const lineup = (match.youTokens || []).map((p) => `${p.pct}% ${tickerOf(p.tokenId)}`)
  const chipH = 38
  let font = 18
  let widths
  for (;;) {
    x.font = `600 ${font}px Inter, sans-serif`
    widths = lineup.map((l) => x.measureText(l).width + chipH)
    if (widths.reduce((a, b) => a + b, 0) + (lineup.length - 1) * 12 <= W - 2 * M || font <= 13) break
    font -= 1
  }
  let cx2 = M
  for (const label of lineup) {
    cx2 += chip(x, label, cx2, 402, chipH, { font: `600 ${font}px Inter, sans-serif` }) + 12
  }

  // ---- the bottom band: hairline, then the call-out ----
  x.strokeStyle = C.lineSoft
  x.lineWidth = 1
  x.beginPath(); x.moveTo(M, 492.5); x.lineTo(W - M, 492.5); x.stroke()
  x.font = '700 21px "Space Grotesk", sans-serif'
  x.fillStyle = C.phos
  x.textAlign = 'right'
  glowOn(x, 'rgba(153,69,255,0.3)', 10)
  x.fillText('Think you can beat me?', W - M, 530)
  glowOff(x)
  x.textAlign = 'left'
  x.font = '500 14px "Space Grotesk", sans-serif'
  x.fillStyle = C.muted
  x.fillText('solarena · pick 3 coins · beat your opponent', M, 529)

  grain(x, 7)
}

export const shareText = (match, userName) =>
  `I ${match.outcome === 'win' ? 'won' : 'fought'} a ${match.training ? 'training' : '$' + match.stake} SolArena battle.\n` +
  `My portfolio: ${fmtPct(match.retYou)}\nOpponent: ${fmtPct(match.retOpp)}\n` +
  (match.outcome === 'win' && !match.training ? `Prize: ${fmtUsd(match.payout)}\n` : '') +
  `Think you can beat me?`

export const downloadCanvas = (canvas, name) => {
  const a = document.createElement('a')
  a.href = canvas.toDataURL('image/png')
  a.download = name
  a.click()
}
