// Custodial money rail - Solana, "their money only":
//
// Deposits: every user gets a derived Solana deposit address. The watcher polls
// balances; any increase is credited at the live SOL price MINUS a flat network
// fee, then auto-SWEPT to the treasury so the pooled funds always sit where
// payouts and hedging happen. The treasury pays the sweep's network fee, so a
// deposit address needs no SOL of its own.
//
// Withdrawals: debit instantly, queue for approval (auto up to the operator's
// band), pay from treasury minus a flat network fee - so fees are funded by the
// flows themselves, not by house capital.
//
// Accounting per (user, chain, asset) is CUMULATIVE: `credited` (base units
// ever credited) and `swept` (base units ever moved to treasury). This makes
// credits and sweeps idempotent and race-safe: a deposit landing mid-sweep is
// simply credited on the next round.

import { randomBytes } from 'node:crypto'
import {
  db, credit, debit, fundsOn, balanceOf, holdingOf, debitTokens, creditTokens,
  getSetting, setSetting, adminLog, totalBalancesUsd, coinColumn, LEDGER_COIN,
} from './db.js'
import { hedgeAssetOf, hedgeRelease } from './hedger.js'
import { setMasterSeed, CHAINS, CHAIN_ENV, fromBase, toBase } from './chains.js'
import { transientRpcError } from './solrpc.js'

// The auto-approve band, in dollars per request. Read live from the settings the
// operator actually sees, with the env var as the boot default: a panel switch
// that a hidden env floor could override is not a switch, it is a decoration.
const AUTO_MAX_DEFAULT = Number(process.env.HOOD_AUTO_WITHDRAW_MAX) || 0
const autoMax = () => {
  const s = getSetting('autoWithdrawMax')
  return typeof s === 'number' && s >= 0 ? s : AUTO_MAX_DEFAULT
}
// The operator's lockdown switch. Read live on every call rather than cached at
// boot: the whole point is that flipping it acts on the very next settlement,
// with no restart between noticing the abuse and stopping the bleed.
export const manualPayouts = () => !!getSetting('manualPayouts')
const MIN_WITHDRAW = 5
const POLL_MS = 60000
const TREASURY = 'treasury'
const SWEEP_ON = process.env.HOOD_SWEEP !== 'off'

// Flat network fees paid by the user. A Solana transfer costs a fraction of a
// cent, so these are small: they cover the sweep and the payout, nothing more.
const DEPOSIT_FEE_USD = process.env.HOOD_DEPOSIT_FEE != null ? { sol: +process.env.HOOD_DEPOSIT_FEE } : { sol: 0.01 }
const WITHDRAW_FEE_USD = process.env.HOOD_WITHDRAW_FEE != null ? +process.env.HOOD_WITHDRAW_FEE : 0.02

db.exec(`
CREATE TABLE IF NOT EXISTS deposit_addresses (
  user_id INTEGER NOT NULL REFERENCES users(id),
  chain TEXT NOT NULL,
  address TEXT NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY (user_id, chain)
);
CREATE TABLE IF NOT EXISTS wallet_ledger (
  user_id INTEGER NOT NULL,
  chain TEXT NOT NULL,
  asset TEXT NOT NULL,
  credited TEXT NOT NULL DEFAULT '0',
  swept TEXT NOT NULL DEFAULT '0',
  PRIMARY KEY (user_id, chain, asset)
);
CREATE TABLE IF NOT EXISTS deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  chain TEXT NOT NULL,
  asset TEXT NOT NULL,
  amount REAL NOT NULL,
  usd REAL NOT NULL,
  price REAL NOT NULL,
  fee REAL NOT NULL DEFAULT 0,
  ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  chain TEXT NOT NULL,
  asset TEXT NOT NULL,
  to_address TEXT NOT NULL,
  usd REAL NOT NULL,
  fee REAL NOT NULL DEFAULT 0,
  asset_amount REAL,
  status TEXT NOT NULL DEFAULT 'pending',
  txhash TEXT,
  note TEXT NOT NULL DEFAULT '',
  ts INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
`)
try { db.exec(`ALTER TABLE withdrawals ADD COLUMN fee REAL DEFAULT 0`) } catch { /* exists */ }
// Coin withdrawals: asset = 'coin', `token` names which one, asset_amount is the
// token quantity (the authoritative number - usd is only a snapshot for review).
try { db.exec(`ALTER TABLE withdrawals ADD COLUMN token TEXT`) } catch { /* exists */ }
try { db.exec(`ALTER TABLE deposits ADD COLUMN fee REAL DEFAULT 0`) } catch { /* exists */ }
// The coin the balance actually gave up, fixed at request time. See
// requestWithdrawal: a queued payout must send THIS, not a later price's idea of
// the same dollars. Zero on rows written before the ledger held coin.
coinColumn('withdrawals', 'eth', 'coin')
// The last block height at which the payout's transaction could still land. It
// is recorded with the signature, before broadcast, and it is what lets a payout
// whose outcome was unknown be settled later: past that height a signature the
// chain has never seen can never land, so refunding it is safe.
try { db.exec(`ALTER TABLE withdrawals ADD COLUMN tx_expiry INTEGER`) } catch { /* exists */ }

