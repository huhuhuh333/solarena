// Server rules unit test: validation, fees and token gating exactly as the
// arena enforces them (imports the real server modules).
//
// The arena's one pool is Solana Memes and carries no curated tokens at all,
// so everything here plays out on a fixture book of dynamic Solana-pool
// tokens - the same registry path the live ingest uses.
//
// Usage: node scripts/rules-test.mjs

import { rmSync, mkdirSync } from 'node:fs'

const DB_DIR = 'server/data/rules-test'
rmSync(DB_DIR, { recursive: true, force: true })
mkdirSync(DB_DIR, { recursive: true })
process.env.HOOD_DB = `${DB_DIR}/test.db`

const { validatePicks, feeFor, tokenAllowed, validateConfig } = await import('../server/rules.js')
const { setSetting, setOverride } = await import('../server/db.js')
const { setDynamic } = await import('../server/registry.js')

// The eth pool ("Robinhood Memes") has NO curated tokens - its coins come from
// the live ingest, and they DO play Live: `POOL_FUND.eth` funds those battles in
// USDG on the Robinhood chain. The chain not being GoPlus-scannable means its
// safety fields are unknown, not bad, which is why the ingest still grades them
// Verified on chain evidence. Simulate both grades so the pool tests cover the
// real mix rather than one stale assumption.
const ETH_FIXTURES = [
  { id: 'IF', ticker: 'IF', name: 'Infinity', pool: 'sol', category: 'verified', maxStake: 1000, dynamic: true },
  { id: 'RDOG', ticker: 'RDOG', name: 'Robo Dog', pool: 'sol', category: 'verified', maxStake: 1000, dynamic: true },
  { id: 'MURRE', ticker: 'MURRE', name: 'Murre', pool: 'sol', category: 'verified', maxStake: 1000, dynamic: true },
  { id: 'RPOP', ticker: 'RPOP', name: 'Robo Pop', pool: 'sol', category: 'verified', maxStake: 1000, dynamic: true },
  { id: 'RGIG', ticker: 'RGIG', name: 'Robo Giga', pool: 'sol', category: 'verified', maxStake: 1000, dynamic: true },
  { id: 'RMEW', ticker: 'RMEW', name: 'Robo Mew', pool: 'sol', category: 'verified', maxStake: 1000, dynamic: true },
  // Verified with a small tier: proves size is PRICED (impact), never blocked.
  { id: 'RSMALL', ticker: 'RSMALL', name: 'Robo Small', pool: 'sol', category: 'verified', maxStake: 100, dynamic: true },
  // Three degen ones too, so the "no Verified coins left" case below still has
  // enough of a book for Classic - otherwise that test would pass for the wrong
  // reason (an empty pool, not a Live-ineligible one).
  { id: 'RTHIN', ticker: 'RTHIN', name: 'Robo Thin', pool: 'sol', category: 'degen', maxStake: 100, dynamic: true },
  { id: 'RTHIN2', ticker: 'RTHIN2', name: 'Robo Thin II', pool: 'sol', category: 'degen', maxStake: 100, dynamic: true },
  { id: 'RTHIN3', ticker: 'RTHIN3', name: 'Robo Thin III', pool: 'sol', category: 'degen', maxStake: 100, dynamic: true },
  // A token from a pool that no longer exists (the shape a legacy Solana coin
  // would have): must never be pickable inside an eth battle.
  { id: 'GHOST', ticker: 'GHOST', name: 'Ghost of Robinhood', pool: 'eth', category: 'verified', maxStake: 1000, dynamic: true },
]
setDynamic(ETH_FIXTURES)
const VERIFIED_ETH = ETH_FIXTURES.filter((t) => t.pool === 'sol' && t.category === 'verified').length
const ALL_ETH = ETH_FIXTURES.filter((t) => t.pool === 'sol').length

const log = (...a) => console.log('[rules]', ...a)
const fail = (msg) => { console.error('[FAIL]', msg); process.exitCode = 1 }
const assert = (cond, msg) => { if (!cond) fail(msg); else log('ok:', msg) }

const cfgLive100 = { mode: 'live', stake: 100, duration: 300, training: false }

assert(validatePicks([{ tokenId: 'IF', pct: 50 }, { tokenId: 'RDOG', pct: 30 }, { tokenId: 'MURRE', pct: 30 }], cfgLive100) !== null, 'sum 110% rejected')

