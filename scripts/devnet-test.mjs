// REAL on-chain proof of the custody rails, on Solana devnet:
//   airdrop -> user's derived deposit address -> watcher credits USD
//   -> withdrawal request -> treasury pays a REAL transaction -> recipient
//   balance verified on-chain.
//
// Manual proof script (devnet faucet is rate-limited, so it's not part of the
// default suite). Usage: node scripts/devnet-test.mjs

import { rmSync, mkdirSync } from 'node:fs'

const DB_DIR = 'server/data/devnet-test'
rmSync(DB_DIR, { recursive: true, force: true })
mkdirSync(DB_DIR, { recursive: true })
process.env.HOOD_DB = `${DB_DIR}/test.db`
process.env.HOOD_WALLET_SEED = process.env.HOOD_WALLET_SEED || 'cd'.repeat(32)
process.env.HOOD_AUTO_WITHDRAW_MAX = '100'
process.env.HOOD_CHAIN_ENV = 'testnet'
process.env.HOOD_DEPOSIT_FEE = '0'
process.env.HOOD_WITHDRAW_FEE = '0'

const log = (...a) => console.log('[devnet]', ...a)
const fail = (msg) => { console.error('[FAIL]', msg); process.exitCode = 1 }
const assert = (cond, msg) => { if (!cond) fail(msg); else log('ok:', msg) }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const { register } = await import('../server/auth.js')
const { balanceOf, setLedgerPrice, db } = await import('../server/db.js')
const wallet = await import('../server/wallet.js')
const { CHAINS } = await import('../server/chains.js')

const SOL_PRICE = 100 // fixed for determinism: 1 SOL = $100
// One price for crediting, the ledger and the payout - as index.js wires it.
setLedgerPrice(() => SOL_PRICE)
wallet.initWalletRails({ getPriceUsd: (sym) => (sym === 'SOL' ? SOL_PRICE : 0) })

const sol = CHAINS.sol
const r = register('devnet_user', 'hunter22222')
if (r.error) throw new Error(r.error)
const uid = r.session.userId
db.prepare('UPDATE users SET balance_coin = 0 WHERE id = ?').run(uid)

const addrs = wallet.depositAddresses(uid)
const depositAddr = addrs.find((a) => a.chain === 'sol').address
const treasuryAddr = sol.address('treasury')
log('deposit address :', depositAddr)
log('treasury address:', treasuryAddr)

// ---- fund via devnet faucet (rate-limited; retry a few times) ----
const airdrop = async (address, amount, label) => {
  for (let i = 0; i < 4; i++) {
    try {
      const sig = await sol.requestAirdrop(address, amount)
      log(`airdrop ${amount} SOL -> ${label} (${sig.slice(0, 16)}…)`)
      return true
    } catch (e) {
      log(`airdrop attempt ${i + 1} failed (${String(e.message || e).slice(0, 80)}), retrying…`)
      await wait(4000)
    }
  }
  return false
}

// The faucet API is rate-limited per IP and often refuses outright. So devnet
// SOL may also arrive by hand - from faucet.solana.com (GitHub login) straight
// to the deposit address printed above - and the test then skips the airdrop.
const lamportsAt = async (a) => Number((await sol.balancesFresh(a)).native)
const preFunded = await lamportsAt(depositAddr)
if (preFunded >= 0.1e9) log(`deposit address already holds ${preFunded / 1e9} SOL - no airdrop needed`)
else if (!await airdrop(depositAddr, 0.2, 'deposit address')) {
  console.error(`[devnet] faucet refused all airdrops (rate limit). Send 0.5 devnet SOL to ${depositAddr} from https://faucet.solana.com and run this again.`)
  process.exit(2)
}
const depositSol = Math.max(preFunded, 0.2e9) / 1e9

// ---- deposit detection: watcher must credit $20 (0.2 SOL @ $100) ----
log('waiting for finality + watcher credit…')
let credited = false
for (let i = 0; i < 30; i++) {
  await wallet.pollDeposits()
  if (balanceOf(uid) > 0) { credited = true; break }
  await wait(3000)
}
assert(credited, 'watcher detected the REAL on-chain deposit')
assert(Math.abs(balanceOf(uid) - depositSol * SOL_PRICE) < 0.01, `deposit valued correctly ($${balanceOf(uid)} for ${depositSol} SOL @ $${SOL_PRICE})`)

// ---- withdrawal: treasury pays a real transaction ----
// The treasury pays every fee (sweeps included), so it needs SOL of its own.
if (await lamportsAt(treasuryAddr) >= 0.15e9) log('treasury already funded - no airdrop needed')
else if (!await airdrop(treasuryAddr, 0.2, 'treasury')) {
  console.error(`[devnet] could not fund treasury - send 0.5 devnet SOL to ${treasuryAddr} from https://faucet.solana.com and run again.`)
  process.exit(process.exitCode || 2)
}

const { Keypair } = await import('@solana/web3.js')
const recipient = Keypair.generate().publicKey.toBase58()
const balBefore = balanceOf(uid)
const req = wallet.requestWithdrawal(uid, { chain: 'sol', asset: 'native', to: recipient, usd: 10 })
assert(req.ok && req.status === 'approved', 'withdrawal request auto-approved')
assert(Math.abs(balBefore - balanceOf(uid) - 10) < 0.01, 'balance debited immediately')

log('sending REAL withdrawal on devnet…')
await wallet.processWithdrawals()
const w = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(req.id)
assert(w.status === 'sent' && w.txhash, `withdrawal SENT on-chain: ${w.txhash}`)
log(`explorer: https://explorer.solana.com/tx/${w.txhash}?cluster=devnet`)

const got = await sol.balances(recipient)
const gotSol = Number(got.native) / 1e9
assert(Math.abs(gotSol - 0.1) < 0.001, `recipient holds the coins on-chain (${gotSol} SOL for $10 @ $${SOL_PRICE})`)

try { rmSync(DB_DIR, { recursive: true, force: true }) } catch { /* wal */ }
log(process.exitCode ? 'FAILURES PRESENT' : 'FULL MONEY CYCLE PROVEN ON A REAL CHAIN ✔')
process.exit(process.exitCode || 0)
