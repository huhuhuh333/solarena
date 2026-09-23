// Cashing out coins a player won in Live Arena.
//
// Live settles in kind: the winner takes the actual tokens, so the house never
// has to find an exit to pay anyone. When a player wants dollars instead, the
// arena executes a real sell on their behalf and credits exactly what came back
// - realised proceeds, not an oracle valuation. The arena is filling their
// order, not quoting them a price, so a thin or dead market costs the holder,
// never the house.
//
// Nothing is debited until the swap has actually landed, and one sale per user
// at a time, so a double-clicked button cannot sell the same coins twice.

import { holdingOf, holdingsOf, debitTokens, credit, txn, adminLog } from './db.js'
import { sellForUser } from './hedger.js'
import { effToken } from './rules.js'
import { venueCanTrade } from './venue.js'
import { poolFund } from '../src/engine/tokens.js'

const selling = new Set()

// A coin in free fall refuses to sell. POOLS reverted seven times running on
// 5 Aug 2026 and sold on the eighth - and the log says why: $2.97 → $2.45 in a
// quarter of an hour. Every quote went stale before its block landed, and the
// router's minimum-output check did exactly its job. The first read of that
// pattern was "this token cannot be sold", which was wrong: it could, once it
// stopped falling.
//
// So the message after two failures says what is true - it is still failing,
// here are both ways out - and never that a coin is unsellable, which is a
// claim a couple of reverts do not support.
const sellFails = new Map() // token -> consecutive failures
const SELL_FAILS_BEFORE_TELLING = 2

export const sellHolding = async (userId, token, amount) => {
  amount = Number(amount)
  if (!(amount > 0)) return { error: 'Enter an amount above zero.' }

  const have = holdingOf(userId, token)
  if (have <= 0) return { error: 'You do not own that coin.' }
  if (amount > have + 1e-9) return { error: `You own ${have.toPrecision(8)} ${token}.` }

  const t = effToken(token)
  if (!t) return { error: 'Unknown coin.' }

  // Proceeds land on the chain that coin trades on - the same chain the
  // treasury just received the stablecoin on. Anywhere else would be a claim
  // against money that is not there.
  const fund = poolFund(t.pool)
  if (!fund) return { error: 'That coin has no cash-out venue - you can only hold or transfer it.' }

  if (selling.has(userId)) return { error: 'A sale is already going through.' }
  selling.add(userId)
  try {
    const sold = Math.min(amount, have)
    // The coins leave the player and the cash arrives inside the same book lock
    // as the swap itself - there is no instant where the treasury has sold
    // something the player is still recorded as owning.
    const fill = await sellForUser(token, sold, (f) => {
      if (!(f?.usd > 0)) return
      txn(() => {
        debitTokens(userId, token, sold)
        credit(userId, Math.round(f.usd * 100) / 100, 'deposit',
          `Sold ${sold.toPrecision(6)} ${token} for $${f.usd.toFixed(2)} (${f.venue})`, fund.chain)
      })
    })
    if (!(fill?.usd > 0)) return { error: 'The sale did not fill - you still hold the coins.' }
    sellFails.delete(token) // it sold, so whatever was wrong before is not wrong now
    adminLog('system', `User #${userId} sold ${sold.toPrecision(6)} ${token} → $${fill.usd.toFixed(2)} (${fill.venue})`)
    return { ok: true, usd: Math.round(fill.usd * 100) / 100, venue: fill.venue, txhash: fill.txhash || null }
  } catch (e) {
    // The player got the chain's own words, truncated at 140 characters, which
    // is how a real failure read as gibberish and left no trace anywhere. The
    // full text goes where it is useful - the admin log and the journal, with
    // the transaction hash if there was one - and the holder gets the two facts
    // that concern them: it did not happen, and the coins are still theirs.
    const raw = String(e.message || e)
    adminLog('system', `Sell FAILED - user #${userId}, ${amount} ${token}: ${raw.slice(0, 400)}`)
    console.error(`[holdings] sell failed for user #${userId} (${token}):`, raw)
    const fails = (sellFails.get(token) || 0) + 1
    sellFails.set(token, fails)
    if (fails >= SELL_FAILS_BEFORE_TELLING) {
      return { error: `${token} keeps refusing the trade - its price is moving faster than the exchange will accept, so every quote goes stale before the trade lands. Give it a minute, or use Send to move the coin itself to your wallet. Your coins are untouched either way.`, sendOnly: true }
    }
    return { error: 'The sale could not go through just now - you still hold every coin. Try again in a moment.' }
  } finally {
    selling.delete(userId)
  }
}

// What a player owns, priced for display. `sellable` is the honest bit: a coin
// whose venue cannot route a sell can still be held or transferred, but the
// arena will not pretend it can cash it out.
export const holdingsView = (userId, priceOf) =>
  holdingsOf(userId).map((h) => {
    const t = effToken(h.token)
    const price = priceOf(h.token) || 0
    return {
      token: h.token,
      ticker: t?.ticker || h.token,
      pool: t?.pool || null,
      amount: h.amount,
      price,
      usd: Math.round(h.amount * price * 100) / 100,
      sellable: !!poolFund(t?.pool) && venueCanTrade(t),
    }
  })