// A deposit address on a retired rail is an address nobody watches any more.
// Showing it would invite money to a place it can never be credited from.
db.prepare(`DELETE FROM deposit_addresses WHERE chain NOT IN (${Object.keys(CHAINS).map(() => '?').join(',')})`).run(...Object.keys(CHAINS))

let priceUsd = () => 0
let adapters = CHAINS

export const initWalletRails = ({ getPriceUsd, chainAdapters } = {}) => {
  if (getPriceUsd) priceUsd = getPriceUsd
  if (chainAdapters) adapters = chainAdapters

  let seed = process.env.HOOD_WALLET_SEED
  if (!seed) {
    seed = getSetting('walletSeedDev')
    if (!seed) {
      seed = randomBytes(32).toString('hex')
      setSetting('walletSeedDev', seed)
    }
    console.warn('[wallet] HOOD_WALLET_SEED not set - using a DEV seed stored in the database. Set a real seed (and back it up!) before mainnet.')
  }
  setMasterSeed(seed)
  console.log(`[wallet] custody rail up (${CHAIN_ENV}). Treasury addresses:`)
  for (const c of Object.values(adapters)) {
    try { console.log(`[wallet]   ${c.label.padEnd(10)} ${c.address(TREASURY)}  (${c.network})`) } catch (e) { console.error(`[wallet]   ${c.id}: ${e.message}`) }
  }
}

export const startWalletWatcher = () => {
  setInterval(pollDeposits, POLL_MS)
  setInterval(processWithdrawals, 20000)
  pollDeposits()
}

const assetPrice = (chain, asset) => (asset === 'usdc' ? 1 : priceUsd(chain.nativeSymbol))

// ---- is the stake actually standing in the arena? ----
//
// Free play, unlimited (owner, 23 Sep 2026): nobody is ever turned away for an
// empty balance. A player short of the stake is silently topped up - to the
// signup amount, or to the stake if the table is bigger - and plays.
//
// `fund` = { chain, label, asset } for Live, which spends only money standing on
// its chain; null for Classic, where any balance plays.
export const ensureFunded = async (userId, usd, fund = null) => {
  const want = Math.round(Number(usd) * 100) / 100
  if (!(want > 0)) return { ok: true }
  const have = fund?.chain ? fundsOn(userId, fund.chain) : balanceOf(userId)
  if (have + 0.000001 >= want) return { ok: true }
  const target = Math.max(want, Number(getSetting('signupCredit')) || 10000)
  credit(userId, Math.round((target - have) * 100) / 100 + 0.01, 'deposit', 'Free play top-up', fund?.chain || null)
  return { ok: true }
}

// Every time a player comes in (register, login, app open) a balance under the
// signup amount is lifted back to it (owner, 23 Sep 2026: "svako kad se uloguje
// nek dobije 10k"). Above it, nothing happens - winnings are kept.
export const topUpOnLogin = (userId) => {
  // Mid-battle the stake is out of the balance; topping up then would hand out
  // a second stake. Wait until the battle settles and they come back.
  if (db.prepare('SELECT 1 FROM stake_locks WHERE user_id = ?').get(userId)) return
  const target = Number(getSetting('signupCredit')) || 10000
  const have = balanceOf(userId)
  if (have + 0.005 >= target) return
  credit(userId, Math.round((target - have) * 100) / 100, 'deposit', 'Free play top-up')
}

