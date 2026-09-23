// The Solana RPC layer and the payout queue under failure, with FAKE endpoints
// - no network. Three things are proven:
//
//   1. failover: a primary that stops answering hands the call to the next
//      endpoint; a real answer (an error that is the same everywhere) does not.
//   2. the send path reads the outcome from the chain, and says whether a
//      failure is DEFINITE - only those may be refunded.
//   3. the withdrawal queue never pays twice: a payout whose outcome is unknown
//      is held, then settled by what the chain says about that one signature.
//
// Usage: node scripts/solrpc-test.mjs

import { rmSync, mkdirSync } from 'node:fs'

const DB_DIR = 'server/data/solrpc-test'
rmSync(DB_DIR, { recursive: true, force: true })
mkdirSync(DB_DIR, { recursive: true })
process.env.HOOD_DB = `${DB_DIR}/test.db`
process.env.HOOD_WALLET_SEED = 'ab'.repeat(32)
process.env.HOOD_AUTO_WITHDRAW_MAX = '1000'
process.env.HOOD_DEPOSIT_FEE = '0'
process.env.HOOD_WITHDRAW_FEE = '0'
process.env.HOOD_SOL_RPC_DOWN_MS = '300'

const log = (...a) => console.log('[solrpc]', ...a)
const fail = (msg) => { console.error('[FAIL]', msg); process.exitCode = 1 }
const assert = (cond, msg) => { if (!cond) fail(msg); else log('ok:', msg) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const { makeRpc, settleRaw, SendError, signatureOutcome } = await import('../server/solrpc.js')

// ---------------------------------------------------------------------------
// 1. failover
// ---------------------------------------------------------------------------
{
  const calls = []
  const behave = { a: 'down', b: 'ok' }
  const fake = (name) => ({
    async getBalance() {
      calls.push(name)
      if (behave[name] === 'down') throw new Error('429 Too Many Requests')
      if (behave[name] === 'answer') throw new Error('Invalid param: WrongSize')
      return name === 'a' ? 111 : 222
    },
  })
  const rpc = makeRpc(['a', 'b'], { connect: fake })

  assert(await rpc.call((c) => c.getBalance()) === 222, 'a rate-limited primary hands the read to the fallback')
  calls.length = 0
  await rpc.call((c) => c.getBalance())
  assert(calls.join() === 'b', 'the primary sits out for a while instead of being hit first every time')
  behave.a = 'ok'
  await sleep(350)
  calls.length = 0
  assert(await rpc.call((c) => c.getBalance()) === 111 && calls.join() === 'a', '...and is back in front once the pause is over')

  behave.a = 'answer'
  calls.length = 0
  let threw = null
  try { await rpc.call((c) => c.getBalance()) } catch (e) { threw = e }
  assert(threw && /WrongSize/.test(threw.message) && calls.join() === 'a',
    'a real answer (not a transport failure) is returned at once, never retried elsewhere')

  behave.a = 'down'; behave.b = 'down'
  threw = null
  try { await rpc.call((c) => c.getBalance()) } catch (e) { threw = e }
  assert(!!threw, 'with every endpoint down the call fails instead of inventing a value')
  assert(rpc.status().failovers >= 1, 'failovers are counted for the admin view')
}

// ---------------------------------------------------------------------------
// 2. the send path
// ---------------------------------------------------------------------------
// A fake chain: a set of landed signatures (with or without an error), a block
// height, and a switchable "RPC is unreachable" state.
const mkChain = () => {
  const s = { landed: new Map(), height: 100, down: false, sends: [], rejectPreflight: null, landOnSend: null, alreadyProcessed: false }
  const guard = () => { if (s.down) throw new Error('fetch failed') }
  const conn = {
    async sendRawTransaction(raw, opts) {
      guard()
      s.sends.push({ raw, preflight: !opts?.skipPreflight })
      if (s.rejectPreflight && !opts?.skipPreflight) throw new Error(`Transaction simulation failed: ${s.rejectPreflight}`)
      if (s.alreadyProcessed && !opts?.skipPreflight) throw new Error('This transaction has already been processed')
      if (s.landOnSend) s.landed.set(s.landOnSend.sig, s.landOnSend.err ?? null)
      return 'ignored'
    },
    async getSignatureStatuses([sig], opts) {
      guard()
      if (!s.landed.has(sig)) return { value: [null] }
      const err = s.landed.get(sig)
      return { value: [{ err, confirmationStatus: 'confirmed' }] }
    },
    async getBlockHeight() { guard(); return s.height },
  }
  return { s, rpc: makeRpc(['only'], { connect: () => conn }) }
}
const RAW = Buffer.from('signed-bytes')
const fast = { pollMs: 5, resendMs: 10, timeoutMs: 400 }

{
  const { s, rpc } = mkChain()
  s.landOnSend = { sig: 'SIG1' }
  assert(await settleRaw(rpc, RAW, 'SIG1', 150, fast) === 'SIG1', 'a transfer that lands and confirms resolves with its signature')
}
{
  const { s, rpc } = mkChain()
  s.rejectPreflight = 'Attempt to debit an account but found no record of a prior credit'
  let e = null
  try { await settleRaw(rpc, RAW, 'SIG2', 150, fast) } catch (x) { e = x }
  assert(e instanceof SendError && e.definite === true, 'rejected in simulation = DEFINITE failure (nothing was forwarded)')
}
{
  const { s, rpc } = mkChain()
  s.landOnSend = { sig: 'SIG3', err: { InstructionError: [0, 'Custom'] } }
  let e = null
  try { await settleRaw(rpc, RAW, 'SIG3', 150, fast) } catch (x) { e = x }
  assert(e?.definite === true, 'landed WITH an error = DEFINITE failure (the transfer itself did not execute)')
}
{
  const { s, rpc } = mkChain()
  s.height = 200 // already past lastValidBlockHeight 150, never landed
  let e = null
  try { await settleRaw(rpc, RAW, 'SIG4', 150, fast) } catch (x) { e = x }
  assert(e?.definite === true && /expired/.test(e.message), 'blockhash expired and never landed = DEFINITE failure')
}
{
  // The dangerous one: broadcast, then the RPC goes dark before anything is known.
  const { s, rpc } = mkChain()
  const settling = settleRaw(rpc, RAW, 'SIG5', 150, fast)
  s.down = true
  let e = null
  try { await settling } catch (x) { e = x }
  assert(e?.definite === false, 'RPC gone after broadcast = UNKNOWN (definite:false) - must never be refunded')
  assert(e?.signature === 'SIG5', '...and the error carries the signature to check later')
}
{
  // A slow landing: nothing on the first polls, then it confirms. Re-sends in
  // between must be the SAME bytes.
  const { s, rpc } = mkChain()
  setTimeout(() => s.landed.set('SIG6', null), 60)
  assert(await settleRaw(rpc, RAW, 'SIG6', 150, fast) === 'SIG6', 'a slow transfer is followed until it confirms')
  assert(s.sends.length >= 2 && s.sends.every((x) => x.raw === RAW), 'every re-broadcast carried the identical signed bytes')
}
{
  // An earlier attempt already got through: "already processed" is success, not rejection.
  const { s, rpc } = mkChain()
  s.alreadyProcessed = true
  s.landed.set('SIG7', null)
  assert(await settleRaw(rpc, RAW, 'SIG7', 150, fast) === 'SIG7', '"already processed" is read as landed, not as a rejection')
}
{
  const { s, rpc } = mkChain()
  s.landed.set('L', null); s.landed.set('F', { err: 1 })
  s.height = 300
  assert(await signatureOutcome(rpc, 'L', 150) === 'landed', 'after the fact: a landed signature reads landed')
  assert(await signatureOutcome(rpc, 'F', 150) === 'failed', 'after the fact: one that landed with an error reads failed')
  assert(await signatureOutcome(rpc, 'NONE', 150) === 'failed', 'after the fact: unseen and expired reads failed')
  s.height = 120
  assert(await signatureOutcome(rpc, 'NONE', 150) === 'unknown', 'after the fact: unseen but still valid reads unknown - not failed')
  s.down = true
  assert(await signatureOutcome(rpc, 'L', 150) === 'unknown', 'after the fact: RPC down reads unknown - not failed')
}

// ---------------------------------------------------------------------------
// 3. the withdrawal queue never pays twice
// ---------------------------------------------------------------------------
const { register } = await import('../server/auth.js')
const { balanceOf, setLedgerPrice, credit, db } = await import('../server/db.js')
const wallet = await import('../server/wallet.js')

// A mock rail whose send can be scripted per call, and whose checkTx answers
// from a table - the chain's memory of each signature.
const chainSays = new Map()
let script = []
const sent = []
const sol = {
  id: 'sol', label: 'Solana', icon: '·', nativeSymbol: 'SOL', nativeDecimals: 9, usdcDecimals: 6,
  network: 'mocknet', explorer: 'x/{tx}',
  address: (who) => `mock_${who}`,
  validAddress: (a) => String(a).startsWith('mock'),
  async balances() { return { native: 0n, usdc: 0n } },
  async send(fromWho, to, asset, baseUnits, { onSigned } = {}) {
    const step = script.shift() || 'ok'
    const sig = `sig_${sent.length + 1}`
    if (step === 'rpc-down-before-sign') throw new Error('fetch failed')
    onSigned?.(sig, 500)
    sent.push({ sig, to, baseUnits })
    if (step === 'ok') { chainSays.set(sig, 'landed'); return sig }
    if (step === 'rejected') throw new SendError('rejected: insufficient funds', { definite: true, signature: sig })
    if (step === 'unknown-landed') { chainSays.set(sig, 'landed'); throw new SendError('could not confirm either way', { definite: false, signature: sig }) }
    if (step === 'unknown-dropped') { chainSays.set(sig, 'unknown'); throw new SendError('could not confirm either way', { definite: false, signature: sig }) }
    if (step === 'crash-after-sign') { chainSays.set(sig, 'landed'); throw Object.assign(new Error('process died'), { simulateCrash: true }) }
    throw new Error('bad script')
  },
  async checkTx(sig) { return chainSays.get(sig) || 'unknown' },
}

setLedgerPrice(() => 100)
wallet.initWalletRails({ getPriceUsd: (sym) => (sym === 'SOL' ? 100 : 0), chainAdapters: { sol } })

const r = register('payee', 'hunter22222')
const uid = r.session.userId
db.prepare('UPDATE users SET balance_coin = 0 WHERE id = ?').run(uid)
credit(uid, 1000, 'deposit', 'fixture funds', 'sol')
const row = (id) => db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id)
const withdraw = (usd) => wallet.requestWithdrawal(uid, { chain: 'sol', to: 'mock_payee', usd })