// ---- picks are stored in WHOLE percent, so they must VALIDATE in whole percent ----
// The equal-split default used to send 33.34/33.33/33.33: a raw total of 100
// that lands as 33/33/33 = 99 once lockPicks rounds each slice, quietly leaving
// 1% of the entry unallocated (dead weight in Classic, a dollar that never
// reaches the market in Live). The total is now checked on the rounded values.
assert(validatePicks([{ tokenId: 'IF', pct: 33.34 }, { tokenId: 'RDOG', pct: 33.33 }, { tokenId: 'MURRE', pct: 33.33 }], cfgLive100) !== null,
  'a fractional split that rounds down to 99% is refused, not silently under-allocated')
assert(validatePicks([{ tokenId: 'IF', pct: 34 }, { tokenId: 'RDOG', pct: 33 }, { tokenId: 'MURRE', pct: 33 }], cfgLive100) === null,
  'the whole-percent equal split (34/33/33) is exactly 100 and accepted')
assert(validatePicks([{ tokenId: 'IF', pct: 99.6 }, { tokenId: 'RDOG', pct: 0.2 }, { tokenId: 'MURRE', pct: 0.2 }], cfgLive100) !== null,
  'a slice that rounds to 0% is refused - a stored 0 would be a token with no money on it')
assert(validatePicks([{ tokenId: 'IF', pct: 50 }, { tokenId: 'IF', pct: 30 }, { tokenId: 'MURRE', pct: 20 }], cfgLive100) !== null, 'duplicate token rejected')
// Degen / fresh / suspended / ineligible states are produced at runtime (the
// ingest or the admin) - simulate them with overrides, the same code path a
// downgraded coin takes.
setOverride('RPOP', { category: 'degen', maxStake: 100 })
// The grade stopped gating Live on 5 Aug 2026: with 952 of 1,200 coins graded
// degen, "Verified only" meant an empty Live arena. What keeps a Live payout
// backed is the venue gate further down - whether the treasury can trade it.
assert(validatePicks([{ tokenId: 'RPOP', pct: 50 }, { tokenId: 'RDOG', pct: 30 }, { tokenId: 'MURRE', pct: 20 }], cfgLive100) === null, 'degen token ACCEPTED in Live - the grade no longer gates it')
assert(validatePicks([{ tokenId: 'RSMALL', pct: 50 }, { tokenId: 'RDOG', pct: 30 }, { tokenId: 'MURRE', pct: 20 }], { ...cfgLive100, stake: 500 }) === null, 'RSMALL plays at $500 despite its $100 tier - size is PRICED via impact, never blocked')
setOverride('RGIG', { category: 'fresh', maxStake: 0 })
setOverride('RMEW', { category: 'ineligible', maxStake: 0 })
setOverride('RTHIN3', { category: 'suspended' })
assert(validatePicks([{ tokenId: 'RGIG', pct: 50 }, { tokenId: 'RDOG', pct: 30 }, { tokenId: 'MURRE', pct: 20 }], cfgLive100) !== null, 'fresh launch rejected in real money')
assert(validatePicks([{ tokenId: 'RMEW', pct: 50 }, { tokenId: 'RDOG', pct: 30 }, { tokenId: 'MURRE', pct: 20 }], { mode: 'classic', stake: 10, duration: 900 }) !== null, 'ineligible (honeypot) token rejected everywhere')
assert(validatePicks([{ tokenId: 'RPOP', pct: 60 }, { tokenId: 'RDOG', pct: 20 }, { tokenId: 'MURRE', pct: 20 }], { mode: 'classic', stake: 100, duration: 900 }) !== null, 'degen >50% rejected')
assert(validatePicks([{ tokenId: 'RPOP', pct: 40 }, { tokenId: 'RDOG', pct: 30 }, { tokenId: 'MURRE', pct: 30 }], { mode: 'classic', stake: 100, duration: 900 }) === null, 'valid degen classic 15m accepted')
assert(validatePicks([{ tokenId: 'RPOP', pct: 40 }, { tokenId: 'RDOG', pct: 30 }, { tokenId: 'MURRE', pct: 30 }], { mode: 'classic', stake: 100, duration: 300 }) === null, 'degen at 5 min accepted - the 15-minute floor came down with the Live gate')
assert(validatePicks([{ tokenId: 'RGIG', pct: 40 }, { tokenId: 'IF', pct: 30 }, { tokenId: 'RTHIN', pct: 30 }], { training: true, mode: 'classic', stake: 0, duration: 300 }) === null, 'fresh allowed in training')
assert(validatePicks([{ tokenId: 'IF', pct: '50' }, { tokenId: 'RDOG', pct: 30 }, { tokenId: 'MURRE', pct: 20 }], cfgLive100) !== null, 'malformed pct (string) rejected')
assert(validatePicks('nonsense', cfgLive100) !== null, 'non-array picks rejected')

