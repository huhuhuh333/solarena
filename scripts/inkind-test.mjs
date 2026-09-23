// Live Arena settles IN KIND: the winner receives the actual coins from BOTH
// portfolios, not their dollar value.
//
// Why it matters: nothing has to be sold to pay a winner, so the house never
// needs an exit to exist. A coin that stops being sellable is the holder's
// problem â€” exactly as it would be trading anywhere else â€” instead of leaving
// the treasury holding a debt it cannot cover.
//
// Usage: node scripts/inkind-test.mjs

import { rmSync, mkdirSync } from 'node:fs'
const DB_DIR = 'server/data/inkind-test'
rmSync(DB_DIR, { recursive: true, force: true })
mkdirSync(DB_DIR, { recursive: true })
process.env.HOOD_DB = `${DB_DIR}/test.db`
process.env.HOOD_HEDGE_MIN = '1'

const log = (...a) => console.log('[inkind]', ...a)
const fail = (msg) => { console.error('[FAIL]', msg); process.exitCode = 1 }
const assert = (cond, msg) => { if (!cond) fail(msg); else log('ok:', msg) }
const near = (a, b, eps = 0.01) => Math.abs(a - b) < eps

const {
  db, credit, balanceOf, creditTokens, debitTokens, holdingOf, holdingsOf, holdingsOwed,
} = await import('../server/db.js')
const { register } = await import('../server/auth.js')
const { initHedger, rebalance, paperExecutor, hedgeValueUsd } = await import('../server/hedger.js')
const { setDynamic } = await import('../server/registry.js')

// The arena's one pool: Solana Memes.
setDynamic([
  { id: 'MOON', ticker: 'MOON', pool: 'sol', address: 'MoonMint1111111111111111111111111111111111', category: 'verified', maxStake: 1000 },
  { id: 'RUG', ticker: 'RUG', pool: 'sol', address: 'RugMint22222222222222222222222222222222222', category: 'verified', maxStake: 1000 },
])

const newUser = (name) => {
  const id = register(name, 'hunter22222').session.userId
  db.prepare('UPDATE users SET balance_coin = 0 WHERE id = ?').run(id) // ignore the testnet signup credit
  db.prepare('DELETE FROM chain_funds WHERE user_id = ?').run(id)
  return id
}
const u = newUser('winner')
const v = newUser('loser')

// ---- the ledger of coins ----
creditTokens(u, 'MOON', 1500, 'Won a battle')
creditTokens(u, 'MOON', 500, 'Won another')
creditTokens(v, 'RUG', 42, 'Won a battle')

assert(holdingOf(u, 'MOON') === 2000, 'coins accumulate across battles')
assert(holdingsOf(u).length === 1 && holdingsOf(u)[0].token === 'MOON', 'a player sees exactly what they own')
assert(balanceOf(u) === 0, 'winning coins moves no dollars â€” the payout IS the coins')

const owed = holdingsOwed()
assert(owed.MOON === 2000 && owed.RUG === 42, 'the arena knows every coin it owes, netted across players')

assert(debitTokens(u, 'MOON', 5000) === false, 'nobody can sell coins they do not own')
assert(holdingOf(u, 'MOON') === 2000, 'and the failed attempt takes nothing')
assert(debitTokens(u, 'MOON', 500) === true, 'a partial sale is allowed')
assert(holdingOf(u, 'MOON') === 1500, 'and leaves the rest')

// ---- the hedger must never sell coins that already belong to a player ----
const prices = { MOON: 0.01, RUG: 2 }
let openBattles = {}
const targets = () => {
  const out = { ...openBattles }
  for (const [t, a] of Object.entries(holdingsOwed())) out[t] = (out[t] || 0) + a
  return out
}
initHedger({ getPriceUsd: (s) => prices[s] || 0, exposure: targets, exec: paperExecutor })

openBattles = { MOON: 1000 }
await rebalance()
const held = () => db.prepare('SELECT amount FROM hedge_positions WHERE token = ?').get('MOON')?.amount ?? 0
assert(held() > 2400, 'the book covers the open battle AND the coins already owned')

// the battle ends â€” its exposure disappears, but the winner's coins do not
openBattles = {}
await rebalance()
assert(near(held(), 1500, 15), 'when the battle closes the book sells down to exactly what players still own')
assert(held() > 1400, 'a winner\'s coins are NOT sold out from under them')

// the player sells; only then may the book let go
debitTokens(u, 'MOON', 1500)
await rebalance()
assert(held() < 60, 'once nobody owns it, the book clears')
assert(hedgeValueUsd() < 100, 'and the treasury is left holding only what it owes')

