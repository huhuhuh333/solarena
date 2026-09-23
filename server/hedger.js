// Treasury hedging engine - "oracle referees, treasury holds the positions".
//
// Open Live-Arena battles imply a token exposure: each player's entry bought a
// virtual basket at battle-start prices. This engine makes the treasury HOLD
// that basket for real, NETTED across all battles (two players long WIF = one
// position), so every payout is backed by assets that moved exactly like the
// players' portfolios. Targets are token AMOUNTS fixed at battle start, so
// price moves cause no churn - trades happen only when battles open or close.
//
// Executors:
//   paper   - records fills at oracle price ± slippage (testnet / unsupported tokens)
//   jupiter - real Solana mainnet swaps via Jupiter aggregator, treasury signs
//
// The engine is view-first: admin always sees target vs held vs drift.

import { db, adminLog } from './db.js'
import { tokenById } from '../src/engine/tokens.js'
import { dynamicById } from './registry.js'
import { HEDGE_MIN_USD } from './rules.js'

const poolOf = (tokenId) => (tokenById(tokenId) || dynamicById(tokenId) || {}).pool || null

// Minimum size worth sending to a venue. It only has to clear the gas - a swap
// costs about a tenth of a cent on Solana and six cents on the Robinhood L2 -
// because there is no churn to suppress: targets are TOKEN AMOUNTS fixed at
// battle start, so a price move never triggers a trade. Lives in rules.js
// because the pick rules enforce the same floor at the door.
const THRESHOLD_USD = HEDGE_MIN_USD
const REBALANCE_MS = 30000
const PAPER_SLIP = 0.003

db.exec(`
CREATE TABLE IF NOT EXISTS hedge_positions (
  token TEXT PRIMARY KEY,
  amount REAL NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS hedge_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  token TEXT NOT NULL,
  side TEXT NOT NULL,
  amount REAL NOT NULL,
  usd REAL NOT NULL,
  price REAL NOT NULL,
  venue TEXT NOT NULL,
  txhash TEXT
);
`)

let priceUsd = () => 0
let openExposure = () => ({})
let executor = null
let timer = null

export const paperExecutor = {
  venue: 'paper',
  async trade(token, side, usd, oraclePrice) {
    const eff = side === 'buy' ? oraclePrice * (1 + PAPER_SLIP) : oraclePrice * (1 - PAPER_SLIP)
    return { amount: usd / eff, usd, price: eff, txhash: null, venue: 'paper' }
  },
}

export const initHedger = ({ getPriceUsd, exposure, exec }) => {
  priceUsd = getPriceUsd
  openExposure = exposure
  executor = exec || paperExecutor
}

// Can the live executor actually route this token? Executors that move no real
// money (the paper book) say yes to everything - there is nothing to protect.
// A real executor answers honestly, and the token source uses that answer to
// decide whether the token may enter Live Arena at all.
export const hedgeCanTrade = (token) =>
  (executor?.canTrade ? executor.canTrade(token) : true)

// Dollars this pool's chain could still put behind a new Live battle: the cash
// sitting there plus the value of what it already holds. Positions count because
// a battle ending frees its basket back into cash - capacity recycles, it is not
// consumed. Infinity when nothing real is at stake (paper book).
export const hedgeCapacityUsd = (pool) => {
  const idle = executor?.spendableUsd ? executor.spendableUsd(pool) : Infinity
  if (!Number.isFinite(idle)) return Infinity
  let held = 0
  for (const r of db.prepare('SELECT token, amount FROM hedge_positions WHERE amount > 0').all()) {
    if (poolOf(r.token) !== pool) continue
    held += r.amount * (priceUsd(r.token) || 0)
  }
  return idle + held
}

export const startHedger = () => {
  if (timer) return
  timer = setInterval(() => { rebalance().catch((e) => console.error('[hedger]', e.message)) }, REBALANCE_MS)
}

// A battle opening or closing changes the target book NOW - waiting for the
// next 30s tick would leave up to 30s of price gap between what players are
// owed (entry-tick baskets) and what the treasury holds. The kick runs a
// rebalance immediately; the interval stays as the safety net for anything a
// kick misses (failed swap, book busy). Debounced a beat so a burst of
// simultaneous battle starts nets into one pass instead of N, and re-armed
// when the book is mid-trade so the change is never silently dropped.
let kickTimer = null
export const kickHedger = () => {
  if (kickTimer) return
  kickTimer = setTimeout(() => {
    kickTimer = null
    if (busy) { kickHedger(); return }
    rebalance().catch((e) => console.error('[hedger]', e.message))
  }, 250)
}

