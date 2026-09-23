// Hedging engine test (paper executor): buys when Live exposure opens, holds
// steady through price moves (token-amount targets = no churn), sells when
// battles close, nets multiple battles into one position.
//
// Usage: node scripts/hedger-test.mjs

import { rmSync, mkdirSync } from 'node:fs'

const DB_DIR = 'server/data/hedger-test'
rmSync(DB_DIR, { recursive: true, force: true })
mkdirSync(DB_DIR, { recursive: true })
process.env.HOOD_DB = `${DB_DIR}/test.db`
process.env.HOOD_HEDGE_MIN = '10'

const log = (...a) => console.log('[hedger]', ...a)
const fail = (msg) => { console.error('[FAIL]', msg); process.exitCode = 1 }
const assert = (cond, msg) => { if (!cond) fail(msg); else log('ok:', msg) }

const { db } = await import('../server/db.js')
const { initHedger, rebalance, hedgeOverview, hedgeValueUsd, paperExecutor } = await import('../server/hedger.js')

const prices = { WIF: 2, BONK: 0.00002 }
let exposure = {}
initHedger({ getPriceUsd: (sym) => prices[sym] || 0, exposure: () => exposure, exec: paperExecutor })

const trades = () => db.prepare('SELECT * FROM hedge_trades ORDER BY id').all()
const pos = (t) => db.prepare('SELECT * FROM hedge_positions WHERE token = ?').get(t) || { amount: 0 }

// no exposure -> no trades
await rebalance()
assert(trades().length === 0, 'no exposure, no trades')

// battle opens: 50 WIF (~$100) -> buy
exposure = { WIF: 50 }
await rebalance()
assert(trades().length === 1 && trades()[0].side === 'buy', 'opening exposure triggers a buy')
assert(Math.abs(pos('WIF').amount - 50 / 1.003) < 0.01, 'paper fill lands at oracle price + slippage')

// price doubles: token-amount target means NO churn
prices.WIF = 4
await rebalance()
assert(trades().length === 1, 'price move causes no churn (target is token amount, not USD)')

// second battle nets into the same position: +25 WIF
exposure = { WIF: 75 }
await rebalance()
assert(trades().length === 2 && trades()[1].side === 'buy', 'second battle netted into one position (one more buy)')
assert(Math.abs(pos('WIF').amount - 75) < 1, 'held amount tracks the netted target')

// small exposure below threshold is ignored
exposure = { WIF: 75, BONK: 100 } // 100 BONK = $0.002 - dust
await rebalance()
assert(pos('BONK').amount === 0, 'dust exposure below the USD threshold is not traded')

// battles settle: sell everything
exposure = {}
await rebalance()
assert(pos('WIF').amount < 0.5, 'closing all battles sells the book down')
assert(trades().some((t) => t.side === 'sell'), 'sell recorded')

// value + overview sanity
assert(hedgeValueUsd() < 2, 'book value ~0 after close')
const ov = hedgeOverview()
assert(ov.venue === 'paper' && Array.isArray(ov.positions) && ov.trades.length >= 3, 'overview exposes venue, positions and trades')

// ---- Live capacity: the float on a chain is what limits how many Live
// battles can be open there, because a stake paid on another chain cannot buy
// that chain's tokens in time. ----
const { hedgeCapacityUsd } = await import('../server/hedger.js')
const { setVenueCapacity, venueCapacityUsd } = await import('../server/venue.js')
const { setDynamic } = await import('../server/registry.js')

assert(hedgeCapacityUsd('sol') === Infinity, 'paper book is uncapped - nothing real is being spent')
assert(venueCapacityUsd('eth') === Infinity, 'unwired venue module is uncapped too (testnet default)')

setDynamic([{ id: 'RHTOK', pool: 'eth', address: '0x1' }, { id: 'WIF', pool: 'sol', address: 'wif' }])
prices.RHTOK = 1
let cash = 200
const cappedExec = {
  venue: 'fake', canTrade: () => true,
  spendableUsd: (pool) => (pool === 'eth' ? cash : Infinity),
  async refresh() {},
  trade: (...a) => paperExecutor.trade(...a),
}
exposure = {}
initHedger({ getPriceUsd: (sym) => prices[sym] || 0, exposure: () => exposure, exec: cappedExec })

assert(hedgeCapacityUsd('eth') === 200, 'capacity is the cash sitting on that chain')
assert(hedgeCapacityUsd('sol') === Infinity, 'a chain with no real venue stays uncapped')

// spend half the float on a hedge: capacity must not drop, it moved into tokens
exposure = { RHTOK: 100 }
await rebalance()
cash = 100
const capAfter = hedgeCapacityUsd('eth')
assert(capAfter > 190 && capAfter < 210, 'buying does not destroy capacity - cash became a position worth the same')

setVenueCapacity((pool) => hedgeCapacityUsd(pool))
assert(venueCapacityUsd('eth') === capAfter, 'the arena reads capacity through the venue module')
assert(venueCapacityUsd('majors') === Infinity, 'pools with no real venue are never capped')

cash = 0
exposure = {}
await rebalance()
assert(hedgeCapacityUsd('eth') < 5, 'an empty chain has no capacity, so no Live battle may open there')

try { rmSync(DB_DIR, { recursive: true, force: true }) } catch { /* wal */ }
log(process.exitCode ? 'FAILURES PRESENT' : 'ALL HEDGER TESTS PASSED')
process.exit(process.exitCode || 0)