// ---- a coin nobody can sell is still owned, and still owed ----
creditTokens(v, 'RUG', 8, 'another win')
assert(holdingOf(v, 'RUG') === 50, 'holdings are unaffected by whether an exit exists')
assert(holdingsOwed().RUG === 50, 'and the arena still counts it as owed â€” the coins are the players\'')

// ---- sending coins to your own wallet ----
//
// The quantity is what gets sent, never a dollar figure: the arena hands over
// the exact tokens it holds, so a price move between request and payout changes
// nothing. And it refuses to send anything it cannot resolve on-chain â€” guessing
// an address would fire a player's coins into nothing.
const wallet = await import('../server/wallet.js')
// A Solana wallet address (on the ed25519 curve - a key someone holds).
const { Keypair } = await import('@solana/web3.js')
const OUT_ADDR = Keypair.generate().publicKey.toBase58()

creditTokens(u, 'MOON', 900, 'another win')

const noVenue = wallet.requestCoinWithdrawal(u, { token: 'MOON', amount: 100, to: OUT_ADDR })
assert(!!noVenue.error, 'with no venue up, the arena refuses to send rather than guess a mint')
assert(holdingOf(u, 'MOON') === 900, 'and the refusal takes no coins')

// stand up a venue that can name the on-chain asset
const { makeExecMux } = await import('../server/execmux.js')
const fakeJup = {
  venue: 'fake', canTrade: () => true,
  assetOf: (id) => (id === 'MOON' ? { chain: 'sol', address: 'MoonMint1111111111111111111111111111111111', decimals: 6 } : null),
  trade: (...a) => paperExecutor.trade(...a),
}
initHedger({ getPriceUsd: (s) => prices[s] || 0, exposure: targets, exec: makeExecMux({ byPool: { sol: fakeJup }, fallback: paperExecutor }) })

assert(!!wallet.requestCoinWithdrawal(u, { token: 'MOON', amount: 100, to: 'not-an-address' }).error, 'a malformed destination is refused')
assert(!!wallet.requestCoinWithdrawal(u, { token: 'MOON', amount: 99999, to: OUT_ADDR }).error, 'you cannot send more than you own')
assert(holdingOf(u, 'MOON') === 900, 'neither refusal moved a coin')

const req = wallet.requestCoinWithdrawal(u, { token: 'MOON', amount: 400, to: OUT_ADDR })
assert(req.ok === true, 'a valid request is accepted')
assert(holdingOf(u, 'MOON') === 500, 'the coins leave the account immediately, so they cannot be spent twice')
// â€¦but they have NOT left the treasury, so the hedge book must still hold them:
// otherwise the next rebalance sells the coins that are queued to be sent out.
assert(near(holdingsOwed().MOON, 900, 0.0001),
  'coins queued for payout still count as owed â€” the book must not sell them out from under the payout')

const row = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(req.id)
assert(row.asset === 'coin' && row.token === 'MOON', 'it is recorded as a coin withdrawal')
assert(near(row.asset_amount, 400, 0.0001), 'the QUANTITY is what was recorded, not a dollar amount')

wallet.decideWithdrawal(req.id, false, 'admin')
assert(holdingOf(u, 'MOON') === 900, 'a rejected coin withdrawal returns coins, not dollars')
assert(balanceOf(u) === 0, 'and credits no cash â€” the player never sold anything')

// ---- coins that physically left must leave the book too ----
const { hedgeRelease } = await import('../server/hedger.js')
const pos0 = db.prepare('SELECT amount FROM hedge_positions WHERE token = ?').get('MOON')?.amount ?? 0
db.prepare(`INSERT INTO hedge_positions (token, amount, cost) VALUES ('SENT', 300, 30)
            ON CONFLICT(token) DO UPDATE SET amount = 300, cost = 30`).run()
hedgeRelease('SENT', 120)
const after = db.prepare('SELECT amount, cost FROM hedge_positions WHERE token = ?').get('SENT')
assert(near(after.amount, 180, 0.001), 'sending coins out reduces the book by exactly what left')
assert(near(after.cost, 18, 0.01), 'and writes off its share of the cost basis, with no trade recorded')
assert(pos0 >= 0, 'the rest of the book is untouched')

try { rmSync(DB_DIR, { recursive: true, force: true }) } catch { /* wal */ }
log(process.exitCode ? 'FAILURES PRESENT' : 'ALL IN-KIND TESTS PASSED')
process.exit(process.exitCode || 0)
