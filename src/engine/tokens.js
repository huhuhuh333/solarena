// Token registry. Categories: verified | degen | fresh | suspended | ineligible
// maxStake: highest per-player stake this token may appear in (0 = free battles only).
// Degen rules: Classic only, min duration 15m, max 50% of a portfolio.
//
// Every token belongs to exactly ONE battle pool. A battle is played inside a
// single pool: both players pick all 3 tokens from it - no mixing pools.

export const CATEGORY = {
  verified: { label: 'Arena Verified', short: 'Verified' },
  degen: { label: 'Degen Approved', short: 'Degen' },
  fresh: { label: 'Fresh Launch', short: 'Fresh' },
  suspended: { label: 'Suspended', short: 'Suspended' },
  ineligible: { label: 'Not Eligible', short: 'Blocked' },
}

// How a trading terminal ranks a book - and the one thing this arena got wrong
// twice. Ranking by LIQUIDITY floats hundreds of untouched launchpad clones
// (every one seeded at the same ~$58k) above coins people actually trade.
// Ranking by TRADES swings the other way: the top fills with $3k pools that
// bots churn, and the book looks like it has no depth anywhere. Neither number
// means anything alone.
//
// So: the geometric mean of depth and honest turnover. A coin has to have BOTH
// to rank - a dead pool scores zero however deep it is, a churned dust pool
// scores little however busy it is, and a real market beats both. Volume is
// capped at 40× depth first, the same wash-trade guard the tier ladder uses.
export const honestVol24 = (t) => Math.min(t?.vol24 ?? t?.volume24 ?? 0, (t?.liquidity || 0) * 40)
export const trades24 = (t) => (t?.txns24 ? (t.txns24.buys || 0) + (t.txns24.sells || 0) : 0)
export const marketScore = (t) => Math.sqrt(Math.max(0, t?.liquidity || 0) * Math.max(0, honestVol24(t)))

// ---- fields the server no longer ships, rebuilt here ----
//
// Both are pure functions of data the token already carries, and at book scale
// (thousands of coins) shipping them per row was hundreds of KB of the same few
// strings on every 15s poll. Curated tokens keep their own hand-written blurb.
export const dexUrlFor = (t) => (t?.dexUrl
  || (t?.srcChain && t?.pairAddress ? `https://dexscreener.com/${t.srcChain}/${t.pairAddress}` : null))

const CHAIN_LABEL = { sol: 'Solana' }
const DYNAMIC_BLURB = {
  verified: (c) => `The arena can buy this on ${c} at your stake size without moving the price, and the buy tax is sane. Live Arena ready - win and you receive the coins themselves. That is NOT a promise the coin won't rug or that you'll be able to sell it later: those are yours, exactly as they would be trading it anywhere else.`,
  degen: (c) => `Tradeable, but the pool is too thin to buy your stake into without moving the price, the buy tax is punitive, or the treasury has no venue on ${c}. Classic Arena only - nothing is bought there, so the depth stops mattering.`,
  fresh: (c, t) => (t?.onCurve
    ? `Still on its launchpad bonding curve on ${c} - one buyer can walk that price up a formula, so it plays free battles only until it graduates to a real pool.`
    : `Freshly migrated on ${c} - pool still too thin to price a battle honestly. Free battles until it fills out.`),
  ineligible: () => 'Can\'t be sold (honeypot or sell-blocked), so its price isn\'t a real market price. Not eligible in any arena.',
  suspended: () => 'Suspended by the arena - it no longer passes the checks it was listed under.',
}
export const blurbFor = (t) => t?.blurb
  || DYNAMIC_BLURB[t?.category]?.(CHAIN_LABEL[t?.pool] || 'this chain', t)
  || null

