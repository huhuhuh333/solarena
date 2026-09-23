// Arena rules, evaluated ONLY on the server. The client shows the same rules
// for UX, but nothing a browser sends is trusted - every pick set is
// re-validated here before a battle starts.

import { TOKENS, tokenById, POOLS, poolById, poolLabel } from '../src/engine/tokens.js'
import { getSetting, getOverrides } from './db.js'
import { dynamicTokens, dynamicById, staticExtraFor, venueLimitFor } from './registry.js'
import { venueCanTrade } from './venue.js'

export { POOLS, poolById }

export const PICK_SECONDS = Number(process.env.HOOD_PICK_SECONDS) || 90
export const DRAW_THRESHOLD = 0.05 // percentage points
export const SWAP_COST = 0.003     // slippage + DEX fee per side, Live Arena only
// Smallest order the hedger will send to a venue. Defined here rather than in
// hedger.js because the PICK rules must know it too: a Live slice below this
// would simply never be bought, and the payout it promises would be backed by
// nothing. One constant, both gates.
export const HEDGE_MIN_USD = Number(process.env.HOOD_HEDGE_MIN) || 1
// How long someone waits at their own number before the arena offers them the
// nearest smaller table instead.
export const QUEUE_OFFER_SECS = Number(process.env.HOOD_QUEUE_OFFER_SECS) || 45
export const FEED_LOSS_VOID_SECS = 90

export const STAKES = [10, 20, 50, 100, 150, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 7500, 10000]
// 60 added 5 Aug 2026 (owner). Must stay in step with src/engine/format.js -
// that list draws the picker, this one decides what a battle may actually be.
export const DURATIONS = [60, 300, 900, 3600, 86400]

// Fee tiers are BANDS, not exact stakes: each key is the smallest stake that
// pays that rate, and everything up to the next key pays the same. With sixteen
// stakes an exact-key lookup would silently drop any unlisted one to the top
// rate, which is the expensive direction to be wrong in.
export const feeFor = (stake) => {
  const tiers = getSetting('feeTiers')
  const bands = Object.keys(tiers).map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => a - b)
  const band = bands.filter((b) => b <= stake).pop()
  const pct = band != null ? tiers[band] : (tiers[bands[0]] ?? 10)
  const pool = stake * 2
  const fee = Math.round(pool * pct) / 100
  return { pct, pool, fee, prize: Math.round((pool - fee) * 100) / 100 }
}

// Dollars of one player's entry that actually reach the market in Live: stake
// minus their half of the fee, minus entry-side swap cost. The same formula
// duel.js applies with the room's locked-in fee; here it previews with the
// current tiers, which is the right answer before a room exists.
export const entryNetFor = (stake) => (stake - feeFor(stake).fee / 2) * (1 - SWAP_COST)

// Estimated market impact of pushing `usd` dollars into this token's reachable
// on-chain book, as a fraction of the order (average fill premium on an AMM is
// roughly order/liquidity). This is the DEX-terminal deal: no size is ever
// blocked - a big order on a thin book simply pays its real cost, disclosed
// before the lock, and the charge stays with the house as the buffer that
// absorbs the actual fill. Below 0.05% it rounds to zero (noise on deep
// markets); clamped at 90% because past that the number stops meaning anything,
// though the trade is still the player's to make.
export const priceImpactFor = (tokenId, usd) => {
  const t = effToken(tokenId)
  const liq = t?.reachableLiquidity ?? t?.liquidity
  if (!(liq > 0) || !(usd > 0)) return 0
  const frac = usd / liq
  return frac < 0.0005 ? 0 : Math.min(0.9, frac)
}

// How big a LIVE battle the treasury could actually fill in this token on-chain.
// Deliberately a separate field from maxStake: Classic buys nothing, so reachable
// depth is none of its business there - a $1000 Classic battle on a thin coin is
// fine, the two players simply settle against each other.
const capToVenue = (t) => {
  const lim = venueLimitFor(t.id)
  if (!lim || lim.maxStake == null) return t
  return { ...t, venueMaxStake: lim.maxStake, reachableLiquidity: lim.reachableLiquidity }
}

