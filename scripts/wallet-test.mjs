// Custody rails test with MOCK chain adapters: cumulative-ledger deposit
// crediting, network fees, AUTO-SWEEP to treasury, withdrawal queue
// (auto-approve threshold, admin approve/reject, refunds on failure).
// No network involved.
//
// Usage: node scripts/wallet-test.mjs

import { rmSync, mkdirSync } from 'node:fs'

const DB_DIR = 'server/data/wallet-test'
rmSync(DB_DIR, { recursive: true, force: true })
mkdirSync(DB_DIR, { recursive: true })
process.env.HOOD_DB = `${DB_DIR}/test.db`
process.env.HOOD_WALLET_SEED = 'ab'.repeat(32)
process.env.HOOD_AUTO_WITHDRAW_MAX = '25'
process.env.HOOD_DEPOSIT_FEE = '1'   // flat $1 for easy math
process.env.HOOD_WITHDRAW_FEE = '2'  // flat $2

const log = (...a) => console.log('[wallet]', ...a)
const fail = (msg) => { console.error('[FAIL]', msg); process.exitCode = 1 }
const assert = (cond, msg) => { if (!cond) fail(msg); else log('ok:', msg) }

const { register } = await import('../server/auth.js')
const { balanceOf, balanceCoinOf, setLedgerPrice, db } = await import('../server/db.js')
const wallet = await import('../server/wallet.js')

// ---- mock chains (sweep decrements the address balance, like a real chain) ----
const mkMock = (id, label, nativeSymbol) => {
  const balances = new Map()
  const sent = []
  const sweeps = []
  let failNext = false
  return {
    id, label, icon: '·', nativeSymbol, nativeDecimals: 9, usdcDecimals: 6, network: `${label} mocknet`,
    explorer: 'x/{tx}',
    address: (who) => `mock_${id}_${who}`,
    validAddress: (a) => String(a).startsWith('mock'),
    async balances(address) { return balances.get(address) || { native: 0n, usdc: 0n } },
    async send(fromWho, to, asset, baseUnits) {
      if (failNext) { failNext = false; throw new Error('mock chain congestion') }
      sent.push({ fromWho, to, asset, baseUnits })
      return 'tx_' + sent.length
    },
    async sweep(who, to, asset, baseUnits) {
      const addr = `mock_${id}_${who}`
      const b = balances.get(addr) || { native: 0n, usdc: 0n }
      b[asset] -= baseUnits
      balances.set(addr, b)
      sweeps.push({ who, to, asset, baseUnits })
      return { txhash: 'sweep_' + sweeps.length, sent: baseUnits }
    },
    _setBalance(address, patch) { balances.set(address, { ...(balances.get(address) || { native: 0n, usdc: 0n }), ...patch }) },
    _sent: sent,
    _sweeps: sweeps,
    _failNext: () => { failNext = true },
  }
}

const sol = mkMock('sol', 'Solana', 'SOL')
const prices = { SOL: 100 }

// One price for crediting a deposit, storing the balance and paying a
// withdrawal - exactly how index.js wires it.
setLedgerPrice(() => prices.SOL)
wallet.initWalletRails({
  getPriceUsd: (sym) => prices[sym] || 0,
  chainAdapters: { sol },
})

const r = register('wally', 'hunter22222')
if (r.error) throw new Error(r.error)
const uid = r.session.userId
db.prepare('UPDATE users SET balance_coin = 0 WHERE id = ?').run(uid)
db.prepare('DELETE FROM chain_funds WHERE user_id = ?').run(uid)

// ---- deposit address ----
const addrs1 = wallet.depositAddresses(uid)
const addrs2 = wallet.depositAddresses(uid)
assert(addrs1.length === 1 && addrs1[0].address === 'mock_sol_' + uid, 'one Solana deposit address, derived per user')
assert(JSON.stringify(addrs1) === JSON.stringify(addrs2), 'deposit addresses are stable across calls')

// ---- deposits: credit minus network fee, then auto-sweep ----
sol._setBalance('mock_sol_' + uid, { native: 2_000_000_000n }) // 2 SOL @ $100 = $200 gross
await wallet.pollDeposits()
assert(Math.abs(balanceOf(uid) - 199) < 0.01, 'SOL deposit credited at live price minus $1 fee (2 SOL -> $199)')
assert(Math.abs(balanceCoinOf(uid) - 1.99) < 1e-9, '...and held as 1.99 SOL')
assert(sol._sweeps.length === 1 && sol._sweeps[0].baseUnits === 2_000_000_000n, 'deposit auto-swept to treasury in full')
assert(sol._sweeps[0].to === 'mock_sol_treasury', 'sweep goes to the treasury address')

await wallet.pollDeposits()
assert(Math.abs(balanceOf(uid) - 199) < 0.01, 'no double-credit after the sweep emptied the address')

