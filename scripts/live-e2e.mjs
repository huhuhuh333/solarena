// Full Live-Arena battle, end to end, through the real DuelManager.
//
// Every other test checks one part. This one runs the whole money path the way a
// player does - queue, match, picks, battle, settlement - and then asks the only
// questions that matter:
//
//   did the winner receive the actual coins from BOTH portfolios?
//   is the treasury holding exactly what it now owes?
//   can the player turn them back into dollars?
//   and did the arena keep its fee, in cash, without ever selling anything?
//
// Paper executor, mocked clock, no network.
//
// Usage: node scripts/live-e2e.mjs

import { rmSync, mkdirSync } from 'node:fs'
const DB_DIR = 'server/data/live-e2e'
rmSync(DB_DIR, { recursive: true, force: true })
mkdirSync(DB_DIR, { recursive: true })
process.env.HOOD_DB = `${DB_DIR}/test.db`
process.env.HOOD_HEDGE_MIN = '1'
process.env.HOOD_RAILS = 'off'

const log = (...a) => console.log('[live-e2e]', ...a)
const fail = (msg) => { console.error('[FAIL]', msg); process.exitCode = 1 }
const assert = (cond, msg) => { if (!cond) fail(msg); else log('ok:', msg) }
const near = (a, b, eps = 0.02) => Math.abs(a - b) < eps

const { db, credit, balanceOf, holdingsOf, holdingOf, holdingsOwed, getLock, chainFunds } = await import('../server/db.js')
const { register } = await import('../server/auth.js')
const { setDynamic } = await import('../server/registry.js')
const { initHedger, rebalance, paperExecutor, hedgeOverview } = await import('../server/hedger.js')
const { DuelManager } = await import('../server/duel.js')
const { feeFor, STAKES, SWAP_COST } = await import('../server/rules.js')
const market = await import('../server/market.js')

// What the treasury should spend on a battle: both entries, net of the fee it
// keeps up front and the spread it crosses on the way in. Derived, never
// hardcoded - the fee ladder is a setting and these numbers must follow it.
const entriesFor = (stake) => 2 * (stake - feeFor(stake).fee / 2) * (1 - SWAP_COST)

// ---- a Solana-pool book the treasury can trade ----
const SAFE = { tradable: true, honeypot: false, buyTaxOk: true, liquidityOk: true }
// DDD exists for the crash-before-hedge scenario at the bottom: a token the
// book has never held, so "was it bought" has an unambiguous answer.
const TOKENS = [['AAA', 'Alpha', 1], ['BBB', 'Beta', 2], ['CCC', 'Gamma', 5], ['DDD', 'Delta', 3]].map(([id, name, base]) => ({
  id, name, ticker: id, pool: 'sol', address: `0x${id.toLowerCase()}`,
  category: 'verified', maxStake: 1000, base, vol: 'high', safety: SAFE,
}))
setDynamic(TOKENS)
for (const t of TOKENS) market.registerToken(t.id, { base: t.base, vol: t.vol })
const prices = { AAA: 1, BBB: 2, CCC: 5, DDD: 3 }
const setPrices = (p) => {
  Object.assign(prices, p)
  market.applyFeed(Object.fromEntries(Object.entries(prices).map(([k, v]) => [k, { price: v }])))
}
setPrices(prices)

// Exactly the wiring index.js uses: open battles plus coins players already own.
let mgr = null
const targets = () => {
  const out = mgr ? { ...mgr.liveExposure() } : {}
  for (const [t, a] of Object.entries(holdingsOwed())) out[t] = (out[t] || 0) + a
  return out
}
initHedger({ getPriceUsd: (s) => prices[s] || 0, exposure: targets, exec: paperExecutor })

// ---- two funded players ----
const sent = []
const hub = { send: (userId, msg) => sent.push({ userId, msg }) }
const manager = new DuelManager(hub)
mgr = manager