const getPos = (token) =>
  db.prepare('SELECT amount, cost FROM hedge_positions WHERE token = ?').get(token) || { amount: 0, cost: 0 }

const putPos = (token, amount, cost) =>
  db.prepare(`INSERT INTO hedge_positions (token, amount, cost) VALUES (?, ?, ?)
              ON CONFLICT(token) DO UPDATE SET amount = excluded.amount, cost = excluded.cost`)
    .run(token, amount, cost)

// One writer at a time on the position book. Both the rebalancer and a player's
// sell read a position, await a swap, then write the result back - run them
// concurrently and the slower one overwrites the other's fill with a stale
// number, and the book silently stops matching what the treasury holds.
let busy = false
const takeBook = async () => {
  for (let i = 0; busy && i < 400; i++) await new Promise((r) => setTimeout(r, 50))
  if (busy) throw new Error('hedge book is busy - try again in a moment')
  busy = true
}

export const rebalance = async () => {
  if (busy || !executor) return
  busy = true
  try {
    if (executor.refresh) await executor.refresh().catch(() => {}) // capacity gate must not read a stale balance
    const targets = openExposure() // token -> amount (token units, fixed at battle start)
    const held = db.prepare('SELECT token FROM hedge_positions WHERE amount > 0').all().map((r) => r.token)
    const tokens = new Set([...Object.keys(targets), ...held])
    for (const token of tokens) {
      const price = priceUsd(token)
      if (!(price > 0)) continue
      const target = targets[token] || 0
      const pos = getPos(token)
      const diffAmount = target - pos.amount
      const diffUsd = diffAmount * price
      if (Math.abs(diffUsd) < THRESHOLD_USD) continue
      const side = diffAmount > 0 ? 'buy' : 'sell'
      try {
        const fill = await executor.trade(token, side, Math.abs(diffUsd), price)
        const signedAmount = side === 'buy' ? fill.amount : -fill.amount
        const signedUsd = side === 'buy' ? fill.usd : -fill.usd
        putPos(token, Math.max(0, pos.amount + signedAmount), Math.max(0, pos.cost + signedUsd))
        db.prepare('INSERT INTO hedge_trades (ts, token, side, amount, usd, price, venue, txhash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(Date.now(), token, side, fill.amount, fill.usd, fill.price, fill.venue, fill.txhash)
        adminLog('system', `Hedge ${side} ${token}: $${fill.usd.toFixed(2)} @ ${fill.price.toPrecision(6)} (${fill.venue}${fill.txhash ? ' ' + fill.txhash.slice(0, 12) + '…' : ''})`)
      } catch (e) {
        adminLog('system', `Hedge ${side} ${token} FAILED: ${String(e.message || e).slice(0, 120)} - drift stays visible`)
      }
    }
  } finally {
    busy = false
  }
}

// Before a payout hands out coins, the book gets asked whether it really holds
// them: `needed` is what this payout wants to give (token → amount), `stillOwed`
// is what must stay behind for every other battle and holder. Returns the USD
// value the positions fall short by, counting only per-token gaps ABOVE the
// trade threshold - gaps under it are the book's own stated blind spot (diffs
// that small are never traded) and paper-slip drift, not missing coins.
// Infinity when a price is missing: what can't be valued can't be verified.
export const hedgeShortfallUsd = (needed, stillOwed = {}) => {
  let short = 0
  for (const [token, amount] of Object.entries(needed)) {
    const price = priceUsd(token)
    if (!(price > 0)) return Infinity
    const missing = (stillOwed[token] || 0) + amount - getPos(token).amount
    const missingUsd = missing * price
    if (missingUsd > THRESHOLD_USD) short += missingUsd
  }
  return Math.round(short * 100) / 100
}

// Coins physically left the treasury without a trade - a player asked for them
// and they were sent. The book has to forget them, or the next rebalance will
// see a position that is no longer there and try to sell it.
export const hedgeRelease = (token, amount) => {
  const pos = getPos(token)
  const share = pos.amount > 0 ? Math.min(1, amount / pos.amount) : 0
  putPos(token, Math.max(0, pos.amount - amount), Math.max(0, pos.cost * (1 - share)))
}

// The on-chain asset the treasury actually holds for a token - mint or contract
// address, its chain, and decimals. Null when the venue cannot say, and then the
// coins can only be held or sold, never sent out: guessing an address here would
// send a player's coins into nothing.
export const hedgeAssetOf = (tokenId) =>
  (executor?.assetOf ? executor.assetOf(tokenId) : null)

// Sell coins a player owns, at whatever the market actually gives. The player
// is credited the REALISED proceeds, never an oracle estimate - the arena is not
// quoting them a price, it is executing their order. If the sell fails, nothing
// moves and they still hold the coins, which is the honest outcome for a token
// whose exit has dried up.
// `onFilled` runs while the book is still locked, so the player's coins and cash
// move in the same breath as the position - nothing can observe a state where
// the treasury has sold but the player still owns what it sold.
export const sellForUser = async (token, amount, onFilled = null) => {
  const price = priceUsd(token)
  if (!(price > 0)) throw new Error('No live price for that coin right now.')
  if (!executor) throw new Error('Trading venue is not running.')
  await takeBook()
  try {
    const fill = await executor.trade(token, 'sell', amount * price, price)
    const pos = getPos(token)
    putPos(token, Math.max(0, pos.amount - fill.amount), Math.max(0, pos.cost - fill.usd))
    db.prepare('INSERT INTO hedge_trades (ts, token, side, amount, usd, price, venue, txhash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(Date.now(), token, 'sell', fill.amount, fill.usd, fill.price, fill.venue, fill.txhash)
    if (onFilled) {
      try {
        onFilled(fill)
      } catch (e) {
        // The player's side of the ledger refused the fill, so the book must not
        // keep the sale either - otherwise the treasury has sold coins someone
        // is still recorded as owning.
        putPos(token, pos.amount, pos.cost)
        adminLog('system', `Sell of ${token} rolled back - ledger write failed: ${String(e.message || e).slice(0, 120)}`)
        throw e
      }
    }
    return fill
  } finally {
    busy = false
  }
}

// Market value of everything the hedge book holds (counts as backing assets).
export const hedgeValueUsd = () => {
  const rows = db.prepare('SELECT token, amount FROM hedge_positions WHERE amount > 0').all()
  let usd = 0
  for (const r of rows) usd += r.amount * (priceUsd(r.token) || 0)
  return Math.round(usd * 100) / 100
}

// Cash the treasury holds on chains that have no deposit addresses - the float
// pre-positioned so a pool like the Robinhood L2 can be hedged at all. It backs
// user balances exactly like treasury USDC does, and treasuryOverview() cannot
// see it (that only walks the custody chains), so the reserve report would show
// a hole the size of the float unless it is counted here.
export const hedgeFloatUsd = (pools = ['eth']) => {
  if (!executor?.spendableUsd) return 0
  let usd = 0
  for (const pool of pools) {
    const v = executor.spendableUsd(pool)
    if (Number.isFinite(v)) usd += v
  }
  return Math.round(usd * 100) / 100
}

export const hedgeOverview = () => {
  const targets = openExposure()
  const rows = db.prepare('SELECT token, amount, cost FROM hedge_positions').all()
  const tokens = new Set([...Object.keys(targets), ...rows.map((r) => r.token)])
  const out = []
  for (const token of tokens) {
    const pos = rows.find((r) => r.token === token) || { amount: 0, cost: 0 }
    const price = priceUsd(token) || 0
    const target = targets[token] || 0
    if (pos.amount === 0 && target === 0) continue
    out.push({
      token,
      targetAmount: target,
      heldAmount: pos.amount,
      heldUsd: Math.round(pos.amount * price * 100) / 100,
      driftUsd: Math.round((target - pos.amount) * price * 100) / 100,
      cost: Math.round(pos.cost * 100) / 100,
    })
  }
  return {
    positions: out,
    venue: executor?.venue || 'off',
    venues: executor?.stats?.() ?? null, // per-chain routability, so admin sees which book is real
    thresholdUsd: THRESHOLD_USD,
    trades: db.prepare('SELECT ts, token, side, amount, usd, price, venue, txhash FROM hedge_trades ORDER BY ts DESC LIMIT 20').all(),
  }
}
