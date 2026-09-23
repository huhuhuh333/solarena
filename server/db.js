// SQLite persistence via node:sqlite (Node 22.5+, zero native deps).
// All money movements go through credit()/debit() so every cent leaves a tx row.

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const DB_PATH = process.env.HOOD_DB || 'server/data/hoodarena.db'
mkdirSync(dirname(DB_PATH), { recursive: true })

export const db = new DatabaseSync(DB_PATH)
db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA foreign_keys = ON')

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  avatar TEXT NOT NULL DEFAULT '🔥',
  bio TEXT NOT NULL DEFAULT 'Here to take pools.',
  created INTEGER NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  blocked INTEGER NOT NULL DEFAULT 0,
  training_done INTEGER NOT NULL DEFAULT 0,
  balance REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS txs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  amount REAL NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_txs_user ON txs(user_id, ts DESC);
CREATE TABLE IF NOT EXISTS stake_locks (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  amount REAL NOT NULL,
  ref TEXT NOT NULL,
  chain TEXT,
  plan TEXT,
  ts INTEGER NOT NULL
);
-- Where each user's money physically stands, by chain. With one rail (Solana)
-- every bucket is 'sol'; the split is kept because Live must spend money that
-- already stands on the chain its basket is bought on.
CREATE TABLE IF NOT EXISTS chain_funds (
  user_id INTEGER NOT NULL REFERENCES users(id),
  chain TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, chain)
);
-- Coins a player owns outright. Live Arena settles IN KIND: the treasury buys
-- both baskets at battle start and the winner takes the actual tokens, not their
-- dollar value. That removes the exit from the house's risk entirely - nothing
-- has to be sold to pay a winner, so a coin that stops being sellable is the
-- holder's problem, exactly as it would be trading anywhere else.
CREATE TABLE IF NOT EXISTS holdings (
  user_id INTEGER NOT NULL REFERENCES users(id),
  token TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, token)
);
-- The coins bought for a battle that is running right now. Rooms live in memory,
-- so a restart used to void them and refund the stakes in CASH - while the
-- treasury was still holding the baskets, forcing it to sell them to cover the
-- refund. That is the one thing in-kind settlement exists to avoid, so the
-- basket is written down the moment it is bought and handed back as coins.
CREATE TABLE IF NOT EXISTS live_baskets (
  user_id INTEGER NOT NULL REFERENCES users(id),
  room TEXT NOT NULL,
  token TEXT NOT NULL,
  amount REAL NOT NULL,
  PRIMARY KEY (user_id, token)
);
CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  mode TEXT NOT NULL,
  stake REAL NOT NULL,
  duration INTEGER NOT NULL,
  training INTEGER NOT NULL DEFAULT 0,
  tournament_id TEXT,
  user_a INTEGER REFERENCES users(id),
  user_b INTEGER REFERENCES users(id),
  name_a TEXT NOT NULL,
  name_b TEXT NOT NULL,
  ret_a REAL,
  ret_b REAL,
  outcome_a TEXT,
  payout_a REAL NOT NULL DEFAULT 0,
  payout_b REAL NOT NULL DEFAULT 0,
  fee REAL NOT NULL DEFAULT 0,
  pool REAL NOT NULL DEFAULT 0,
  flagged INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_matches_a ON matches(user_a, ts DESC);
