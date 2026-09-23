// Funds test: which money may pay for what, on the one rail (Solana).
//
// Every unit of balance is attributed to the chain it stands on. With one rail
// that is always 'sol' - and anything a caller tries to file elsewhere lands
// there too, because a bucket on a chain nobody carries is money nobody can pay.
//
// The rule the arena runs on:
//   Classic - the house holds nothing, the two stakes settle against each other.
//   Live    - the treasury buys the basket on Solana with SOL, so the stake must
//             already stand there.
//
// Plain DB accounting - no chains, no network.
//
// Usage: node scripts/funds-test.mjs

import { rmSync, mkdirSync } from 'node:fs'
const DB_DIR = 'server/data/funds-test'
rmSync(DB_DIR, { recursive: true, force: true })
mkdirSync(DB_DIR, { recursive: true })
process.env.HOOD_DB = `${DB_DIR}/test.db`

const log = (...a) => console.log('[funds]', ...a)
const fail = (msg) => { console.error('[FAIL]', msg); process.exitCode = 1 }
const assert = (cond, msg) => { if (!cond) fail(msg); else log('ok:', msg) }

const { register } = await import('../server/auth.js')
const {
  db, credit, debit, balanceOf, chainFunds, fundsOn, chainLiabilities,
  lockStake, releaseLock, getLock, lockPlan,
} = await import('../server/db.js')
const { poolFund } = await import('../src/engine/tokens.js')

const newUser = (name) => {
  const r = register(name, 'hunter22222')
  if (r.error) throw new Error(r.error)
  db.prepare('UPDATE users SET balance_coin = 0 WHERE id = ?').run(r.session.userId)
  db.prepare('DELETE FROM chain_funds WHERE user_id = ?').run(r.session.userId)
  return r.session.userId
}

const u = newUser('funder')

// ---- pool → chain map ----
assert(poolFund('sol').chain === 'sol' && poolFund('sol').asset === 'SOL', 'Solana memes are bought with SOL on Solana')
assert(poolFund('eth') === null, 'the retired Robinhood pool has no Live funding')
assert(poolFund('majors') === null, 'the retired Blue Chips pool has no Live funding')

// ---- deposits land on the rail ----
credit(u, 100, 'deposit', 'Deposit SOL', 'sol')
assert(balanceOf(u) === 100 && fundsOn(u, 'sol') === 100, 'a deposit is filed on Solana')
// A caller naming a chain that no longer exists cannot open a bucket for it.
credit(u, 25, 'refund', 'filed under a retired rail', 'rh')
assert(fundsOn(u, 'rh') === 0 && fundsOn(u, 'sol') === 125, 'money filed under a retired chain lands on the rail')
assert(Object.keys(chainFunds(u)).every((c) => c === 'sol'), 'no bucket exists off the rail')

// ---- Live: only money standing on the rail ----
assert(lockStake(u, 500, 'live', poolFund('sol')).ok === false, 'Live refuses a stake the balance cannot cover')
assert(balanceOf(u) === 125, 'a refused stake takes nothing')
assert(lockStake(u, 50, 'live', poolFund('sol')).ok === true, 'Live plays with the SOL on the rail')
assert(fundsOn(u, 'sol') === 75 && getLock(u).chain === 'sol', 'the stake came out of Solana, and the lock remembers it')

// ---- refunds return exactly what was taken ----
releaseLock(u, { refund: true, note: 'cancelled' })
assert(fundsOn(u, 'sol') === 125, 'a refund goes back to where it came from')

// ---- Classic ----
assert(lockStake(u, 40, 'classic').ok === true, 'Classic takes a stake with no chain requirement')
assert(lockPlan(getLock(u)).every((p) => p.chain === 'sol'), 'and records the exact split it was funded from')
releaseLock(u, { refund: true })
assert(balanceOf(u) === 125, 'a Classic round trip returns every cent')

// ---- withdrawals ----
assert(debit(u, 200, 'withdraw', 'too much', 'sol') === false, 'cannot withdraw more than the balance')
assert(balanceOf(u) === 125, 'a refused withdrawal takes nothing')
const plan = debit(u, 50, 'withdraw', 'payout', 'sol')
assert(plan && plan.length === 1 && plan[0].chain === 'sol', 'a withdrawal spends the rail')
assert(debit(u, 999999, 'withdraw', 'overdraw') === false, 'no overdrawing')
assert(chainLiabilities().sol > 0, 'the arena knows what it owes on the rail')

// ---- a total with no chain behind it is unusable, not silently spendable ----
const legacy = newUser('legacy')
db.prepare('UPDATE users SET balance_coin = 500 WHERE id = ?').run(legacy)
assert(balanceOf(legacy) === 500 && fundsOn(legacy, 'sol') === 0, 'setup: a total with nothing located behind it')
assert(lockStake(legacy, 100, 'live', poolFund('sol')).ok === false, 'unlocated balance cannot open a Live battle')
assert(lockStake(legacy, 100, 'classic').ok === false, '…nor a Classic one - the arena only spends money it can point at')
assert(debit(legacy, 100, 'withdraw', 'unlocated', 'sol') === false, '…and cannot be withdrawn')

try { rmSync(DB_DIR, { recursive: true, force: true }) } catch { /* wal */ }
log(process.exitCode ? 'FAILURES PRESENT' : 'ALL FUNDS TESTS PASSED')
process.exit(process.exitCode || 0)
