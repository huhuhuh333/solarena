// Bot portfolio builder for training battles. Difficulty is HONEST - prices
// are real and unknowable, so the levels differ in how the bot builds its
// portfolio, not in any rigged outcome:
//   easy   - three random coins, money spread flat: pure dartboard
//   normal - random coins with a realistic conviction split (the old bot)
//   hard   - backs the day's top movers and concentrates its stack, the way a
//            momentum chaser actually plays

const SPLITS = [[50, 30, 20], [40, 35, 25], [60, 25, 15], [45, 30, 25], [70, 20, 10], [34, 33, 33]]

export const BOT_LEVELS = ['easy', 'normal', 'hard']

export const botPicks = (allowedIds, level = 'normal', infoOf = null) => {
  const pool = [...allowedIds]
  if (level === 'hard' && infoOf && pool.length > 3) {
    const chg = (id) => {
      const t = infoOf(id) || {}
      const c = t.priceChange?.h24 ?? t.change24
      return Number.isFinite(c) ? c : 0
    }
    const picks = pool.sort((a, b) => chg(b) - chg(a)).slice(0, 3)
    return picks.map((tokenId, i) => ({ tokenId, pct: [50, 30, 20][i] }))
  }
  // A bot that picks three dead coins sits at exactly 0.00% for the whole
  // battle - technically correct (nothing traded, nothing moved) and utterly
  // lifeless to fight. Weight the random draw by real activity so the bot's
  // side of the screen moves like a market: a coin doing 5,000 trades a day is
  // sqrt(5000)≈70× likelier than one doing one.
  const weight = (id) => {
    const t = infoOf?.(id) || {}
    const trades = (t.txns24?.buys || 0) + (t.txns24?.sells || 0)
    return Math.sqrt(1 + trades)
  }
  const picks = []
  for (let k = 0; k < 3 && pool.length; k++) {
    const weights = pool.map(weight)
    let roll = Math.random() * weights.reduce((a, w) => a + w, 0)
    let i = 0
    while (i < pool.length - 1 && (roll -= weights[i]) > 0) i++
    picks.push(pool.splice(i, 1)[0])
  }
  const split = level === 'easy' ? [34, 33, 33] : SPLITS[Math.floor(Math.random() * SPLITS.length)]
  return picks.map((tokenId, i) => ({ tokenId, pct: split[i] ?? 0 }))
}