// ---- deposit addresses ----
export const depositAddresses = (userId) => {
  const out = []
  for (const c of Object.values(adapters)) {
    let row = db.prepare('SELECT address FROM deposit_addresses WHERE user_id = ? AND chain = ?').get(userId, c.id)
    if (!row) {
      const address = c.address(String(userId))
      db.prepare('INSERT INTO deposit_addresses (user_id, chain, address, created) VALUES (?, ?, ?, ?)')
        .run(userId, c.id, address, Date.now())
      row = { address }
    }
    const native = c.nativeLabel || c.nativeSymbol
    out.push({
      chain: c.id, label: c.label, icon: c.icon, network: c.network,
      address: row.address, nativeSymbol: c.nativeSymbol, nativeLabel: native,
      stableSymbol: null, accepts: native,
      // Spelled out rather than implied: it is the one thing the player has to
      // get right in their own wallet, and it is not recoverable by us.
      networkWarning: `Send only SOL, only over ${c.network}. Tokens, or SOL sent over another network, cannot be credited or returned.`,
      feeUsd: DEPOSIT_FEE_USD[c.id] ?? 0,
    })
  }
  return out
}

// ---- cumulative ledger ----
const getLedger = (userId, chainId, asset) => {
  const r = db.prepare('SELECT credited, swept FROM wallet_ledger WHERE user_id = ? AND chain = ? AND asset = ?').get(userId, chainId, asset)
  return { credited: BigInt(r?.credited ?? '0'), swept: BigInt(r?.swept ?? '0') }
}

const putLedger = (userId, chainId, asset, led) =>
  db.prepare(`INSERT INTO wallet_ledger (user_id, chain, asset, credited, swept) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(user_id, chain, asset) DO UPDATE SET credited = excluded.credited, swept = excluded.swept`)
    .run(userId, chainId, asset, led.credited.toString(), led.swept.toString())

let onWalletChanged = () => {}
export const setDepositCallback = (fn) => { onWalletChanged = fn }

// ---- deposit watcher + auto-sweep ----
// Read every address on one chain in as few requests as the chain allows.
//
// Returns a Map of address -> balances holding ONLY the addresses that were
// actually read. An address missing from the map was NOT read, and the caller
// must skip it - the one rule this whole file turns on is that an unread
// balance never becomes a zero, because the reconcile branch would then mark
// live funds as swept.
const readChainBalances = async (chain, addresses) => {
  const out = new Map()
  if (chain.balancesMany) {
    try {
      return await chain.balancesMany(addresses)
    } catch (e) {
      adminLog('system', `Deposit sweep: batched read failed on ${chain.label} (${String(e?.message).slice(0, 90)}) - falling back to one at a time`)
    }
  }
  for (const address of addresses) {
    // Fresh, not cached: this is the read that decides whether money arrived,
    // and a stale snapshot delays a player's credit.
    try {
      out.set(address, await (chain.balancesFresh ? chain.balancesFresh(address) : chain.balances(address)))
    } catch { /* unread - stays absent, never a zero */ }
  }
  return out
}

// One sweep at a time. setInterval does not await, so a sweep that outlives its
// interval would have the next one start on top of it.
let sweeping = false

export const pollDeposits = async () => {
  if (sweeping) return
  sweeping = true
  try { await runDepositSweep() } finally { sweeping = false }
}

