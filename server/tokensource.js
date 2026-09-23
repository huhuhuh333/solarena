// Live token ingestion for Solana memecoins - the arena's one battle pool
// since 22 Sep 2026 (owner: the Robinhood book is dropped, Solana memes only).
//
// DISCOVERY is broad, the BOOK is not, and the difference matters enough that
// player-facing copy has already been wrong about it once. Discovery reads
// Jupiter's whole verified token list plus its top-traded / trending / organic
// / newest feeds and DexScreener's boosted and profiled coins; what leaves this
// file is PER_POOL taken off the TOP by depth × turnover, after the floors
// below (MIN_LIQ, MIN_TRADES_24H, DUP_MIN_LIQ, EXCLUDE, the non-meme tags).
// Nothing here can honestly be called "every memecoin on Solana" - it is
// Solana's real memecoin markets, ranked and capped.
//
// Safety: Jupiter's audit block (mint / freeze authority, top-holder share)
// rides along on every row for free; GoPlus scans the stake-eligible coins on
// a per-cycle budget for taxes (token-2022 transfer fees), frozen-by-default
// accounts and non-transferable mints. Only a POSITIVE can't-sell finding
// hard-blocks a coin, exactly as before.

import { registerToken, applyFeed, setBroadcastIds, getPrice } from './market.js'
import { setDynamic, setStaticExtra, staticExtraFor, dynamicTokens } from './registry.js'
import { venueCanTrade, venueWarm } from './venue.js'
import { TOKENS, tokenById, marketScore, POOLS } from '../src/engine/tokens.js'
import { db, holdingsOwed } from './db.js'
import { mark, markAsync } from './blockwatch.js'
import { jupPriceFresh } from './solprices.js'

// The ingested book survives a restart.
//
// It used to live only in memory, so for the ninety seconds a fresh boot needs
// to finish its first discovery pass the arena knew about nineteen curated
// coins and nothing else. That is not just a thin-looking home page: effToken()
// backs the whole token layer, so during that window a player could not sell
// coins they had won, and the executor could not resolve which on-chain asset a
// holding even was. Writing the last good book down makes the arena warm the
// instant it starts, and the first live cycle replaces it.
db.exec(`CREATE TABLE IF NOT EXISTS token_cache (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  ts INTEGER NOT NULL,
  data TEXT NOT NULL
)`)

// ---- token identity, pinned to the contract ----
//
// A token's id is what the arena WRITES DOWN: holdings.token, open_holdings,
// every pick in match history. It was being re-derived from the ticker each
// cycle, and the strongest coin of a ticker won the clean name - so when
// leadership changed, an id silently moved to a different contract. Measured
// on the live book: ten ids changed contract inside ten minutes, and some
// crossed CHAINS ("TROLL" went from a Robinhood address to a Solana one). A
// player holding those coins from a Live battle would have had their winnings
// resolve to a different asset entirely.
//
// So identity is now permanent: an address claims an id once and keeps it for
// good. New coins wearing a taken ticker get a suffixed id of their own and
// keep that. Nothing an id points at can ever change underneath a holding.
db.exec(`CREATE TABLE IF NOT EXISTS token_ids (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  pool TEXT NOT NULL,
  first_seen INTEGER NOT NULL
)`)
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS token_ids_addr ON token_ids (address)')

// EVM addresses arrive in mixed case from different sources; Solana's base58 is
// case-SENSITIVE and must never be folded.
export const normAddr = (pool, address) => (pool === 'eth' ? String(address).toLowerCase() : String(address))

// The key BOTH sides of a vendor match must go through.
//
// DexScreener returns EVM addresses CHECKSUMMED (0x5Cb6F1…), while every record
// we build from the chain ourselves carries them lowercase - the firehose reads
// them out of event logs, which are lowercase. Matching vendor rows to our
// records by raw string therefore missed EVERY firehose-sourced token, silently:
// the loop just `continue`d. Measured on the live book before the fix: 493 of
// 1200 coins had zero socials and zero chart links, and the 134 of them whose
// contract publishes no logo() of its own had no picture at all (HOODRAT was
// the one the owner spotted).
//
// Hex-only on purpose: Solana base58 never matches, so it passes through
// untouched and stays case-sensitive.
export const addrKey = (a) => (/^0x[0-9a-fA-F]{40}$/.test(String(a)) ? String(a).toLowerCase() : String(a))

const qIdByAddr = db.prepare('SELECT id FROM token_ids WHERE address = ?')
const qAddrById = db.prepare('SELECT address FROM token_ids WHERE id = ?')
const insId = db.prepare('INSERT OR IGNORE INTO token_ids (id, address, pool, first_seen) VALUES (?,?,?,?)')

export const pinnedIdFor = (pool, address) => qIdByAddr.get(normAddr(pool, address))?.id || null

// Claim (or recall) this contract's permanent id. Returns null when no usable
// id can be formed - the caller drops the token rather than reusing someone's.
const claimTokenId = (pool, address, base) => {
  const addr = normAddr(pool, address)
  const known = qIdByAddr.get(addr)
  if (known) return known.id
  const take = (id) => {
    if (tokenById(id)) return false            // a curated coin owns this name
    const owner = qAddrById.get(id)
    if (owner && owner.address !== addr) return false
    insId.run(id, addr, pool, Date.now())
    return true
  }
  if (take(base)) return base
  // Suffix from the contract itself, so the id is reproducible from the chain.
  const raw = addr.replace(/^0x/i, '').replace(/[^a-zA-Z0-9]/g, '')
  for (const len of [4, 6, 8]) {
    const id = `${base.slice(0, 7)}_${raw.slice(0, len).toUpperCase()}`
    if (id.length > 20) break
    if (take(id)) return id
  }
  return null
}

// One-time: pin whatever the book is serving right now, so today's ids stay
// today's ids instead of every coin reshuffling on the first cycle.
export const seedTokenIds = (tokens) => {
  let n = 0
  for (const t of tokens || []) {
    if (!t?.id || !t.address || !t.pool) continue
    const addr = normAddr(t.pool, t.address)
    if (qIdByAddr.get(addr) || qAddrById.get(t.id)) continue
    insId.run(t.id, addr, t.pool, Date.now())
    n++
  }
  if (n) console.log(`[tokensrc] pinned ${n} existing token ids to their contracts`)
  return n
}

const saveCache = (tokens) => mark(`tokensrc.saveCache(${tokens.length})`, () => {
  try {
    db.prepare(`INSERT INTO token_cache (id, ts, data) VALUES (1, ?, ?)
                ON CONFLICT(id) DO UPDATE SET ts = excluded.ts, data = excluded.data`)
      .run(Date.now(), JSON.stringify(tokens))
  } catch (e) { console.error('[tokensrc] could not cache the book:', e.message) }
})

export const warmFromCache = () => {
  let row
  try { row = db.prepare('SELECT ts, data FROM token_cache WHERE id = 1').get() } catch { return 0 }
  if (!row) return 0
  let tokens
  try { tokens = JSON.parse(row.data) } catch { return 0 }
  if (!Array.isArray(tokens) || !tokens.length) return 0
  // A cache written before a pool was retired still holds that pool's whole
  // book. Only the live pool comes back.
  tokens = tokens.filter((t) => ACTIVE_POOLS.has(t.pool))
  if (!tokens.length) return 0
  for (const t of tokens) {
    registerToken(t.id, { base: t.base, vol: t.vol })
    applyFeed({ [t.id]: { price: t.base, vol24: t.volume24 } })
  }
  setDynamic(tokens)
  setBroadcastIds(tokens.map((t) => t.id))
  seedTokenIds(tokens) // today's ids become permanent, rather than reshuffling
  const age = Math.round((Date.now() - row.ts) / 1000)
  console.log(`[tokensrc] warmed ${tokens.length} tokens from the last book (${age}s old) - live discovery replaces it shortly`)
  return tokens.length
}

const NETWORKS = [
  // Jupiter is the lane that carries the pool: its verified list plus its
  // activity feeds. DexScreener adds boosted/profiled coins and the chart pair,
  // GoPlus the tax and can't-sell checks. GeckoTerminal discovery stays off -
  // its ~30 calls a minute are worth more as the candle fallback.
  // (`be` deliberately absent: Birdeye's free compute units run out and the
  // lane then starves silently.)
  { pool: 'sol', gt: null, ds: 'solana', goplus: 'solana', jup: true },
]
const ACTIVE_POOLS = new Set(NETWORKS.map((n) => n.pool))
const CHAIN_NAME = { sol: 'Solana' }

const heldIds = () => {
  try { return new Set(Object.keys(holdingsOwed())) } catch { return new Set() }
}

