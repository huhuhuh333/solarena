// The share card's canvas kit: the site's design tokens and gestures, made
// drawable, so the card stays in the same room, light and lean as the site -
// and a palette change lands on it at once.
//
// Everything here is derived from styles.css, not invented:
//   TOKENS      - the :root custom properties, verbatim
//   SKEW_K      - tan(--skew): the wordmark/VS lean, -8deg exactly
//   horizon()   - body::after, the hairline of light along the top edge
//   skyLobes()  - body::before, the rotating colour fields, frozen mid-turn
//   grain()     - .bg-noise, the film grain that kills digital flatness
//   wordmark()  - .logo: Anton, skewed, with the glowing em
//
// Anton ships in ONE weight (400). Asking canvas for 900 made Chrome synthesize
// a fake bold that read as smeared - every Anton call here is honest 400 and
// gets its presence from size, which is how a poster face is meant to be used.

export const TOKENS = {
  bg: '#0d0c0f', panel: '#161419', panel2: '#121014',
  line: '#2c2832', lineSoft: '#1f1c23',
  text: '#e9e6ef', muted: '#867e8c',
  phos: '#9945ff', acid: '#dc1fff', live: '#9945ff',
  up: '#14f195', down: '#ff5c4d',
}

export const SKEW_K = Math.tan((-8 * Math.PI) / 180)

// Retina export: the canvas renders at 2x and the CSS class scales it back
// down, so a downloaded card survives X/Telegram recompression with its
// hairlines intact. All drawing stays in 1000x560 coordinates.
export const setupCard = (canvas, W, H) => {
  canvas.width = W * 2
  canvas.height = H * 2
  const x = canvas.getContext('2d')
  x.scale(2, 2)
  x.textAlign = 'left'
  x.textBaseline = 'alphabetic'
  return x
}

// Text with the site's lean. The skew has to happen around the text's own
// anchor, or the offset would depend on where on the card it sits.
export const skewText = (x, text, px, py, { align = 'left' } = {}) => {
  x.save()
  x.translate(px, py)
  x.transform(1, 0, SKEW_K, 1, 0, 0)
  x.textAlign = align
  x.fillText(text, 0, 0)
  x.restore()
}

export const glowOn = (x, color, blur) => { x.shadowColor = color; x.shadowBlur = blur }
export const glowOff = (x) => { x.shadowColor = 'transparent'; x.shadowBlur = 0 }

// .logo - HOOD in ink, the product word in the accent, leaning together.
export const wordmark = (x, word, accent, glowRgba, px, py, size = 30) => {
  x.font = `400 ${size}px Anton, sans-serif`
  x.save()
  x.translate(px, py)
  x.transform(1, 0, SKEW_K, 1, 0, 0)
  x.fillStyle = TOKENS.text
  x.fillText('SOL', 0, 0)
  const w = x.measureText('SOL').width
  x.fillStyle = accent
  glowOn(x, glowRgba, 14)
  x.fillText(word, w + 2, 0)
  glowOff(x)
  x.restore()
}

// body::after - the screen's own horizon, on the card's top edge.
export const horizon = (x, W, c1, c2) => {
  const g = x.createLinearGradient(0, 0, W, 0)
  g.addColorStop(0.08, 'rgba(0,0,0,0)')
  g.addColorStop(0.38, c1)
  g.addColorStop(0.62, c2)
  g.addColorStop(0.92, 'rgba(0,0,0,0)')
  x.fillStyle = g
  x.fillRect(0, 0, W, 1.5)
}

// body::before - the sky, one frame of it. `lobes` is [cx, cy, r, rgba color].
export const skyLobes = (x, W, H, lobes) => {
  for (const [cx, cy, r, color] of lobes) {
    const g = x.createRadialGradient(cx * W, cy * H, 0, cx * W, cy * H, r * W)
    g.addColorStop(0, color)
    g.addColorStop(1, 'rgba(0,0,0,0)')
    x.fillStyle = g
    x.fillRect(0, 0, W, H)
  }
}

// .bg-noise - seeded so the same result always renders the same card, drawn in
// device pixels so the grain stays film-fine on the 2x export.
export const grain = (x, seed = 7) => {
  let s = seed >>> 0
  const rnd = () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  x.save()
  x.setTransform(1, 0, 0, 1, 0, 0)
  const w = x.canvas.width, h = x.canvas.height
  for (let i = 0; i < 4200; i++) {
    x.fillStyle = rnd() > 0.5 ? 'rgba(255,255,255,0.030)' : 'rgba(0,0,0,0.045)'
    x.fillRect(rnd() * w, rnd() * h, 1, 1)
  }
  x.restore()
}

// A fully-round chip - the site's only curve. Returns the width it took, so a
// row of chips can lay itself out.
export const chip = (x, label, px, py, h, { color = TOKENS.text, border = TOKENS.line, fill = 'rgba(22,20,25,0.85)', font = '600 18px Inter, sans-serif' } = {}) => {
  x.font = font
  const tw = x.measureText(label).width
  const w = tw + h // h/2 padding each side
  const r = h / 2
  x.beginPath()
  if (x.roundRect) x.roundRect(px, py, w, h, r)
  else x.rect(px, py, w, h)
  x.fillStyle = fill
  x.fill()
  x.lineWidth = 1
  x.strokeStyle = border
  x.stroke()
  x.fillStyle = color
  x.textAlign = 'left'
  // The px SIZE, not the leading weight - parseInt('600 18px …') reads 600.
  const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] || 16)
  x.fillText(label, px + r, py + h / 2 + size * 0.36)
  return w
}

// Step a font size down until the text fits - a cropped word is a wrong word.
export const fitFont = (x, text, maxW, px, minPx, weightFace) => {
  let size = px
  x.font = `${weightFace(size)}`
  while (size > minPx && x.measureText(text).width > maxW) {
    size -= 1
    x.font = `${weightFace(size)}`
  }
  return size
}
