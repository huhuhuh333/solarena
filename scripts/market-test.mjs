// Market engine: a chart labelled LIVE PRICES must show real price action, not
// the fabricated random walk the sim draws around a stale seed (BTC seeded near
// 117k while real is ~64k). The moment a real price lands, the simulated past is
// discarded - no invented shape, no step where fiction meets reality.
//
// Usage: node scripts/market-test.mjs

const log = (...a) => console.log('[market]', ...a)
const fail = (msg) => { console.error('[FAIL]', msg); process.exitCode = 1 }
const assert = (cond, msg) => { if (!cond) fail(msg); else log('ok:', msg) }

const m = await import('../server/market.js')

// No curated tokens are seeded at boot any more - register the test token the
// same way the ingest registers a discovered coin, with a deliberately stale
// seed far from the "real" price the feed will bring.
m.registerToken('BTC', { base: 117400, vol: 'low' })

// Build a simulated history at the seed level (no feed yet).
for (let i = 0; i < 60; i++) m.stepMarket(1)
const before = m.getHist('BTC').map((h) => h.p)
assert(before.length > 10, 'the sim built a history before any real price arrived')
assert(before[0] > 100000, 'the seed history sits at the stale seed level, not reality')

// First real print lands far from the seed. This is the moment that used to cliff.
m.applyFeed({ BTC: { price: 64000, change24: -1 } })
const after = m.getHist('BTC').map((h) => h.p)

assert(Math.abs(m.getPrice('BTC') - 64000) < 1, 'the live price is now the real one')
assert(after.length === 1 && Math.abs(after[0] - 64000) < 1,
  'the simulated past is discarded - the chart restarts clean at the real price')
assert(!after.some((p) => p > 100000), 'no fabricated seed-level point survives into the live chart')

// From here the chart accumulates only genuine prints, each a real move.
m.stepMarket(1)
m.applyFeed({ BTC: { price: 64500 } })
m.stepMarket(1)
const live = m.getHist('BTC').map((h) => h.p)
assert(Math.abs(m.getPrice('BTC') - 64500) < 1, 'later prints follow the live feed directly')
const worst = Math.max(...live.slice(1).map((p, i) => Math.abs(p / live[i] - 1)))
assert(worst < 0.02, `every step in the live chart is a real move, none a cliff (worst ${(worst * 100).toFixed(2)}%)`)

log(process.exitCode ? 'FAILURES PRESENT' : 'ALL MARKET TESTS PASSED')
process.exit(process.exitCode || 0)