const mkPlayer = (name) => {
  const id = register(name, 'hunter22222').session.userId
  db.prepare('UPDATE users SET balance_coin = 0, training_done = 1 WHERE id = ?').run(id)
  db.prepare('DELETE FROM chain_funds WHERE user_id = ?').run(id)
  credit(id, 500, 'deposit', 'Deposit SOL', 'sol')
  return id
}
const alice = mkPlayer('alice')
const bob = mkPlayer('bob')

const cfg = { mode: 'live', stake: 100, duration: 300, pool: 'sol' }

// ---- queue and match ----
// joinQueue is async now (the stake may be pulled on-chain first) - await it.
assert((await manager.joinQueue({ ...db.prepare('SELECT * FROM users WHERE id = ?').get(alice) }, { ...cfg })).ok === true, 'first player queues')
assert(getLock(alice)?.chain === 'sol', 'the stake was taken from the chain this pool settles on')
assert(balanceOf(alice) === 400, '…and $100 left the balance')
assert((await manager.joinQueue({ ...db.prepare('SELECT * FROM users WHERE id = ?').get(bob) }, { ...cfg })).ok === true, 'second player queues and matches')

const room = [...manager.rooms.values()][0]
assert(!!room && room.phase === 'picking', 'a room opened in the pick phase')

// ---- picks: alice goes heavy on the winner, bob on the loser ----
assert(manager.lockPicks(alice, [{ tokenId: 'AAA', pct: 60 }, { tokenId: 'BBB', pct: 20 }, { tokenId: 'CCC', pct: 20 }]).ok === true, 'alice locks a portfolio')
assert(manager.lockPicks(bob, [{ tokenId: 'CCC', pct: 60 }, { tokenId: 'BBB', pct: 20 }, { tokenId: 'AAA', pct: 20 }]).ok === true, 'bob locks a portfolio')

// run the room forward until it goes live
for (let i = 0; i < 40 && room.phase !== 'live'; i++) manager.tick()
if (room.phase !== 'live') {
  console.error('[debug] phase:', room.phase, '| checks:', JSON.stringify(room.checks))
  console.error('[debug] events:', room.events.map((e) => e.msg).join(' | '))
}
assert(room.phase === 'live', 'the battle started and start prices are locked')
assert(!!room.startPrices.AAA, 'start prices captured for the picked tokens')

// ---- the treasury really buys both baskets ----
await rebalance()
const bookAfterBuy = Object.fromEntries(
  db.prepare('SELECT token, amount FROM hedge_positions WHERE amount > 0').all().map((r) => [r.token, r.amount]))
const want = manager.liveExposure()
assert(Object.keys(want).length === 3, 'both baskets net into three positions')
for (const [t, a] of Object.entries(want)) {
  assert(near(bookAfterBuy[t] || 0, a, a * 0.01), `treasury holds the ${t} the players are riding`)
}
const spent = db.prepare(`SELECT SUM(usd) s FROM hedge_trades WHERE side = 'buy'`).get().s
assert(near(spent, entriesFor(100), 1), `it spent both entries net of the fee ($${spent.toFixed(2)} of $200 staked)`)

// ---- AAA moons, CCC dumps: alice wins ----
// Settlement reads a 30-reading TWAP, so the new prices have to actually sit in
// the history - one print is not a battle result.
setPrices({ AAA: 2, BBB: 2, CCC: 2.5 })
for (let i = 0; i < 40; i++) market.stepMarket(1)

room.endsAt = market.simTime() - 1
manager.tick()
assert(room.phase === 'done', 'the battle settled')
assert(room.result.outcomes[0] === 'win', 'alice won on the numbers')

// ---- THE POINT: the winner got coins, not dollars ----
assert(balanceOf(alice) === 400, 'no dollars were credited - the payout is the coins')
assert(balanceOf(bob) === 400, 'the loser is out exactly their stake, nothing more')