// One battlefield: Solana memecoins (owner, 22 Sep 2026). Robinhood Memes
// (`eth`) is retired - its id lives on in match history and in coins players
// won there, so it resolves through RETIRED_POOLS below.
export const POOLS = [
  { id: 'sol', label: 'Solana Memes', icon: '◎', tagline: 'Solana\'s live memecoin book - the deepest, busiest markets on it, a coin often listed minutes after it starts trading.' },
]

export const poolById = (id) => POOLS.find((p) => p.id === id)

// Pools the arena no longer fields. Their battles happened - they are in match
// history, tournament standings and holdings forever - so their NAMES must keep
// resolving even though nothing can ever be played in them again.
//
// The split matters: `poolById` answers "can a battle be fought here?" and must
// never return a retired pool, while `poolLabel` answers "what was this called?"
// and covers both. Rendering a retired battle through poolById left a dangling
// "· " separator with no name on every old history row.
const RETIRED_POOLS = { majors: 'Blue Chips', eth: 'Robinhood Memes' }
export const poolLabel = (id) => poolById(id)?.label || RETIRED_POOLS[id] || null

// Which chain a pool's LIVE battles are funded and settled on.
//
// Classic is chain-agnostic on purpose: the house holds nothing, the two stakes
// settle against each other. Live is not, because the treasury has to buy that
// pool's basket on that pool's chain in the seconds before a battle starts - so
// Live spends only money already standing there.
//
// null = that pool has no Live venue at all (Classic only).
//
// Solana Memes are bought with the SOL players deposit, on Solana, by the
// Jupiter executor - money and basket stand on the same chain, so the arena
// buys with the player's own money and keeps the fee.
export const POOL_FUND = {
  // `asset` is what the refusal message tells a player their Live stake spends.
  sol: { chain: 'sol', label: 'Solana', asset: 'SOL' },
}

export const poolFund = (id) => POOL_FUND[id] ?? null

// No curated tokens at all: the arena's one pool is filled ENTIRELY by the
// live token-source ingest (Jupiter's token book + DexScreener `solana`). Fresh / Suspended / Ineligible tokens are never hardcoded
// either; they come from the live ingest and admin overrides. Everything in
// the arena is a real token.
export const TOKENS = []

export const tokenById = (id) => TOKENS.find((t) => t.id === id)

// No size is blocked anywhere - big Live orders on thin books simply pay their
// market impact, like on any DEX. The tier is guidance, not a gate: the stake
// up to which the impact charge stays negligible.
export const eligibilityLabel = (maxStake) => {
  if (maxStake >= 10000) return 'Deep market - negligible impact at any size'
  if (maxStake >= 10) return `Any size playable · low impact up to $${maxStake.toLocaleString()}`
  return 'Free battles only'
}

// Live Arena pays the winner the COINS themselves, so the arena buys and never
// sells. Only the first four checks are therefore its business - they are what
// the entry costs. Everything below them is about getting back OUT, which is
// the holder's side of the trade: shown in full so you can judge the coin, but
// blocking nothing. It is the same deal you'd have buying it on any DEX.
export const SAFETY_LABELS = {
  tradable: 'Buys execute normally',
  honeypot: 'Honeypot mechanism',
  buyTaxOk: 'Buy tax within limits',
  liquidityOk: 'Pool deep enough to buy your stake without moving the price',
  exitObserved: 'Sells are going through on-chain - your risk, not the arena\'s',
  sellTaxOk: 'Sell tax within limits - your risk, not the arena\'s',
  migrated: 'Completed launchpad migration - your risk, not the arena\'s',
  sellNotBlockable: 'No sell-blocking or freeze functions - your risk, not the arena\'s',
  mintLocked: 'Mint authority revoked - your risk, not the arena\'s',
  lpLocked: 'Liquidity locked - your risk, not the arena\'s',
  holdersOk: 'No extreme supply concentration - your risk, not the arena\'s',
  manipulationLow: 'Deep book, harder to push - your risk, not the arena\'s',
  historyOk: 'Has post-migration trading history - your risk, not the arena\'s',
}