export const effToken = (id) => {
  const stat = tokenById(id)
  const t = stat || dynamicById(id)
  if (!t) return null
  const extra = stat ? staticExtraFor(id) : null
  const o = getOverrides()[id]
  return capToVenue(extra || o ? { ...t, ...extra, ...o } : t)
}

export const allTokensEff = () => {
  const overrides = getOverrides()
  const apply = (t, extra) => capToVenue(extra || overrides[t.id] ? { ...t, ...extra, ...overrides[t.id] } : t)
  return [...TOKENS.map((t) => apply(t, staticExtraFor(t.id))), ...dynamicTokens().map((t) => apply(t, null))]
}

export const tokenAllowed = (id, cfg) => {
  const t = effToken(id)
  if (!t) return { ok: false, why: 'Unknown token' }
  if (t.paused) return { ok: false, why: `${t.ticker} is temporarily paused by the arena` }
  if (t.category === 'suspended') return { ok: false, why: `${t.ticker} is suspended - it no longer passes safety checks` }
  if (t.category === 'ineligible') return { ok: false, why: `${t.ticker} failed safety checks and is not eligible` }
  if (cfg.allowedIds && !cfg.allowedIds.includes(id)) return { ok: false, why: `${t.ticker} is not on this event's token list` }
  // One battle = one pool. All 3 picks come from the same battlefield - no mixing.
  if (cfg.pool && t.pool !== cfg.pool) return { ok: false, why: `${t.ticker} is not on the ${poolLabel(cfg.pool) ?? cfg.pool} battlefield` }
  if (cfg.training) return { ok: true }
  if (t.category === 'fresh') return { ok: false, why: `${t.ticker} is a Fresh Launch - free battles only until it earns Degen status` }
  // Degen Approved used to mean Classic-only, and 15 minutes minimum even
  // there. Measured 5 Aug 2026, the book is 952 degen / 229 fresh / 19
  // verified - so those two lines left 19 of 1,200 coins pickable in Live and
  // in any 5-minute battle, which is not an arena, it is an empty list with a
  // red sentence on every row. Lowered on the owner's call.
  //
  // Both were curation opinions. What is NOT an opinion is the venue gate
  // below: whether the treasury can actually buy and sell the coin. A Live
  // battle the house cannot hedge is a payout with nothing behind it, so that
  // one stays, and thin books keep paying their own slippage through
  // priceImpactFor rather than being blocked.
  const DEGEN_LIVE_OK = true
  const DEGEN_MIN_DURATION = 60 // follows the shortest rung; at 900 it emptied the whole book
  if (t.category === 'degen') {
    if (!DEGEN_LIVE_OK && cfg.mode === 'live') return { ok: false, why: `${t.ticker} is Degen Approved - Classic Arena only.` }
    if (cfg.duration < DEGEN_MIN_DURATION) return { ok: false, why: `${t.ticker} needs battles of ${Math.round(DEGEN_MIN_DURATION / 60)} min or longer` }
  }
  // Live is only affordable while the treasury holds the same basket, so a token
  // no venue can actually execute must never enter it - however blue-chip it
  // looks. A curated category is a claim about the coin; this is a claim about
  // OUR ability to trade it, and only the second one keeps the payout backed.
  // Classic is unaffected: there the house holds nothing.
  if (cfg.mode === 'live' && !venueCanTrade(t)) {
    return { ok: false, why: `${t.ticker} has no tradable market right now - Classic Arena only.` }
  }
  // No size gate in either mode. Size on a thin book is PRICED, not blocked:
  // the entry pays its estimated market impact (priceImpactFor) exactly like a
  // DEX order pays its slippage, so the choice - and the cost - belong to the
  // player. maxStake / venueMaxStake survive only as display fields.
  return { ok: true }
}

export const allowedTokenIds = (cfg) => allTokensEff().filter((t) => tokenAllowed(t.id, cfg).ok).map((t) => t.id)

