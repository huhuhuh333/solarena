// The ledger is denominated in SOL.
//
// This is the test for the one property the whole design exists to give: a
// player's balance is a quantity of coin, so when SOL moves the dollar figure
// moves with it and the arena's liability does not open a hole against the
// treasury that backs it. Everything else - stakes, fees, payouts - is still
// quoted in dollars and must land to the cent at the price of the moment.
//
// Usage: node scripts/ledger-coin-test.mjs

import { rmSync, mkdirSync } from 'node:fs'
const DB_DIR = 'server/data/ledger-coin-test'
rmSync(DB_DIR, { recursive: true, force: true })
mkdirSync(DB_DIR, { recursive: true })
process.env.HOOD_DB = `${DB_DIR}/test.db`
process.env.HOOD_CHAIN_ENV = 'mainnet' // no parity fallback: prove it against a real price

const {
  db, credit, debit, balanceOf, balanceCoinOf, chainFunds, fundsOn,
  setLedgerPrice, totalBalancesUsd, totalBalancesCoin, ledgerPriceUsd,
} = await import('../server/db.js')

let px = 2000
setLedgerPrice(() => px)

let fails = 0
const near = (a, b, tol = 0.005) => Math.abs(a - b) <= tol
const ok = (label, cond, extra = '') => {
  if (cond) console.log(`[ledger] ok: ${label}`)
  else { console.log(`[FAIL] ${label}${extra ? ' - ' + extra : ''}`); fails++ }
}

const newUser = (name) => {
  const r = db.prepare(`INSERT INTO users (name, pass_hash, created) VALUES (?, 'x', ?)`).run(name, Date.now())
  return Number(r.lastInsertRowid)
}

// ---- a deposit is filed as coin, not as dollars ----
const u = newUser('holder')
credit(u, 100, 'deposit', 'Deposit 0.05 SOL', 'sol')
ok('a $100 deposit at $2000/SOL is filed as 0.05 SOL', near(balanceCoinOf(u), 0.05, 1e-9), `${balanceCoinOf(u)}`)
ok('and reads back as $100 at the same price', near(balanceOf(u), 100))
ok('the chain bucket agrees with the balance', near(fundsOn(u, 'sol'), 100))

// ---- THE POINT: the dollar figure follows the market ----
px = 2200
ok('SOL up 10% and the coin held is unchanged', near(balanceCoinOf(u), 0.05, 1e-9))
ok('...while the balance now reads $110', near(balanceOf(u), 110), `${balanceOf(u)}`)
ok('...and the per-chain view followed it too', near(chainFunds(u).sol, 110))

px = 1600
ok('SOL down 20% from the deposit and the balance reads $80', near(balanceOf(u), 80), `${balanceOf(u)}`)
ok('the coin is still exactly what was deposited', near(balanceCoinOf(u), 0.05, 1e-9))

// ---- a stake spends dollars, at the price of the moment ----
px = 2000
debit(u, 50, 'stake', 'Entered $50 battle', 'sol')
ok('a $50 stake at $2000 takes 0.025 SOL', near(balanceCoinOf(u), 0.025, 1e-9), `${balanceCoinOf(u)}`)
ok('leaving $50 spendable', near(balanceOf(u), 50))
ok('and the bucket still reconciles to the balance', near(chainFunds(u).sol, balanceOf(u)))

// A won battle pays dollars back in. Priced when it settles, which is the
// arena's promise: you win $95, you get $95 worth.
px = 2500
credit(u, 95, 'win', 'Won a battle', 'sol')
ok('$95 won at $2500 adds 0.038 SOL', near(balanceCoinOf(u), 0.025 + 0.038, 1e-9), `${balanceCoinOf(u)}`)
ok('and the balance reads the coin at the new price', near(balanceOf(u), (0.025 + 0.038) * 2500))

// ---- no overdrawing, whatever the price does ----
px = 500 // a crash: the same coin is worth a quarter of what it was
const spendable = balanceOf(u)
ok('a crash shrinks what the balance is worth', spendable < 100, `$${spendable.toFixed(2)}`)
ok('spending more than that is refused', debit(u, spendable + 1, 'stake', 'too big', 'sol') === false)
ok('spending exactly that is allowed', debit(u, spendable, 'stake', 'all in', 'sol') !== false)
ok('...and leaves nothing behind', near(balanceCoinOf(u), 0, 1e-9), `${balanceCoinOf(u)}`)
ok('...with the chain bucket emptied too', near(fundsOn(u, 'sol'), 0))

// ---- a second holder, for the totals and the outage below ----
px = 2000
const s = newUser('second')
credit(s, 200, 'deposit', 'Deposit', 'sol')
px = 3000
ok('after a price move the bucket still adds up to the balance', near(fundsOn(s, 'sol'), balanceOf(s)))

