// Deposit sweep unit test - the batched read must be an OPTIMISATION and never
// a semantic change.
//
// The one rule this file exists to defend, in the deposit watcher's own words:
// "a failed read skips the address entirely - it must never be treated as
// 'balance is zero', which would make the reconcile branch mark live funds as
// swept." A batch makes that rule easier to break: 200 addresses now ride on one
// request, so one clumsy catch could zero all 200 at once and sweep real money.
//
// Usage: node scripts/deposit-batch-test.mjs

import { rmSync, mkdirSync } from 'node:fs'

const DB_DIR = 'server/data/deposit-batch-test'
rmSync(DB_DIR, { recursive: true, force: true })
mkdirSync(DB_DIR, { recursive: true })
process.env.HOOD_DB = `${DB_DIR}/test.db`
process.env.HOOD_SWEEP = 'off' // this test is about reading, not moving

const log = (...a) => console.log('[dep]', ...a)
const fail = (m) => { console.error('[FAIL]', m); process.exitCode = 1 }
const assert = (c, m) => { if (!c) fail(m); else log('ok:', m) }

const { db } = await import('../server/db.js')

// ---------------------------------------------------------------------------
// A fake chain adapter, so the test never touches a real network. It answers
// like the Solana adapter does and can be told to fail in each of the ways that
// matter.
// ---------------------------------------------------------------------------
const mkChain = (mode) => {
  const held = new Map([
    ['0xA', { native: 5_000_000_000n, usdc: 0n }], // 5 SOL ($5 at a $1 test price) sitting on the address
    ['0xB', { native: 0n, usdc: 0n }],
    ['0xA2', { native: 5_000_000_000n, usdc: 0n }],
  ])
  return {
    id: 'test', label: 'Test', usdcDecimals: 6, nativeDecimals: 9, nativeSymbol: 'SOL',
    calls: { many: 0, single: 0 },
    address: () => '0xTREASURY',
    async balancesMany(addresses) {
      this.calls.many++
      if (mode === 'batch-throws') throw new Error('rate limited')
      const out = new Map()
      for (const a of addresses) {
        // 'partial' = this address could not be read this round. It must come
        // back ABSENT, which is exactly what the real adapter does when a
        // sub-call reports success:false.
        if (mode === 'partial' && a === '0xA') continue
        out.set(a, held.get(a))
      }
      return out
    },
    async balancesFresh(a) {
      this.calls.single++
      if (mode === 'single-throws') throw new Error('rate limited')
      return held.get(a)
    },
    async balances(a) { return this.balancesFresh(a) },
  }
}

// No test-only hooks in production code: adapters already go in through
// initWalletRails, and the ledger is read straight out of its table.
const { initWalletRails, pollDeposits } = await import('../server/wallet.js')
const useChain = (chain) => initWalletRails({ getPriceUsd: () => 1, chainAdapters: { test: chain } })
const ledgerOf = (userId, asset) => {
  const r = db.prepare('SELECT credited, swept FROM wallet_ledger WHERE user_id = ? AND chain = ? AND asset = ?')
    .get(userId, 'test', asset)
  return { credited: BigInt(r?.credited ?? '0'), swept: BigInt(r?.swept ?? '0') }
}

// One deposit address per user per chain - the table says so (UNIQUE on
// user_id, chain), which is also why the address count is users x chains and
// why the sweep grows with sign-ups.
let seq = 0
const seed = (address) => {
  const r = db.prepare(`INSERT INTO users (name, pass_hash, avatar, bio, created, balance)
                        VALUES (?, 'x', 'T', '', ?, 0)`).run('u' + (++seq), Date.now())
  const uid = Number(r.lastInsertRowid)
  db.prepare('INSERT INTO deposit_addresses (user_id, chain, address, created) VALUES (?, ?, ?, ?)')
    .run(uid, 'test', address, Date.now())
  return uid
}

// ---------------------------------------------------------------------------
// 1. the happy path: a batched read credits exactly what a single read would
// ---------------------------------------------------------------------------
let chain = mkChain('ok')
useChain(chain)
const u1 = seed('0xA')
const uB = seed('0xB')
await pollDeposits()
const bal1 = db.prepare('SELECT balance_coin FROM users WHERE id = ?').get(u1).balance_coin
assert(bal1 > 0, `a batched read credits the $5 that was sitting on the address (got $${bal1})`)
assert(chain.calls.many === 1 && chain.calls.single === 0, 'and it did it in ONE batched call, not one per address')

// ---------------------------------------------------------------------------
// 2. THE RULE: an address the batch could not read is skipped, not zeroed
// ---------------------------------------------------------------------------
const ledBefore = ledgerOf(u1, 'native')
chain = mkChain('partial')
useChain(chain)
await pollDeposits()
const ledAfter = ledgerOf(u1, 'native')
assert(ledAfter.swept === ledBefore.swept,
  'an address missing from the batch is NOT swept - an unread balance is not a zero')
assert(ledAfter.credited === ledBefore.credited, '...and nothing is re-credited for it either')

// ---------------------------------------------------------------------------
// 3. a batch that cannot be made falls back, and the money still lands
// ---------------------------------------------------------------------------
chain = mkChain('batch-throws')
useChain(chain)
const u2 = seed('0xA2')
await pollDeposits()
const bal2 = db.prepare('SELECT balance_coin FROM users WHERE id = ?').get(u2).balance_coin
assert(bal2 > 0, 'when the batch throws, the sweep falls back to one address at a time and still credits')
assert(chain.calls.single > 0, '...using the per-address path')

// ---------------------------------------------------------------------------
// 4. every read failing must still not sweep anybody
// ---------------------------------------------------------------------------
const led2Before = ledgerOf(u2, 'native')
chain = mkChain('single-throws')
chain.balancesMany = async () => { throw new Error('rate limited') }
useChain(chain)
await pollDeposits()
const led2After = ledgerOf(u2, 'native')
assert(led2After.swept === led2Before.swept,
  'a total read failure sweeps nothing - the ledger is untouched rather than zeroed')

// ---------------------------------------------------------------------------
// 5. one sweep at a time: a slow sweep must not have the next start on top
// ---------------------------------------------------------------------------
let concurrent = 0
let maxConcurrent = 0
chain = mkChain('ok')
chain.balancesMany = async (addresses) => {
  concurrent++
  maxConcurrent = Math.max(maxConcurrent, concurrent)
  await new Promise((r) => setTimeout(r, 60))
  concurrent--
  return new Map(addresses.map((a) => [a, { native: 0n, usdc: 0n }]))
}
useChain(chain)
await Promise.all([pollDeposits(), pollDeposits(), pollDeposits()])
assert(maxConcurrent === 1, 'three sweeps fired at once run as one - the re-entrancy guard holds')

log(process.exitCode ? 'FAILURES ABOVE' : 'all good')
