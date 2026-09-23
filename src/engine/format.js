export const uid = () => Math.random().toString(36).slice(2, 10)

export const fmtUsd = (n, opts = {}) => {
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  const digits = opts.digits ?? (abs >= 1000 ? 0 : 2)
  return sign + '$' + abs.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

// Balances are held in SOL, and a SOL figure needs enough decimals to be
// recognisable as the amount the player sent. Trailing zeros are dropped so a
// round number reads as a round number.
export const fmtCoin = (n) => {
  if (!Number.isFinite(n)) return '0'
  const s = Math.abs(n) >= 1 ? n.toFixed(4) : n.toFixed(6)
  return s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
}

// Past a thousand percent the exact figure stops being information and starts
// being a column-width problem, so it collapses to a magnitude instead.
export const fmtPct = (n, digits = 2) => {
  if (!Number.isFinite(n)) return '-'
  const sign = n >= 0 ? '+' : '−'
  const abs = Math.abs(n)
  if (abs >= 1e6) return `${sign}${Math.round(abs / 1e6)}M%`
  if (abs >= 1e3) return `${sign}${Math.round(abs / 1e3)}k%`
  return sign + abs.toFixed(digits) + '%'
}

// Adaptive precision so meme prices like $0.0000122 stay readable
export const fmtPrice = (p) => {
  if (p >= 1000) return '$' + p.toLocaleString('en-US', { maximumFractionDigits: 0 })
  if (p >= 1) return '$' + p.toFixed(p >= 100 ? 2 : 3)
  if (p >= 0.01) return '$' + p.toFixed(4)
  if (p >= 0.0001) return '$' + p.toFixed(6)
  return '$' + p.toFixed(8)
}

export const fmtCompact = (n) => {
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(1) + 'B'
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K'
  return '$' + n.toFixed(0)
}

// Compact plain number (no $) - holders, tx counts. Null-safe → em dash.
export const fmtNum = (n) => {
  if (n == null || !Number.isFinite(n)) return '-'
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(Math.round(n))
}

export const fmtClock = (secs) => {
  secs = Math.max(0, Math.ceil(secs))
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = Math.floor(secs % 60)
  const pad = (x) => String(x).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

export const DURATIONS = [
  // One minute is one candle wide: there is no trend to read, only the next few
  // trades. It belongs at the top of the ladder as the extreme, not as a
  // default - the picker keeps 5 min selected.
  { secs: 60, label: '1 min', tag: 'Blitz' },
  { secs: 300, label: '5 min', tag: 'Sprint' },
  { secs: 900, label: '15 min', tag: 'Rush' },
  { secs: 3600, label: '1 hour', tag: 'Marathon' },
  { secs: 86400, label: '24 hours', tag: 'Endurance' },
]

export const durLabel = (secs) => (DURATIONS.find((d) => d.secs === secs) || { label: secs + 's' }).label

export const STAKES = [10, 20, 50, 100, 150, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 7500, 10000]

// Bands, not exact stakes: each key is the smallest stake paying that rate.
export const FEE_PCT_DEFAULT = { 10: 10, 100: 8, 300: 6, 750: 5, 1500: 4, 3000: 3, 7500: 2.5 }

export const timeAgo = (ts) => {
  const d = Math.floor((Date.now() - ts) / 1000)
  if (d < 60) return 'just now'
  if (d < 3600) return Math.floor(d / 60) + 'm ago'
  if (d < 86400) return Math.floor(d / 3600) + 'h ago'
  return Math.floor(d / 86400) + 'd ago'
}