// A retired pool's ids go back into circulation. Robinhood clones held the
// clean names of Solana's biggest coins, so the real BONK listed as BONK_DEZX.
// A pin exists to keep a HOLDING pointed at its contract; one nobody holds
// protects nothing. Run at boot, before the first cycle claims names - battles
// do not survive a restart, so no running room can be reading one of these.
export const releaseRetiredIds = () => {
  const held = heldIds()
  const del = db.prepare('DELETE FROM token_ids WHERE id = ?')
  let n = 0
  for (const r of db.prepare('SELECT id, pool FROM token_ids').all()) {
    if (ACTIVE_POOLS.has(r.pool) || held.has(r.id)) continue
    del.run(r.id)
    n++
  }
  if (n) console.log(`[tokensrc] released ${n} ids pinned to retired-pool coins nobody holds`)
  return n
}
// Per-pool ceiling on the surfaced book, taken off the TOP by liquidity - a
// cut, not a race. It exists because two payloads scale with it: the 15s
// /api/tokens poll and the 1s websocket tick. Both were shrunk (derivable
// fields dropped, sparklines thinned, ticks turned into deltas), which is what
// bought this headroom. Raise it further only with those two numbers in hand -
// `node scripts/payload-weight.mjs` prints them.
const PER_POOL = Number(process.env.HOOD_TOKENS_PER_POOL) || 1500
const MIN_LIQ = 1000
// Trades in the last 24h before a coin is a coin. Deliberately low - a token
// twenty minutes old has barely had time for more - but not zero, because a
// launchpad deployment nobody ever bought is not a market.
const MIN_TRADES_24H = Number(process.env.HOOD_MIN_TRADES) || 6
// Depth a SECOND coin wearing an already-listed ticker must have to earn its
// place. Measured on the Robinhood chain: clone farms seed at ~$2.6k, while
// genuine same-name coins (a second FRANK, CATE, PIPECAT) sit above $25k.
const DUP_MIN_LIQ = Number(process.env.HOOD_DUP_MIN_LIQ) || 25000
const THIN_LIQ = 50000 // display/volatility tier only - no longer gates anything
const INGEST_MS = 3 * 60 * 1000
const PRICE_MS = 7 * 1000 // real-price + stats refresh for every surfaced token
const GT = 'https://api.geckoterminal.com/api/v2'
const DS = 'https://api.dexscreener.com'
const BE = 'https://public-api.birdeye.so'
// GeckoTerminal free tier 429s past ~1 page/endpoint, so we keep it lean and
// let `break`-on-error self-limit. `new_pools` is the freshest signal.
const GT_ENDPOINTS = [['pools', 2], ['new_pools', 3], ['trending_pools', 2]]
// Birdeye is the real scale lever: a free API key unlocks a volume-ranked
// Solana token list (hundreds/thousands), exactly like GMGN trending. Without
// a key it's simply skipped and we fall back to GeckoTerminal + DexScreener.
const BIRDEYE_KEY = process.env.HOOD_BIRDEYE_KEY || ''
const BIRDEYE_PAGES = Number(process.env.HOOD_BIRDEYE_PAGES) || 6 // ×50 tokens/page
// New GoPlus scans per ingest cycle. Results cache for an hour, so coverage of
// the eligible set builds up over the first few cycles rather than in one burst.
const GOPLUS_MAX_NEW = Number(process.env.HOOD_GOPLUS_MAX_NEW) || 40
// Vendor requests the ingest may spend on card enrichment per cycle, and the
// gap between them. Both exist because an unpaced 40-request burst was refused
// in full by DexScreener while the same calls, spaced, all answered 200.
const ENRICH_REQ_CAP = Number(process.env.HOOD_ENRICH_REQ_CAP) || 12
const ENRICH_GAP_MS = Number(process.env.HOOD_ENRICH_GAP_MS) || 400
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const EXCLUDE = new Set(['USDC', 'USDT', 'DAI', 'USDE', 'USDS', 'FDUSD', 'TUSD', 'BUSD', 'PYUSD', 'USD1', 'GUSD', 'FRAX', 'USDG', 'USDR',
  'WETH', 'WBTC', 'CBBTC', 'STETH', 'WSTETH', 'WEETH', 'RETH', 'WSOL', 'JITOSOL', 'MSOL', 'WBNB', 'WMATIC', 'WAVAX',
  // Yield-bearing receipts and LP tokens: they track a vault, not a market, and
  // the source's own tags don't always catch them.
  'JLP', 'JUPUSD', 'JUPSOL', 'JLUSDC', 'BNSOL', 'INF', 'HSOL', 'BBSOL', 'DSOL',
  // Impersonations. A pool named after a major asset that does not natively
  // exist on this chain is a costume, not a coin - the "$1.1B XMR on Solana"
  // kind. Real exposure to these lives in the curated Blue Chips list; a
  // dynamic listing under their ticker can only ever be a fake.
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'AVAX', 'LINK', 'DOT', 'LTC', 'ATOM',
  'XMR', 'ZEC', 'DASH', 'ETC', 'BCH', 'XLM', 'TRX', 'TON', 'HBAR', 'APT', 'SUI',
  'NEAR', 'ICP', 'FIL', 'VET', 'ALGO', 'EOS', 'XTZ', 'KAS', 'TAO', 'ARB', 'OP', 'INJ', 'TIA', 'SEI'])

const PALETTE = ['#F7931A', '#8A92F8', '#4EE0B3', '#E8C462', '#5DBB63', '#D6A77A',
  '#F0813C', '#F5C33B', '#E0A9C0', '#4C9EE8', '#E86A5B', '#7BE0D6', '#E89A6B', '#9AA5B5']
const colorFor = (seed) => {
  let h = 0
  for (const c of String(seed)) h = (h * 31 + c.charCodeAt(0)) | 0
  return PALETTE[Math.abs(h) % PALETTE.length]
}

const defaultFetchJson = async (url, opts = {}) => {
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(12000), ...opts })
  if (!res.ok) throw new Error('http ' + res.status)
  // Parsing a vendor payload is synchronous and some of them are large; this
  // is the one place a "slow API call" can actually stall the game thread, so
  // it is measured under its own name rather than hiding inside the caller.
  const text = await res.text()
  return mark(`parse ${new URL(url).hostname}(${Math.round(text.length / 1024)}KB)`, () => JSON.parse(text))
}

const state = { tokens: [], lastRun: 0, byCat: {}, bySource: {}, running: false, errors: [] }

// Birdeye costs compute units (free tier: 30K/month), so we DISCOVER via it
// only occasionally and cache the result. Prices + stats for those tokens still
// refresh every 7s off DexScreener (free). Default: rediscover every 30 min.
const beCache = { at: 0, byNet: {} }
const BIRDEYE_INTERVAL = Number(process.env.HOOD_BIRDEYE_INTERVAL_MS) || 30 * 60 * 1000

// ---- GMGN-style enrichment pulled from a DexScreener pair object ----
// Everything a player sees when picking a coin: chart pair, market cap, FDV,
// price changes across timeframes, buys/sells, website + socials.
const sane = (x) => { const n = Number(x) || 0; return n > 0 && n < 5e11 ? n : null } // DS occasionally reports 1000x-off caps
const extraFromPair = (p) => ({
  pairAddress: p.pairAddress || null,
  dexId: p.dexId || null,
  dexUrl: p.url || null,
  // Guarded: a pair without the timestamp must not null out an age another
  // source (GeckoTerminal pool_created_at) already supplied.
  ...(p.pairCreatedAt ? { ageHours: (Date.now() - p.pairCreatedAt) / 3.6e6 } : {}),
  marketCap: sane(p.marketCap),
  fdv: sane(p.fdv),
  priceChange: {
    m5: Number(p.priceChange?.m5 ?? NaN), h1: Number(p.priceChange?.h1 ?? NaN),
    h6: Number(p.priceChange?.h6 ?? NaN), h24: Number(p.priceChange?.h24 ?? NaN),
  },
  txns24: { buys: Number(p.txns?.h24?.buys) || 0, sells: Number(p.txns?.h24?.sells) || 0 },
  websites: (p.info?.websites || []).map((w) => w.url).filter(Boolean).slice(0, 3),
  socials: (p.info?.socials || []).map((s) => ({ type: s.type || s.platform || 'link', url: s.url || s.handle })).filter((s) => s.url).slice(0, 6),
})

// ---- house-solvency gating ----
// Live Arena is the only place the house has real money at risk: the treasury
// hedges every open battle by actually HOLDING the players' basket, and the
// winner is paid the combined FINAL VALUE of both portfolios (duel.js settle).
// So eligibility answers exactly one question - can the treasury get in and out
// at the size involved?
//   • can it sell at all?          honeypot / cannot-sell → hard no
//   • does tax eat the margin?     buy or sell tax > 10% → no
//   • is the pool deep enough?     liquidity vs stake → sets maxStake
//   • is the price a real price?   some genuine 24h turnover
//
// Everything a safety scan otherwise reports - LP unlocked, mint authority
// alive, coin is 20 minutes old, one wallet holds 90% - is RUG risk, and a rug
// is a price going to zero. The hedge holds the same token the player picked,
// so a rug drops both sides identically: the player loses their pick, the house
// loses nothing. That is exactly what would happen if they traded the coin on
// their own, so those checks no longer gate anything. They are still surfaced
// on the token card so the player chooses with open eyes.
const STAKE_TIERS = [10000, 7500, 5000, 3000, 2000, 1500, 1000, 750, 500, 300, 200, 150, 100, 50, 20, 10]
// Worst case a single token carries 2× the stake (both players nearly all-in on
// the same coin, netted into one treasury position). Live now settles IN KIND -
// the winner receives the coins themselves - so the treasury only ever crosses
// the spread ONCE, on the way in. At 100× the stake in pool depth that entry is
// ~2% of the book, costing ~2% of the position: still well inside the arena fee
// on the same battle. The figure was 150 when a round trip had to fit.
const LIQ_PER_STAKE = 100
const VOL_PER_STAKE = 25 // turnover proves the price is a market, not one wallet
const VOL_FLOOR = 2000
// Never below this, however young the coin: a real market, not one wallet.
const VOL_MIN = Number(process.env.HOOD_VOL_MIN) || 500
const MAX_TAX = 10
// Sell traffic no longer gates anything - see categorize() - but it is still the
// clearest evidence a player will be able to cash out, so it stays measured and
// shown on the card.
const MIN_SELLS_24H = 200
const MIN_SELL_RATIO = 0.25

// Largest stake tier this pool can absorb (0 = free battles only).
// Volume is trusted only up to 40× the pool's liquidity: clone-spam launches
// report $10M of wash "volume" against a $15k pool (a 670:1 ratio no real
// market sustains) to farm listings. The cap costs honest coins nothing -
// their turnover sits far below it - and stops fake activity from buying a
// verified badge.
// VOL_FLOOR is a 24-HOUR number, so applying it whole to a token that has
// existed for forty minutes asks it to prove something time has not allowed.
// On a chain minting ~22,000 tokens a day that parked every fresh launch in
// "free battles only" for its first day - precisely the window this arena is
// about. So the floor is pro-rated by the slice of a day the token has actually
// lived, with a hard minimum that still demands real money changed hands: a
// coin 40 minutes old must show VOL_MIN of turnover, not 3% of the full floor.
// Age unknown → treated as a full day, i.e. the strict old behaviour.
const proratedFloor = (ageHours) => {
  if (ageHours == null || !Number.isFinite(ageHours) || ageHours >= 24) return VOL_FLOOR
  return Math.max(VOL_MIN, VOL_FLOOR * (Math.max(0, ageHours) / 24))
}

export const stakeTierFor = (liq, vol, ageHours = null) => {
  const honest = Math.min(vol, liq * 40)
  const floor = proratedFloor(ageHours)
  return STAKE_TIERS.find((s) => liq >= LIQ_PER_STAKE * s && honest >= Math.max(floor, VOL_PER_STAKE * s)) || 0
}

// Did the chain itself demonstrate that sells go through? Independent of any
// scanner, and available on every chain DexScreener indexes.
export const exitObserved = (txns24) => {
  const sells = txns24?.sells ?? 0
  const buys = txns24?.buys ?? 0
  return sells >= MIN_SELLS_24H && sells >= MIN_SELL_RATIO * buys
}