export const validatePicks = (picks, cfg) => {
  if (!Array.isArray(picks) || picks.length !== 3) return 'Pick exactly 3 tokens.'
  for (const p of picks) {
    if (!p || typeof p.tokenId !== 'string' || typeof p.pct !== 'number' || !Number.isFinite(p.pct)) return 'Malformed picks.'
  }
  const ids = picks.map((p) => p.tokenId)
  if (new Set(ids).size !== 3) return 'Each token can only appear once.'
  // Validate the numbers that will actually be STORED. lockPicks rounds every
  // slice to a whole percent, so a set totalling 100 in fractions but 99 once
  // rounded (33.34/33.33/33.33) has to be refused here - otherwise 1% of the
  // entry silently buys nothing: dead weight in Classic, a dollar that never
  // reaches the market in Live.
  const total = picks.reduce((a, p) => a + Math.round(p.pct), 0)
  if (total !== 100) return `Allocation must total exactly 100% in whole percent (currently ${total}%).`
  for (const p of picks) {
    if (Math.round(p.pct) <= 0) return 'Every token needs an allocation of at least 1%.'
    const allowed = tokenAllowed(p.tokenId, cfg)
    if (!allowed.ok) return allowed.why
    const t = effToken(p.tokenId)
    if (!cfg.training && t.category === 'degen' && Math.round(p.pct) > 50) return `${t.ticker} is Degen Approved - max 50% of your portfolio.`
  }
  // Live buys every slice for real, and the hedger never sends an order below
  // HEDGE_MIN_USD - so a slice that small must be refused here, at the door,
  // or it becomes a payout in coins the treasury was never going to buy.
  // Checked on the ROUNDED pct because that is what lockPicks stores and the
  // basket is built from: 11.4% may be worth $1.02 raw but trades as 11%.
  if (!cfg.training && cfg.mode === 'live' && Number.isFinite(cfg.stake)) {
    const minPct = Math.ceil((HEDGE_MIN_USD / entryNetFor(cfg.stake)) * 100)
    if (minPct > 1) {
      for (const p of picks) {
        if (Math.round(p.pct) < minPct) {
          return `On a $${cfg.stake} Live battle every coin needs at least ${minPct}% - smaller slices are below the $${HEDGE_MIN_USD} market minimum.`
        }
      }
    }
  }
  return null
}

// Battle-config validation for queue joins.
export const validateConfig = (cfg) => {
  if (cfg.pool != null && !poolById(cfg.pool)) return 'Unknown battlefield.'
  if (cfg.training) {
    if (!DURATIONS.includes(cfg.duration)) return 'Invalid duration.'
    return null
  }
  if (!['classic', 'live'].includes(cfg.mode)) return 'Invalid mode.'
  if (!STAKES.includes(cfg.stake)) return 'Invalid stake.'
  if (!DURATIONS.includes(cfg.duration)) return 'Invalid duration.'
  if (!poolById(cfg.pool)) return 'Pick a battlefield.'
  if (cfg.mode === 'classic' && getSetting('classicPaused')) return 'Classic Arena is temporarily paused.'
  if (cfg.mode === 'live' && getSetting('livePaused')) return 'Live Arena is temporarily paused.'
  if (cfg.mode === 'live') {
    // Live tables unlock stepwise as the arena's fee reserve grows - the
    // "their money only" guarantee: never expose more than the buffer covers.
    const cap = getSetting('liveMaxStake')
    if (cfg.stake > cap) return `Live Arena tables above $${cap} are not open yet - they unlock as the arena's reserve grows. Classic Arena has no cap.`
  }
  if (cfg.mode === 'live' && !allTokensEff().some((t) => t.pool === cfg.pool && venueCanTrade(t))) {
    return `Live Arena isn't open on ${poolById(cfg.pool).label} yet - these coins have no tradable market. Classic Arena plays every coin now.`
  }
  if (allowedTokenIds(cfg).length < 3) {
    return `${poolById(cfg.pool).label} doesn't have 3 eligible tokens for a $${cfg.stake} ${cfg.mode} battle${cfg.duration < 900 ? ' at this duration' : ''} - lower the stake or change the duration.`
  }
  return null
}