CREATE INDEX IF NOT EXISTS idx_matches_b ON matches(user_b, ts DESC);
CREATE INDEX IF NOT EXISTS idx_matches_ts ON matches(ts DESC);
-- Multiplayer tournaments (5-10 players, one Classic battle, top of the field
-- takes the pot). Lobbies live in memory like matchmaking queues; a row exists
-- only from the moment the pick phase starts, because that is when there is
-- something to recover: entries are stake_locks, so a crash refunds them via
-- recoverLocks() and the row is closed out as cancelled at boot.
CREATE TABLE IF NOT EXISTS tourneys (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  tier TEXT NOT NULL,
  stake REAL NOT NULL,
  pool TEXT NOT NULL,
  duration INTEGER NOT NULL,
  status TEXT NOT NULL,
  settled INTEGER,
  pot REAL NOT NULL DEFAULT 0,
  fee REAL NOT NULL DEFAULT 0,
  fee_pct REAL NOT NULL DEFAULT 0,
  data TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_tourneys_ts ON tourneys(ts DESC);
CREATE TABLE IF NOT EXISTS tourney_players (
  tourney_id TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  avatar TEXT,
  picks TEXT,
  ret REAL,
  rank INTEGER,
  prize REAL NOT NULL DEFAULT 0,
  outcome TEXT,
  PRIMARY KEY (tourney_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_tourney_players_user ON tourney_players(user_id);
CREATE TABLE IF NOT EXISTS challenges (
  code TEXT PRIMARY KEY,
  from_user INTEGER NOT NULL REFERENCES users(id),
  target TEXT,
  mode TEXT NOT NULL,
  stake REAL NOT NULL,
  duration INTEGER NOT NULL,
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
);
CREATE TABLE IF NOT EXISTS token_overrides (
  token_id TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Direct messages between players. Plain text only (the client renders as
-- text, never HTML); read state lives on the recipient's copy.
CREATE TABLE IF NOT EXISTS dms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user INTEGER NOT NULL REFERENCES users(id),
  to_user INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  ts INTEGER NOT NULL,
  read INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_dms_to ON dms(to_user, read);
CREATE INDEX IF NOT EXISTS idx_dms_pair ON dms(from_user, to_user, ts);
-- Support: one thread per player, the arena on the other side of it. Kept apart
-- from the dms table on purpose - a support thread is a player talking to the
-- HOUSE, it must never land in the social inbox, and the admin needs it grouped
-- by player with its own unread state. Plain text only, like dms.
-- (No backticks in here: this whole schema is one JS template literal.)
CREATE TABLE IF NOT EXISTS support_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  from_admin INTEGER NOT NULL DEFAULT 0,
  body TEXT NOT NULL,
  ts INTEGER NOT NULL,
  read_user INTEGER NOT NULL DEFAULT 0,   -- has the PLAYER read the arena's reply
  read_admin INTEGER NOT NULL DEFAULT 0   -- has the ARENA read the player's message
);
CREATE INDEX IF NOT EXISTS idx_support_user ON support_messages(user_id, ts);
CREATE INDEX IF NOT EXISTS idx_support_unread ON support_messages(from_admin, read_admin);
CREATE TABLE IF NOT EXISTS admin_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,
  msg TEXT NOT NULL
);
-- Achievements a player has CLAIMED. Whether one is EARNED is never stored: it
-- is derived from the match record every time it is asked, so a badge can never
-- drift away from what actually happened. This table exists for the money side.
-- One row per claim, holding the dollars actually paid out, and the primary key
-- is the thing that makes a second claim of the same achievement impossible --
-- the row is inserted before the credit, inside one transaction, so a race
-- loses on the constraint rather than paying twice.
--
-- SUM(reward) per user is one half of the rebate invariant (achievements.js):
-- it can never exceed a fraction of the fees that same user has already paid.
CREATE TABLE IF NOT EXISTS achievements (
  user_id INTEGER NOT NULL REFERENCES users(id),
  key TEXT NOT NULL,
  ts INTEGER NOT NULL,
  reward REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, key)
);
CREATE INDEX IF NOT EXISTS idx_achievements_user ON achievements(user_id);
`)

// Migrations for columns added after first release.
try { db.exec(`ALTER TABLE challenges ADD COLUMN pool TEXT DEFAULT 'majors'`) } catch { /* already there */ }
// A challenge posted to the public board carries its author's portfolio, locked
// at the moment they post it. That is what makes it ASYNCHRONOUS: the battle can
// start without them, so a table no longer needs two people awake at once - the
// single biggest reason an empty arena stays empty.
try { db.exec(`ALTER TABLE challenges ADD COLUMN picks TEXT`) } catch { /* already there */ }
try { db.exec(`ALTER TABLE challenges ADD COLUMN listed INTEGER NOT NULL DEFAULT 0`) } catch { /* already there */ }
try { db.exec(`ALTER TABLE stake_locks ADD COLUMN chain TEXT`) } catch { /* already there */ }
try { db.exec(`ALTER TABLE stake_locks ADD COLUMN plan TEXT`) } catch { /* already there */ }
// The ledger is denominated in the coin the treasury actually holds - SOL, the
// rail's native coin. `balance` stays as the pre-migration dollar record and is
// never written again.
//
// These columns were named `*_eth` while the rail was Robinhood ETH. They are
// renamed in place (the values are converted from ETH to SOL once, below - see
// ensureCoinLedger) so nothing downstream reads a SOL amount under an ETH name.
const hasCol = (table, col) => {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col) } catch { return false }
}
export const coinColumn = (table, oldName, newName) => {
  if (hasCol(table, newName)) return
  if (hasCol(table, oldName)) db.exec(`ALTER TABLE ${table} RENAME COLUMN ${oldName} TO ${newName}`)
  else db.exec(`ALTER TABLE ${table} ADD COLUMN ${newName} REAL NOT NULL DEFAULT 0`)
}
coinColumn('users', 'balance_eth', 'balance_coin')
coinColumn('chain_funds', 'amount_eth', 'amount_coin')
coinColumn('txs', 'eth', 'coin')
// What the lock actually holds. A stake can sit locked for days on a board
// posting, and the coin that was taken is the only thing that can honestly come
// back - a dollar figure from posting day is a number about the past. Zero on
// rows written before the ledger held coin; those refund in dollars as they
// always did.
coinColumn('stake_locks', 'eth', 'coin')

// ---- settings ----
const DEFAULT_SETTINGS = {
  classicPaused: false,
  livePaused: false,
  // Each key is the smallest stake paying that rate; it holds until the next key.
  // The rate falls with size because a $10,000 player has somewhere else to go
  // and a $10 player does not notice - the arena's cost per battle is roughly
  // proportional either way. Taken from the pool, in cash, before any coin is
  // bought, so it never depends on what the coins do.
  feeTiers: { 10: 10, 100: 8, 300: 6, 750: 5, 1500: 4, 3000: 3, 7500: 2.5 },
  // Free play: every new account starts with play credits.
  signupCredit: 10000,
  // Which chain house-granted money (play credits, manual refunds) is treated as
  // sitting on. It is not free-floating: the treasury must actually hold it there,
  // because a player can stake it in Live on that chain or withdraw it from it.
  // Where house-granted money lands (play credits, manual refunds, achievement
  // rewards). Solana is the only rail, so it is the only answer.
  creditChain: 'sol',
  // Live Arena stake ceiling. Defaults to the top of the ladder - every table
  // open - since the event-driven hedger buys within ~a second of battle start,
  // which shrank the price-gap risk this cap existed to contain. The knob stays
  // for emergencies: admin can lower it and tables above it lock again.
  liveMaxStake: 10000,
  // Share of a player's OWN paid fees that achievement rewards may hand back,
  // in percent. This is the only knob on achievement economics, and the whole
  // guarantee rests on it staying under 100: at 40 the arena keeps three of
  // every five fee dollars that player ever paid, so no achievement - and no
  // combination of them - can leave the house down on that player. See
  // achievements.js, which clamps this to 90 no matter what is stored here.
  //
  // This mechanic is house-side accounting and is NEVER shown to players: the
  // API deliberately does not serve the fee base or the rate, because rewards
  // are meant to read as something worth chasing rather than as their own money
  // handed back. What players see is a reward balance that grows as they play.
  achieveRebatePct: 40,
  // The lockdown switch (owner's call, 2 Aug 2026). OFF by default: money
  // leaves on its own, the way it should when nothing is wrong.
  //
  // Turned ON, no dollar leaves the treasury without the operator pressing a
  // button. Winners are still credited in full - a player who won, won - but
  // the on-chain payout is held and every withdrawal queues for review instead
  // of auto-approving. It exists for the one scenario that a fee cap and a
  // stake cap cannot cover: somebody finds a bug that lets them win on demand.
  // Against that, the only real defence is a human between the exploit and the
  // exit, and this is that human's switch.
  //
  // Deliberately NOT a pause on play: pausing the arena punishes everyone for
  // one player's exploit, and it hides the abuse instead of letting it pile up
  // in a queue where it can be seen, refused and traced.
  manualPayouts: false,
}

export const getSetting = (key) => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
  if (row) return JSON.parse(row.value)
  return DEFAULT_SETTINGS[key]
}

export const setSetting = (key, value) => {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value))
}

// ---- users & money ----
//
// THE UNIT. Balances are stored as SOL, not dollars. The treasury holds SOL
// against them, so a SOL-denominated liability is backed one for one whatever
// the price does; a dollar-denominated one is a bet the house never agreed to
// take. Every function below still SPEAKS dollars - stakes, fees and payouts are
// quoted in dollars everywhere a player reads them - and converts at the edge.
//
// The consequence a player sees, and the wallet screen says so plainly: their
// balance moves with SOL between battles, because it IS SOL.
export const LEDGER_COIN = 'SOL'
// Starts at "unknown", never at 1. A default of 1 would let a mainnet process
// that forgot to wire the feed run happily at a dollar a SOL, filing every
// deposit as a hundred-times-too-large coin balance and never once complaining.
let priceFn = () => 0
let lastGoodPrice = 0

// Wired to the same live SOL/USD the deposit watcher and the hedger use - one
// price for crediting, spending and buying, never two.
export const setLedgerPrice = (fn) => { if (typeof fn === 'function') priceFn = fn; ensureCoinLedger() }

// A missing tick falls back to the last price this process saw, then to the last
// one any process ever saw - stored, so a restart during an outage still knows
// what a SOL is worth. Returns 0 when nothing is known.
const coinUsdRaw = () => {
  const p = Number(priceFn()) || 0
  if (p > 0) {
    if (p !== lastGoodPrice) { lastGoodPrice = p; try { setSetting('coinUsdLast', p) } catch { /* pre-schema */ } }
    return p
  }
  return lastGoodPrice || Number(getSetting('coinUsdLast')) || 0
}

// Testnet and the test suite may have no SOL feed, so they fall back to dollar
// parity - which is exactly how the ledger behaved before it was denominated,
// and why every existing assertion still holds to the cent.
//
// Mainnet never guesses. With real money on the books, converting a stake at an
// invented price is worse than refusing to move it, so it refuses. That freezes
// entries and payouts until a price returns; balances themselves are untouched
// and nothing is lost.
const PARITY_OK = (process.env.HOOD_CHAIN_ENV || 'testnet') !== 'mainnet'
const coinUsd = () => {
  const p = coinUsdRaw()
  if (p > 0) return p
  if (PARITY_OK) return 1
  throw new Error('No SOL price available - the ledger cannot convert. Refusing to move money.')
}

// 0 when the price is genuinely unknown, so a screen can hide the figure rather
// than print a parity placeholder as if it were a quote.
export const ledgerPriceUsd = () => coinUsdRaw()

const usdToCoin = (usd) => usd / coinUsd()
// Deliberately unrounded: this is the same full-precision number `balance` used
// to hold, and every caller that displays it already rounds. Rounding here would
// change what settlement arithmetic sees, not just what a screen shows.
const coinToUsd = (coin) => coin * coinUsd()

export const getUser = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id)
export const getUserByName = (name) => db.prepare('SELECT * FROM users WHERE name = ? COLLATE NOCASE').get(name)

export const addTx = (userId, type, amount, note, coin = 0) => {
  db.prepare('INSERT INTO txs (user_id, ts, type, amount, note, coin) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId, Date.now(), type, amount, note, coin)
}

// ---- per-chain funds ----
//
// Every unit of balance is attributed to the chain it actually sits on. With
// one rail that is always 'sol', and filing anything anywhere else would be a
// balance no adapter can pay - so bumpChain files every move onto the rail.
// The per-chain shape stays because Live spends only money standing on the
// chain its basket is bought on, and a second rail would need it again.
export const RAIL = 'sol'
const creditChain = () => RAIL

// Buckets are held in the coin, like the balance they add up to.
const bumpChain = (userId, chain, deltaCoin) => {
  const c = chain === RAIL ? chain : RAIL
  db.prepare(`INSERT INTO chain_funds (user_id, chain, amount_coin) VALUES (?, ?, ?)
              ON CONFLICT(user_id, chain) DO UPDATE SET amount_coin = amount_coin + excluded.amount_coin`)
    .run(userId, c, deltaCoin)
  db.prepare('DELETE FROM chain_funds WHERE user_id = ? AND chain = ? AND amount_coin <= ?').run(userId, c, EPS_COIN)
}

export const chainFunds = (userId) => {
  const out = {}
  for (const r of db.prepare('SELECT chain, amount_coin FROM chain_funds WHERE user_id = ?').all(userId)) {
    out[r.chain] = Math.round(coinToUsd(r.amount_coin) * 100) / 100
  }
  return out
}

// The same buckets in the coin they are actually held in.
export const chainFundsCoin = (userId) => {
  const out = {}
  for (const r of db.prepare('SELECT chain, amount_coin FROM chain_funds WHERE user_id = ?').all(userId)) {
    out[r.chain] = r.amount_coin
  }
  return out
}

// What the arena owes players on each chain, unstaked. Money locked in a battle
// is not here - lockStake already took it out of the bucket.
export const chainLiabilities = () => {
  const out = {}
  for (const r of db.prepare('SELECT chain, SUM(amount_coin) s FROM chain_funds GROUP BY chain').all()) {
    out[r.chain] = Math.round(coinToUsd(r.s) * 100) / 100
  }
  return out
}

const fundsOnCoin = (userId, chain) =>
  db.prepare('SELECT amount_coin FROM chain_funds WHERE user_id = ? AND chain = ?').get(userId, chain)?.amount_coin ?? 0

export const fundsOn = (userId, chain) => coinToUsd(fundsOnCoin(userId, chain))

// Every rail but Solana is gone (owner, 22 Sep 2026). Money a database still
// files under an old chain - 'rh', 'base', 'eth', 'free' - is re-filed onto the
// rail as it stands: only the filing changes, never a player's total. Stake
// locks and their funding plans follow, so a refund cannot land on a dead rail.
const refileToRail = () => {
  const rows = db.prepare('SELECT user_id, chain, amount_coin FROM chain_funds WHERE chain != ? AND amount_coin > 0').all(RAIL)
  for (const r of rows) {
    db.prepare(`INSERT INTO chain_funds (user_id, chain, amount_coin) VALUES (?, ?, ?)
                ON CONFLICT(user_id, chain) DO UPDATE SET amount_coin = amount_coin + excluded.amount_coin`)
      .run(r.user_id, RAIL, r.amount_coin)
  }
  db.prepare('DELETE FROM chain_funds WHERE chain != ?').run(RAIL)
  if (getSetting('creditChain') !== RAIL) setSetting('creditChain', RAIL)
  for (const l of db.prepare('SELECT user_id, chain, plan FROM stake_locks').all()) {
    let plan = null
    try { plan = JSON.parse(l.plan) } catch { /* legacy row */ }
    const fixed = Array.isArray(plan) ? JSON.stringify(plan.map((p) => ({ ...p, chain: RAIL }))) : l.plan
    if (l.chain !== RAIL || fixed !== l.plan) {
      db.prepare('UPDATE stake_locks SET chain = ?, plan = ? WHERE user_id = ?').run(RAIL, fixed, l.user_id)
    }
  }
  if (rows.length) adminLog('system', `Re-filed ${rows.length} balance(s) from retired rails onto Solana - totals unchanged`)
}

const backfillChainFunds = () => {
  const rows = db.prepare(`
    SELECT u.id, u.balance_coin - COALESCE((SELECT SUM(amount_coin) FROM chain_funds WHERE user_id = u.id), 0) AS gap
    FROM users u`).all().filter((r) => r.gap > 1e-9)
  if (!rows.length) return
  for (const r of rows) bumpChain(r.id, RAIL, r.gap)
  adminLog('system', `Located ${rows.length} legacy balance(s) on ${RAIL}`)
}


// One ledger row, one balance move, and the chains it lands on.
//
// The dollar figure is what the player is owed at this instant; the coin figure
// is what actually gets filed. The spread is split on the coin amount rather
// than converted share by share, so the buckets always sum to the balance
// exactly - two roundings of the same number never quite agree.
const creditSpread = (userId, amount, type, note, spread) => {
  if (!(amount >= 0)) throw new Error('credit amount must be >= 0')
  requireCoinLedger()
  const coin = usdToCoin(amount)
  db.prepare('UPDATE users SET balance_coin = balance_coin + ? WHERE id = ?').run(coin, userId)
  const total = spread.reduce((a, s) => a + s.amount, 0)
  let left = coin
  spread.forEach((s, i) => {
    const share = i === spread.length - 1 ? left : (total > 0 ? coin * (s.amount / total) : 0)
    if (share > 0) bumpChain(userId, s.chain, share)
    left -= share
  })
  addTx(userId, type, amount, note, coin)
}

export const credit = (userId, amount, type, note, chain = null) =>
  creditSpread(userId, amount, type, note, [{ chain: chain || creditChain(), amount }])

// Pay money back across the same chains that funded the stake, in proportion.
// A Classic stake may span two chains; returning all of it to one would quietly
// move a liability to a chain that is not holding the asset.
export const creditLike = (userId, amount, type, note, plan) => {
  const total = plan?.reduce((a, p) => a + p.amount, 0) || 0
  if (!(total > 0) || !(amount > 0)) return credit(userId, amount, type, note, plan?.[0]?.chain)
  const spread = []
  let left = Math.round(amount * 100) / 100
  plan.forEach((p, i) => {
    const share = i === plan.length - 1 ? left : Math.round((amount * p.amount / total) * 100) / 100
    spread.push({ chain: p.chain, amount: share })
    left = Math.round((left - share) * 100) / 100
  })
  creditSpread(userId, amount, type, note, spread)
}

// Debit refuses to overdraw: returns false when the balance is insufficient.
const EPS = 0.000001
// The same slack in the unit the ledger is kept in. A billionth of a SOL is one
// lamport - enough to absorb a float remainder, far too little to spend.
const EPS_COIN = 1e-9

// Which chains would pay for this, in order - or null if they can't cover it.
// Works in coin: the plan is later used for its proportions, never its units.
//   chain given → Live and withdrawals: that chain's money, nothing else
//   chain null  → Classic: the fattest chain first, which keeps them level
const spendPlan = (userId, amountCoin, chain) => {
  const rows = db.prepare('SELECT chain, amount_coin FROM chain_funds WHERE user_id = ?').all(userId)
  const have = Object.fromEntries(rows.map((r) => [r.chain, r.amount_coin]))
  const order = chain ? [chain] : rows.slice().sort((a, b) => b.amount_coin - a.amount_coin).map((r) => r.chain)
  const plan = []
  let left = amountCoin
  for (const c of order) {
    if (left <= EPS_COIN) break
    const take = Math.min(have[c] || 0, left)
    if (take <= 0) continue
    plan.push({ chain: c, amount: take })
    left -= take
  }
  return left > EPS_COIN ? null : plan
}

// Returns the chains actually spent (truthy) or false when it can't be covered.
export const debit = (userId, amount, type, note, chain = null) => {
  if (!(amount >= 0)) throw new Error('debit amount must be >= 0')
  requireCoinLedger()
  const coin = usdToCoin(amount)
  const plan = spendPlan(userId, coin, chain)
  if (!plan) return false
  const r = db.prepare('UPDATE users SET balance_coin = balance_coin - ? WHERE id = ? AND balance_coin >= ?')
    .run(coin, userId, coin - EPS_COIN)
  if (r.changes === 0) return false
  for (const p of plan) bumpChain(userId, p.chain, -p.amount)
  addTx(userId, type, -amount, note, -coin)
  return plan
}

// Where winnings and refunds belong: the chain that paid most of the stake.
const mainChain = (plan) => plan.slice().sort((a, b) => b.amount - a.amount)[0]?.chain || null

// Every unstaked balance the arena owes, in both units. The coin figure is the
// one the reserve is really measured against: the treasury holds SOL, the
// players are owed SOL, and a price move changes both sides together.
export const totalBalancesCoin = () =>
  db.prepare('SELECT COALESCE(SUM(balance_coin), 0) s FROM users').get().s
export const totalBalancesUsd = () => coinToUsd(totalBalancesCoin())

// What they can spend right now, in dollars, at this minute's price.
export const balanceOf = (userId) => coinToUsd(getUser(userId)?.balance_coin ?? 0)
// What they own, full stop. This number does not move when the market does.
export const balanceCoinOf = (userId) => getUser(userId)?.balance_coin ?? 0

// ---- coin holdings (Live Arena settles in kind) ----

const bumpHolding = (userId, token, delta) => {
  db.prepare(`INSERT INTO holdings (user_id, token, amount) VALUES (?, ?, ?)
              ON CONFLICT(user_id, token) DO UPDATE SET amount = amount + excluded.amount`)
    .run(userId, token, delta)
  db.prepare('DELETE FROM holdings WHERE user_id = ? AND token = ? AND amount <= 0').run(userId, token)
}

export const creditTokens = (userId, token, amount, note) => {
  if (!(amount > 0)) return
  bumpHolding(userId, token, amount)
  addTx(userId, 'coins', 0, note) // no dollars moved - the player received coins
}

export const debitTokens = (userId, token, amount) => {
  const have = holdingOf(userId, token)
  if (!(amount > 0) || have + EPS < amount) return false
  bumpHolding(userId, token, -Math.min(amount, have))
  return true
}

export const holdingOf = (userId, token) =>
  db.prepare('SELECT amount FROM holdings WHERE user_id = ? AND token = ?').get(userId, token)?.amount ?? 0

export const holdingsOf = (userId) =>
  db.prepare('SELECT token, amount FROM holdings WHERE user_id = ? AND amount > 0 ORDER BY token').all(userId)

// Every coin the arena owes its players, netted. The hedge book must hold at
// least this much or a player cannot be paid what they already own - so this
// feeds straight into the hedger's targets alongside open battles.
//
// Coins queued for an on-chain payout count too. They already left the player's
// account so they cannot be spent twice, but they have NOT left the treasury
// yet - dropping them from the target here would have the hedger sell the very
// coins it is about to send out.
export const holdingsOwed = () => {
  const out = {}
  for (const r of db.prepare('SELECT token, SUM(amount) s FROM holdings GROUP BY token').all()) {
    if (r.s > 0) out[r.token] = r.s
  }
  try {
    const rows = db.prepare(`SELECT token, SUM(asset_amount) s FROM withdrawals
                             WHERE asset = 'coin' AND status IN ('pending','approved','sending','unconfirmed')
                             GROUP BY token`).all()
    for (const r of rows) if (r.token && r.s > 0) out[r.token] = (out[r.token] || 0) + r.s
  } catch { /* wallet rails not loaded (tests) - holdings alone are the truth then */ }
  return out
}

// ---- in-flight baskets (so a restart never forces a sale) ----

export const saveBasket = (userId, room, basket) => {
  db.prepare('DELETE FROM live_baskets WHERE user_id = ?').run(userId)
  const ins = db.prepare('INSERT INTO live_baskets (user_id, room, token, amount) VALUES (?, ?, ?, ?)')
  for (const [token, amount] of Object.entries(basket)) if (amount > 0) ins.run(userId, room, token, amount)
}

export const clearBaskets = (room) => db.prepare('DELETE FROM live_baskets WHERE room = ?').run(room)

export const savedBasketOf = (userId) =>
  db.prepare('SELECT token, amount FROM live_baskets WHERE user_id = ?').all(userId)

// ---- stake locks (one active battle per user) ----
// fund = { chain, label, asset } when the stake must come from one chain (Live),
// null when any dollar will do (Classic, training).
export const lockStake = (userId, amount, ref, fund = null) => {
  const existing = db.prepare('SELECT * FROM stake_locks WHERE user_id = ?').get(userId)
  if (existing) return { ok: false, why: 'You already have an active battle or queue entry.' }
  const chain = fund?.chain || null
  let paidFrom = chain
  let paidPlan = null
  let paidCoin = 0
  if (amount > 0) {
    const plan = debit(userId, amount, 'stake', `Entered $${amount} battle`, chain)
    if (!plan) {
      if (chain) {
        const have = Math.round(fundsOn(userId, chain) * 100) / 100
        return { ok: false, why: `You have $${have} in ${fund.asset} - deposit more ${fund.asset} to your arena address, or pick a smaller stake.` }
      }
      return { ok: false, why: 'Insufficient balance for this stake.' }
    }
    paidFrom = mainChain(plan)
    paidPlan = JSON.stringify(plan)
    // The plan is in coin; its sum is the exact coin this lock took.
    paidCoin = plan.reduce((a, p) => a + p.amount, 0)
  }
  db.prepare('INSERT INTO stake_locks (user_id, amount, ref, chain, plan, ts, coin) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(userId, amount, ref, paidFrom, paidPlan, Date.now(), paidCoin)
  return { ok: true }
}

export const relabelLock = (userId, ref) => {
  db.prepare('UPDATE stake_locks SET ref = ? WHERE user_id = ?').run(ref, userId)
}

// What a refund is worth in dollars right now. The lock holds COIN: giving back
// the posting-day dollar figure would send a different amount of coin than was
// taken, and the difference would be the house's silent gain or loss on every
// cancelled table. Legacy locks (coin = 0) predate the coin ledger and keep
// their dollar figure - there is nothing truer on record for them.
const lockRefundUsd = (lock) => (lock.coin > 0 ? coinToUsd(lock.coin) : lock.amount)

export const releaseLock = (userId, { refund = false, note = '' } = {}) => {
  const lock = db.prepare('SELECT * FROM stake_locks WHERE user_id = ?').get(userId)
  if (!lock) return 0
  db.prepare('DELETE FROM stake_locks WHERE user_id = ?').run(userId)
  // Money goes back exactly where it came from, or it would quietly migrate
  // between chains every time a battle is cancelled. In coin terms the refund
  // is EXACT: usd/price here is the very coin the lock took.
  if (refund && lock.amount > 0) {
    creditLike(userId, lockRefundUsd(lock), 'refund', note || 'Stake refunded', lockPlan(lock))
  }
  return lock.amount
}

// A lock taken days ago holds coin, not a dollar amount. When its battle
// finally forms, the table is charged AT THAT MOMENT: the exact coin goes back,
// and the stake is taken again at the current price. Between posting and battle
// the poster's coin floated on their own books - exactly as it would have
// sitting in their balance - and the house never holds the difference.
//
// Fails, leaving the refund standing, when the re-priced balance no longer
// covers the stake (their coin fell and nothing else is in the account). The
// caller cancels the listing then: an underfunded table must not start.
export const resettleLock = (userId, stakeUsd, fund = null) => txn(() => {
  const lock = getLock(userId)
  if (!lock) return { ok: false, why: 'No stake is locked.' }
  if (!(lock.amount > 0)) return { ok: true } // training/free entry - nothing to re-price
  const ref = lock.ref
  releaseLock(userId, { refund: true, note: 'Battle forming - stake re-priced at the current SOL rate' })
  return lockStake(userId, stakeUsd, ref, fund)
})

// How the stake was funded, chain by chain. Older rows only recorded the main
// chain; treat that as the whole stake.
export const lockPlan = (lock) => {
  if (!lock) return null
  try { const p = JSON.parse(lock.plan); if (Array.isArray(p) && p.length) return p } catch { /* legacy row */ }
  return lock.chain ? [{ chain: lock.chain, amount: lock.amount }] : null
}

export const getLock = (userId) => db.prepare('SELECT * FROM stake_locks WHERE user_id = ?').get(userId)

// ---- admin log ----
export const adminLog = (actor, msg) => {
  db.prepare('INSERT INTO admin_log (ts, actor, msg) VALUES (?, ?, ?)').run(Date.now(), actor, msg)
}

// ---- the one-way trips into SOL ----
//
// The `ledgerCoin` setting is the latch, and every money function refuses to
// move until it reads 'SOL'. Two histories lead here:
//
//   dollars (never denominated)  every balance converts at the SOL price of the
//                                moment it runs, once.
//   Robinhood ETH (ledgerUnit    every coin amount on the books is ETH. It
//     = 'eth')                   converts to SOL at the last ETH price this
//                                database ever recorded against the live SOL
//                                price - the same dollars on both sides of the
//                                line, only the unit moves.
//
// A database with no money migrates at any price, because there is nothing to
// misprice - so a fresh install is never blocked waiting for a feed. One that
// DOES hold balances waits for real prices rather than guess, and says so.
//
// Every table carrying a coin amount, including the ones other modules own
// (withdrawals). Those rename their own columns at import, which is why a
// conversion with money in it only ever runs from setLedgerPrice - by then
// every module has loaded.
const COIN_COLUMNS = [
  ['users', 'balance_coin'], ['chain_funds', 'amount_coin'], ['stake_locks', 'coin'], ['txs', 'coin'],
  ['withdrawals', 'coin'],
]
let coinLedger = getSetting('ledgerCoin') === LEDGER_COIN

export const ensureCoinLedger = () => {
  if (coinLedger) return true
  const fromEth = getSetting('ledgerUnit') === 'eth'
  const sum = (sql) => { try { return db.prepare(sql).get().s || 0 } catch { return 0 } }
  const owed = fromEth
    ? sum('SELECT COALESCE(SUM(balance_coin), 0) s FROM users') + sum('SELECT COALESCE(SUM(coin), 0) s FROM stake_locks')
    : sum('SELECT COALESCE(SUM(balance), 0) s FROM users') + sum('SELECT COALESCE(SUM(amount), 0) s FROM chain_funds')
  let factor = 1
  if (owed > EPS_COIN) {
    const sol = coinUsdRaw()
    if (!(sol > 0)) {
      console.warn('[db] Ledger not yet in SOL: no SOL price yet. Money is frozen until one arrives.')
      return false
    }
    if (fromEth) {
      const eth = Number(getSetting('ethUsdLast')) || 0
      if (!(eth > 0)) {
        console.warn('[db] Ledger holds ETH amounts but no ETH price was ever recorded - cannot convert to SOL.')
        return false
      }
      factor = eth / sol
    } else factor = 1 / sol
  }
  if (fromEth) {
    for (const [table, col] of COIN_COLUMNS) {
      try { db.prepare(`UPDATE ${table} SET ${col} = ${col} * ?`).run(factor) } catch { /* table absent in this database */ }
    }
  } else {
    db.prepare('UPDATE users SET balance_coin = balance * ?').run(factor)
    db.prepare('UPDATE chain_funds SET amount_coin = amount * ?').run(factor)
  }
  setSetting('ledgerCoin', LEDGER_COIN)
  setSetting('ledgerUnit', 'coin')
  setSetting('ledgerMigratedAt', Date.now())
  coinLedger = true
  if (owed > EPS_COIN) {
    adminLog('system', fromEth
      ? `Ledger converted from Robinhood ETH to SOL (1 ETH = ${factor.toFixed(4)} SOL at the last recorded prices). Balances follow the SOL price from here on.`
      : `Ledger converted from dollars to SOL at $${(1 / factor).toFixed(2)}. Balances follow the SOL price from here on.`)
  }
  return true
}

// Called before every balance move. On a fresh database this passed at import;
// on one that was waiting for a price it is the retry.
const requireCoinLedger = () => {
  if (coinLedger) return
  if (!ensureCoinLedger()) throw new Error('Ledger has not been converted to SOL yet - no price available. Refusing to move money.')
}

// Only an EMPTY database can latch here; one holding money waits for
// setLedgerPrice (see COIN_COLUMNS).
{
  const empty = !(Number(db.prepare('SELECT COALESCE(SUM(balance_coin), 0) + COALESCE(SUM(balance), 0) s FROM users').get().s) > 0)
  if (empty) ensureCoinLedger()
}

// Fund migrations run here, not where they are defined: they write to the admin
// log, and that has to exist first.
refileToRail()
backfillChainFunds()

// ---- token overrides ----
export const getOverrides = () => {
  const rows = db.prepare('SELECT token_id, data FROM token_overrides').all()
  const out = {}
  for (const r of rows) out[r.token_id] = JSON.parse(r.data)
  return out
}

export const setOverride = (tokenId, data) => {
  if (data === null) db.prepare('DELETE FROM token_overrides WHERE token_id = ?').run(tokenId)
  else db.prepare('INSERT INTO token_overrides (token_id, data) VALUES (?, ?) ON CONFLICT(token_id) DO UPDATE SET data = excluded.data')
    .run(tokenId, JSON.stringify(data))
}

// ---- crash recovery ----
// Rooms live in memory; a server restart voids any battle that was in flight.
// How a lock is settled depends on whether the coins were already bought:
//   basket on record → the player gets the COINS. The treasury is holding them,
//                      and paying cash instead would force it to sell.
//   no basket        → still in the queue or the pick phase, nothing was bought,
//                      so the stake goes back as money.
export const recoverLocks = () => {
  const locks = db.prepare('SELECT * FROM stake_locks').all()

  // A saved basket is a claim that the treasury bought these coins - but a
  // crash inside the ~30s before the hedger's first rebalance (or during a
  // venue outage) leaves baskets on record that were never filled. Prices are
  // not up yet at boot, so the check runs in TOKEN UNITS against the hedge
  // book: everything recovery wants to hand out, plus everything holders are
  // already owed, per token. 2% slack covers slippage drift and sub-threshold
  // dust. A token the book can't cover turns every basket containing it into
  // a cash refund - the safe direction: full stake back, and the treasury
  // sells whatever partial fills remain.
  const uncovered = new Set()
  try {
    const wanted = {}
    for (const l of locks) {
      for (const b of savedBasketOf(l.user_id)) wanted[b.token] = (wanted[b.token] || 0) + b.amount
    }
    for (const [token, owed] of Object.entries(holdingsOwed())) {
      if (wanted[token]) wanted[token] += owed
    }
    for (const [token, needed] of Object.entries(wanted)) {
      const held = db.prepare('SELECT amount FROM hedge_positions WHERE token = ?').get(token)?.amount || 0
      if (held < needed * 0.98) uncovered.add(token)
    }
  } catch { /* hedge book not present (tests import db alone) - recover as before */ }

  let inKind = 0
  for (const l of locks) {
    const basket = savedBasketOf(l.user_id)
    db.prepare('DELETE FROM stake_locks WHERE user_id = ?').run(l.user_id)
    db.prepare('DELETE FROM live_baskets WHERE user_id = ?').run(l.user_id)
    if (basket.length && !basket.some((b) => uncovered.has(b.token))) {
      inKind++
      for (const b of basket) {
        creditTokens(l.user_id, b.token, b.amount,
          `Server restarted mid-battle - kept your ${b.amount.toPrecision(6)} ${b.token}`)
      }
    } else if (l.amount > 0) {
      // Same rule as releaseLock: the coin the lock took is what comes back.
      creditLike(l.user_id, lockRefundUsd(l), 'refund',
        basket.length
          ? 'Server restarted mid-battle - your coins were not all bought yet, so your stake came back as money'
          : 'Server restarted - battle voided, stake refunded',
        lockPlan(l))
    }
  }
  if (locks.length) {
    adminLog('system', `Recovered ${locks.length} stake lock(s) after restart - ${inKind} returned as coins, ${locks.length - inKind} as cash${uncovered.size ? ` (book short on: ${[...uncovered].join(', ')})` : ''}`)
  }
  return locks.length
}

export const txn = (fn) => {
  db.exec('BEGIN')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}