// ---- pure categorisation (unit-tested) ----
//
// Live settles IN KIND: the treasury buys both baskets at the start and the
// winner takes the coins themselves. Nothing is ever sold to pay anyone - not on
// a win, not on a draw, not on a void - so the only thing the house is exposed
// to is the ENTRY. That collapses the criteria to what an entry actually costs:
//
//   can we buy it        → the venue probe answers this (venue.js)
//   what does the buy cost → buy tax, and pool depth for the size
//
// Everything else is the holder's risk, and it is theirs whether they trade here
// or anywhere else: a rug, a sell tax, an exit that dries up. Those are shown on
// the card, in full, and gate nothing.
export const categorize = (t, safety) => {
  const s = safety || {}
  const liq = t.liquidity || 0
  const vol = t.volume24 || 0
  const txns = (t.txns24?.buys || 0) + (t.txns24?.sells || 0)
  // Only the BUY side is the arena's cost now. A punitive sell tax is paid by
  // whoever sells - which is never the house.
  const highTax = (s.buyTax ?? 0) > MAX_TAX
  // A pool's numbers must hang together before any of them is believed.
  // Transactions cost gas - they are the one stat a spoofer can't print for
  // free - so serious claimed depth with almost no trading is a painted
  // backdrop, not a market: the "$1.1B XMR" pool doing 34 txns/day, the $59M
  // "WIF" doing 2. Painted pools never reach Verified, and their tier is
  // recomputed from the depth their own activity actually vouches for.
  const spoofy = liq > 250_000 && liq > txns * 25_000
  const maxStake = stakeTierFor(spoofy ? Math.min(liq, txns * 3000) : liq, vol, t.ageHours)

  // A honeypot's price is not a market price - nobody can sell into it, so it
  // only ever prints up. That is not a rug the player chose, it is a rigged
  // quote that would break Classic too. Only these two stay hard blocks.
  if (s.honeypot === true || s.sellable === false) {
    return { category: 'ineligible', maxStake: 0, spoofy }
  }
  // Still on a launchpad bonding curve: one wallet can walk the price up the
  // formula, so it plays free battles only until it graduates to a real pool.
  if (t.onCurve) return { category: 'fresh', maxStake: 0, spoofy }
  // Live-eligible: the entry is affordable, the pool can carry the size, and
  // the stats are coherent enough to trust.
  if (!highTax && maxStake > 0 && !spoofy) {
    return { category: 'verified', maxStake, spoofy }
  }
  // Classic-only: real trades never happen here, so the house cannot go minus
  // whatever the coin does. Depth still sets the ceiling to keep a thin pool
  // from being pumped against the OTHER player.
  if (maxStake > 0) {
    return { category: 'degen', maxStake, spoofy }
  }
  return { category: 'fresh', maxStake: 0, spoofy }
}

const blurbFor = (cat, chain, venueBlocked = false, curve = false) => (curve && cat === 'fresh'
  ? `Still on its launchpad bonding curve on ${chain} - one buyer can walk that price up a formula, so it plays free battles only until it graduates to a real pool.`
  : {
  verified: `The arena can buy this on ${chain} at your stake size without moving the price, and the buy tax is sane. Live Arena ready - win and you receive the coins themselves. That is NOT a promise the coin won't rug or that you'll be able to sell it later: those are yours, exactly as they would be trading it anywhere else.`,
  degen: venueBlocked
    ? `The arena's treasury has no way to buy it on ${chain}, so it can't stock a Live battle with it. Classic Arena only until that chain is wired up.`
    : `Tradeable, but the pool is too thin to buy your stake into without moving the price, or the buy tax is punitive. Classic Arena only - nothing is bought there, so the depth stops mattering.`,
  fresh: `Freshly migrated on ${chain} - pool still too thin to price a battle honestly. Free battles until it fills out.`,
  ineligible: `Can't be sold (honeypot or sell-blocked), so its price isn't a real market price. Not eligible in any arena.`,
}[cat])

// ---- GeckoTerminal discovery (paginated + throttled) ----
const discoverGecko = async (gtNet, fetchJson) => {
  const out = new Map()
  const real = fetchJson === defaultFetchJson
  for (const [ep, pages] of GT_ENDPOINTS) {
    for (let page = 1; page <= pages; page++) {
      if (real) await sleep(700) // stay well under GeckoTerminal's ~30 req/min
      let body
      try { body = await fetchJson(`${GT}/networks/${gtNet}/${ep}?include=base_token&page=${page}`) } catch { break }
      const rows = body?.data || []
      if (!rows.length) break // ran out of pages (or rate-limited) → stop this endpoint
      const included = new Map((body.included || []).map((i) => [i.id, i]))
      for (const pool of rows) {
        const a = pool.attributes || {}
        const tok = included.get(pool.relationships?.base_token?.data?.id)
        if (!tok) continue
        const ta = tok.attributes || {}
        const liquidity = Number(a.reserve_in_usd) || 0
        const price = Number(a.base_token_price_usd) || 0
        if (!ta.address || !ta.symbol || liquidity < MIN_LIQ || !(price > 0)) continue
        const raw = {
          address: ta.address, symbol: String(ta.symbol).trim(), name: ta.name || ta.symbol,
          img: ta.image_url && ta.image_url !== 'missing.png' ? ta.image_url : null,
          price, liquidity, volume24: Number(a.volume_usd?.h24) || 0,
          change24: a.price_change_percentage?.h24 != null ? Number(a.price_change_percentage.h24) : null,
          pairAddress: a.address || null, // GT pool address (fallback chart pair)
          ageHours: a.pool_created_at ? (Date.now() - Date.parse(a.pool_created_at)) / 3.6e6 : null, // unknown is unknown, never a fake "1.1y"
          src: 'gt', srcChain: gtNet,
        }
        const prev = out.get(ta.address)
        if (!prev || raw.liquidity > prev.liquidity) out.set(ta.address, raw)
      }
    }
  }
  return out
}

// ---- Birdeye discovery (keyed; the path to GMGN-scale) ----
// Volume-ranked Solana token list, paginated. Free tier ~1 rps, limit 50/page.
const discoverBirdeye = async (chain, fetchJson) => {
  const out = new Map()
  if (!BIRDEYE_KEY || !chain) return out
  const real = fetchJson === defaultFetchJson
  const headers = { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': chain, accept: 'application/json' }
  for (let page = 0; page < BIRDEYE_PAGES; page++) {
    if (real) await sleep(1100) // respect the free tier's ~1 req/sec (60 rpm)
    let body
    try { body = await fetchJson(`${BE}/defi/tokenlist?sort_by=v24hUSD&sort_type=desc&offset=${page * 50}&limit=50`, { headers }) } catch { break }
    const toks = body?.data?.tokens || body?.data?.items || []
    if (!toks.length) break
    for (const t of toks) {
      const liquidity = Number(t.liquidity) || 0
      // price is filled from DexScreener during enrichment if Birdeye omits it
      const price = Number(t.price ?? t.priceUsd) || 0
      if (!t.address || !t.symbol || liquidity < MIN_LIQ) continue
      const raw = {
        address: t.address, symbol: String(t.symbol).trim(), name: t.name || t.symbol,
        img: t.logoURI || null, price, liquidity, volume24: Number(t.v24hUSD) || 0,
        change24: t.v24hChangePercent != null ? Number(t.v24hChangePercent) : null,
        marketCap: Number(t.mc) || null, ageHours: null, src: 'be', srcChain: chain,
      }
      const prev = out.get(t.address)
      if (!prev || raw.liquidity > prev.liquidity) out.set(t.address, raw)
    }
  }
  return out
}

// ---- Jupiter discovery (Solana, keyless) ----
//
// Birdeye was Solana's scale lever and its compute-unit budget runs out, at
// which point `/defi/tokenlist` answers 400 and the pool silently starves -
// which is exactly what happened: 72 tokens, of which GeckoTerminal (429ing
// after a page on the free tier) supplied 41.
//
// Jupiter publishes the same universe with no key at all, and richer: every row
// carries the real logo, holder count, 24h buy/sell COUNTS, age, market cap and
// per-window price changes. Thirteen calls across its category feeds union to
// ~380 distinct tokens, 99% of them with a picture. It is the aggregator every
// Solana route already goes through, so its book is the tradable book.
const JUP = 'https://lite-api.jup.ag/tokens/v2'
const JUP_FEEDS = [
  'toptraded/5m', 'toptraded/1h', 'toptraded/6h', 'toptraded/24h',
  'toporganicscore/5m', 'toporganicscore/1h', 'toporganicscore/6h', 'toporganicscore/24h',
  'toptrending/5m', 'toptrending/1h', 'toptrending/6h', 'toptrending/24h',
  'recent',
]
// The feeds above are 100 rows each and only ever show what is hot RIGHT NOW,
// so on their own a coin that had a quiet afternoon fell out of the arena. The
// verified list is Jupiter's whole vetted universe (~3,500 rows, ~5 MB) - every
// established memecoin is in it whatever the hour. It barely changes, so it is
// fetched on its own slower clock and reused between cycles.
const JUP_VERIFIED_MS = Number(process.env.HOOD_JUP_VERIFIED_MS) || 15 * 60 * 1000
const jupVerified = { at: 0, rows: [] }
// What a fast-listing pass asks for: the newest coins and what just started
// moving. Three small calls, every FAST_LIST_MS.
const JUP_FAST_FEEDS = ['recent', 'toptrending/5m', 'toptraded/5m']
// Address lookups (100 mints each) spent per cycle keeping the existing book
// alive - see ingestOnce.
const JUP_KEEP_REQ_CAP = Number(process.env.HOOD_JUP_KEEP_REQ_CAP) || 20
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : NaN)
// This pool is "Solana Memes". Jupiter labels what a token IS, so use its own
// classification rather than guessing from names: yield-bearing wrappers and
// liquid-staking receipts (JLUSDC, JUPSOL) barely move by construction,
// tokenised equities (xStocks, Ondo, pre-IPO) track a stock market, and
// protocol tokens (`defi`, `infra`, `major` - JUP, RAY, the chain's own
// plumbing) are not memecoins. All of them would rank near the top on depth ×
// turnover and none of them is this battle.
// `stable` is the important one: a dollar token's return is ~0 by design, so
// three of them is a portfolio that cannot lose - a way to grief a battle, not
// a pick.
const JUP_EXCLUDE_TAGS = new Set([
  'stable', 'yb', 'yield', 'lst', 'original-lst', 'jup-lend-earn',
  'stocks', 'equities', 'xstocks', 'prestocks', 'pre-ipo', 'rwa', 'ondo', 'tessera', 'commodities',
  'defi', 'infra', 'major', 'internal', 'deprecated', 'duplicate',
])