const held = Object.fromEntries(holdingsOf(alice).map((h) => [h.token, h.amount]))
assert(Object.keys(held).length === 3, 'alice received all three coins')
for (const [t, a] of Object.entries(want)) {
  assert(near(held[t] || 0, a, a * 0.001), `she got every ${t} from BOTH portfolios`)
}
assert(holdingsOf(bob).length === 0, 'the loser holds nothing')

// ---- the treasury still holds exactly what it owes ----
await rebalance()
const owed = holdingsOwed()
const book = Object.fromEntries(
  db.prepare('SELECT token, amount FROM hedge_positions WHERE amount > 0').all().map((r) => [r.token, r.amount]))
for (const [t, a] of Object.entries(owed)) {
  assert(near(book[t] || 0, a, a * 0.01), `${t}: the book still covers what the winner owns`)
}
const sells = db.prepare(`SELECT COUNT(*) c FROM hedge_trades WHERE side = 'sell'`).get().c
assert(sells === 0, 'and not one coin was sold to pay her - that is the whole point')

// ---- the house kept its fee, in cash, and is flat ----
const feeUsd = room.fee
assert(near(feeUsd, feeFor(100).fee, 0.01), `the arena took its $${feeUsd} fee at entry, in stablecoin`)
const boughtFor = db.prepare(`SELECT SUM(usd) s FROM hedge_trades WHERE side = 'buy'`).get().s
assert(near(200 - boughtFor, 200 - entriesFor(100), 1), 'cash left over = the fee plus the spread: flat on the market, up on the fee')

// ---- she cashes out ----
const { sellHolding } = await import('../server/holdings.js')
const before = balanceOf(alice)
const r = await sellHolding(alice, 'AAA', held.AAA)
assert(r.ok === true, 'selling her coins goes through')
assert(holdingOf(alice, 'AAA') === 0, 'the coins left her account')
assert(balanceOf(alice) > before, 'and the realised dollars arrived')
assert(near(balanceOf(alice) - before, held.AAA * prices.AAA, held.AAA * prices.AAA * 0.01), 'credited at what the sale actually fetched')

await rebalance()
const bookAAA = db.prepare('SELECT amount FROM hedge_positions WHERE token = ?').get('AAA')?.amount ?? 0
assert(bookAAA < 1, 'once she has sold, the treasury stops holding it too')

const ov = hedgeOverview()
assert(Array.isArray(ov.positions) && ov.trades.length > 0, 'admin can see the whole book and every fill')

// ---- a restart mid-battle must not force the treasury to sell ----
//
// Rooms live in memory, so a restart voids whatever was running. Refunding the
// stake in CASH would leave the treasury holding baskets it has to sell to cover
// the refund - the one thing in-kind settlement exists to prevent. So the coins
// go to the players and the house sells nothing.
const { recoverLocks, savedBasketOf } = await import('../server/db.js')
const carol = mkPlayer('carol')
const dave = mkPlayer('dave')
await manager.joinQueue({ ...db.prepare('SELECT * FROM users WHERE id = ?').get(carol) }, { ...cfg })
await manager.joinQueue({ ...db.prepare('SELECT * FROM users WHERE id = ?').get(dave) }, { ...cfg })
const room2 = [...manager.rooms.values()].find((r) => r.phase === 'picking')
manager.lockPicks(carol, [{ tokenId: 'AAA', pct: 50 }, { tokenId: 'BBB', pct: 25 }, { tokenId: 'CCC', pct: 25 }])
manager.lockPicks(dave, [{ tokenId: 'BBB', pct: 50 }, { tokenId: 'AAA', pct: 25 }, { tokenId: 'CCC', pct: 25 }])
for (let i = 0; i < 40 && room2.phase !== 'live'; i++) manager.tick()
assert(room2.phase === 'live', 'a second battle is running')
assert(savedBasketOf(carol).length === 3, 'the basket is on record from battle start')
// The hedger's cycle ran before the crash - the coins are REALLY there. That is
// the premise of in-kind recovery, and since recoverLocks now checks the book
// instead of assuming, the test has to make the premise true the same way
// production does (a rebalance within 30s of battle start).
await rebalance()