// ---- what the arena owes, in both units ----
px = 2000
const owedEth = totalBalancesCoin()
ok('total owed in coin is the sum of every balance', near(owedEth, 0.1, 1e-9), `${owedEth}`)
ok('and in dollars it is that coin priced now', near(totalBalancesUsd(), owedEth * 2000))
px = 4000
ok('the dollar liability doubles when SOL doubles', near(totalBalancesUsd(), owedEth * 4000))
ok('...but the coin liability does not move - which is what the treasury holds',
  near(totalBalancesCoin(), owedEth, 1e-9))

// ---- a queued withdrawal pays out the coin it took, not a later price's ----
//
// This is the exit door. A request can sit waiting for the operator for hours,
// and in that time SOL moves. Paying "$X at today's price" would send a
// different amount of coin than was debited, and the gap is a gain or a loss
// nobody agreed to.
{
  process.env.HOOD_SWEEP = 'off'
  const { initWalletRails, requestWithdrawal, processWithdrawals } = await import('../server/wallet.js')
  const sent = []
  initWalletRails({
    getPriceUsd: (sym) => (sym === 'SOL' ? px : 0),
    chainAdapters: {
      sol: {
        id: 'sol', label: 'Solana', nativeSymbol: 'SOL', nativeDecimals: 9, usdcDecimals: 6,
        stableSymbol: null, address: () => 'TREASURY', validAddress: () => true,
        async balances() { return { native: 0n, usdc: 0n } },
        async send(_from, to, asset, baseUnits) { sent.push({ to, asset, baseUnits }); return '0xhash' },
      },
    },
  })

  px = 2000
  const w = newUser('leaver')
  credit(w, 200, 'deposit', 'Deposit', 'sol')
  ok('setup: 0.1 SOL on the books', near(balanceCoinOf(w), 0.1, 1e-9), `${balanceCoinOf(w)}`)

  const req = requestWithdrawal(w, { chain: 'sol', to: 'PLAYER', usd: 100 })
  ok('a $100 withdrawal is accepted', req.ok === true, JSON.stringify(req))
  ok('...and takes 0.05 SOL off the balance now', near(balanceCoinOf(w), 0.05, 1e-9), `${balanceCoinOf(w)}`)

  // The request waits. SOL runs 25% while it does.
  px = 2500
  db.prepare(`UPDATE withdrawals SET status = 'approved' WHERE user_id = ?`).run(w)
  await processWithdrawals()

  const feeUsd = db.prepare('SELECT fee FROM withdrawals WHERE user_id = ?').get(w).fee
  const expectEth = 0.05 * ((100 - feeUsd) / 100)
  const gotEth = Number(sent.at(-1)?.baseUnits ?? 0n) / 1e9
  ok('the payout sends the coin that was debited, less the fee share',
    Math.abs(gotEth - expectEth) < 1e-9, `sent ${gotEth}, expected ${expectEth}`)
  ok('...which is NOT what a re-priced dollar figure would have sent',
    Math.abs(gotEth - ((100 - feeUsd) / 2500)) > 1e-6, `re-priced would be ${(100 - feeUsd) / 2500}`)
  ok('the balance left behind is untouched by the payout', near(balanceCoinOf(w), 0.05, 1e-9))
}

// ---- a board posting re-prices the moment its battle forms ----
{
  const { lockStake, resettleLock, getLock } = await import('../server/db.js')
  const poster = newUser('board_poster')
  px = 2000
  credit(poster, 150, 'deposit', 'Deposit', 'sol')
  ok('posting a $100 table locks 0.05 SOL', lockStake(poster, 100, 'challenge:TEST').ok === true
    && Math.abs(balanceCoinOf(poster) - 0.025) < 1e-9)

  // SOL rises while the table waits. At battle time the stake is re-taken at
  // the new price: exact coin back, $100 charged fresh - the poster's float
  // lands in their own balance, never the house's.
  px = 2500
  ok('the battle forms and the stake re-prices', resettleLock(poster, 100).ok === true)
  // They had 0.075 SOL total; $100 at $2500 is 0.04 SOL locked; 0.035 left.
  ok('the float stayed with the poster', Math.abs(balanceCoinOf(poster) - 0.035) < 1e-9, `${balanceCoinOf(poster)}`)
  ok('the fresh lock holds the fresh coin', Math.abs(getLock(poster).coin - 0.04) < 1e-9)

  // The other direction: coin fell so far the table can no longer be funded.
  const broke = newUser('board_broke')
  px = 2000
  credit(broke, 100, 'deposit', 'Deposit', 'sol')
  ok('setup: their whole $100 goes onto a table', lockStake(broke, 100, 'challenge:POOR').ok === true)
  px = 1000
  const re = resettleLock(broke, 100)
  ok('after a 50% crash the table cannot re-fund - battle refused', re.ok === false)
  ok('...and their exact coin is back in the balance', Math.abs(balanceCoinOf(broke) - 0.05) < 1e-9, `${balanceCoinOf(broke)}`)
}