// A launchpad coin that has not graduated is still on its bonding curve: its
// "pool" is a formula a single buyer can walk up. The owner's rule from the
// first listing pass stands - migrated coins play, the curve plays free
// battles only - so this is carried on the record and categorize() reads it.
//
// Not every launchpad reports its graduation (a $800k stonkfun coin and a
// $1.5M metadao coin carry no graduation record), while every coin measured
// genuinely on a pump.fun curve sat under $15k of depth - a curve graduates
// long before it could hold more. So no record AND a curve-sized book.
const CURVE_MAX_LIQ = 50_000
const onCurve = (t) => !!t.launchpad && !t.graduatedPool && !t.graduatedAt && (Number(t.liquidity) || 0) < CURVE_MAX_LIQ

const jupRaw = (t) => {
  const liquidity = Number(t.liquidity) || 0
  const price = Number(t.usdPrice) || 0
  if (!t.id || !t.symbol || liquidity < MIN_LIQ || !(price > 0)) return null
  if ((t.tags || []).some((g) => JUP_EXCLUDE_TAGS.has(String(g).toLowerCase()))) return null
  const s24 = t.stats24h || {}
  const created = t.firstPool?.createdAt || t.createdAt
  const socials = []
  if (t.twitter) socials.push({ type: 'twitter', url: t.twitter })
  if (t.telegram) socials.push({ type: 'telegram', url: t.telegram })
  if (t.discord) socials.push({ type: 'discord', url: t.discord })
  return {
    address: t.id, symbol: String(t.symbol).trim(), name: t.name || t.symbol,
    img: t.icon || null,
    price, liquidity,
    volume24: (Number(s24.buyVolume) || 0) + (Number(s24.sellVolume) || 0),
    change24: Number.isFinite(Number(s24.priceChange)) ? Number(s24.priceChange) : null,
    txns24: { buys: Number(s24.numBuys) || 0, sells: Number(s24.numSells) || 0 },
    priceChange: {
      m5: num(t.stats5m?.priceChange), h1: num(t.stats1h?.priceChange),
      h6: num(t.stats6h?.priceChange), h24: num(s24.priceChange),
    },
    marketCap: sane(t.mcap), fdv: sane(t.fdv),
    holders: Number(t.holderCount) || null,
    top10Pct: Number.isFinite(Number(t.audit?.topHoldersPercentage)) ? Number(t.audit.topHoldersPercentage) : null,
    ...(created ? { ageHours: (Date.now() - Date.parse(created)) / 3.6e6 } : {}),
    websites: t.website ? [t.website] : [],
    socials,
    launchpad: t.launchpad || null,
    onCurve: onCurve(t),
    // Jupiter's own audit block: a live mint or freeze authority is a rug
    // SIGNAL the card shows; it gates nothing, exactly like the GoPlus
    // equivalent. Freeze is the Solana form of "the dev can stop your sell".
    mintable: t.audit?.mintAuthorityDisabled === false ? true : undefined,
    freezable: t.audit?.freezeAuthorityDisabled === false ? true : undefined,
    src: 'jup', srcChain: 'solana',
  }
}

const discoverJupiter = async (fetchJson, feeds = JUP_FEEDS, { withVerified = true } = {}) => {
  const out = new Map()
  const add = (t) => {
    const raw = jupRaw(t)
    if (!raw) return
    const prev = out.get(raw.address)
    if (!prev || raw.liquidity > prev.liquidity) out.set(raw.address, raw)
  }
  for (const feed of feeds) {
    let rows
    try { rows = await fetchJson(`${JUP}/${feed}${feed === 'recent' ? '' : '?limit=100'}`) } catch { continue }
    for (const t of Array.isArray(rows) ? rows : []) add(t)
  }
  if (withVerified) {
    if (Date.now() - jupVerified.at > JUP_VERIFIED_MS) {
      try {
        const rows = await fetchJson(`${JUP}/tag?query=verified`, { signal: AbortSignal.timeout(30000) })
        if (Array.isArray(rows) && rows.length) { jupVerified.rows = rows; jupVerified.at = Date.now() }
      } catch (e) { state.errors.push(`jup/verified: ${String(e.message).slice(0, 60)}`) }
    }
    for (const t of jupVerified.rows) add(t)
  }
  return out
}

// ---- DexScreener discovery ----
// The profile + boost lists are global; fetch once and index addresses by chain.
const dexAddressLists = async (fetchJson) => {
  const byChain = {}
  for (const u of ['/token-profiles/latest/v1', '/token-boosts/latest/v1', '/token-boosts/top/v1']) {
    let arr
    try { arr = await fetchJson(DS + u) } catch { continue }
    for (const it of Array.isArray(arr) ? arr : []) {
      if (!it.chainId || !it.tokenAddress) continue
      const m = byChain[it.chainId] || (byChain[it.chainId] = new Map())
      // Keyed like every other address map here, so a vendor that ever returns
      // a different case from its profile list than from /tokens/v1 cannot
      // silently empty this lane. (Same bug class as the enrichment match.)
      if (!m.has(addrKey(it.tokenAddress))) m.set(addrKey(it.tokenAddress), it.icon || null)
    }
  }
  return byChain
}

const discoverDex = async (dsChain, addrMap, fetchJson) => {
  const out = new Map()
  const addrs = [...(addrMap?.keys() || [])]
  for (let i = 0; i < addrs.length; i += 30) {
    const batch = addrs.slice(i, i + 30)
    let pairs
    try { pairs = await fetchJson(`${DS}/tokens/v1/${dsChain}/${batch.join(',')}`) } catch { continue }
    for (const p of Array.isArray(pairs) ? pairs : (pairs?.pairs || [])) {
      const bt = p.baseToken
      if (!bt?.address || !addrMap.has(addrKey(bt.address))) continue
      const liquidity = Number(p.liquidity?.usd) || 0
      const price = Number(p.priceUsd) || 0
      if (liquidity < MIN_LIQ || !(price > 0)) continue
      const raw = {
        address: bt.address, symbol: String(bt.symbol || '').trim(), name: bt.name || bt.symbol,
        img: p.info?.imageUrl || addrMap.get(addrKey(bt.address)) || null,
        price, liquidity, volume24: Number(p.volume?.h24) || 0,
        change24: p.priceChange?.h24 != null ? Number(p.priceChange.h24) : null,
        src: 'ds', srcChain: dsChain,
        ...extraFromPair(p),
      }
      const prev = out.get(bt.address)
      if (!prev || raw.liquidity > prev.liquidity) out.set(bt.address, raw)
    }
  }
  return out
}

// ---- safety (GoPlus) ----
const safetyCache = new Map()
const SAFE_TTL = 60 * 60 * 1000

// GoPlus reports Solana in its own vocabulary: no honeypot flag, but the
// token program's switches, which are what can actually stop a sell. A
// non-transferable mint, or one whose accounts start FROZEN, cannot be sold by
// anyone - that is the honeypot here. A token-2022 transfer fee is the tax,
// charged on every move in either direction. Freeze authority and transfer
// hooks CAN stop a sell but need the dev to act, so they are shown, not gated.
const solFeePct = (tf) => {
  const cur = tf?.current_fee_rate || tf?.currentFeeRate || null
  const x = Number(cur?.fee_rate ?? cur?.feeRate ?? cur?.transfer_fee_basis_points ?? NaN)
  if (!Number.isFinite(x) || x <= 0) return 0
  if (x <= 1) return x * 100   // a fraction
  if (x <= 100) return x       // already a percent
  return x / 100               // basis points
}

const parseGoplusSolana = (raw) => {
  const on = (x) => String(x?.status ?? x) === '1'
  const holderList = raw.holders || []
  const p = holderList.length ? Number(holderList[0].percent) : NaN
  const fee = solFeePct(raw.transfer_fee)
  const cannotSell = String(raw.non_transferable) === '1' || String(raw.default_account_state) === '2'
  return {
    checked: true,
    honeypot: cannotSell,
    sellable: !cannotSell,
    mintable: on(raw.mintable),
    freezable: on(raw.freezable),
    transferHook: Array.isArray(raw.transfer_hook) && raw.transfer_hook.length > 0,
    lpLocked: false,
    buyTax: fee,
    sellTax: fee,
    holderCount: raw.holder_count != null && raw.holder_count !== '' ? Number(raw.holder_count) : null,
    // Solana percents arrive as percents already ("0.0883" is 0.0883%).
    topHolderPct: Number.isFinite(p) ? p : null,
  }
}

const parseGoplus = (raw, isSolana) => {
  if (!raw) return { checked: false }
  if (isSolana) return parseGoplusSolana(raw)
  const num = (x) => (x == null || x === '' ? null : Number(x))
  const lpHolders = raw.lp_holders || raw.lpHolders || []
  const lpLocked = Array.isArray(lpHolders) && lpHolders.length
    ? lpHolders.some((h) => Number(h.is_locked) === 1 || h.locked_detail?.length)
    : (raw.lp_total_supply != null ? false : null)
  // holder distribution - GoPlus returns holder_count + a holders[] list whose
  // first entry is the biggest wallet (percent is a fraction on EVM, sometimes
  // already a percent; normalise defensively).
  const holderList = raw.holders || raw.holder_list || []
  const holderCount = num(raw.holder_count)
  let topHolderPct = null
  if (Array.isArray(holderList) && holderList.length) {
    const p = num(holderList[0].percent ?? holderList[0].pct)
    if (p != null) topHolderPct = p <= 1 ? p * 100 : p
  }
  return {
    checked: true,
    honeypot: raw.is_honeypot != null ? Number(raw.is_honeypot) === 1 : (raw.honeypot != null ? !!raw.honeypot : false),
    sellable: raw.cannot_sell_all != null ? Number(raw.cannot_sell_all) === 0 : true,
    mintable: raw.is_mintable != null ? Number(raw.is_mintable) === 1 : (raw.mintable?.status === '1'),
    lpLocked: lpLocked === null ? false : lpLocked,
    buyTax: num(raw.buy_tax) != null ? num(raw.buy_tax) * (isSolana ? 1 : 100) : 0,
    sellTax: num(raw.sell_tax) != null ? num(raw.sell_tax) * (isSolana ? 1 : 100) : 0,
    holderCount, topHolderPct,
  }
}

const safetyCached = (address) => {
  const c = safetyCache.get(address)
  return c && Date.now() - c.at < SAFE_TTL ? c.safety : null
}

