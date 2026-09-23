// Brand marks for the things that aren't tokens - chains and battle pools.
// One place, because these URLs are used on both the wallet (chain rails) and
// the arena (battlefield cards), and two copies would drift apart.
//
// Everything here is shaped like a token record so <TokenLogo> can render it
// and fall back to the glyph on its own if a CDN ever 404s.

const CG = 'https://assets.coingecko.com'

// Chains, by id. Solana is the rail; `rh` survives only to draw the retired
// Robinhood pool on old match history.
export const CHAIN_IMG = {
  sol: `${CG}/coins/images/4128/small/solana.png`,
  rh: 'https://dd.dexscreener.com/ds-data/chains/robinhood.png',
}
export const CHAIN_COLOR = { sol: '#9945ff', rh: '#dc1fff' }

export const chainMark = (c) => ({
  img: CHAIN_IMG[c.id] || null,
  glyph: c.icon,
  ticker: c.label,
  color: CHAIN_COLOR[c.id] || '#867e8c',
})

// Battle pools. Only `sol` (Solana Memes) is playable. `majors` and `eth` are
// RETIRED (Blue Chips, Robinhood Memes) and keep their marks because old match
// history, tournament standings and won holdings still render them; Blue Chips
// never had a chain of its own, so it flies BTC as its standard-bearer. See
// `poolLabel` in engine/tokens.js for the matching names.
export const POOL_IMG = {
  majors: `${CG}/coins/images/1/small/bitcoin.png`,
  sol: CHAIN_IMG.sol,
  eth: CHAIN_IMG.rh,
}
export const POOL_COLOR = { majors: '#F7931A', sol: CHAIN_COLOR.sol, eth: CHAIN_COLOR.rh }

export const poolMark = (p) => ({
  img: POOL_IMG[p.id] || null,
  glyph: p.icon,
  ticker: p.label,
  color: POOL_COLOR[p.id] || '#867e8c',
})