const cashBefore = balanceOf(carol)
recoverLocks() // this is what boot does after a crash
assert(balanceOf(carol) === cashBefore, 'a restart does NOT refund cash for coins already bought')
assert(holdingsOf(carol).length === 3, '…the player is handed the coins the treasury is holding')
assert(savedBasketOf(carol).length === 0, 'and the record is cleared so it cannot be paid twice')

const sellsBefore = db.prepare(`SELECT COUNT(*) c FROM hedge_trades WHERE side = 'sell'`).get().c
await rebalance()
const sellsAfter = db.prepare(`SELECT COUNT(*) c FROM hedge_trades WHERE side = 'sell'`).get().c
assert(sellsAfter === sellsBefore, 'and the book sells nothing, because it still owes exactly what it holds')

// ---- a crash BEFORE the hedger's first cycle must refund cash, not coins ----
//
// The basket is written down at battle start; the purchase happens up to 30s
// later. A crash inside that window leaves a basket on record that was never
// bought - and recovery crediting those coins would hand out tokens the
// treasury does not hold. The honest outcome is the player's full stake back
// in money, which is what recoverLocks does once the book says the coins are
// not there. DDD makes the check unambiguous: the book has never held it.
const erin = mkPlayer('erin')
const frank = mkPlayer('frank')
await manager.joinQueue({ ...db.prepare('SELECT * FROM users WHERE id = ?').get(erin) }, { ...cfg })
await manager.joinQueue({ ...db.prepare('SELECT * FROM users WHERE id = ?').get(frank) }, { ...cfg })
const room3 = [...manager.rooms.values()].find((r) => r.phase === 'picking')
assert(!!room3, 'a third battle opened')
manager.lockPicks(erin, [{ tokenId: 'DDD', pct: 50 }, { tokenId: 'AAA', pct: 25 }, { tokenId: 'BBB', pct: 25 }])
manager.lockPicks(frank, [{ tokenId: 'DDD', pct: 50 }, { tokenId: 'BBB', pct: 25 }, { tokenId: 'AAA', pct: 25 }])
for (let i = 0; i < 40 && room3.phase !== 'live'; i++) manager.tick()
assert(room3.phase === 'live', 'it went live - baskets are on record')
// no rebalance() here: the crash beat the hedger to it
recoverLocks()
assert(balanceOf(erin) === 500 && balanceOf(frank) === 500, 'both got their full stake back as MONEY - the coins were never bought')
assert(holdingsOf(erin).length === 0 && holdingsOf(frank).length === 0, 'no phantom coins were credited')
assert(savedBasketOf(erin).length === 0, 'and the unfilled basket record is gone')
assert((db.prepare(`SELECT COUNT(*) c FROM hedge_trades WHERE token = 'DDD'`).get().c) === 0, 'the book never traded the token, confirming the shortfall was real')

// ---- fee bands ----
//
// Sixteen stakes, seven bands. Each band key is the smallest stake paying that
// rate; an exact-key lookup would drop every unlisted stake to the top rate.
assert(STAKES.length === 16 && STAKES[0] === 10 && STAKES[15] === 10000, 'the ladder runs $10 to $10,000')
const rate = (s) => feeFor(s).pct
assert(rate(10) === 10 && rate(20) === 10 && rate(50) === 10, '$10-$50 pay 10%')
assert(rate(100) === 8 && rate(150) === 8 && rate(200) === 8, '$100-$200 pay 8%')
assert(rate(300) === 6 && rate(500) === 6, '$300-$500 pay 6%')
assert(rate(750) === 5 && rate(1000) === 5, '$750-$1,000 pay 5%')
assert(rate(1500) === 4 && rate(2000) === 4, '$1,500-$2,000 pay 4%')
assert(rate(3000) === 3 && rate(5000) === 3, '$3,000-$5,000 pay 3%')
assert(rate(7500) === 2.5 && rate(10000) === 2.5, '$7,500-$10,000 pay 2.5%')
assert(rate(37) === 10 && rate(9999) === 2.5, 'a stake between bands pays its band, never a default')
assert(near(feeFor(10000).fee, 500) && near(feeFor(10000).prize, 19500), '$10,000 battle: $500 to the house, $19,500 to the winner')
assert(near(feeFor(10).fee, 2) && near(feeFor(10).prize, 18), '$10 battle: $2 to the house, $18 to the winner')