const checkSafety = async (goplus, address, fetchJson) => {
  // Chain not scannable → every safety field stays undefined. That is "unknown",
  // not "unsafe": the hard blocks below need a POSITIVE honeypot/sell-blocked
  // finding, so these coins are still judged Verified on chain evidence (depth,
  // coherent stats, observed sells) and still play Live.
  if (!goplus) return { checked: false }
  const cached = safetyCached(address)
  if (cached) return cached
  let safety = { checked: false }
  if (fetchJson === defaultFetchJson) await sleep(250) // GoPlus free tier rate limit
  try {
    const url = goplus === 'solana'
      ? `${'https://api.gopluslabs.io/api/v1'}/solana/token_security?contract_addresses=${address}`
      : `${'https://api.gopluslabs.io/api/v1'}/token_security/${goplus}?contract_addresses=${address}`
    const body = await fetchJson(url)
    const result = body?.result || {}
    const raw = result[address] || result[address.toLowerCase()] || Object.values(result)[0]
    if (raw) safety = parseGoplus(raw, goplus === 'solana')
  } catch { /* unknown → conservative */ }
  // Only cache SUCCESSFUL scans - a rate-limited failure must be retried next
  // cycle, not remembered as "unknown" for an hour.
  if (safety.checked) safetyCache.set(address, { at: Date.now(), safety })
  return safety
}

// ---- static curated tokens: resolve their real DEX identity ----
// The curated Solana memes (WIF, BONK, PENGU…) get the same GMGN-style card as
// the ingested ones - address, chart pair, mcap, website, socials - found via
// DexScreener search on Solana. Activity-gated match (real volume + trades) so
// a copycat can never hijack the card. Display-only: settlement prices for
// these stay on Pyth/CoinGecko - DexScreener never feeds a curated token's price.
const staticPairCache = new Map() // id -> { chainId, address }
// No curated tokens remain (TOKENS is empty), so nothing maps here any more -
// enrichStatics() is a no-op until a curated pool ever returns.
const STATIC_CHAINS = {}
// GoPlus chain param by DexScreener chain id.
const GOPLUS_CHAIN = { solana: 'solana' }

const normSym = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '') // '$WIF' → 'WIF'

const enrichStatics = async (fetchJson) => {
  for (const tok of TOKENS) {
    const chains = STATIC_CHAINS[tok.pool]
    if (!chains) continue
    try {
      let ref = staticPairCache.get(tok.id)
      if (!ref) {
        // ticker search first, full-name second - junk pairs can crowd out the
        // real pool in ticker results (e.g. "WIF" is buried, "dogwifhat" isn't).
        // Liquidity alone is spoofable (we caught a fake $59M "WIF" pool doing 2
        // trades/day) - demand real trading activity, rank by liquidity.
        let best = null
        for (const q of [tok.ticker, tok.name]) {
          const body = await fetchJson(`${DS}/latest/dex/search?q=${encodeURIComponent(q)}`)
          const pairs = (body?.pairs || []).filter((p) =>
            chains.includes(p.chainId) &&
            normSym(p.baseToken?.symbol) === tok.ticker &&
            (p.liquidity?.usd || 0) >= 5e5 &&
            (p.volume?.h24 || 0) >= 2e4 &&
            ((p.txns?.h24?.buys || 0) + (p.txns?.h24?.sells || 0)) >= 25)
          if (pairs.length) { best = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0]; break }
        }
        if (!best) continue
        ref = { chainId: best.chainId, address: best.baseToken.address }
        staticPairCache.set(tok.id, ref)
        setStaticExtra(tok.id, {
          address: best.baseToken.address, srcChain: best.chainId,
          ...(best.info?.imageUrl ? { img: best.info.imageUrl } : {}),
          liquidity: Number(best.liquidity?.usd) || tok.liquidity,
          volume24: Number(best.volume?.h24) || tok.volume24,
          ...extraFromPair(best),
        })
      }
      // Holders + taxes via GoPlus on the resolved real address - retried each
      // cycle until it succeeds (GoPlus rate-limits; checkSafety caches wins 1h).
      const cur = staticExtraFor(tok.id) || {}
      const gp = GOPLUS_CHAIN[ref.chainId]
      if (cur.holders == null && gp) {
        const s = await checkSafety(gp, ref.address, fetchJson)
        if (s.checked) setStaticExtra(tok.id, { ...cur, holders: s.holderCount ?? null, topHolderPct: s.topHolderPct ?? null, buyTax: s.buyTax ?? 0, sellTax: s.sellTax ?? 0 })
      }
    } catch { /* next ingest run retries */ }
  }
}