// a) sent, outcome unknown, it HAD landed -> held, then settled as sent; no refund
script = ['unknown-landed']
const a = withdraw(100)
await wallet.processWithdrawals()
assert(row(a.id).status === 'unconfirmed', 'unknown outcome: the payout is HELD as unconfirmed')
assert(Math.abs(balanceOf(uid) - 900) < 0.01, '...and NOT refunded (the player cannot get it twice)')
assert(row(a.id).txhash === 'sig_1' && row(a.id).tx_expiry === 500, '...with its signature and expiry recorded before broadcast')
await wallet.processWithdrawals()
assert(row(a.id).status === 'sent', 'the chain says it landed: settled as SENT on the next round')
assert(Math.abs(balanceOf(uid) - 900) < 0.01, '...still no refund - paid exactly once')

// b) sent, outcome unknown, it never landed -> held until the chain proves it, then refunded ONCE
script = ['unknown-dropped']
const b = withdraw(50)
await wallet.processWithdrawals()
assert(row(b.id).status === 'unconfirmed' && Math.abs(balanceOf(uid) - 850) < 0.01, 'unknown again: held, not refunded')
await wallet.processWithdrawals()
assert(row(b.id).status === 'unconfirmed', 'while the chain still cannot say, it stays held')
chainSays.set(row(b.id).txhash, 'failed') // blockhash expired, never seen
await wallet.processWithdrawals()
assert(row(b.id).status === 'failed' && Math.abs(balanceOf(uid) - 900) < 0.01, 'once the chain proves it never landed: refunded')
await wallet.processWithdrawals()
assert(Math.abs(balanceOf(uid) - 900) < 0.01, '...exactly once')