const runDepositSweep = async () => {
  const rows = db.prepare('SELECT user_id, chain, address FROM deposit_addresses').all()
  const byChain = new Map()
  for (const row of rows) {
    if (!adapters[row.chain]) continue
    if (!byChain.has(row.chain)) byChain.set(row.chain, [])
    byChain.get(row.chain).push(row)
  }

  for (const [chainId, chainRows] of byChain) {
    const chain = adapters[chainId]
    const balances = await readChainBalances(chain, [...new Set(chainRows.map((r) => r.address))])

    for (const row of chainRows) {
      const bal = balances.get(row.address)
      if (!bal) continue // not read this round - never treated as empty
      const asset = 'native'
      const decimals = chain.nativeDecimals
      const led = getLedger(row.user_id, chain.id, asset)
      const expected = led.credited - led.swept

      // 1) credit anything new
      if (bal[asset] > expected) {
        const delta = bal[asset] - expected
        const amount = fromBase(delta, decimals)
        const price = assetPrice(chain, asset)
        const gross = amount * price
        const fee = DEPOSIT_FEE_USD[chain.id] ?? 0
        const usd = Math.round(Math.max(0, gross - fee) * 100) / 100
        if (price > 0 && gross >= fee + 0.01) {
          const sym = chain.nativeLabel || chain.nativeSymbol
          db.prepare('INSERT INTO deposits (user_id, chain, asset, amount, usd, price, fee, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(row.user_id, chain.id, asset, amount, usd, price, fee, Date.now())
          credit(row.user_id, usd, 'deposit',
            `Deposit ${amount} ${sym} @ $${price.toFixed(2)}${fee ? ` (−$${fee} network fee)` : ''}`,
            chain.id)
          led.credited += delta
          putLedger(row.user_id, chain.id, asset, led)
          adminLog('system', `Deposit credited: $${usd} (${amount} ${sym}) to user #${row.user_id}`)
          try { onWalletChanged(row.user_id) } catch { /* best effort */ }
        } else if (price > 0) {
          led.credited += delta // dust below the network fee - absorbed
          putLedger(row.user_id, chain.id, asset, led)
        }
      } else if (bal[asset] < led.credited - led.swept) {
        // funds left without us recording a sweep (e.g. crash between tx and
        // bookkeeping) - reconcile so we never double-credit
        led.swept = led.credited - bal[asset]
        putLedger(row.user_id, chain.id, asset, led)
      }

      // 2) sweep credited funds to the treasury
      if (!SWEEP_ON || !chain.sweep) continue
      const sweepable = led.credited - led.swept
      if (sweepable <= 0n) continue
      try {
        const r = await chain.sweep(String(row.user_id), chain.address(TREASURY), asset, sweepable)
        if (r?.sent) {
          led.swept += r.sent
          putLedger(row.user_id, chain.id, asset, led)
          if (r.txhash) adminLog('system', `Swept ${fromBase(r.sent, decimals)} ${chain.nativeSymbol} user #${row.user_id} → treasury`)
        }
      } catch { /* sweep retries next round */ }
    }
  }
}

// ---- withdrawals ----
export const requestWithdrawal = (userId, { chain: chainId, to, usd }) => {
  const chain = adapters[chainId]
  if (!chain) return { error: 'Unknown chain.' }
  const asset = 'native'
  usd = Math.round(Number(usd) * 100) / 100
  if (!(usd >= MIN_WITHDRAW)) return { error: `Minimum withdrawal is $${MIN_WITHDRAW}.` }
  if (!chain.validAddress(String(to || ''))) {
    return { error: `That is not a ${chain.label} wallet address. Paste the address of a wallet you hold the keys to - not a token account.` }
  }
  const price = assetPrice(chain, asset)
  if (!(price > 0)) return { error: 'Price feed unavailable - try again shortly.' }
  const plan = debit(userId, usd, 'withdraw',
    `Withdrawal request: $${usd} → ${chain.label} (${chain.nativeSymbol})${WITHDRAW_FEE_USD ? ` incl. $${WITHDRAW_FEE_USD} network fee` : ''}`,
    chainId)
  if (!plan) {
    const have = Math.round(fundsOn(userId, chainId) * 100) / 100
    return { error: `Your balance is $${have} - pick a smaller amount.` }
  }
  // The COIN that left the balance, recorded now. A request can sit in the queue
  // for hours; paying it out as "$X at whatever the price is by then" would send
  // a different amount of SOL than was taken. The plan is already in coin.
  const coin = plan.reduce((a, p) => a + p.amount, 0)
  // Lockdown overrides the auto-approve band completely: under manual payouts
  // every request waits for a person, however small.
  const auto = usd <= autoMax() && !manualPayouts()
  const r = db.prepare(`INSERT INTO withdrawals (user_id, chain, asset, to_address, usd, fee, coin, status, ts, updated)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(userId, chainId, asset, String(to).trim(), usd, WITHDRAW_FEE_USD, coin, auto ? 'approved' : 'pending', Date.now(), Date.now())
  adminLog('system', `Withdrawal #${r.lastInsertRowid} requested: $${usd} → ${chain.label} by user #${userId}${auto ? ' (auto-approved)' : manualPayouts() ? ' (held - manual payouts on)' : ''}`)
  return { ok: true, id: Number(r.lastInsertRowid), status: auto ? 'approved' : 'pending' }
}

// ---- settling a winner ----
//
// The win lands as arena balance and stays there (owner's call, 5 Aug 2026).
// `creditLike` has already credited it before this runs, so the player can
// stake it, rematch with it, or withdraw it - once, deliberately, through the
// form. One trip to the chain instead of two, at the moment they choose.
//
// Kept as a function because settlement calls it and the manual-payouts
// lockdown is recorded here. Never throws.
export const payoutWinnings = (userId, usd, _plan, note) => {
  const out = { queued: 0, kept: 0 }
  try {
    const total = Math.round(Number(usd) * 100) / 100
    if (!(total > 0)) return out
    if (manualPayouts()) {
      adminLog('system', `Manual payouts ON - $${total} to user #${userId} kept as balance (${note || 'winnings'})`)
    }
    out.kept = total
  } catch (e) {
    adminLog('system', `Payout bookkeeping failed for user #${userId} ($${usd}): ${String(e.message || e).slice(0, 160)} - left as balance`)
  }
  return out
}

export const decideWithdrawal = (id, approve, actor) => {
  const w = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id)
  if (!w || w.status !== 'pending') return { error: 'No pending withdrawal with that id.' }
  if (approve) {
    db.prepare(`UPDATE withdrawals SET status = 'approved', updated = ? WHERE id = ?`).run(Date.now(), id)
    adminLog(actor, `Withdrawal #${id} approved ($${w.usd})`)
  } else {
    db.prepare(`UPDATE withdrawals SET status = 'rejected', updated = ? WHERE id = ?`).run(Date.now(), id)
    if (w.asset === 'coin') creditTokens(w.user_id, w.token, w.asset_amount, `Coin withdrawal #${id} rejected - coins returned`)
    else credit(w.user_id, w.usd, 'refund', `Withdrawal #${id} rejected - funds returned`, w.chain)
    adminLog(actor, `Withdrawal #${id} rejected (${w.asset === 'coin' ? `${w.asset_amount} ${w.token}` : `$${w.usd}`}) - returned`)
  }
  return { ok: true }
}

// Send coins a player owns to their own wallet. The quantity is what counts, not
// a dollar figure: the arena is handing over the exact tokens it holds for them,
// so a price move between request and payout changes nothing about what is sent.
export const requestCoinWithdrawal = (userId, { token, amount, to }) => {
  token = String(token || '')
  amount = Number(amount)
  const have = holdingOf(userId, token)
  if (!(amount > 0)) return { error: 'Enter an amount above zero.' }
  if (have <= 0) return { error: 'You do not own that coin.' }
  if (amount > have + 1e-9) return { error: `You own ${have.toPrecision(8)} ${token}.` }

  const asset = hedgeAssetOf(token)
  if (!asset?.address || asset.decimals == null) {
    return { error: 'The arena cannot resolve that coin on-chain right now, so it will not send it anywhere. Hold it, or sell it for SOL.' }
  }
  const chain = adapters[asset.chain]
  if (!chain?.sendToken) return { error: 'That coin lives on a chain the arena cannot send from.' }
  if (!chain.validAddress(String(to || ''))) return { error: `That is not a ${chain.label} wallet address.` }

  const send = Math.min(amount, have)
  if (!debitTokens(userId, token, send)) return { error: 'Insufficient coins.' }

  const usd = Math.round(send * (priceUsd(token) || 0) * 100) / 100
  // Lockdown covers coins too: they leave the treasury exactly like money does,
  // and a switch that holds one but not the other is not a lockdown.
  const auto = usd > 0 && usd <= autoMax() && !manualPayouts()
  const r = db.prepare(`INSERT INTO withdrawals (user_id, chain, asset, token, to_address, usd, fee, asset_amount, status, ts, updated)
                        VALUES (?, ?, 'coin', ?, ?, ?, 0, ?, ?, ?, ?)`)
    .run(userId, asset.chain, token, String(to).trim(), usd, send, auto ? 'approved' : 'pending', Date.now(), Date.now())
  adminLog('system', `Coin withdrawal #${r.lastInsertRowid} requested: ${send.toPrecision(6)} ${token} (~$${usd}) → ${chain.label} by user #${userId}${auto ? ' (auto-approved)' : ''}`)
  return { ok: true, id: Number(r.lastInsertRowid), status: auto ? 'approved' : 'pending' }
}

// A payout left the queue, one way or the other. Shared by the first attempt
// and by the reconciler that settles payouts whose outcome was unknown.
const markSent = (w, txhash, assetAmount, chain) => {
  const isCoin = w.asset === 'coin'
  db.prepare(`UPDATE withdrawals SET status = 'sent', txhash = ?, asset_amount = ?, updated = ? WHERE id = ?`)
    .run(txhash, assetAmount, Date.now(), w.id)
  // The coins are gone from the treasury for real now, so the hedge book
  // must stop counting them as held.
  if (isCoin) hedgeRelease(w.token, assetAmount)
  adminLog('system', isCoin
    ? `Coin withdrawal #${w.id} sent: ${Number(assetAmount).toPrecision(6)} ${w.token} → ${chain.label} - ${txhash}`
    : `Withdrawal #${w.id} sent: $${Math.max(0, w.usd - (w.fee || 0))} net (${Number(assetAmount).toFixed(6)} ${chain.nativeSymbol}) - ${txhash}`)
  try { onWalletChanged(w.user_id) } catch { /* refresh push */ }
}
// Only for a payout the chain PROVABLY did not execute - see solrpc.js.
const markFailedAndRefund = (w, reason) => {
  const isCoin = w.asset === 'coin'
  db.prepare(`UPDATE withdrawals SET status = 'failed', note = ?, updated = ? WHERE id = ?`)
    .run(String(reason).slice(0, 300), Date.now(), w.id)
  // Give back exactly what was taken: coins as coins, money as money.
  if (isCoin) creditTokens(w.user_id, w.token, w.asset_amount, `Coin withdrawal #${w.id} failed on-chain - coins returned`)
  else credit(w.user_id, w.usd, 'refund', `Withdrawal #${w.id} failed on-chain - funds returned`, w.chain)
  adminLog('system', `Withdrawal #${w.id} FAILED (${String(reason).slice(0, 120)}) - returned ${isCoin ? `${w.asset_amount} ${w.token}` : `$${w.usd}`}`)
  try { onWalletChanged(w.user_id) } catch { /* refresh push */ }
}

// Payouts whose outcome was not known when they were sent ('unconfirmed'), or
// that a crash interrupted mid-send ('sending'). Nothing here ever pays twice:
// a payout with a recorded signature is settled by what the chain says about
// THAT signature, and one that never got as far as being signed was never
// broadcast, so it simply goes back in the queue.
const reconcileWithdrawals = async () => {
  const stuck = db.prepare(`SELECT * FROM withdrawals WHERE status IN ('unconfirmed', 'sending') ORDER BY ts ASC LIMIT 10`).all()
  for (const w of stuck) {
    const chain = adapters[w.chain]
    if (!chain) continue
    if (!w.txhash) {
      db.prepare(`UPDATE withdrawals SET status = 'approved', updated = ? WHERE id = ?`).run(Date.now(), w.id)
      continue
    }
    if (typeof chain.checkTx !== 'function') continue
    const outcome = await chain.checkTx(w.txhash, w.tx_expiry)
    if (outcome === 'landed') markSent(w, w.txhash, w.asset_amount, chain)
    else if (outcome === 'failed') markFailedAndRefund(w, 'did not land on-chain (checked after the fact)')
    else if (w.status === 'sending') {
      db.prepare(`UPDATE withdrawals SET status = 'unconfirmed', updated = ? WHERE id = ?`).run(Date.now(), w.id)
    }
  }
}

let sending = false
export const processWithdrawals = async () => {
  if (sending) return
  sending = true
  try {
    await reconcileWithdrawals()
    const queue = db.prepare(`SELECT * FROM withdrawals WHERE status = 'approved' ORDER BY ts ASC LIMIT 5`).all()
    for (const w of queue) {
      const chain = adapters[w.chain]
      if (!chain) continue
      // Coins go out as the quantity that was requested; only cash withdrawals
      // convert through a price.
      const isCoin = w.asset === 'coin'
      const asset = isCoin ? hedgeAssetOf(w.token) : null
      if (isCoin && (!asset?.address || asset.decimals == null)) continue // venue not up yet - retry next round
      const price = isCoin ? 1 : assetPrice(chain, 'native')
      if (!(price > 0)) continue
      const netUsd = Math.max(0, w.usd - (w.fee || 0))
      const decimals = isCoin ? asset.decimals : chain.nativeDecimals
      // Send back the coin that left the balance, less the fee as a SHARE of it,
      // so the amount that goes out does not depend on where the price drifted
      // while the request waited. Legacy rows with no coin on record convert
      // through the price, as they always did.
      const ledgerCoin = !isCoin && w.coin > 0 && chain.nativeSymbol === LEDGER_COIN
      const assetAmount = isCoin ? w.asset_amount
        : ledgerCoin ? w.coin * (w.usd > 0 ? netUsd / w.usd : 1)
          : netUsd / price
      // The amount is fixed on the row BEFORE sending, so a payout settled later
      // by the reconciler records exactly what went out.
      db.prepare(`UPDATE withdrawals SET status = 'sending', asset_amount = ?, updated = ? WHERE id = ?`).run(assetAmount, Date.now(), w.id)
      // The signature is on the row before a byte is broadcast: if the process
      // dies mid-send, the reconciler still knows exactly which transaction to
      // ask the chain about.
      const onSigned = (sig, expiry) => db.prepare(`UPDATE withdrawals SET txhash = ?, tx_expiry = ? WHERE id = ?`).run(sig, expiry ?? null, w.id)
      try {
        const txhash = isCoin
          ? await chain.sendToken(TREASURY, w.to_address, asset.address, toBase(assetAmount, decimals), { onSigned })
          : await chain.send(TREASURY, w.to_address, 'native', toBase(assetAmount, decimals), { onSigned })
        markSent(w, txhash, assetAmount, chain)
      } catch (e) {
        if (e?.definite === false) {
          // Sent, but the chain has not said how it ended. Refunding now could
          // pay twice - held instead, and settled by reconcileWithdrawals.
          db.prepare(`UPDATE withdrawals SET status = 'unconfirmed', note = ?, updated = ? WHERE id = ?`)
            .run(String(e.message || e).slice(0, 300), Date.now(), w.id)
          adminLog('system', `Withdrawal #${w.id} outcome unknown (${String(e.message || e).slice(0, 100)}) - held, will be checked against the chain`)
          try { onWalletChanged(w.user_id) } catch { /* refresh push */ }
        } else if (transientRpcError(e) && !db.prepare('SELECT txhash FROM withdrawals WHERE id = ?').get(w.id)?.txhash) {
          // The RPC did not answer before anything was signed - nothing left
          // the treasury. Back in the queue rather than bounced to the player.
          db.prepare(`UPDATE withdrawals SET status = 'approved', note = ?, updated = ? WHERE id = ?`)
            .run(`RPC unavailable, retrying: ${String(e.message || e).slice(0, 200)}`, Date.now(), w.id)
        } else {
          markFailedAndRefund(w, e.message || e)
        }
      }
    }
  } finally {
    sending = false
  }
}

// ---- views ----
export const userWithdrawals = (userId) =>
  db.prepare('SELECT id, chain, asset, token, to_address, usd, fee, asset_amount, status, txhash, note, ts FROM withdrawals WHERE user_id = ? ORDER BY ts DESC LIMIT 20').all(userId)

export const userDeposits = (userId) =>
  db.prepare('SELECT chain, asset, amount, usd, price, fee, ts FROM deposits WHERE user_id = ? ORDER BY ts DESC LIMIT 20').all(userId)

export const pendingWithdrawals = () =>
  db.prepare(`SELECT w.*, u.name FROM withdrawals w JOIN users u ON u.id = w.user_id WHERE w.status = 'pending' ORDER BY w.ts ASC`).all()

export const recentWithdrawals = () =>
  db.prepare(`SELECT w.*, u.name FROM withdrawals w JOIN users u ON u.id = w.user_id ORDER BY w.ts DESC LIMIT 30`).all()

export const treasuryOverview = async () => {
  const out = []
  for (const c of Object.values(adapters)) {
    let address = null, native = null, error = null
    try {
      address = c.address(TREASURY)
      const b = await c.balances(address)
      native = fromBase(b.native, c.nativeDecimals)
    } catch (e) { error = String(e.message || e).slice(0, 120) }
    out.push({ chain: c.id, label: c.label, network: c.network, address, native, nativeSymbol: c.nativeSymbol, usdc: 0, error })
  }
  return out
}

// Unswept credited funds still sitting on deposit addresses, valued in USD.
export const unsweptUsd = () => {
  const rows = db.prepare('SELECT user_id, chain, asset, credited, swept FROM wallet_ledger').all()
  let usd = 0
  for (const r of rows) {
    const chain = adapters[r.chain]
    if (!chain || r.asset !== 'native') continue
    const pending = BigInt(r.credited) - BigInt(r.swept)
    if (pending <= 0n) continue
    usd += fromBase(pending, chain.nativeDecimals) * assetPrice(chain, 'native')
  }
  return Math.round(usd * 100) / 100
}

// Full-reserve check: what we OWE users vs what we HOLD.
export const backingReport = async (extraAssetsUsd = 0, coinLiabilitiesUsd = 0) => {
  // Coins won in Live are a liability too: the player owns them, the treasury
  // merely holds them. They are matched one-for-one by hedge positions on the
  // asset side, so counting only the asset would overstate the reserve.
  const liabilities = totalBalancesUsd()
    + db.prepare('SELECT COALESCE(SUM(amount), 0) s FROM stake_locks').get().s
    + coinLiabilitiesUsd
  const treasury = await treasuryOverview()
  let treasuryUsd = 0
  for (const t of treasury) {
    if (t.error) continue
    treasuryUsd += (t.native || 0) * priceUsd(t.nativeSymbol)
  }
  const unswept = unsweptUsd()
  const assets = Math.round((treasuryUsd + unswept + extraAssetsUsd) * 100) / 100
  return {
    liabilities: Math.round(liabilities * 100) / 100,
    coinLiabilitiesUsd: Math.round(coinLiabilitiesUsd * 100) / 100,
    treasuryUsd: Math.round(treasuryUsd * 100) / 100,
    unsweptUsd: unswept,
    hedgeUsd: Math.round(extraAssetsUsd * 100) / 100,
    assets,
    equity: Math.round((assets - liabilities) * 100) / 100,
    ratio: liabilities > 0 ? Math.round((assets / liabilities) * 1000) / 10 : null,
  }
}

export const walletMeta = () => ({
  env: CHAIN_ENV,
  coin: LEDGER_COIN,
  minWithdraw: MIN_WITHDRAW,
  autoMax: autoMax(),
  withdrawFeeUsd: WITHDRAW_FEE_USD,
  chains: Object.values(adapters).map((c) => ({
    id: c.id, label: c.label, icon: c.icon, network: c.network, nativeSymbol: c.nativeSymbol,
    // Whether money on this rail is real, independent of the env label.
    liveNetwork: c.liveNetwork !== false,
    nativeLabel: c.nativeLabel || c.nativeSymbol,
    nativeDecimals: c.nativeDecimals,
    depositFeeUsd: DEPOSIT_FEE_USD[c.id] ?? 0,
    explorer: c.explorer ?? null,
  })),
})