// ---- the coin's picture, made loadable ----
// Solana metadata points its image wherever the deployer liked. Most of the
// book points at an IPFS gateway, and the Protocol Labs ones (ipfs.io,
// dweb.link, w3s.link, nftstorage.link) answer 429 as soon as one browser
// asks for a page of logos - measured: the whole Tokens page lost half its
// pictures. Every IPFS form is rewritten to one gateway that serves the burst
// (HOOD_IPFS_GATEWAY); anything that is not http(s) - one coin's "image" was a
// file path on its deployer's laptop - is no picture, and the card shows its
// monogram. Never a generated stand-in.
const IPFS_GATEWAY = (process.env.HOOD_IPFS_GATEWAY || 'https://ipfs.filebase.io/ipfs/').replace(/\/?$/, '/')
const IPFS_PATH = /^https?:\/\/[^/]+\/ipfs\/(.+)$/i
const IPFS_SUBDOMAIN = /^https?:\/\/([a-z0-9]{46,})\.ipfs\.[^/]+(\/.*)?$/i
export const cleanImg = (u) => {
  if (!u || typeof u !== 'string') return null
  const s = u.trim()
  if (/^ipfs:\/\//i.test(s)) return IPFS_GATEWAY + s.replace(/^ipfs:\/\/(ipfs\/)?/i, '')
  let m = s.match(IPFS_SUBDOMAIN)
  if (m) return IPFS_GATEWAY + m[1] + (m[2] || '')
  m = s.match(IPFS_PATH)
  if (m && !s.startsWith(IPFS_GATEWAY)) return IPFS_GATEWAY + m[1]
  return /^https?:\/\//i.test(s) ? s.replace(/^https?/i, (p) => p.toLowerCase()) : null
}

// Grade one raw discovery record into a full arena token. Shared by the ingest
// cycle and the firehose fast-list path so a token is identical whichever door
// it came in through. `category: 'ineligible'` returns record: null.
const buildDynToken = (r, safety = { checked: false }) => {
  const graded = categorize(r, safety)
  const maxStake = graded.maxStake
  // Last gate, and the one that can't be argued with: if the treasury has no
  // venue to buy and sell this token, its Live hedge would be a paper entry
  // against a real payout. Drop it to Classic, where the house holds nothing.
  const category = graded.category === 'verified' &&
    !venueCanTrade({ id: r.id, pool: r.chain, address: r.address, srcChain: r.srcChain })
    ? 'degen' : graded.category
  if (category === 'ineligible') return { category, record: null }
  return {
    category,
    record: {
      id: r.id, address: r.address, chain: r.chain, dynamic: true, src: r.src, srcChain: r.srcChain,
      ticker: r.ticker || r.id, name: r.name, img: cleanImg(r.img), glyph: (r.ticker || r.id).slice(0, 2), color: colorFor(r.address),
      base: r.price, vol: r.liquidity < THIN_LIQ ? 'insane' : 'high',
      pool: r.chain, category, maxStake,
      liquidity: r.liquidity, volume24: r.volume24, ageHours: r.ageHours == null ? null : Math.round(r.ageHours),
      // GoPlus first (it also knows the top-holder split), then whatever the
      // discovery source reported - Jupiter ships a holder count for every row.
      holders: safety.holderCount ?? r.holders ?? null, topHolderPct: safety.topHolderPct ?? null,
      top10Pct: r.top10Pct ?? null,
      buyTax: safety.checked ? (safety.buyTax ?? 0) : null, sellTax: safety.checked ? (safety.sellTax ?? 0) : null,
      pairAddress: r.pairAddress || null, dexId: r.dexId || null, dexUrl: r.dexUrl || null,
      marketCap: r.marketCap || null, fdv: r.fdv || null, change24: r.change24 ?? null,
      priceChange: r.priceChange || null, txns24: r.txns24 || null,
      websites: r.websites || [], socials: r.socials || [],
      launchpad: r.launchpad || null, ...(r.onCurve ? { onCurve: true } : {}),
      blurb: blurbFor(category, CHAIN_NAME[r.chain] || 'this chain', graded.category === 'verified' && category === 'degen', !!r.onCurve),
      // Two groups. The first three are what the ARENA needs to be true to
      // stock a Live battle - it buys, it never sells. Everything after that
      // is the HOLDER's risk: whether they can get back out, whether the thing
      // rugs. Those gate nothing and are shown so the player judges the coin
      // themselves, exactly as they would on any screener before buying it.
      safety: {
        tradable: safety.sellable !== false, honeypot: safety.honeypot === true,
        buyTaxOk: (safety.buyTax ?? 0) <= MAX_TAX,
        liquidityOk: maxStake > 0,
        exitObserved: exitObserved(r.txns24), sellTaxOk: (safety.sellTax ?? 0) <= MAX_TAX,
        migrated: !r.onCurve,
        // Solana's version of a sell-blocking function is the freeze
        // authority (the dev can freeze your token account) or a transfer
        // hook that can refuse the transfer.
        sellNotBlockable: safety.sellable !== false
          && (safety.checked ? safety.freezable !== true && !safety.transferHook : r.freezable !== true),
        // Jupiter's audit answers this for every Solana row; GoPlus, when it
        // ran, wins because it also covers the chains Jupiter doesn't.
        mintLocked: safety.checked ? safety.mintable !== true : r.mintable !== true,
        lpLocked: safety.lpLocked === true,
        holdersOk: (safety.topHolderPct == null || safety.topHolderPct < 50) && (r.top10Pct == null || r.top10Pct < 80),
        manipulationLow: r.liquidity >= THIN_LIQ, historyOk: r.ageHours == null || r.ageHours >= 24,
        statsCoherent: !graded.spoofy, // claimed depth backed by real activity
      },
    },
  }
}

// ---- one ingest cycle ----
export const ingestOnce = async ({ fetchJson = defaultFetchJson, withSafety = true } = {}) => {
  const all = []
  const byCat = { verified: 0, degen: 0, fresh: 0, ineligible: 0 }
  const bySource = { be: 0, gt: 0, ds: 0, ci: 0, jup: 0, fh: 0 }
  let dexLists = {}
  if (NETWORKS.some((n) => n.ds)) { try { dexLists = await dexAddressLists(fetchJson) } catch { /* both sources are optional */ } }

  // Birdeye discovery is compute-unit-metered → refresh the token set only every
  // BIRDEYE_INTERVAL; between refreshes we reuse the cached set (its prices/stats
  // still update every cycle off DexScreener below).
  const refreshBE = BIRDEYE_KEY && (Date.now() - beCache.at > BIRDEYE_INTERVAL)
  let scanBudget = GOPLUS_MAX_NEW // new (uncached) safety scans allowed this cycle

  for (const net of NETWORKS) {
    const merged = new Map()
    // EVM addresses arrive in mixed checksum case from different sources; the
    // same token must not enter the merge twice. Solana addresses are base58
    // and case-SENSITIVE - never lowercase those.
    const norm = (a) => addrKey(a)
    const add = (a, r) => { const k = norm(a); if (!merged.has(k) || r.liquidity > merged.get(k).liquidity) merged.set(k, r) }
    if (net.be) {
      if (refreshBE) { try { beCache.byNet[net.be] = await discoverBirdeye(net.be, fetchJson) } catch (e) { state.errors.push(`be/${net.be}: ${e.message}`) } }
      for (const [a, r] of (beCache.byNet[net.be] || new Map())) add(a, r)
    }
    if (net.jup) { try { for (const [a, r] of await discoverJupiter(fetchJson)) add(a, r) } catch (e) { state.errors.push(`jup: ${e.message}`) } }
    if (net.gt) { try { for (const [a, r] of await discoverGecko(net.gt, fetchJson)) add(a, r) } catch (e) { state.errors.push(`gt/${net.gt}: ${e.message}`) } }
    if (net.ds) { try { for (const [a, r] of await discoverDex(net.ds, dexLists[net.ds] || new Map(), fetchJson)) add(a, r) } catch (e) { state.errors.push(`ds/${net.ds}: ${e.message}`) } }
    // Keep what the book already has. Jupiter's activity feeds only show what is
    // hot this minute and the newest-coins feed is thirty rows deep, so a coin
    // fast-listed ten minutes ago, or one having a quiet hour, is in none of
    // them by the next cycle - and the book would silently drop it. Everything
    // the book is serving that this cycle did not rediscover is asked about by
    // address instead, and stays only if it still clears the same floors.
    if (net.jup) {
      const missing = dynamicTokens()
        .filter((t) => t.pool === net.pool && t.address && !merged.has(norm(t.address)))
        .map((t) => t.address)
      let asked = 0
      for (let i = 0; i < missing.length && asked < JUP_KEEP_REQ_CAP; i += 100, asked++) {
        try {
          const rows = await fetchJson(`${JUP}/search?query=${missing.slice(i, i + 100).join(',')}`)
          for (const t of Array.isArray(rows) ? rows : []) { const r = jupRaw(t); if (r) add(r.address, r) }
        } catch (e) { state.errors.push(`jup/keep: ${String(e.message).slice(0, 60)}`) }
      }
    }

    // Rank by DEPTH × TURNOVER together - see marketScore in engine/tokens.js
    // for why either alone puts the wrong coins on top. Trades still gate
    // presence (a pool nobody bought is not a market) but they do not set the
    // order, or the book fills with dust that bots churn.
    const trades = (r) => (r.txns24?.buys || 0) + (r.txns24?.sells || 0)
    const byActivity = (x, y) => marketScore(y) - marketScore(x) || trades(y) - trades(x)

    // sanitise ticker, drop excluded, rank by market score, cap at the best PER_POOL.
    //
    // Ticker collisions cut both ways and this is the balance point. Dropping
    // every duplicate deleted real coins; keeping every duplicate filled the
    // Robinhood pool with launchpad clone farms - fifty-one coins called "BOP",
    // each seeded with the same ~$2.6k, all displayed to the player as simply
    // "BOP". A battle where both players "picked BOP" and got different coins
    // is not a selection, it is a coin flip with extra steps.
    //
    // So: `raws` is ranked by market score, and a ticker's FIRST (strongest)
    // coin keeps the clean id. A later coin with the same ticker survives only
    // if it stands on its own depth (DUP_MIN_LIQ) - that keeps the genuine
    // second FRANK or CATE and kills the farm. A ticker belonging to a curated
    // token is exclusive: nothing ingested may wear "PENGU" but PENGU.
    // Two separate ledgers on purpose. `seenBase` is about the NAME (has this
    // ticker already been listed this cycle?), `seenId` is about IDENTITY (is
    // this id already spoken for this cycle?). Conflating them meant a stronger
    // clone, processed first, marked the base name as seen and thereby evicted
    // the very coin that permanently owns that id.
    const seenBase = new Set()
    const seenId = new Set()
    const raws = [...merged.values()]
      // A pool nobody has traded is not a market, it is a deployment. Sources
      // that report trades must show some; sources that don't (gt/be) are
      // pre-filtered by their own ranking and pass through.
      .filter((r) => !r.txns24 || trades(r) >= MIN_TRADES_24H)
      .sort(byActivity)
      .filter((r) => {
        const base = String(r.symbol).toUpperCase().replace(/[^A-Z0-9]/g, '')
        if (!base || base.length > 12 || EXCLUDE.has(base)) return false
        if (tokenById(base)) return false // a curated coin owns this ticker outright
        // A contract that already has an identity keeps its place - it earned
        // it once, and dropping it now would orphan anything holding it.
        const already = pinnedIdFor(net.pool, r.address)
        // Only a NEWCOMER to an already-listed ticker has to prove itself, and
        // that bar is what stops launchpad clone farms.
        if (!already && seenBase.has(base) && (r.liquidity || 0) < DUP_MIN_LIQ) return false
        const id = already || claimTokenId(net.pool, r.address, base)
        if (!id || seenId.has(id)) return false
        seenBase.add(base); seenId.add(id); r.id = id; r.ticker = base; r.chain = net.pool
        return true
      })
      .slice(0, PER_POOL)

    // GeckoTerminal/Birdeye tokens: pull the DexScreener view of the same
    // address so they too carry socials / mcap / txns / a proper chart pair + age.
    // What only the vendor has - the picture, the socials, the chart pair - and
    // none of it changes after a coin is listed. Asking about the WHOLE book
    // every cycle was 40 back-to-back requests on top of the 7-second price
    // sweep, and the vendor rejected the burst wholesale: measured 40 of 40
    // batches failing, silently, which is what blanked cards that were fine a
    // minute earlier. So the sweep now asks only about tokens that are NEW or
    // still have no picture, capped and paced. A warm book needs a handful of
    // requests; a cold one fills in over a few cycles instead of being refused.
    if (net.ds) {
      const known = new Map(dynamicTokens().map((t) => [t.id, t]))
      const need = raws.filter((r) => r.src !== 'ds' && (!known.has(r.id) || !known.get(r.id).img))
      const real = fetchJson === defaultFetchJson
      let enrichFails = 0
      for (let i = 0; i < Math.min(need.length, ENRICH_REQ_CAP * 30); i += 30) {
        const batch = need.slice(i, i + 30)
        if (real && i) await sleep(ENRICH_GAP_MS) // pace the burst the vendor refused
        try {
          const pairs = await fetchJson(`${DS}/tokens/v1/${net.ds}/${batch.map((r) => r.address).join(',')}`)
          const best = {}
          for (const p of Array.isArray(pairs) ? pairs : []) {
            const a = addrKey(p.baseToken?.address)
            if (a && (!best[a] || (p.liquidity?.usd || 0) > (best[a].liquidity?.usd || 0))) best[a] = p
          }
          for (const r of batch) {
            const p = best[addrKey(r.address)]
            if (!p) continue
            // Enrichment FILLS, it does not overwrite. A DexScreener pair is one
            // pool; Jupiter's row is the whole token (all pools' trades, holder
            // count, aggregate mcap). Blindly assigning the pair over it traded
            // a better number for a narrower one - the chart pair and socials
            // are the parts only DexScreener has.
            const extra = extraFromPair(p)
            for (const [k, v] of Object.entries(extra)) {
              const empty = r[k] == null
                || (k === 'txns24' && !((r.txns24?.buys || 0) + (r.txns24?.sells || 0)))
                || (Array.isArray(r[k]) && !r[k].length)
                || (k === 'priceChange' && !Object.values(r[k] || {}).some(Number.isFinite))
              if (empty && v != null) r[k] = v
            }
            r.srcChain = net.ds
            if (!r.img && p.info?.imageUrl) r.img = p.info.imageUrl
            if (r.change24 == null && p.priceChange?.h24 != null) r.change24 = Number(p.priceChange.h24)
            if (!(r.price > 0) && Number(p.priceUsd) > 0) r.price = Number(p.priceUsd) // Birdeye may omit price
          }
        } catch (e) {
          // Best-effort, but no longer INVISIBLE: a silent catch here is what
          // made a rate-limited minute look like "this coin has no picture".
          enrichFails++
          state.errors.push(`enrich/${net.ds}: ${String(e.message).slice(0, 60)}`)
        }
      }
      const sent = Math.ceil(Math.min(need.length, ENRICH_REQ_CAP * 30) / 30)
      if (enrichFails) console.log(`[tokensrc] enrichment: ${enrichFails} of ${sent} vendor batches failed - those tokens keep their last known card`)
      else if (sent) console.log(`[tokensrc] enrichment: ${sent} batch(es) for ${need.length} token(s) missing a card`)
    }

    for (const r of raws) {
      if (!(r.price > 0)) continue // dropped only if every source failed to price it
      // The scan reports the buy tax and the honeypot flag - the two things the
      // arena pays for. GoPlus rate-limits and this set is hundreds of coins, so
      // cached results are free and NEW scans are budgeted per cycle, deepest
      // pool first (raws is liquidity-sorted). An unscanned coin simply has no
      // reported tax, which is not a reason to keep it out of Live: the venue
      // probe already proved the treasury can buy it.
      let safety = { checked: false }
      if (withSafety && net.goplus && stakeTierFor(r.liquidity, r.volume24, r.ageHours) > 0) {
        const hit = safetyCached(r.address)
        if (hit) safety = hit
        else if (scanBudget > 0) { scanBudget--; safety = await checkSafety(net.goplus, r.address, fetchJson) }
      }
      const { category, record } = buildDynToken(r, safety)
      byCat[category] = (byCat[category] || 0) + 1
      if (!record) continue
      bySource[r.src] = (bySource[r.src] || 0) + 1
      all.push(record)
    }
  }

  // A discovery source having a bad cycle (rate limit, outage) must not SHRINK
  // the arena: replacing a 200-coin pool with the 20 that survived one flaky
  // fetch is a transient error promoted to truth. If a pool collapses below
  // half of what it had, this cycle keeps the previous book for that pool -
  // prices still refresh by address, and the next healthy cycle replaces it.
  //
  // Only pools NETWORKS still discovers get this protection. A REMOVED pool
  // (the old Solana book, still present in a pre-removal token cache) reads as
  // "collapsed to zero" every cycle, and the guard would resurrect its dead
  // tokens forever - burning the shared DexScreener refresh budget on coins no
  // battle can use. Gone from NETWORKS means gone from the book.
  const KEEP_MIN = Number(process.env.HOOD_POOL_KEEP_MIN) || 20
  const activePools = new Set(NETWORKS.map((n) => n.pool))
  const prevByPool = new Map()
  for (const t of dynamicTokens()) {
    if (!activePools.has(t.pool)) continue // a removed pool must not rise again
    if (!prevByPool.has(t.pool)) prevByPool.set(t.pool, [])
    prevByPool.get(t.pool).push(t)
  }
  for (const [poolId, prev] of prevByPool) {
    const fresh = all.filter((t) => t.pool === poolId).length
    if (prev.length >= KEEP_MIN && fresh < prev.length / 2) {
      const freshIds = new Set(all.filter((t) => t.pool === poolId).map((t) => t.id))
      for (const t of prev) if (!freshIds.has(t.id)) all.push(t)
      const msg = `pool ${poolId} collapsed this cycle (${fresh} of ${prev.length}) - kept the last good book`
      console.log('[tokensrc] ' + msg)
      state.errors.push(msg)
    }
  }

  // ---- last known good: a card must not lose parts it already had ----
  //
  // The book is rebuilt from nothing every cycle, and the descriptive half of a
  // card (picture, socials, chart pair) comes from ONE flaky vendor call. So the
  // cycle whose batch was rate-limited didn't just fail to add a picture - it
  // DELETED the picture the player was looking at a minute ago. Measured live:
  // HOODRAT's logo appeared, then vanished on the next cycle, with the vendor
  // serving it correctly the whole time.
  //
  // Prices, depth and volume are deliberately NOT carried: those must be fresh
  // or absent, because a stale one is a wrong number a battle could settle on.
  // These fields are furniture - a coin's picture does not go stale.
  const prevById = new Map(dynamicTokens().map((t) => [t.id, t]))
  let carried = 0
  for (const t of all) {
    const prev = prevById.get(t.id)
    if (!prev || prev === t) continue
    for (const k of ['img', 'pairAddress', 'dexId', 'marketCap', 'fdv', 'holders']) {
      if (t[k] == null && prev[k] != null) { t[k] = k === 'img' ? cleanImg(prev[k]) : prev[k]; carried++ }
    }
    for (const k of ['socials', 'websites']) {
      if (!t[k]?.length && prev[k]?.length) { t[k] = prev[k]; carried++ }
    }
  }
  if (carried) console.log(`[tokensrc] kept ${carried} card fields from the last book (this cycle's vendor pass didn't return them)`)

  mark(`tokensrc.register(${all.length})`, () => {
    for (const t of all) {
      registerToken(t.id, { base: t.base, vol: t.vol })
      applyFeed({ [t.id]: { price: t.base, vol24: t.volume24, ...(t.change24 != null ? { change24: t.change24 } : {}) } })
    }
  })
  await enrichStatics(fetchJson).catch(() => {})
  // Teach the executor about this cycle's stake-eligible coins (deepest first)
  // so the ones it can route are Live-eligible from the next cycle on.
  await venueWarm(all.filter((t) => t.maxStake > 0))
  setDynamic(all)
  setBroadcastIds(all.map((t) => t.id))
  saveCache(all) // so the next boot starts with a full arena instead of nineteen coins
  if (refreshBE) beCache.at = Date.now() // stamp only after a successful discovery pass
  state.tokens = all
  state.byCat = byCat
  state.bySource = bySource
  state.lastRun = Date.now()
  state.errors = state.errors.slice(-10)
  // The GeckoTerminal sparkline refresh used to run here. It is off because
  // nothing renders a sparkline any more, and its budget was the same free
  // tier the CHART candles now draw from (server/candles.js) - spending 30
  // calls a cycle on a series no screen shows meant a player's chart got the
  // 429. `refreshSparks` and `sparkFor24h` stay wired up for the day a
  // sparkline column returns; turning them back on is uncommenting this line.
  // if (fetchJson === defaultFetchJson) refreshSparks(fetchJson).catch(() => {})
  return { count: all.length, byCat, bySource }
}

// ---- 24h sparkline for ingested tokens ----
// The old fallback was "history since the server booted", which right after a
// restart is a flat line with two blips - it looked broken because it
// effectively was. Two real sources replace it:
//   1. GeckoTerminal hourly OHLCV for the pool (true 24h candles) - budgeted
//      per cycle, deepest pools first, cached for an hour. Solana only, since
//      GT doesn't index the Robinhood chain.
//   2. Anchor reconstruction from DexScreener's own timeframe changes: the
//      price 24h/6h/1h/5m ago is exactly current/(1+chg), so five REAL points
//      of the last day are always known for every token. Drawn as a line they
//      are the honest silhouette of the day - sparse, but never fabricated.
const sparkCache = new Map() // token id -> { at, points: number[] | null }
const SPARK_TTL = 60 * 60 * 1000
const SPARK_GT_BUDGET = Number(process.env.HOOD_SPARK_GT_BUDGET) || 30

const anchorSpark = (t) => {
  const p = getPrice(t.id) || t.base
  if (!(p > 0)) return null
  const pc = t.priceChange || {}
  const anchors = [[24, pc.h24], [6, pc.h6], [1, pc.h1], [5 / 60, pc.m5], [0, 0]]
    .filter(([, c]) => Number.isFinite(c) && c > -99.99)
    .map(([hAgo, c]) => [hAgo, p / (1 + c / 100)])
  if (anchors.length < 3 || anchors[0][0] < 6) return null // need at least a 6h reach to call it a day-shape
  const span = anchors[0][0]
  const out = []
  for (let i = 0; i <= 24; i++) {
    const hAgo = span * (1 - i / 24)
    let j = 0
    while (j < anchors.length - 2 && anchors[j + 1][0] > hAgo) j++
    const [h0, p0] = anchors[j]
    const [h1, p1] = anchors[j + 1]
    const f = h0 === h1 ? 1 : Math.min(1, Math.max(0, (h0 - hAgo) / (h0 - h1)))
    out.push(p0 + (p1 - p0) * f)
  }
  return out
}

// ---- our own candle book ----
// We already read every surfaced token's real price every 7 seconds - so we
// WRITE it down too: one close per token per hour, persisted, pruned after a
// week. After the server's first day of uptime every token has a genuine
// 24h chart made of prints we ourselves observed - including the Robinhood
// chain, which no public candle API covers.
db.exec(`CREATE TABLE IF NOT EXISTS spark_hist (
  token TEXT NOT NULL,
  hour INTEGER NOT NULL,
  price REAL NOT NULL,
  PRIMARY KEY (token, hour)
)`)

const ownSparkCache = new Map() // token id -> number[] (chronological, last 24h)

const recordSparkHours = () => {
  const hour = Math.floor(Date.now() / 3600e3)
  const put = db.prepare(`INSERT INTO spark_hist (token, hour, price) VALUES (?, ?, ?)
    ON CONFLICT(token, hour) DO UPDATE SET price = excluded.price`)
  const ids = new Set([...state.tokens.map((t) => t.id), ...TOKENS.map((t) => t.id)])
  for (const id of ids) {
    const p = getPrice(id)
    if (p > 0) put.run(id, hour, p)
  }
  db.prepare('DELETE FROM spark_hist WHERE hour < ?').run(hour - 24 * 8)
  ownSparkCache.clear()
  for (const row of db.prepare('SELECT token, price FROM spark_hist WHERE hour >= ? ORDER BY hour').all(hour - 24)) {
    let arr = ownSparkCache.get(row.token)
    if (!arr) ownSparkCache.set(row.token, arr = [])
    arr.push(row.price)
  }
}

// Candles when we have them (GeckoTerminal's, then our own once at least half
// a day is on record), anchors as the day-one fallback. Takes the token OBJECT
// so the per-request cost is a map hit, never a scan.
export const sparkFor24h = (t) => {
  const gt = sparkCache.get(t.id)?.points
  if (gt) return gt
  const own = ownSparkCache.get(t.id)
  if (own && own.length >= 12) return own
  return anchorSpark(t)
}

const refreshSparks = async (fetchJson) => {
  let budget = SPARK_GT_BUDGET
  const cands = state.tokens
    .filter((t) => t.chain === 'sol' && t.pairAddress)
    .sort((a, b) => (b.liquidity || 0) - (a.liquidity || 0))
  for (const t of cands) {
    if (budget <= 0) break
    const hit = sparkCache.get(t.id)
    if (hit && Date.now() - hit.at < SPARK_TTL) continue
    budget--
    try {
      await sleep(1200) // GT free tier allows ~30/min - pace exactly under it
      const body = await fetchJson(`${GT}/networks/solana/pools/${t.pairAddress}/ohlcv/hour?aggregate=1&limit=24`)
      const list = body?.data?.attributes?.ohlcv_list
      const closes = Array.isArray(list)
        ? [...list].sort((a, b) => a[0] - b[0]).map((c) => Number(c[4])).filter((x) => x > 0)
        : []
      sparkCache.set(t.id, { at: Date.now(), points: closes.length > 2 ? closes : hit?.points || null })
    } catch {
      sparkCache.set(t.id, { at: Date.now(), points: hit?.points || null }) // a failed attempt still cools down
    }
  }
}

// ---- price + stats refresh for every surfaced token (every PRICE_MS) ----
// One DexScreener /tokens/v1 sweep per chain refreshes price, liquidity,
// volume, mcap, timeframe changes and buys/sells for dynamic tokens AND the
// curated statics (display stats only for those - Pyth/CoinGecko keep price
// authority). GeckoTerminal simple-price is the fallback for anything
// DexScreener missed.
// The sweep must stay inside DexScreener's rate budget no matter how big the
// book grows: cap the requests per tick and walk the book in a rotating window
// instead.
//
// The cap was 20 (600 tokens/tick, whole book every ~14s) and that ate the
// WHOLE budget: measured on the live book, this sweep alone ran ~171 req/min,
// the vendor started answering `http 429`, and the loser was the ingest's card
// enrichment - every one of its batches refused, which is how coins ended up
// with no picture. The sweep is not the urgent consumer it looks like: the
// firehose is PRIMARY for this chain's prices (a vendor price is only fed for a
// coin we have seen no swap in for 90s), so what this really refreshes is
// depth, volume and mcap. Those do not need seven-second freshness. At 12 the
// book still turns over every ~23s and there is room left for the pictures.
const REFRESH_REQ_CAP = Number(process.env.HOOD_REFRESH_REQ_CAP) || 12
const sweepOffsets = new Map() // chain -> rotating start index
// The vendor's latest opinion per token id, kept for the price shadow whether
// or not it is allowed to feed the market engine.
export const vendorPrices = new Map()

// How the vendor sweep is actually going. It used to swallow every failure
// ("keep last"), which is correct behaviour and terrible reporting: a sweep that
// has been refused for an hour looks exactly like a sweep with nothing new to
// say. Surfaced in tokenSourceStats so the admin page can show it.
export const refreshHealth = { sent: 0, failed: 0, lastOk: 0, lastFail: 0 }

const refreshPrices = async ({ fetchJson = defaultFetchJson } = {}) => {
  const feed = {}
  const byChain = {}
  for (const t of state.tokens) if (t.address) (byChain[t.srcChain || 'solana'] ||= []).push({ kind: 'dyn', t, address: t.address })
  for (const tok of TOKENS) {
    const c = staticPairCache.get(tok.id)
    if (c) (byChain[c.chainId] ||= []).push({ kind: 'static', t: tok, address: c.address })
  }
  const total = Object.values(byChain).reduce((n, e) => n + e.length, 0)
  for (const [chain, entries] of Object.entries(byChain)) {
    // Each chain gets its share of the cap; a rotating offset makes successive
    // ticks cover successive windows, so every token still refreshes.
    const share = Math.max(1, Math.floor(REFRESH_REQ_CAP * (entries.length / (total || 1))))
    const window = Math.min(entries.length, share * 30)
    const start = sweepOffsets.get(chain) || 0
    const slice = entries.slice(start, start + window)
    if (slice.length < window) slice.push(...entries.slice(0, window - slice.length)) // wrap
    sweepOffsets.set(chain, entries.length ? (start + window) % entries.length : 0)
    for (let i = 0; i < slice.length; i += 30) {
      const batch = slice.slice(i, i + 30)
      try {
        const pairs = await fetchJson(`${DS}/tokens/v1/${chain}/${batch.map((e) => e.address).join(',')}`)
        const best = {}
        for (const p of Array.isArray(pairs) ? pairs : []) {
          const a = addrKey(p.baseToken?.address)
          if (a && (!best[a] || (p.liquidity?.usd || 0) > (best[a].liquidity?.usd || 0))) best[a] = p
        }
        for (const e of batch) {
          const p = best[addrKey(e.address)]
          if (!p) continue
          const price = Number(p.priceUsd) || 0
          const extra = {
            ...extraFromPair(p),
            liquidity: Number(p.liquidity?.usd) || e.t.liquidity,
            volume24: Number(p.volume?.h24) || e.t.volume24,
          }
          if (e.kind === 'dyn') {
            // Jupiter's price feed (server/solprices.js) is the price for this
            // pool - it quotes the TOKEN across every pool it trades in, where
            // a DexScreener pair is one pool. So here the vendor refreshes the
            // card (depth, volume, mcap, windows) and only prices a coin the
            // Jupiter feed has not reached in the last minute.
            const priceSilenced = jupPriceFresh(e.t.id)
            // Live records - /api/tokens serves these. A Jupiter row describes
            // the whole TOKEN (every pool's trades, total depth); a DexScreener
            // pair is one pool, so over a Jupiter row it only FILLS gaps - apart
            // from the chart pair, which only DexScreener has.
            if (e.t.src === 'jup') {
              for (const [k, v] of Object.entries(extra)) {
                if (v == null) continue
                if (k === 'pairAddress' || k === 'dexId' || k === 'dexUrl') { e.t[k] = v; continue }
                const cur = e.t[k]
                const empty = cur == null || (Array.isArray(cur) && !cur.length)
                  || (k === 'priceChange' && !Object.values(cur || {}).some(Number.isFinite))
                  || (k === 'txns24' && !((cur.buys || 0) + (cur.sells || 0)))
                if (empty) e.t[k] = v
              }
            } else Object.assign(e.t, extra)
            // Re-judge coherence on every stats refresh, not just at ingest.
            // A spoofer can present a modest pair at discovery time and pump
            // the claimed depth through this 7-second path afterwards - the
            // "$310M USDT clone with 36 txns" trick. The moment the refreshed
            // numbers stop hanging together, Verified is withdrawn on the spot;
            // the next full ingest can restore it if the market becomes real.
            const txns = (e.t.txns24?.buys || 0) + (e.t.txns24?.sells || 0)
            if (e.t.category === 'verified' && e.t.liquidity > 250_000 && e.t.liquidity > txns * 25_000) {
              e.t.category = 'degen'
              if (e.t.safety) e.t.safety.statsCoherent = false
            }
            // The vendor's opinion is RECORDED even when it is not allowed to
            // feed - that record is what the price shadow compares against, so
            // promotion never blinds the very comparison that justified it.
            if (price > 0) {
              vendorPrices.set(e.t.id, { price, ts: Date.now() })
              if (!priceSilenced) feed[e.t.id] = { price, vol24: e.t.volume24, ...(e.t.src !== 'jup' && p.priceChange?.h24 != null ? { change24: Number(p.priceChange.h24) } : {}) }
            }
          } else {
            setStaticExtra(e.t.id, { ...(staticExtraFor(e.t.id) || {}), ...extra, ...(p.info?.imageUrl ? { img: p.info.imageUrl } : {}) })
          }
        }
        refreshHealth.sent++
        refreshHealth.lastOk = Date.now()
      } catch {
        // Keep the last good numbers - but COUNT the refusal, so "the book's
        // depth looks stale" is a number someone can read instead of a guess.
        refreshHealth.sent++
        refreshHealth.failed++
        refreshHealth.lastFail = Date.now()
      }
    }
  }
  // NOTE: price refresh is DexScreener-only on purpose - it covers Solana + the
  // Robinhood chain by token address, and keeping GeckoTerminal OUT of the hot
  // 7s loop preserves its scarce ~30 req/min budget entirely for discovery
  // pagination (the thing that decides how many coins the arena has).
  if (Object.keys(feed).length) applyFeed(feed)
}

// ---- instant listing ----
// The 3-minute ingest is how the book breathes; this is how a NEW coin gets in
// the door the moment it starts trading. Every 30s Jupiter is asked for its
// newest coins and what just started moving; anything that clears the same
// floors and is not yet in the book is graded through the exact same
// buildDynToken as everything else and appended live. The next full ingest
// keeps it alive by address (see the keep-alive lookup in ingestOnce), so
// nothing here is ever load-bearing.
const FAST_LIST_MS = 30_000
const fastListOnce = async ({ fetchJson = defaultFetchJson } = {}) => {
  const pool = NETWORKS.find((n) => n.jup)?.pool
  if (!pool) return
  const found = await discoverJupiter(fetchJson, JUP_FAST_FEEDS, { withVerified: false })
  const fresh = [...found.values()].filter((r) => (r.txns24?.buys || 0) + (r.txns24?.sells || 0) >= MIN_TRADES_24H)
  if (!fresh.length) return
  const cur = dynamicTokens()
  const have = new Set(cur.map((t) => (t.address ? normAddr(t.pool, t.address) : '')))
  const added = []
  // Same identity and ticker rules as the full ingest - a clone farm must not
  // walk in through the fast door, and an id must mean the same contract here.
  const seenBase = new Set(cur.map((t) => t.ticker))
  const seenId = new Set(cur.map((t) => t.id))
  for (const r of fresh) {
    if (have.has(normAddr(pool, r.address))) continue
    const base = String(r.symbol).toUpperCase().replace(/[^A-Z0-9]/g, '')
    if (!base || base.length > 12 || EXCLUDE.has(base) || tokenById(base)) continue
    const already = pinnedIdFor(pool, r.address)
    if (!already && seenBase.has(base) && (r.liquidity || 0) < DUP_MIN_LIQ) continue
    const id = already || claimTokenId(pool, r.address, base)
    if (!id || seenId.has(id)) continue
    seenBase.add(base); seenId.add(id)
    r.id = id; r.ticker = base; r.chain = pool
    const { record } = buildDynToken(r)
    if (!record) continue
    added.push(record)
  }
  if (!added.length) return
  for (const t of added) {
    registerToken(t.id, { base: t.base, vol: t.vol })
    applyFeed({ [t.id]: { price: t.base, vol24: t.volume24, ...(t.change24 != null ? { change24: t.change24 } : {}) } })
  }
  const book = [...cur, ...added]
  setDynamic(book)
  setBroadcastIds(book.map((t) => t.id))
  for (const t of added) {
    console.log(`[tokensrc] ⚡ fast-listed ${t.ticker} (${t.category}, $${Math.round(t.liquidity).toLocaleString()} liq, ${fmtAgeLog(t.ageHours)} old)`)
  }
}
const fmtAgeLog = (h) => (h == null ? 'age unknown' : h < 1 ? `${Math.round(h * 60)}min` : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`)
export { fastListOnce }

let ingestTimer = null, priceTimer = null
export const startTokenSource = () => {
  if (ingestTimer) return
  try { releaseRetiredIds() } catch (e) { state.errors.push(`release ids: ${e.message}`) }
  const run = () => {
    if (state.running) return
    state.running = true
    markAsync('tokensrc.ingestOnce', () => ingestOnce())
      .catch((e) => state.errors.push(String(e.message)))
      .finally(() => { state.running = false })
  }
  run()
  ingestTimer = setInterval(run, INGEST_MS)
  priceTimer = setInterval(() => markAsync('tokensrc.refreshPrices', () => refreshPrices()).catch(() => {}), PRICE_MS)
  setInterval(() => { if (!state.running) markAsync('tokensrc.fastList', () => fastListOnce()).catch(() => {}) }, FAST_LIST_MS)
  // Our own hourly candle book: write the close every 5 minutes (idempotent per
  // hour) and rebuild the 24h series cache. Delayed first run so the first
  // ingest has surfaced tokens and real prices before anything is recorded.
  setTimeout(() => { try { recordSparkHours() } catch { /* next tick */ } }, 120e3)
  setInterval(() => { try { recordSparkHours() } catch { /* keep last book */ } }, 5 * 60 * 1000)
}

export const tokenSourceStats = () => ({
  count: state.tokens.length,
  pinnedIds: (() => { try { return db.prepare('SELECT COUNT(*) n FROM token_ids').get().n } catch { return 0 } })(),
  byCat: state.byCat,
  bySource: state.bySource,
  lastRun: state.lastRun,
  perPool: PER_POOL,
  vendorSweep: { ...refreshHealth, failRate: refreshHealth.sent ? Math.round((refreshHealth.failed / refreshHealth.sent) * 100) : 0 },
  jupiterVerified: { rows: jupVerified.rows.length, ageSec: jupVerified.at ? Math.round((Date.now() - jupVerified.at) / 1000) : null },
  errors: state.errors,
  sample: state.tokens.slice(0, 12).map((t) => ({ ticker: t.ticker, chain: t.chain, category: t.category, src: t.src, liquidity: Math.round(t.liquidity) })),
})