// The rate falls with size: a $10,000 player has somewhere else to go, a $10
// player does not notice. Each key is the smallest stake paying that rate.
assert(feeFor(10).fee === 2 && feeFor(10).prize === 18, '$10 battle @ 10%: $2 fee, $18 prize')
assert(feeFor(50).fee === 10 && feeFor(50).prize === 90, '$50 still pays the 10% band')
assert(feeFor(100).fee === 16 && feeFor(100).prize === 184, '$100 battle @ 8%: $16 fee, $184 prize')
assert(feeFor(500).fee === 60 && feeFor(500).prize === 940, '$500 battle @ 6%: $60 fee, $940 prize')
assert(feeFor(1000).fee === 100 && feeFor(1000).prize === 1900, '$1000 battle @ 5%: $100 fee, $1900 prize')
assert(feeFor(10000).fee === 500 && feeFor(10000).prize === 19500, '$10,000 battle @ 2.5%: $500 fee, $19,500 prize')
assert(feeFor(150).pct === 8 && feeFor(3000).pct === 3, 'stakes inside a band pay that band, not a default')

assert(tokenAllowed('RTHIN3', { mode: 'classic', stake: 10, duration: 900 }).ok === false, 'suspended token blocked')
assert(tokenAllowed('RGIG', { training: true, allowedIds: ['IF'] }).ok === false, 'event token list enforced even in training')
setOverride('RGIG', null); setOverride('RMEW', null); setOverride('RTHIN3', null); setOverride('RPOP', null)

// ---- battle categories (pools): one battle = one pool, no mixing ----
// GHOST wears the shape of a legacy Solana coin (pool 'sol'): its pool no
// longer exists as a battle category, so it must never enter an eth battle -
// and an eth coin must never validate against a pool id that is gone.
assert(tokenAllowed('GHOST', { mode: 'classic', stake: 100, duration: 900, pool: 'sol' }).ok === false, 'a foreign-pool token is rejected in a Solana-memes battle')
assert(tokenAllowed('IF', { mode: 'classic', stake: 100, duration: 900, pool: 'eth' }).ok === false, 'a Solana meme is rejected against a removed pool id')
assert(validateConfig({ mode: 'classic', stake: 100, duration: 300, pool: 'eth' }) !== null, 'the removed Robinhood pool is an unknown battle category now')
assert(validateConfig({ mode: 'classic', stake: 100, duration: 300, pool: 'majors' }) !== null, 'the removed Blue Chips pool is an unknown battle category now')
// Robinhood memes are a LIVE pool. This asserted the opposite for a long time
// and passed only because the fixtures above were hardcoded degen - a test that
// agreed with a stale README instead of with POOL_FUND.
assert(tokenAllowed('IF', { mode: 'live', stake: 100, duration: 900, pool: 'sol' }).ok === true, 'Verified Solana meme ACCEPTED in Live')
assert(tokenAllowed('RTHIN', { mode: 'live', stake: 100, duration: 900, pool: 'sol' }).ok === true, 'a degen Solana meme enters Live too - neither the grade nor the pool gates it, the venue does')
assert(validatePicks(
  [{ tokenId: 'IF', pct: 50 }, { tokenId: 'RDOG', pct: 30 }, { tokenId: 'GHOST', pct: 20 }],
  { mode: 'classic', stake: 100, duration: 900, pool: 'sol' },
) !== null, 'mixed-pool portfolio rejected (2 Solana memes + 1 foreign)')
assert(validatePicks(
  [{ tokenId: 'IF', pct: 50 }, { tokenId: 'RDOG', pct: 30 }, { tokenId: 'MURRE', pct: 20 }],
  { mode: 'classic', stake: 100, duration: 900, pool: 'sol' },
) === null, 'all-Solana-memes portfolio accepted (Classic)')

assert(validateConfig({ mode: 'classic', stake: 7, duration: 300, pool: 'sol' }) !== null, 'invalid stake rejected')
assert(validateConfig({ mode: 'turbo', stake: 100, duration: 300, pool: 'sol' }) !== null, 'invalid mode rejected')
assert(validateConfig({ mode: 'live', stake: 100, duration: 301, pool: 'sol' }) !== null, 'invalid duration rejected')
assert(validateConfig({ mode: 'live', stake: 100, duration: 300 }) !== null, 'missing battle category rejected')
assert(validateConfig({ mode: 'live', stake: 100, duration: 300, pool: 'dogechain' }) !== null, 'unknown category rejected')
assert(validateConfig({ mode: 'classic', stake: 1000, duration: 300, pool: 'sol' }) === null, 'Solana memes open at $1000 - no size gate, a thin book charges its impact instead')
assert(validateConfig({ mode: 'live', stake: 100, duration: 300, pool: 'sol' }) === null, 'valid config accepted')