sol._setBalance('mock_sol_' + uid, { native: 500_000_000n }) // +0.5 SOL
await wallet.pollDeposits()
assert(Math.abs(balanceOf(uid) - 248) < 0.01, 'incremental deposit credits the delta minus fee (+$49)')
assert(sol._sweeps.length === 2, 'second deposit swept too')
assert(db.prepare('SELECT COUNT(*) c FROM deposits WHERE user_id = ?').get(uid).c === 2, 'two deposit records written')
assert(db.prepare('SELECT fee FROM deposits WHERE user_id = ? ORDER BY id LIMIT 1').get(uid).fee === 1, 'network fee recorded on the deposit')

// ---- withdrawals ----
assert(wallet.requestWithdrawal(uid, { chain: 'sol', to: 'nope', usd: 20 }).error, 'invalid address rejected')
assert(wallet.requestWithdrawal(uid, { chain: 'sol', to: 'mock_dest', usd: 2 }).error, 'below-minimum rejected')
assert(wallet.requestWithdrawal(uid, { chain: 'sol', to: 'mock_dest', usd: 9999 }).error, 'insufficient balance rejected')

const small = wallet.requestWithdrawal(uid, { chain: 'sol', to: 'mock_dest', usd: 20 })
assert(small.ok && small.status === 'approved', 'small withdrawal auto-approved (<= $25)')
assert(Math.abs(balanceOf(uid) - 228) < 0.01, 'withdrawal debits balance immediately')
await wallet.processWithdrawals()
const w1 = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(small.id)
assert(w1.status === 'sent' && w1.txhash === 'tx_1', 'auto-approved withdrawal paid on-chain')
assert(sol._sent[0].asset === 'native' && sol._sent[0].baseUnits === 180_000_000n, 'payout is net of the $2 fee (0.18 SOL for $20)')

const big = wallet.requestWithdrawal(uid, { chain: 'sol', to: 'mock_dest', usd: 100 })
assert(big.ok && big.status === 'pending', 'large withdrawal waits for approval')
assert(wallet.decideWithdrawal(big.id, false, 'admin').ok, 'admin can reject')
assert(Math.abs(balanceOf(uid) - 228) < 0.01, 'rejected withdrawal refunds in full')

const big2 = wallet.requestWithdrawal(uid, { chain: 'sol', to: 'mock_dest', usd: 100 })
wallet.decideWithdrawal(big2.id, true, 'admin')
// SOL moves while the request waits: the coin that left the balance is what goes out.
prices.SOL = 125
await wallet.processWithdrawals()
const w2 = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(big2.id)
assert(w2.status === 'sent' && Math.abs(w2.asset_amount - 0.98) < 1e-9, 'approved withdrawal sends 0.98 SOL for $100 minus $2 fee, whatever SOL did meanwhile')
assert(sol._sent[1].baseUnits === 980_000_000n, 'native base units correct')
prices.SOL = 100

// failure path: chain error refunds automatically
const balBefore = balanceOf(uid)
const f = wallet.requestWithdrawal(uid, { chain: 'sol', to: 'mock_dest', usd: 25 })
assert(f.status === 'approved', 'auto-approved at exactly the threshold')
sol._failNext()
await wallet.processWithdrawals()
const w3 = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(f.id)
assert(w3.status === 'failed' && /congestion/.test(w3.note), 'on-chain failure recorded')
assert(Math.abs(balanceOf(uid) - balBefore) < 0.01, 'failed withdrawal refunded in full')

// ---- a stake that is not in the balance is refused with a way forward ----
const fund = await wallet.ensureFunded(uid, 99999)
assert(fund.error && fund.needsDeposit, 'a stake above the balance is refused, and the refusal says "deposit"')
assert((await wallet.ensureFunded(uid, 10)).ok, 'a stake the balance covers passes')

// ---- reconcile: crash between sweep tx and bookkeeping never double-credits ----
sol._setBalance('mock_sol_' + uid, { native: 1_000_000_000n }) // 1 SOL arrives
await wallet.pollDeposits() // credited (+$99) and swept
const balAfterDep = balanceOf(uid)
// simulate lost bookkeeping: pretend we recorded nothing as swept
db.prepare(`UPDATE wallet_ledger SET swept = '0' WHERE user_id = ? AND chain = 'sol' AND asset = 'native'`).run(uid)
await wallet.pollDeposits() // balance < credited-swept -> reconcile, NOT a new credit
assert(Math.abs(balanceOf(uid) - balAfterDep) < 0.01, 'reconcile path never double-credits after a crash')

// ---- backing report ----
const backing = await wallet.backingReport(0)
assert(backing.liabilities > 0 && typeof backing.ratio === 'number', 'backing report computes liabilities and ratio')
assert(backing.unsweptUsd === 0, 'everything credited is swept - no funds stranded on deposit addresses')

const t = await wallet.treasuryOverview()
assert(t.length === 1 && t[0].address === 'mock_sol_treasury', 'treasury overview lists the derived treasury address')

try { rmSync(DB_DIR, { recursive: true, force: true }) } catch { /* wal */ }
log(process.exitCode ? 'FAILURES PRESENT' : 'ALL WALLET TESTS PASSED')
process.exit(process.exitCode || 0)