// ---- a feed that dies mid-session keeps working off the last price ----
px = 4000
const beforeOutage = balanceCoinOf(s)
ledgerPriceUsd() // one good read, so there is something to remember
setLedgerPrice(() => 0)
ok('a dead feed still reports the last price it saw', ledgerPriceUsd() === 4000, `${ledgerPriceUsd()}`)
credit(s, 40, 'grant', 'credited during an outage', 'sol')
ok('...and money still moves, at that price', near(balanceCoinOf(s), beforeOutage + 0.01, 1e-9), `${balanceCoinOf(s)}`)

// ---- but a mainnet process that has NEVER seen a price refuses outright ----
// Fresh database, fresh module instance: nothing to fall back on.
const COLD_DIR = 'server/data/ledger-coin-test-cold'
rmSync(COLD_DIR, { recursive: true, force: true })
mkdirSync(COLD_DIR, { recursive: true })
process.env.HOOD_DB = `${COLD_DIR}/test.db`
const cold = await import('../server/db.js?cold=1')
const c = Number(cold.db.prepare(`INSERT INTO users (name, pass_hash, created) VALUES ('cold', 'x', ?)`).run(Date.now()).lastInsertRowid)
let threw = false
try { cold.credit(c, 10, 'grant', 'no price anywhere', 'sol') } catch { threw = true }
ok('with no price ever seen, mainnet refuses to move money rather than guess', threw)
ok('...and the account is left at zero, not at a made-up figure', cold.balanceCoinOf(c) === 0)
cold.setLedgerPrice(() => 3000)
cold.credit(c, 30, 'grant', 'price arrived', 'sol')
ok('...then credits normally the moment a price arrives', near(cold.balanceCoinOf(c), 0.01, 1e-9), `${cold.balanceCoinOf(c)}`)

// ---- a database kept in Robinhood ETH converts to SOL once, dollars intact ----
// Built by the real module, then rolled back to the old shape: `*_eth` columns,
// ledgerUnit 'eth', balances filed on 'rh', a last ETH price on record.
{
  const MIG_DIR = 'server/data/ledger-coin-test-mig'
  rmSync(MIG_DIR, { recursive: true, force: true })
  mkdirSync(MIG_DIR, { recursive: true })
  process.env.HOOD_DB = `${MIG_DIR}/test.db`
  const old = await import('../server/db.js?mig=seed')
  const uid = Number(old.db.prepare(`INSERT INTO users (name, pass_hash, created, balance) VALUES ('ethholder', 'x', ?, 1000)`).run(Date.now()).lastInsertRowid)
  old.db.exec('ALTER TABLE users RENAME COLUMN balance_coin TO balance_eth')
  old.db.exec('ALTER TABLE chain_funds RENAME COLUMN amount_coin TO amount_eth')
  old.db.exec('ALTER TABLE stake_locks RENAME COLUMN coin TO eth')
  old.db.exec('ALTER TABLE txs RENAME COLUMN coin TO eth')
  old.db.prepare('UPDATE users SET balance_eth = 0.5 WHERE id = ?').run(uid)
  old.db.prepare(`INSERT INTO chain_funds (user_id, chain, amount, amount_eth) VALUES (?, 'rh', 1000, 0.5)`).run(uid)
  old.setSetting('ledgerUnit', 'eth')
  old.setSetting('ledgerCoin', null)
  old.setSetting('ethUsdLast', 2000)

  const mig = await import('../server/db.js?mig=run')
  ok('the old columns are renamed in place', mig.db.prepare('SELECT balance_coin FROM users WHERE id = ?').get(uid)?.balance_coin === 0.5)
  ok('money on the books waits for a real SOL price before converting', mig.getSetting('ledgerCoin') !== 'SOL')
  mig.setLedgerPrice(() => 100)
  ok('with a SOL price the ledger converts', mig.getSetting('ledgerCoin') === 'SOL')
  ok('0.5 ETH at $2000 becomes 10 SOL at $100', near(mig.balanceCoinOf(uid), 10, 1e-9), `${mig.balanceCoinOf(uid)}`)
  ok('the dollar balance is exactly what it was', near(mig.balanceOf(uid), 1000), `${mig.balanceOf(uid)}`)
  ok('the Robinhood bucket is re-filed onto Solana', near(mig.fundsOn(uid, 'sol'), 1000) && mig.fundsOn(uid, 'rh') === 0,
    JSON.stringify(mig.chainFunds(uid)))
}

console.log(fails ? `\n[ledger] ${fails} FAILURE(S)` : '\n[ledger] ALL GREEN - balances are coin, prices are dollars')
process.exit(fails ? 1 : 0)
