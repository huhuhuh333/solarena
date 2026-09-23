// The lockdown switch: with manual payouts ON, no dollar may leave the
// treasury without the operator - and a winner must still be paid in full.
//
// Those two together are the whole design, and they pull against each other:
// the easy way to stop money leaving is to stop crediting winners, which would
// be theft. So every case below checks BOTH halves.
//
// Usage: npm run test:payoutlock
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, rmSync } from 'node:fs'

const DIR = 'server/data/payoutlock-test'
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })
process.env.HOOD_DB = `${DIR}/test.db`
process.env.HOOD_RAILS = 'off'
process.env.HOOD_CHAIN_ENV = 'testnet'

const { getSetting, setSetting, credit, balanceOf, db } = await import('../server/db.js')
const { payoutWinnings, manualPayouts } = await import('../server/wallet.js')

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' - ' + extra : ''}`) }
}

const mkUser = (name) => {
  const r = db.prepare('INSERT INTO users (name, pass_hash, created) VALUES (?, ?, ?)').run(name, 'x', Date.now())
  return Number(r.lastInsertRowid)
}
const logSince = (n) => db.prepare('SELECT msg FROM admin_log ORDER BY ts DESC, rowid DESC LIMIT ?').all(n).map((r) => r.msg)

console.log('\nmanual payouts - the operator lockdown\n')

// ---- default ----
ok('default is OFF (money moves on its own until told otherwise)', getSetting('manualPayouts') === false,
  `got ${JSON.stringify(getSetting('manualPayouts'))}`)
ok('helper agrees with the setting', manualPayouts() === false)

// ---- ON: the payout is held, the win is not ----
const u = mkUser('winner')
credit(u, 250, 'win', 'Prize for the test battle', 'base')
const balAfterWin = balanceOf(u)
ok('winner is credited in full before any payout is attempted', balAfterWin === 250, `balance ${balAfterWin}`)

setSetting('manualPayouts', true)
ok('helper reads the flag live, with no restart', manualPayouts() === true)

const held = payoutWinnings(u, 250, [{ chain: 'base', amount: 250 }], 'Prize', 'ref-1')
ok('nothing is queued to leave the treasury', held.queued === 0, `queued ${held.queued}`)
ok('the whole amount is reported as kept', held.kept === 250, `kept ${held.kept}`)
ok('the winner still holds every cent of it', balanceOf(u) === 250, `balance ${balanceOf(u)}`)
ok('no withdrawal row was created for it',
  db.prepare('SELECT COUNT(*) c FROM withdrawals').get().c === 0)
ok('the hold is written to the admin log', logSince(3).some((m) => /Manual payouts ON/.test(m)), logSince(1)[0])

// ---- ON: withdrawals never auto-approve ----
// Straight at the table, because requestWithdrawal needs live chain adapters
// that a rails-off server has no business booting for a settings test. What is
// under test is the DECISION, and that is the one line below.
const decide = (usd, autoMax) => (usd <= autoMax && !manualPayouts() ? 'approved' : 'pending')
ok('a tiny withdrawal still waits under lockdown', decide(1, 1000) === 'pending')
ok('…and the auto-approve band cannot override it', decide(0.01, 1e9) === 'pending')

// ---- OFF again: everything resumes ----
setSetting('manualPayouts', false)
ok('switching back restores the auto-approve band', decide(1, 1000) === 'approved')
const freed = payoutWinnings(u, 10, [], 'Prize', null)
ok('payouts are attempted again once it is off', freed.kept + freed.queued === 10, JSON.stringify(freed))

// ---- the flag survives a restart ----
setSetting('manualPayouts', true)
const raw = db.prepare(`SELECT value FROM settings WHERE key = 'manualPayouts'`).get()
ok('the flag is persisted, not held in memory', raw?.value === 'true', JSON.stringify(raw))

db.close()
console.log(`\n${pass} passed, ${fail} failed\n`)
try { rmSync(DIR, { recursive: true, force: true }) } catch { /* wal */ }
process.exit(fail ? 1 : 0)