// c) rejected outright -> refunded at once (the old behaviour, still right)
script = ['rejected']
const c = withdraw(40)
await wallet.processWithdrawals()
assert(row(c.id).status === 'failed' && Math.abs(balanceOf(uid) - 900) < 0.01, 'a definite rejection is refunded immediately')

// d) RPC down before anything was signed -> back in the queue, not bounced to the player
script = ['rpc-down-before-sign']
const d = withdraw(30)
await wallet.processWithdrawals()
assert(row(d.id).status === 'approved' && Math.abs(balanceOf(uid) - 870) < 0.01,
  'RPC unreachable before signing: stays queued (nothing left the treasury), no refund, no loss')
script = ['ok']
await wallet.processWithdrawals()
assert(row(d.id).status === 'sent', '...and goes out on the next round')

// e) crash between signing and knowing -> after restart the row is 'sending' with a
//    signature; the reconciler asks the chain instead of re-sending or refunding
script = ['crash-after-sign']
const e = withdraw(20)
try { await wallet.processWithdrawals() } catch { /* the "crash" */ }
// Simulate the restart: the crash left the row mid-send with its signature on it.
db.prepare(`UPDATE withdrawals SET status = 'sending', note = '' WHERE id = ?`).run(e.id)
const balBefore = balanceOf(uid)
const sentBefore = sent.length
await wallet.processWithdrawals()
assert(row(e.id).status === 'sent', 'after a crash mid-send, the recorded signature is checked and the payout settled as sent')
assert(sent.length === sentBefore, '...without broadcasting it a second time')
assert(Math.abs(balanceOf(uid) - balBefore) < 0.01, '...and without refunding it')

// f) crash BEFORE signing -> nothing was broadcast, so it simply goes back in the queue
const f = withdraw(10)
db.prepare(`UPDATE withdrawals SET status = 'sending', txhash = NULL WHERE id = ?`).run(f.id)
script = ['ok']
const sentBeforeF = sent.length
await wallet.processWithdrawals()
assert(row(f.id).status === 'sent' && sent.length === sentBeforeF + 1,
  'a row that died before signing is re-queued and sent exactly once')
assert(Math.abs(balanceOf(uid) - (balBefore - 10)) < 0.01, 'the ledger ends exactly where the payouts say it should')

try { rmSync(DB_DIR, { recursive: true, force: true }) } catch { /* wal */ }
log(process.exitCode ? 'FAILURES PRESENT' : 'ALL SOLRPC TESTS PASSED')