// ---- matching down to the nearest smaller table ----
//
// The whole point of sixteen stakes is that they can be bridged. Someone
// waiting at $150 with only a $50 player around should be asked, not stranded -
// and accepting must move them DOWN, never up.
const big = mkPlayer('bigspender')
const small = mkPlayer('smallfry')
await manager.joinQueue({ ...db.prepare('SELECT * FROM users WHERE id = ?').get(small) }, { mode: 'classic', stake: 50, duration: 300, pool: 'sol' })
await manager.joinQueue({ ...db.prepare('SELECT * FROM users WHERE id = ?').get(big) }, { mode: 'classic', stake: 150, duration: 300, pool: 'sol' })
assert(balanceOf(big) === 350, 'the bigger stake is locked in full while they wait')

const offers = () => sent.filter((s) => s.msg.type === 'queue.offer')
manager.offerNearest(big)
assert(offers().length === 1, 'after the wait, the arena proposes the nearest smaller table')
const off = offers()[0].msg
assert(off.userId === undefined && off.yourStake === 150 && off.theirStake === 50, 'it names both numbers plainly')
assert(/\$50/.test(off.text) && /goes back/.test(off.text), 'and says the difference comes back')

// declining leaves everything exactly as it was
assert(manager.acceptNearest(big, false).declined === true, 'declining is allowed')
assert(balanceOf(big) === 350, 'and moves no money')
assert(manager.queueEntryOf(big) !== null, '…and keeps them queued at their own number')
manager.offerNearest(big)
assert(offers().length === 1, 'the same opponent is never proposed twice - declining means "not that one"')

// a closer opponent shows up: the arena must pick the NEAREST one below, not
// just any one, or a $150 player gets pushed all the way down to $50.
const mid = mkPlayer('midstakes')
await manager.joinQueue({ ...db.prepare('SELECT * FROM users WHERE id = ?').get(mid) }, { mode: 'classic', stake: 100, duration: 300, pool: 'sol' })
manager.offerNearest(big)
assert(offers().length === 2 && offers()[1].msg.theirStake === 100, 'a different opponent is proposed, and it is the closest one below')

const res = manager.acceptNearest(big, true)
assert(res.ok === true && res.stake === 100, 'accepting matches them at the SMALLER stake')
assert(balanceOf(big) === 400, 'and hands back the $50 difference')
assert(chainFunds(big).sol === 400, '…onto the chain it was taken from')
const matched = [...manager.rooms.values()].find((r) => r.source === 'stake-matched')
assert(!!matched && matched.cfg.stake === 100, 'a $100 room opened')
assert(matched.players.every((p) => [big, mid].includes(p.userId)), 'with exactly those two players')
assert(near(matched.fee, feeFor(100).fee), 'and the fee is the one for the stake actually played')
assert(manager.queueEntryOf(big) === null && manager.queueEntryOf(mid) === null, 'both left the queue')
assert(manager.queueEntryOf(small) !== null, 'the $50 player is untouched - they never agreed to anything')

try { rmSync(DB_DIR, { recursive: true, force: true }) } catch { /* wal */ }
log(process.exitCode ? 'FAILURES PRESENT' : 'ALL LIVE E2E TESTS PASSED')
process.exit(process.exitCode || 0)
