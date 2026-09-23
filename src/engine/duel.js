// Client-side mirror of the arena rules - used for instant UX feedback
// (disabled tokens, validation messages, fee preview). The server re-validates
// everything; nothing here is trusted for real decisions.

import { getState, effToken, allTokens } from './store'
import { poolLabel } from './tokens'

export const PICK_SECONDS = 90
export const DRAW_THRESHOLD = 0.05 // percentage points
export const SWAP_COST = 0.003     // est. slippage + DEX fee per side, Live Arena only

// Mirrors the server: fee tiers are bands, each key the smallest stake paying
// that rate. Preview only - the server's number is the one that counts.
export const feeFor = (stake) => {
  const tiers = getState().config.feeTiers || {}
  const bands = Object.keys(tiers).map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => a - b)
  const band = bands.filter((b) => b <= stake).pop()
  const pct = band != null ? tiers[band] : (tiers[bands[0]] ?? 10)
  const pool = stake * 2
  const fee = Math.round(pool * pct) / 100
  return { pct, pool, fee, prize: Math.round((pool - fee) * 100) / 100 }
}

export const tokenAllowed = (id, cfg) => {
  const t = effToken(id)
  if (!t) return { ok: false, why: 'Unknown token' }
  if (t.paused) return { ok: false, why: `${t.ticker} is temporarily paused by the arena` }
  if (t.category === 'suspended') return { ok: false, why: `${t.ticker} is suspended - it no longer passes safety checks` }
  if (t.category === 'ineligible') return { ok: false, why: `${t.ticker} failed safety checks and is not eligible` }
  if (cfg.allowedIds && !cfg.allowedIds.includes(id)) return { ok: false, why: `${t.ticker} is not on this event's token list` }
  // One battle = one pool: all 3 picks must come from the same battlefield.
  if (cfg.pool && t.pool !== cfg.pool) return { ok: false, why: `${t.ticker} is not on the ${poolLabel(cfg.pool) ?? cfg.pool} battlefield` }
  if (cfg.training) return { ok: true }
  if (t.category === 'fresh') return { ok: false, why: `${t.ticker} is a Fresh Launch - free battles only until it earns Degen status` }
  // Mirrors server/rules.js - see the note there for why both of these came
  // down. Keep the two in step: this copy decides what the picker paints, the
  // server's decides what a lock is allowed to contain, and a disagreement
  // shows up as a coin you can select but not play.
  const DEGEN_LIVE_OK = true
  const DEGEN_MIN_DURATION = 60
  if (t.category === 'degen') {
    if (!DEGEN_LIVE_OK && cfg.mode === 'live') return { ok: false, why: `${t.ticker} is Degen Approved - Classic Arena only. Not tradable enough for Live yet.` }
    if (cfg.duration < DEGEN_MIN_DURATION) return { ok: false, why: `${t.ticker} needs battles of ${Math.round(DEGEN_MIN_DURATION / 60)} min or longer (manipulation protection)` }
  }
  // The server's venue gate, mirrored: a coin the treasury cannot buy cannot
  // back a Live payout. `liveOk: false` is shipped with the book.
  if (cfg.mode === 'live' && t.liveOk === false) return { ok: false, why: `${t.ticker} can't be hedged by the treasury right now - Classic Arena only.` }
  // No size gate in either mode - mirrors the server. Size on a thin book is
  // priced (see priceImpactFor), not blocked: the player pays the market
  // impact of their own order, exactly like on any DEX terminal.
  return { ok: true }
}

// Mirror of the server's impact model, for honest previews before the lock:
// average fill premium ≈ order / reachable liquidity, zero under 0.05%,
// clamped at 90%. The server recomputes this - the client only discloses.
export const priceImpactFor = (tokenId, usd) => {
  const t = effToken(tokenId)
  const liq = t?.reachableLiquidity ?? t?.liquidity
  if (!(liq > 0) || !(usd > 0)) return 0
  const frac = usd / liq
  return frac < 0.0005 ? 0 : Math.min(0.9, frac)
}

export const allowedTokenIds = (cfg) => allTokens().filter((t) => tokenAllowed(t.id, cfg).ok).map((t) => t.id)

export const validatePicks = (picks, cfg) => {
  if (!picks || picks.length !== 3) return 'Pick exactly 3 tokens.'
  const ids = picks.map((p) => p.tokenId)
  if (new Set(ids).size !== 3) return 'Each token can only appear once.'
  // Mirrors the server: picks are stored in WHOLE percent, so the total is
  // checked on the rounded values - a split that only reaches 100 in fractions
  // would land as 99 and leave 1% of the entry unallocated.
  const total = picks.reduce((a, p) => a + Math.round(p.pct), 0)
  if (total !== 100) return `Allocation must total exactly 100% in whole percent (currently ${total}%).`
  for (const p of picks) {
    if (Math.round(p.pct) <= 0) return 'Every token needs an allocation of at least 1%.'
    const allowed = tokenAllowed(p.tokenId, cfg)
    if (!allowed.ok) return allowed.why
    const t = effToken(p.tokenId)
    if (!cfg.training && t.category === 'degen' && Math.round(p.pct) > 50) return `${t.ticker} is Degen Approved - max 50% of your portfolio.`
  }
  // Mirrors the server's Live floor: a slice worth less than the venue minimum
  // would never be bought for real, so it is refused at the door. Preview only -
  // the server re-checks with its own numbers.
  if (!cfg.training && cfg.mode === 'live' && Number.isFinite(cfg.stake)) {
    const hedgeMin = getState().config.hedgeMinUsd || 1
    const entryNet = (cfg.stake - feeFor(cfg.stake).fee / 2) * (1 - SWAP_COST)
    const minPct = Math.ceil((hedgeMin / entryNet) * 100)
    if (minPct > 1) {
      for (const p of picks) {
        if (Math.round(p.pct) < minPct) {
          return `On a $${cfg.stake} Live battle every coin needs at least ${minPct}% - smaller slices are below the $${hedgeMin} market minimum.`
        }
      }
    }
  }
  return null
}