// ---- Live stake cap: open to $10,000 by default, an emergency knob for admin ----
assert(validateConfig({ mode: 'live', stake: 500, duration: 300, pool: 'sol' }) === null, 'live $500 open at the default $10,000 cap')
assert(validateConfig({ mode: 'classic', stake: 500, duration: 300, pool: 'sol' }) === null, 'classic has no reserve cap')
setSetting('liveMaxStake', 500)
assert(validateConfig({ mode: 'live', stake: 500, duration: 300, pool: 'sol' }) === null, 'live $500 still open at an admin cap of exactly $500')
assert(validateConfig({ mode: 'live', stake: 1000, duration: 300, pool: 'sol' }) !== null, 'live $1000 locks when the admin lowers the cap')

// ---- Robinhood (eth) pool: a real Live pool ----
const ethLive = { mode: 'live', stake: 100, duration: 900, pool: 'sol' }
const ethClassic = { ...ethLive, mode: 'classic' }
assert(validateConfig(ethLive) === null, 'Solana pool opens Live battles on the paper book - it is NOT a Classic-only pool')
assert(validateConfig(ethClassic) === null, 'Solana pool works in Classic')

// A pool with no Verified coins left used to close Live. It no longer does -
// the grade is not the gate any more, so a degen-only book is a full arena in
// both modes. What DOES close Live is the venue, tested below with
// setVenueCheck(() => false).
setDynamic(ETH_FIXTURES.filter((t) => t.category === 'degen'))
assert(validateConfig(ethLive) === null, 'a degen-only Solana pool keeps Live open')
assert(validateConfig(ethClassic) === null, '…and Classic with it')
setDynamic(ETH_FIXTURES)

// ---- the venue gate: a token the treasury cannot execute is never Live ----
//
// A Verified grade says the COIN is sound. It says nothing about whether the
// treasury can trade it, and only the second question keeps a Live payout
// backed. Without this gate a Live battle on a pool with no executor would
// fill on the paper book - fake hedge, real debt.
const { allowedTokenIds } = await import('../server/rules.js')
const { setVenueCheck } = await import('../server/venue.js')

const liveEth10 = { mode: 'live', stake: 10, duration: 900, pool: 'sol' }
const classicEth1000 = { mode: 'classic', stake: 1000, duration: 900, pool: 'sol' }
assert(allowedTokenIds(liveEth10).length === ALL_ETH, 'paper book (testnet default) leaves every Solana coin Live-eligible, degen included')

setVenueCheck(() => false) // mainnet shape today - no Solana venue: no executor at all
assert(allowedTokenIds(liveEth10).length === 0, 'no executor for the pool → none of its tokens may enter Live')
assert(allowedTokenIds({ ...liveEth10, mode: 'classic' }).length === ALL_ETH, '…while Classic is untouched, because there the house holds nothing')
assert(validateConfig(liveEth10) !== null, 'and the battle itself is refused, not just the picks')
assert(validatePicks([
  { tokenId: 'IF', pct: 34 }, { tokenId: 'RDOG', pct: 33 }, { tokenId: 'MURRE', pct: 33 },
], liveEth10) !== null, 'picking them directly is refused too - the gate is not just a list filter')

setVenueCheck(() => true) // restore the permissive default for anything after this

// ---- reachable depth, not the book's own figure, sets the Live stake ceiling ----
//
// Live is settled by buying ON-CHAIN: what matters is how much of the coin the
// venue can actually reach, and the venue reports that per token at runtime.
const { setVenueLimit } = await import('../server/registry.js')
const { effToken } = await import('../server/rules.js')

assert(effToken('MURRE').venueMaxStake == null, 'before the venue reports in, there is no on-chain ceiling to apply')

setVenueLimit('MURRE', { maxStake: 10, reachableLiquidity: 2273 })
setVenueLimit('IF', { maxStake: 1000, reachableLiquidity: 21497803 })

assert(effToken('MURRE').venueMaxStake === 10, 'a thin on-chain market caps how big a Live battle it can back')
assert(effToken('MURRE').maxStake === 1000, '…without touching the coin\'s own ceiling, which Classic still uses')
assert(effToken('MURRE').reachableLiquidity === 2273, 'and the reachable depth is visible, not just the global one')
assert(effToken('IF').venueMaxStake === 1000, 'a deep market carries the full stake')
assert(allowedTokenIds(liveEth10).includes('MURRE'),
  'the thin coin still plays at a stake its book can absorb')
assert(allowedTokenIds(classicEth1000).includes('MURRE'),
  'and Classic is untouched - the house buys nothing there')

try { rmSync(DB_DIR, { recursive: true, force: true }) } catch { /* wal */ }
log(process.exitCode ? 'FAILURES PRESENT' : 'ALL RULES TESTS PASSED')
process.exit(process.exitCode || 0)
