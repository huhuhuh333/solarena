// Shared dynamic-token registry. The token-source writes ingested tokens here;
// rules.js and the API read them. Kept separate to avoid an import cycle
// (rules → registry → nothing).

const dynamic = new Map() // id -> token record (same shape as static TOKENS)

export const setDynamic = (tokens) => {
  dynamic.clear()
  for (const t of tokens) dynamic.set(t.id, t)
}

export const dynamicTokens = () => [...dynamic.values()]
export const dynamicById = (id) => dynamic.get(id) || null
export const dynamicCount = () => dynamic.size

// Enrichment for STATIC curated tokens (address, pair for the real chart,
// market cap, socials…) resolved from DexScreener at runtime. Display-only:
// never contains gating fields (category / maxStake / pool / price).
const staticExtra = new Map() // id -> partial record

export const setStaticExtra = (id, data) => { staticExtra.set(id, data) }
export const staticExtraFor = (id) => staticExtra.get(id) || null

// What the treasury can actually REACH for a curated token, as opposed to what
// the coin is worth in the world. BTC has a trillion-dollar market and $21M of
// it on Solana; DOT has a real market and $2,273 of it. Live is settled by
// buying on-chain, so only the reachable number may set the stake ceiling -
// the global one would let a $1000 battle eat half a pool.
const venueLimit = new Map() // id -> { maxStake, reachableLiquidity }

export const setVenueLimit = (id, data) => { venueLimit.set(id, data) }
export const venueLimitFor = (id) => venueLimit.get(id) || null
