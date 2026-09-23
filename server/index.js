// SolArena server: REST API + websocket arena.
//   node server/index.js          (HOOD_PORT, HOOD_DB, HOOD_ADMIN_PASS, HOOD_SPEED)
// Serves the built frontend from dist/ when present, so one process = whole app.

// A server that dies must say so - somewhere that SURVIVES it. Twice now this
// process has vanished leaving a log that ends mid-sentence, and printing the
// reason to the console was not enough: the console dies with the terminal.
// So every exit path both prints AND appends one line to
// <db-dir>/exit.log (sync - a dying process can't be trusted to flush an
// async write), with memory, uptime and the worst recent event-loop stalls:
// the final minute's stall log is exactly the context a post-mortem needs.
// (A hard kill - OOM killer, TerminateProcess - can't be caught by anyone;
// for those, the absence of an exit.log entry is itself the answer.)
const bye = (why, err) => {
  const m = process.memoryUsage()
  const head = `[FATAL] ${why}` +
    ` | rss ${Math.round(m.rss / 1048576)}MB heap ${Math.round(m.heapUsed / 1048576)}/${Math.round(m.heapTotal / 1048576)}MB` +
    ` | up ${Math.round(process.uptime())}s`
  console.error('\n' + head)
  if (err) console.error(err?.stack || String(err))
  try {
    let stalls = ''
    try { stalls = JSON.stringify(blockReport().worst?.slice(0, 3) ?? []) } catch { /* best-effort */ }
    appendFileSync(join(dirname(process.env.HOOD_DB || 'server/data/hoodarena.db'), 'exit.log'),
      `${new Date().toISOString()} pid=${process.pid} ${head}\n` +
      (err ? `  ${String(err?.stack || err).split('\n').join('\n  ')}\n` : '') +
      `  recent stalls: ${stalls}\n`)
  } catch { /* the log must never be the thing that kills us */ }
}
process.on('uncaughtException', (e) => { bye('uncaught exception', e); process.exit(1) })
process.on('unhandledRejection', (e) => { bye('unhandled promise rejection', e) })
process.on('SIGTERM', () => { bye('SIGTERM (something asked it to stop)'); process.exit(0) })
process.on('SIGINT', () => { bye('SIGINT (Ctrl-C)'); process.exit(0) })
process.on('SIGHUP', () => { bye('SIGHUP (terminal closed)'); process.exit(0) })
process.on('SIGBREAK', () => { bye('SIGBREAK'); process.exit(0) })
process.on('exit', (code) => { if (code) bye(`exiting with code ${code}`) })

import express from 'express'
import cors from 'cors'
import compression from 'compression'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, appendFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { WebSocketServer } from 'ws'
import { randomBytes } from 'node:crypto'
import { getHeapStatistics } from 'node:v8'

import {
  db, getUser, getUserByName, getSetting, setSetting, getOverrides, setOverride,
  lockStake, releaseLock, adminLog, recoverLocks, credit, chainFunds, holdingsOwed,
  setLedgerPrice, ensureCoinLedger, balanceOf, balanceCoinOf, ledgerPriceUsd, resettleLock, LEDGER_COIN,
} from './db.js'
import { register, login, logout, sessionUser, ensureAdmin } from './auth.js'
import { startMarket, onTick, marketSnapshot, getFeedStatus, setFeedStatus, applyFeed, setSnapGuard, getHist, getVol24, getPrice, isReal, changeOverSec, registerToken, setBroadcastIds } from './market.js'
import { startFeed, startOhlcWarm, getOhlc, getCgChange6h, cgCard, cgFeedStatus, isCgCharted, OHLC_RANGES } from './feed.js'
import { candlesForToken, candleStatus, TIMEFRAMES } from './candles.js'
import { startPyth } from './pyth.js'
import { DuelManager, statsFor } from './duel.js'
import { TourneyManager, recoverTourneys } from './tourney.js'
import { allTokensEff, validateConfig, validatePicks, feeFor, STAKES, DURATIONS, HEDGE_MIN_USD } from './rules.js'
import { poolFund, POOLS } from '../src/engine/tokens.js'
import {
  initWalletRails, userWithdrawals, userDeposits,
  walletMeta,
  ensureFunded, topUpOnLogin,
} from './wallet.js'
import { initHedger, startHedger, paperExecutor, hedgeOverview } from './hedger.js'
import { venueCanTrade } from './venue.js'
import { startTokenSource, tokenSourceStats, warmFromCache } from './tokensource.js'
import { startSolPrices, setHotTokens, solPricesStatus, solUsdNow, primeSolUsd } from './solprices.js'
import { startBlockWatch, blockReport } from './blockwatch.js'
import { setDynamic } from './registry.js'
import { sellHolding, holdingsView } from './holdings.js'
import { achievementsFor, claimAchievement, publicBadgesFor, rebateAudit } from './achievements.js'
import { CHAIN_ENV, CHAINS } from './chains.js'

const PORT = Number(process.env.HOOD_PORT) || 8787

// SOL/USD for everything custody touches - crediting a deposit, converting a
// balance, sizing a Live buy. One source, on purpose. If it is 0 the deposit
// watcher refuses to credit rather than credit at a made-up price (the
// `price > 0` gate in wallet.js), and mainnet refuses to move money at all.
const priceForCustody = (sym) => (sym === LEDGER_COIN ? solUsdNow() : getPrice(sym))

// Free-play build (owner, 23 Sep 2026): no wallets, no deposits, no withdrawals,
// no real swaps. Balances are play credits only.
if (CHAIN_ENV === 'mainnet') {
  console.error('[boot] REFUSING TO START: this is the free-play build - real money (HOOD_CHAIN_ENV=mainnet) is removed.')
  process.exit(1)
}

// ---- boot ----
ensureAdmin()

// The mainnet-era database stored signupCredit = 0 (full reserve: no credit
// without a deposit). In free play there is no deposit, so a stored 0 leaves new
// players with nothing. Lift it once; after that the admin panel owns the knob.
if (!getSetting('freePlayCreditFixed')) {
  if (!(Number(getSetting('signupCredit')) > 0)) setSetting('signupCredit', 10000)
  setSetting('freePlayCreditFixed', true)
}
// Owner, 23 Sep 2026: every player gets $10k. Raise the stored value once.
if (!getSetting('freePlay10k')) {
  if (Number(getSetting('signupCredit')) < 10000) setSetting('signupCredit', 10000)
  setSetting('freePlay10k', true)
}

// THE LEDGER'S UNIT, wired before anything can move money: balances are stored
// as SOL and converted to dollars on the way out, so the arena owes the same
// coin it holds. The first SOL price is awaited here - a database that still
// needs converting (dollars, or the old Robinhood ETH) needs a REAL price to
// convert at, and stake recovery below moves money. Offline test runs skip the
// fetch and run at parity.
if (process.env.HOOD_RAILS !== 'off') await primeSolUsd()
// Play credits must not drift with SOL: the ledger's rate is frozen at the last
// price it ever saw, so every stored balance keeps its dollar value.
const playRate = Number(getSetting('coinUsdLast')) || solUsdNow() || 1
setLedgerPrice(() => playRate)
const recover = () => {
  const refunded = recoverLocks()
  if (refunded) console.log(`[boot] refunded ${refunded} in-flight stake(s) from before restart`)
  recoverTourneys()
}
if (ensureCoinLedger()) recover()
else {
  // No price yet: keep asking rather than leave the conversion to whichever
  // player happens to move money first. Stakes are recovered once it lands.
  console.warn('[boot] ledger waiting for a SOL price - stake recovery deferred')
  const ledgerRetry = setInterval(() => { if (ensureCoinLedger()) { clearInterval(ledgerRetry); recover() } }, 5000)
}
startMarket()
startBlockWatch() // names whatever stalls the event loop - a stalled loop is a frozen duel clock
// The CoinGecko poll no longer prices anything in the arena (no curated
// tokens), but it STAYS: it is the feed-status heartbeat, and 90s of 'sim'
// status voids running battles. startSparklines is gone with the curated
// pools - nothing displayed its data any more. startOhlcWarm self-disables
// (no Blue Chips → no CG-charted ids) and is kept for the day one returns.
startFeed(applyFeed, setFeedStatus)
if (process.env.HOOD_RAILS !== 'off') {
  startOhlcWarm()
  startPyth(applyFeed, setFeedStatus) // heartbeat oracle; CoinGecko stays as fallback
  if (process.env.HOOD_TOKENSOURCE !== 'off') {
    warmFromCache()   // last known book, so the arena is never empty at boot
    startTokenSource() // …then live discovery takes over
  }
  // The battle book, the money and the hedge are all Solana: Jupiter prices it.
  startSolPrices()
}

// Test fixture book. The curated TOKENS list is empty now (the arena is 100%
// live-ingested), which leaves a HOOD_RAILS=off test server with no tokens to
// fight over - so the integration tests inject their own book here, as JSON,
// through the same registry and market registration the real ingest uses.
// Never set in production; with rails on, the first ingest cycle replaces it.
if (process.env.HOOD_FIXTURE_TOKENS) {
  try {
    const fixtures = JSON.parse(process.env.HOOD_FIXTURE_TOKENS)
    for (const t of fixtures) registerToken(t.id, { base: t.base, vol: t.vol })
    setDynamic(fixtures)
    setBroadcastIds(fixtures.map((t) => t.id))
    console.log(`[boot] fixture book: ${fixtures.length} tokens (tests only)`)
  } catch (e) { console.error('[boot] bad HOOD_FIXTURE_TOKENS, ignored:', e.message) }
}

// ---- websocket hub ----
const conns = new Map()      // userId -> Set<ws>
const marketSubs = new Set() // ws

const hub = {
  send(userId, msg) {
    const set = conns.get(userId)
    if (!set) return
    const s = JSON.stringify(msg)
    for (const ws of set) { try { ws.send(s) } catch { /* dead socket, cleaned on close */ } }
  },
  online(userId) { return conns.has(userId) },
  // Every connected client sees lobby boards move - join counts and countdowns
  // are the whole pitch of a standing tournament lobby. It hangs off the hub so
  // the duel manager can say "that table is gone" the moment it takes one off
  // the board, without reaching back into this file.
  broadcast(msg) {
    const s = JSON.stringify(msg)
    for (const set of conns.values()) for (const ws of set) { try { ws.send(s) } catch { /* dead socket */ } }
  },
}

const manager = new DuelManager(hub)

const broadcastAll = (msg) => hub.broadcast(msg)
const tourneys = new TourneyManager(hub, { pushWallet: (id) => manager.pushWallet(id), broadcast: broadcastAll })
setSnapGuard(() => !manager.anyLive() && !tourneys.anyLive())
setHotTokens(() => [...manager.hotTokenIds(), ...tourneys.hotTokenIds()])

// No deposit watcher and no withdrawal processor: nothing enters or leaves.
initWalletRails({ getPriceUsd: priceForCustody })

// hedging engine: treasury mirrors the net Live-Arena exposure.
// Paper book everywhere except mainnet, where Jupiter executes for real.
// What the treasury must hold: the coins riding in open Live battles PLUS the
// coins already won and sitting in players' accounts. Both are real obligations
// in token units - leaving the second out would have the hedger sell a winner's
// coins the moment their battle ended.
const hedgeTargets = () => {
  const out = { ...manager.liveExposure() }
  for (const [token, amount] of Object.entries(holdingsOwed())) out[token] = (out[token] || 0) + amount
  return out
}

initHedger({ getPriceUsd: (sym) => getPrice(sym), exposure: hedgeTargets, exec: paperExecutor })
// Paper book only - the free-play build never swaps on chain.
if (process.env.HOOD_RAILS !== 'off' && process.env.HOOD_HEDGE !== 'off') startHedger()

// Deltas every second, a full resync every 30. The message is sent even when
// nothing moved: the client treats a gap in ticks as "the server stopped
// feeding me" and falls back to its own simulation, so silence is not free.
let tickN = 0
onTick(() => {
  if (!marketSubs.size) return
  const full = tickN++ % 30 === 0
  const msg = JSON.stringify({ type: 'market.tick', prices: marketSnapshot({ full }), feed: getFeedStatus() })
  for (const ws of marketSubs) { try { ws.send(msg) } catch { /* ignore */ } }
})

// ---- challenge expiry sweep ----
// A table posted in a pool that has since been retired can never start - the
// battle would be refused - so it closes like an expired one, stake refunded.
const LIVE_POOL_IDS = POOLS.map((p) => p.id)
setInterval(() => {
  const now = Date.now()
  const stale = db.prepare(`SELECT * FROM challenges WHERE status = 'open'
    AND (expires < ? OR pool NOT IN (${LIVE_POOL_IDS.map(() => '?').join(',')}))`).all(now, ...LIVE_POOL_IDS)
  for (const c of stale) {
    db.prepare(`UPDATE challenges SET status = 'expired' WHERE code = ?`).run(c.code)
    const lock = db.prepare('SELECT * FROM stake_locks WHERE user_id = ? AND ref = ?').get(c.from_user, 'challenge:' + c.code)
    if (lock) {
      const retired = !LIVE_POOL_IDS.includes(c.pool)
      releaseLock(c.from_user, { refund: true, note: retired ? 'Table closed - that battlefield was retired, stake refunded' : 'Challenge expired - stake refunded' })
      manager.pushWallet(c.from_user)
      hub.send(c.from_user, { type: 'challenge.expired', code: c.code })
    }
  }
}, 15000)

// ---- REST ----
const app = express()
app.use(cors())
// Nothing here was compressed before: the book went out as 1.28 MB of raw JSON
// and the bundle as 661 KB, on every single load. Level 1 rather than the
// default 6 - it still strips ~79%, at half the CPU, and this process already
// shares its one thread with the tick. The default filter leaves avatars and
// market pictures alone; their bytes are already compressed.
app.use(compression({ level: 1 }))
// 900kb, not 32kb: profile pictures arrive as base64 data URLs (client crops
// to 256px first, so a legitimate upload is ~40-300kb). Everything else on the
// API stays tiny; the parser still hard-stops anything bigger.
app.use(express.json({ limit: '900kb' }))

const authed = (req, res, next) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  const user = sessionUser(token)
  if (!user) return res.status(401).json({ error: 'Not logged in.' })
  req.user = user
  req.token = token
  next()
}

const adminOnly = (req, res, next) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admin only.' })
  next()
}

const publicUser = (u) => ({
  name: u.name, avatar: u.avatar, bio: u.bio, created: u.created,
})

// `balance` is dollars at this minute's price, `balanceCoin` is what they own.
// Both travel together everywhere, so no screen has to guess which one it holds.
const meView = (u) => ({
  user: { name: u.name, avatar: u.avatar, bio: u.bio, isAdmin: !!u.is_admin },
  balance: balanceOf(u.id),
  balanceCoin: balanceCoinOf(u.id),
  coinUsd: ledgerPriceUsd(),
  trainingDone: !!u.training_done,
})

app.get('/api/health', (_req, res) => res.json({ ok: true, feed: getFeedStatus(), cg: cgFeedStatus(), ts: Date.now() }))

app.post('/api/register', (req, res) => {
  const { name, password } = req.body || {}
  const r = register(name, password)
  if (r.error) return res.status(400).json({ error: r.error })
  const u = getUser(r.session.userId)
  adminLog('system', `New account: ${u.name}`)
  res.json({ token: r.session.token, ...meView(u) })
})

app.post('/api/login', (req, res) => {
  const { name, password } = req.body || {}
  const r = login(name, password)
  if (r.error) return res.status(400).json({ error: r.error })
  topUpOnLogin(r.session.userId)
  res.json({ token: r.session.token, ...meView(getUser(r.session.userId)) })
})

app.post('/api/logout', authed, (req, res) => {
  logout(req.token)
  res.json({ ok: true })
})

app.get('/api/me', authed, (req, res) => {
  // A saved session skips /api/login, so opening the app counts as logging in.
  topUpOnLogin(req.user.id)
  res.json({
    ...meView(req.user),
    stats: fullStats(req.user.id),
    lock: db.prepare('SELECT amount, ref FROM stake_locks WHERE user_id = ?').get(req.user.id) || null,
  })
})

app.post('/api/profile', authed, (req, res) => {
  const { name, bio, avatar } = req.body || {}
  if (name && name !== req.user.name) {
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(name)) return res.status(400).json({ error: 'Username: 3-20 chars, letters/digits/underscore.' })
    if (getUserByName(name)) return res.status(400).json({ error: 'That username is taken.' })
    db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, req.user.id)
  }
  if (typeof bio === 'string') db.prepare('UPDATE users SET bio = ? WHERE id = ?').run(bio.slice(0, 60), req.user.id)
  if (typeof avatar === 'string') db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatar.slice(0, 8), req.user.id)
  res.json(meView(getUser(req.user.id)))
})

// ---- profile pictures ----
// Uploaded as a data URL (the client crops and shrinks to a 256px square
// first), stored on disk next to the DB, served back via /api/avatar/:id.
// users.avatar simply holds that serving path - every queue entry, room
// snapshot and leaderboard row already passes the string through untouched.
// Moderation: every upload is admin-logged, and an admin can reset any
// user's picture - on a real-money floor that lever has to exist.
const AVATAR_DIR = join(dirname(process.env.HOOD_DB || 'server/data/hoodarena.db'), 'avatars')
mkdirSync(AVATAR_DIR, { recursive: true })
const AVATAR_TYPES = {
  png: { mime: 'image/png', magic: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  jpg: { mime: 'image/jpeg', magic: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  webp: { mime: 'image/webp', magic: (b) => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
}
const avatarFile = (userId) => {
  for (const ext of Object.keys(AVATAR_TYPES)) {
    const p = join(AVATAR_DIR, `${userId}.${ext}`)
    if (existsSync(p)) return { path: p, ext }
  }
  return null
}
const clearAvatarFile = (userId) => {
  const f = avatarFile(userId)
  if (f) unlinkSync(f.path)
}
const lastAvatarUpload = new Map() // userId -> ts; a small cooldown against churn

app.post('/api/profile/avatar', authed, (req, res) => {
  if (Date.now() - (lastAvatarUpload.get(req.user.id) || 0) < 30_000) {
    return res.status(429).json({ error: 'Give it a moment between uploads.' })
  }
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body?.image || ''))
  if (!m) return res.status(400).json({ error: 'Send a PNG, JPG or WEBP image.' })
  const buf = Buffer.from(m[2], 'base64')
  if (buf.length < 100) return res.status(400).json({ error: 'That does not look like a real image.' })
  if (buf.length > 400_000) return res.status(400).json({ error: 'Image must be under 400 KB after resizing.' })
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1]
  // The declared type must match the bytes - a mislabelled file is refused.
  if (!AVATAR_TYPES[ext].magic(buf)) return res.status(400).json({ error: 'That file is not what it claims to be.' })
  clearAvatarFile(req.user.id)
  writeFileSync(join(AVATAR_DIR, `${req.user.id}.${ext}`), buf)
  // ?v= makes the stored path itself the cache-buster: change picture, change URL.
  db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(`/api/avatar/${req.user.id}?v=${Date.now()}`, req.user.id)
  lastAvatarUpload.set(req.user.id, Date.now())
  adminLog(req.user.name, 'Uploaded a new profile picture')
  res.json(meView(getUser(req.user.id)))
})

app.delete('/api/profile/avatar', authed, (req, res) => {
  clearAvatarFile(req.user.id)
  db.prepare(`UPDATE users SET avatar = '' WHERE id = ?`).run(req.user.id)
  res.json(meView(getUser(req.user.id)))
})

app.get('/api/avatar/:id', (req, res) => {
  const f = avatarFile(Number(req.params.id))
  if (!f) return res.status(404).end()
  res.set('Content-Type', AVATAR_TYPES[f.ext].mime)
  res.set('Cache-Control', 'public, max-age=86400')
  res.send(readFileSync(f.path))
})

app.post('/api/admin/avatar-reset', authed, adminOnly, (req, res) => {
  const u = getUser(Number(req.body?.userId))
  if (!u) return res.status(404).json({ error: 'No such user.' })
  clearAvatarFile(u.id)
  db.prepare(`UPDATE users SET avatar = '' WHERE id = ?`).run(u.id)
  adminLog(req.user.name, `Reset profile picture for ${u.name}`)
  res.json({ ok: true })
})

app.get('/api/tokens', (_req, res) => {
  // Three fields are deliberately NOT sent. `blurb` is one of four fixed
  // sentences chosen by category - at book scale that was 238 KB of the same
  // four strings - and `dexUrl` is `dexscreener.com/{srcChain}/{pairAddress}`,
  // both of which the payload already carries; the client rebuilds them
  // (src/engine/tokens.js).
  //
  // `spark` was the third: 16 points per token, built for a token-table
  // sparkline that no screen ever drew. At 1563 tokens that is ~400 KB on a
  // list every client re-pulls every 15 seconds, logged in or not - paid for
  // by everyone, rendered for no one. The machinery that produced it is still
  // here (tokensource.sparkFor24h, feed.getSpark7d, market.getSpark), so a
  // sparkline column can have it back the day a screen wants one - behind its
  // own endpoint, called only while that screen is open.
  const toks = allTokensEff().map((t) => {
    const { blurb, dexUrl, spark: _unusedSpark, ...rest } = t
    // A Blue Chip has no pair to read a card off, so the catalog carried
    // constants that were true the day they were typed and drifted ever since.
    // CoinGecko answers for the market numbers, its 30-minute candles for 6h,
    // and our own print history for 5m - the vendor's row starts at 1h.
    const cg = cgCard(t.id)
    const live = cg ? {
      ...cg,
      priceChange: { m5: changeOverSec(t.id, 300), h6: getCgChange6h(t.id), ...(cg.priceChange || {}) },
    } : null
    // `base` is where the client starts a token's price before the websocket
    // says otherwise - so it must be the market's CURRENT print, not the
    // catalog seed it was born with. A logged-out visitor never gets a tick,
    // and BTC's seed was typed at $117k: the strip along the bottom was
    // scrolling a simulation of a price that has not existed for a year.
    // `sim: 1` rides along only for the few tokens the market has no print for
    // yet, so the client knows this one number is still a seed and may animate
    // it. Everything else is a real print and the client holds it flat.
    const real = isReal(t.id)
    const base = real ? getPrice(t.id) : t.base
    // Whether the treasury could hedge it - the server's Live gate, shipped so
    // the picker can say "Classic only" before a lock is refused. Only the
    // false case is sent; absent means the paper book / a routable coin.
    const liveOk = venueCanTrade(t)
    return { ...rest, ...live, base, ...(real ? {} : { sim: 1 }), ...(liveOk ? {} : { liveOk: false }), vol24: getVol24(t.id) }
  })
  res.json({ tokens: toks, feed: getFeedStatus() })
})

// Which RPC endpoints are answering, which are cooling down after rate-limiting
// us, and how much the read cache is absorbing. This is the first thing to look
// at when a player says their balance will not load.
app.get('/api/rpc/status', (_req, res) => {
  res.json({
    chains: Object.values(CHAINS)
      .filter((c) => typeof c.rpcStatus === 'function')
      .map((c) => ({ chain: c.id, ...c.rpcStatus() })),
  })
})

// Price-feed health in one curl: the Jupiter feed that prices the Solana book
// and the ledger, and the event loop.
app.get('/api/prices/status', (_req, res) =>
  res.json({ solPrices: solPricesStatus(), loop: blockReport() }))

app.get('/api/token/:id/hist', (req, res) => {
  res.json({ hist: getHist(req.params.id).filter((_, i) => i % 2 === 0) })
})

// Candles for any token in the book, from whichever source actually knows it
// (server/candles.js). This is what the in-app chart draws, instead of booting
// a third-party terminal in an iframe on the pick clock.
app.get('/api/token/:id/candles', async (req, res) => {
  const t = allTokensEff().find((x) => x.id === req.params.id)
  if (!t) return res.status(404).json({ error: 'Unknown token' })
  const tf = TIMEFRAMES.includes(String(req.query.tf)) ? String(req.query.tf) : '1h'
  const out = await candlesForToken(t, tf, Math.min(Number(req.query.limit) || 400, 1000))
  // An empty 200 rather than an error: "no series right now" is a normal state
  // for a coin that just listed, and the chart falls back to price history
  // without the browser logging a failed request on every pick screen.
  if (!out) return res.json({ id: t.id, tf, candles: [], reason: 'no series for this token yet' })
  res.json({ id: t.id, tf, bucketMs: out.bucketMs, src: out.src, stale: !!out.stale, candles: out.candles })
})

// Real candles for the one pool that has no pair to embed. The vendor is the
// only source here, so the response says which candle size it actually is and
// whether it is the last good series rather than a fresh one - the chart prints
// both instead of passing coarse or stale data off as live.
app.get('/api/token/:id/ohlc', async (req, res) => {
  const range = String(req.query.range || '1d')
  // 404 means "this token never has candles here" - a coin whose chart is its
  // DEX pair, or a range we do not serve. A token that SHOULD have them but
  // does not right now (vendor down, rate-limited, rails off in tests) is an
  // empty 200: the chart quietly falls back to price history instead of the
  // browser logging a failed request on every pick screen.
  if (!isCgCharted(req.params.id) || !OHLC_RANGES.includes(range)) {
    return res.status(404).json({ error: 'No candle series for this token' })
  }
  const out = await getOhlc(req.params.id, range)
  if (!out) return res.json({ id: req.params.id, range, candles: [], reason: 'series unavailable right now' })
  res.json({ id: req.params.id, range, bucket: out.bucket, stale: !!out.stale, src: 'coingecko', candles: out.candles })
})

// `HOOD_CHARTS=embed` puts every chart back to the DexScreener iframe exactly
// as it was before the in-app renderer - one env var, no rebuild, nothing to
// un-write. `?charts=embed` in the URL does the same for one browser, so both
// can be compared side by side before deciding.
const CHART_ENGINE = process.env.HOOD_CHARTS === 'embed' ? 'embed' : 'lw'

app.get('/api/config', (_req, res) => {
  res.json({
    charts: CHART_ENGINE,
    stakes: STAKES, durations: DURATIONS,
    feeTiers: getSetting('feeTiers'),
    classicPaused: getSetting('classicPaused'),
    livePaused: getSetting('livePaused'),
    liveMaxStake: getSetting('liveMaxStake'),
    hedgeMinUsd: HEDGE_MIN_USD, // client mirrors the min-% Live rule for instant UX
  })
})

// ---- matches & stats ----

// Money the way a player reads it: whole dollars keep no cents.
const fmtMoney = (n) => '$' + (Number(n) || 0).toLocaleString('en-US', {
  minimumFractionDigits: Number.isInteger(Number(n)) ? 0 : 2,
  maximumFractionDigits: 2,
})

const perspective = (row, userId) => {
  const data = JSON.parse(row.data)
  const iAmA = row.user_a === userId
  const outcomeA = row.outcome_a
  const outcome = iAmA ? outcomeA : outcomeA === 'win' ? 'loss' : outcomeA === 'loss' ? 'win' : 'draw'
  return {
    id: row.id, ts: row.ts, mode: row.mode, training: !!row.training, stake: row.stake,
    duration: row.duration, feePct: data.feePct, fee: row.fee, pool: row.pool,
    battlePool: data.pool || null, // token category the battle was played in
    opp: { name: iAmA ? row.name_b : row.name_a, avatar: iAmA ? data.avatarB : data.avatarA },
    outcome,
    retYou: iAmA ? row.ret_a : row.ret_b,
    retOpp: iAmA ? row.ret_b : row.ret_a,
    payout: iAmA ? row.payout_a : row.payout_b,
    payoutNote: data.notes ? data.notes[iAmA ? 0 : 1] : '',
    youTokens: iAmA ? data.tokensA : data.tokensB,
    oppTokens: iAmA ? data.tokensB : data.tokensA,
    finalYou: data.finals ? data.finals[iAmA ? 0 : 1] : null,
    finalOpp: data.finals ? data.finals[iAmA ? 1 : 0] : null,
    costYou: data.costs ? data.costs[iAmA ? 0 : 1] : null,
    costOpp: data.costs ? data.costs[iAmA ? 1 : 0] : null,
    events: data.events || [],
  }
}

// A settled tournament from one player's seat, shaped like a match record so
// history and profile screens can list both kinds side by side. The `tourney`
// block carries what a 2-player record has no place for: rank, pot, standings.
const tourneyPerspective = (r) => {
  let data = {}
  try { data = JSON.parse(r.data) } catch { /* legacy row */ }
  let tokens = []
  try { tokens = JSON.parse(r.my_picks) || [] } catch { /* legacy row */ }
  const standings = data.standings || []
  return {
    id: r.id, ts: r.settled || r.ts, mode: 'tourney', training: false,
    stake: r.stake, duration: r.duration, battlePool: r.pool,
    outcome: r.my_rank === 1 ? 'win' : r.my_prize > 0 ? 'placed' : 'loss',
    retYou: r.my_ret, payout: r.my_prize, fee: r.fee,
    tourney: {
      players: standings.length, rank: r.my_rank, prize: r.my_prize,
      pot: r.pot, fee: r.fee, feePct: r.fee_pct, standings,
    },
    youTokens: tokens, // tokenId/pct/start/end/ret - same rows a 1v1 result shows
    events: data.events || [],
  }
}

const TOURNEY_ROWS_SQL = `
  SELECT t.*, tp.picks AS my_picks, tp.ret AS my_ret, tp.rank AS my_rank, tp.prize AS my_prize
  FROM tourney_players tp JOIN tourneys t ON t.id = tp.tourney_id
  WHERE tp.user_id = ? AND t.status = 'done'`

const tourneyRowsFor = (userId, limit = 60) =>
  db.prepare(`${TOURNEY_ROWS_SQL} ORDER BY t.settled DESC LIMIT ?`).all(userId, limit).map(tourneyPerspective)

const fullStats = (userId) => {
  const rows = db.prepare('SELECT * FROM matches WHERE user_a = ? OR user_b = ? ORDER BY ts ASC').all(userId, userId)
  const empty = () => ({ matches: 0, wins: 0, losses: 0, draws: 0, earned: 0, biggestWin: 0, streak: 0, bestStreak: 0 })
  const out = { classic: empty(), live: empty(), training: empty() }
  for (const r of rows) {
    const iAmA = r.user_a === userId
    const outcome = iAmA ? r.outcome_a : r.outcome_a === 'win' ? 'loss' : r.outcome_a === 'loss' ? 'win' : 'draw'
    const payout = iAmA ? r.payout_a : r.payout_b
    const b = out[r.training ? 'training' : r.mode]
    b.matches++
    if (outcome === 'win') {
      b.wins++
      b.streak++
      b.bestStreak = Math.max(b.bestStreak, b.streak)
      const net = payout - (r.training ? 0 : r.stake)
      b.earned += net
      b.biggestWin = Math.max(b.biggestWin, net)
    } else if (outcome === 'loss') {
      b.losses++
      b.streak = 0
      if (!r.training) b.earned -= r.stake
    } else b.draws++
  }
  // Tournaments score in their own bucket: `wins` are titles (rank 1, shared
  // counts), `paid` is prize places below the title, a loss is leaving with
  // nothing. Net is always prize minus entry.
  const ty = { matches: 0, wins: 0, paid: 0, losses: 0, draws: 0, earned: 0, biggestWin: 0, streak: 0, bestStreak: 0 }
  const trows = db.prepare(`SELECT tp.prize, tp.rank, t.stake FROM tourney_players tp
    JOIN tourneys t ON t.id = tp.tourney_id WHERE tp.user_id = ? AND t.status = 'done' ORDER BY t.settled ASC`).all(userId)
  for (const r of trows) {
    ty.matches++
    const net = r.prize - r.stake
    ty.earned += net
    if (r.rank === 1) {
      ty.wins++
      ty.streak++
      ty.bestStreak = Math.max(ty.bestStreak, ty.streak)
    } else {
      ty.streak = 0
      if (r.prize > 0) ty.paid++
      else ty.losses++
    }
    if (net > 0) ty.biggestWin = Math.max(ty.biggestWin, net)
  }
  out.tourney = ty
  return out
}

app.get('/api/history', authed, (req, res) => {
  const rows = db.prepare('SELECT * FROM matches WHERE user_a = ? OR user_b = ? ORDER BY ts DESC LIMIT 60')
    .all(req.user.id, req.user.id)
  const merged = [...rows.map((r) => perspective(r, req.user.id)), ...tourneyRowsFor(req.user.id)]
    .sort((a, b) => b.ts - a.ts).slice(0, 60)
  res.json({ matches: merged })
})

app.get('/api/match/:id', (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  const viewer = sessionUser(token)
  const row = db.prepare('SELECT * FROM matches WHERE id = ?').get(req.params.id)
  if (row) {
    // public match page - viewer perspective is player A unless the caller is player B
    const userId = viewer && row.user_b === viewer.id ? row.user_b : row.user_a
    return res.json({ match: perspective(row, userId) })
  }
  // Not a duel - maybe a settled tournament. A participant sees their own
  // seat; anyone else watches from the winner's.
  const seat = (userId) => userId == null ? null : db.prepare(
    `${TOURNEY_ROWS_SQL} AND t.id = ?`).get(userId, req.params.id)
  const mine = seat(viewer?.id)
  const winner = mine || db.prepare(`
    SELECT t.*, tp.picks AS my_picks, tp.ret AS my_ret, tp.rank AS my_rank, tp.prize AS my_prize
    FROM tourney_players tp JOIN tourneys t ON t.id = tp.tourney_id
    WHERE t.id = ? AND t.status = 'done' ORDER BY tp.rank ASC LIMIT 1`).get(req.params.id)
  if (!winner) return res.status(404).json({ error: 'Match not found.' })
  res.json({ match: tourneyPerspective(winner) })
})

// ---- direct messages ----
// Conversations grouped by the other fighter: their latest line + how many of
// theirs you haven't read. The client's envelope badge is the unread total.
app.get('/api/messages', authed, (req, res) => {
  const uid = req.user.id
  const rows = db.prepare(`
    SELECT m.*, uf.name AS from_name, uf.avatar AS from_avatar, ut.name AS to_name, ut.avatar AS to_avatar
    FROM dms m JOIN users uf ON uf.id = m.from_user JOIN users ut ON ut.id = m.to_user
    WHERE m.from_user = ? OR m.to_user = ? ORDER BY m.ts DESC LIMIT 300`).all(uid, uid)
  const convos = new Map()
  for (const m of rows) {
    const mine = m.from_user === uid
    const name = mine ? m.to_name : m.from_name
    if (!convos.has(name)) {
      convos.set(name, { name, avatar: mine ? m.to_avatar : m.from_avatar, last: m.body, lastTs: m.ts, lastMine: mine, unread: 0 })
    }
    if (!mine && !m.read) convos.get(name).unread++
  }
  const list = [...convos.values()]
  res.json({ conversations: list, unreadTotal: list.reduce((a, c) => a + c.unread, 0) })
})

// One thread, oldest first. Opening it is reading it.
app.get('/api/messages/:name', authed, (req, res) => {
  const other = getUserByName(req.params.name)
  if (!other) return res.status(404).json({ error: 'No fighter with that name.' })
  const uid = req.user.id
  const msgs = db.prepare(`
    SELECT from_user, body, ts FROM dms
    WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)
    ORDER BY ts ASC LIMIT 200`).all(uid, other.id, other.id, uid)
  db.prepare('UPDATE dms SET read = 1 WHERE to_user = ? AND from_user = ? AND read = 0').run(uid, other.id)
  res.json({
    with: { name: other.name, avatar: other.avatar },
    messages: msgs.map((m) => ({ mine: m.from_user === uid, body: m.body, ts: m.ts })),
  })
})

app.post('/api/messages/:name', authed, (req, res) => {
  const other = getUserByName(req.params.name)
  if (!other) return res.status(404).json({ error: 'No fighter with that name.' })
  if (other.id === req.user.id) return res.status(400).json({ error: 'That would be talking to yourself.' })
  const body = String(req.body?.body || '').trim()
  if (!body) return res.status(400).json({ error: 'Write something first.' })
  if (body.length > 500) return res.status(400).json({ error: 'Messages are capped at 500 characters.' })
  // One message per 700ms per sender - enough for any human, a wall for spam loops.
  const last = db.prepare('SELECT MAX(ts) t FROM dms WHERE from_user = ?').get(req.user.id)?.t || 0
  if (Date.now() - last < 700) return res.status(429).json({ error: 'Slow down a moment.' })
  const ts = Date.now()
  db.prepare('INSERT INTO dms (from_user, to_user, body, ts) VALUES (?, ?, ?, ?)').run(req.user.id, other.id, body, ts)
  hub.send(other.id, { type: 'dm', from: req.user.name, avatar: req.user.avatar, body, ts })
  res.json({ ok: true, ts })
})

// ---- support: the player's line to the house ----
//
// One thread per player, whatever they are stuck on. The player writes from the
// widget in the corner; the arena answers from the admin panel. Deliberately not
// built on `dms`: this is not a fighter you can message back, it is the house,
// and it must not sit in the social inbox or depend on an admin account being
// online.
const SUPPORT_MAX = 1000

app.get('/api/support', authed, (req, res) => {
  const uid = req.user.id
  const msgs = db.prepare('SELECT from_admin, body, ts FROM support_messages WHERE user_id = ? ORDER BY ts ASC LIMIT 200').all(uid)
  // Reading the thread is reading the replies.
  db.prepare('UPDATE support_messages SET read_user = 1 WHERE user_id = ? AND from_admin = 1 AND read_user = 0').run(uid)
  res.json({ messages: msgs.map((m) => ({ mine: !m.from_admin, body: m.body, ts: m.ts })) })
})

// Just the badge - cheap enough to ask for on every load without pulling a thread.
app.get('/api/support/unread', authed, (req, res) => {
  const n = db.prepare('SELECT COUNT(*) n FROM support_messages WHERE user_id = ? AND from_admin = 1 AND read_user = 0').get(req.user.id).n
  res.json({ unread: n })
})

app.post('/api/support', authed, (req, res) => {
  const body = String(req.body?.body || '').trim()
  if (!body) return res.status(400).json({ error: 'Write what went wrong first.' })
  if (body.length > SUPPORT_MAX) return res.status(400).json({ error: `Keep it under ${SUPPORT_MAX} characters - a second message is fine.` })
  const last = db.prepare('SELECT MAX(ts) t FROM support_messages WHERE user_id = ? AND from_admin = 0').get(req.user.id)?.t || 0
  if (Date.now() - last < 2000) return res.status(429).json({ error: 'Slow down a moment.' })
  const ts = Date.now()
  db.prepare('INSERT INTO support_messages (user_id, from_admin, body, ts, read_admin) VALUES (?, 0, ?, ?, 0)').run(req.user.id, body, ts)
  // The owner reads this from the admin panel, so the trail belongs in the log
  // too: a support request that arrives while nobody is looking is still a
  // support request.
  adminLog('system', `Support message from ${req.user.name}: ${body.slice(0, 120)}`)
  res.json({ ok: true, ts })
})

// ---- support, the arena's side ----
// Proof, not trust: re-checks every player who has ever claimed an achievement
// and reports anyone whose rebates exceed their allowance. `breaches` is empty
// by construction - the claim gate cannot produce one - so this exists to let
// the operator SHOW that, and to catch it loudly if the invariant ever breaks.
app.get('/api/admin/rebates', authed, adminOnly, (_req, res) => {
  res.json(rebateAudit())
})

app.get('/api/admin/support', authed, adminOnly, (_req, res) => {
  const rows = db.prepare(`
    SELECT s.user_id, u.name, u.avatar, u.blocked,
           MAX(s.ts) AS last_ts,
           SUM(CASE WHEN s.from_admin = 0 AND s.read_admin = 0 THEN 1 ELSE 0 END) AS unread,
           COUNT(*) AS total
    FROM support_messages s JOIN users u ON u.id = s.user_id
    GROUP BY s.user_id ORDER BY unread DESC, last_ts DESC LIMIT 200`).all()
  const lastOf = db.prepare('SELECT body, from_admin FROM support_messages WHERE user_id = ? ORDER BY ts DESC LIMIT 1')
  res.json({
    threads: rows.map((r) => {
      const l = lastOf.get(r.user_id)
      return {
        userId: r.user_id, name: r.name, avatar: r.avatar, blocked: !!r.blocked,
        lastTs: r.last_ts, unread: r.unread, total: r.total,
        last: l?.body || '', lastFromAdmin: !!l?.from_admin,
      }
    }),
    unreadTotal: rows.reduce((a, r) => a + r.unread, 0),
  })
})

app.get('/api/admin/support/:userId', authed, adminOnly, (req, res) => {
  const uid = Number(req.params.userId)
  const u = getUser(uid)
  if (!u) return res.status(404).json({ error: 'No such player.' })
  const msgs = db.prepare('SELECT from_admin, body, ts FROM support_messages WHERE user_id = ? ORDER BY ts ASC LIMIT 400').all(uid)
  db.prepare('UPDATE support_messages SET read_admin = 1 WHERE user_id = ? AND from_admin = 0 AND read_admin = 0').run(uid)
  res.json({
    player: { id: u.id, name: u.name, avatar: u.avatar, balance: balanceOf(u.id), blocked: !!u.blocked },
    messages: msgs.map((m) => ({ fromAdmin: !!m.from_admin, body: m.body, ts: m.ts })),
  })
})

app.post('/api/admin/support/:userId', authed, adminOnly, (req, res) => {
  const uid = Number(req.params.userId)
  const u = getUser(uid)
  if (!u) return res.status(404).json({ error: 'No such player.' })
  const body = String(req.body?.body || '').trim()
  if (!body) return res.status(400).json({ error: 'Write a reply first.' })
  if (body.length > SUPPORT_MAX) return res.status(400).json({ error: `Replies are capped at ${SUPPORT_MAX} characters.` })
  const ts = Date.now()
  db.prepare('INSERT INTO support_messages (user_id, from_admin, body, ts, read_user) VALUES (?, 1, ?, ?, 0)').run(uid, body, ts)
  // Live if they are online; the widget's badge catches them if they are not.
  hub.send(uid, { type: 'support', body, ts })
  adminLog(req.user.name, `Replied to ${u.name} in support`)
  res.json({ ok: true, ts })
})

// Everything worth telling a player about, in one feed. Built from what
// actually happened (deposits, withdrawal states, settled battles and
// tournaments) rather than from live socket traffic, so it survives a reload,
// a new device, and time spent logged out.
app.get('/api/notifications', authed, (req, res) => {
  const uid = req.user.id
  const out = []

  for (const d of userDeposits(uid)) {
    const c = CHAINS[d.chain]
    out.push({
      id: `dep-${d.ts}-${d.chain}`, ts: d.ts, kind: 'deposit',
      title: `Deposit credited - ${fmtMoney(d.usd)}`,
      body: `${d.amount} ${d.asset === 'usdc' ? (c?.stableSymbol || 'USDC') : (c?.nativeSymbol || '')} arrived on ${c?.label || d.chain}.`,
      href: '/wallet',
    })
  }

  for (const w of userWithdrawals(uid)) {
    const c = CHAINS[w.chain]
    const where = c?.label || w.chain
    const amount = w.asset === 'coin' ? `${Number(w.asset_amount).toPrecision(6)} ${w.token}` : fmtMoney(w.usd)
    const T = {
      sent: [`Withdrawal sent - ${amount}`, `It is on its way to your ${where} address.`],
      approved: [`Withdrawal approved - ${amount}`, `Sending to ${where} shortly.`],
      sending: [`Withdrawal sending - ${amount}`, `The payout transaction is going out on ${where}.`],
      rejected: [`Withdrawal rejected - ${amount}`, w.note || 'Your balance was refunded in full.'],
      // `rejected` carries an operator's own words, so it is worth reading.
      // `failed` carries the chain's, and "execution reverted (unknown custom
      // error) data=0x356680b7" is true, useless and frightening at the exact
      // moment a player is watching their money. The raw revert stays in
      // w.note for the admin log; the player gets the two facts that matter.
      failed: [`Withdrawal failed - ${amount}`,
        `The payout did not go out and the full ${amount} is back in your balance. You can request it again.`],
      pending: [`Withdrawal received - ${amount}`, `An operator reviews it before it goes out to ${where}.`],
    }[w.status]
    if (!T) continue
    out.push({ id: `wd-${w.id}-${w.status}`, ts: w.ts, kind: 'withdraw', title: T[0], body: T[1], href: '/wallet' })
  }

  const matches = db.prepare('SELECT * FROM matches WHERE (user_a = ? OR user_b = ?) AND training = 0 ORDER BY ts DESC LIMIT 15').all(uid, uid)
  for (const row of matches) {
    const m = perspective(row, uid)
    const verb = m.outcome === 'win' ? 'Victory' : m.outcome === 'draw' ? 'Draw' : 'Defeat'
    out.push({
      id: `m-${m.id}`, ts: m.ts, kind: m.outcome === 'win' ? 'win' : 'battle',
      title: `${verb} vs ${m.opp.name}${m.payout > 0 ? ` - ${fmtMoney(m.payout)}` : ''}`,
      body: `$${m.stake} ${m.mode} battle · your portfolio ${m.retYou >= 0 ? '+' : ''}${(m.retYou ?? 0).toFixed(2)}%.`,
      href: `/match/${m.id}`,
    })
  }

  for (const t of tourneyRowsFor(uid, 10)) {
    const placed = t.payout > 0
    out.push({
      id: `t-${t.id}`, ts: t.ts, kind: placed ? 'win' : 'battle',
      title: `${t.tourney.rank === 1 ? 'Tournament win' : `Finished #${t.tourney.rank}`}${placed ? ` - ${fmtMoney(t.payout)}` : ''}`,
      body: `$${t.stake} tournament · ${t.tourney.players} players · ${fmtMoney(t.tourney.pot)} pot.`,
      href: `/match/${t.id}`,
    })
  }

  out.sort((a, b) => b.ts - a.ts)
  res.json({ notifications: out.slice(0, 25) })
})

app.get('/api/profile/:name', (req, res) => {
  const u = getUserByName(req.params.name)
  if (!u) return res.status(404).json({ error: 'Player not found.' })
  const rows = db.prepare('SELECT * FROM matches WHERE user_a = ? OR user_b = ? ORDER BY ts DESC LIMIT 10').all(u.id, u.id)
  const recent = [...rows.map((r) => perspective(r, u.id)), ...tourneyRowsFor(u.id, 10)]
    .sort((a, b) => b.ts - a.ts).slice(0, 10)
  res.json({ profile: publicUser(u), stats: fullStats(u.id), recent, badges: publicBadgesFor(u.id) })
})

// ---- achievements ----
// Badges are derived from the record; the rebate attached to them is paid out of
// fees the same player already paid the arena. `rebate` in this payload is the
// whole economic story - allowance, what has been paid, what is left - because a
// reward the player cannot claim yet needs to say why in numbers.
app.get('/api/achievements', authed, (req, res) => {
  res.json(achievementsFor(req.user.id))
})

app.post('/api/achievements/claim', authed, (req, res) => {
  const { key } = req.body || {}
  if (typeof key !== 'string') return res.status(400).json({ error: 'Which achievement?' })
  const r = claimAchievement(req.user.id, key)
  if (r.error) return res.status(400).json(r)
  adminLog('system', `${req.user.name} claimed achievement "${r.name}" - $${r.reward} rebate`)
  res.json({ ...r, ...achievementsFor(req.user.id) })
})

// Landing-page stats (public, all real numbers).
app.get('/api/stats', (_req, res) => {
  const dayAgo = Date.now() - 864e5
  const toks = allTokensEff()
  const tokenVolume24 = toks.reduce((s, t) => s + (getVol24(t.id) ?? t.volume24 ?? 0), 0)
  res.json({
    activeBattles: manager.activeRooms().length + tourneys.activeSummary().length, // real battles incl. tournaments (0 until players are in)
    topPrizeToday: db.prepare('SELECT COALESCE(MAX(MAX(payout_a, payout_b)), 0) m FROM matches WHERE ts >= ? AND training = 0').get(dayAgo).m,
    supportedTokens: toks.length,                 // real: every token live in the arena
    verifiedTokens: toks.filter((t) => t.category === 'verified').length, // real: audited/deep tokens (static + dynamic)
    tokenVolume24,                                // real: aggregate 24h trading volume across all arena tokens
    battleVolume24: db.prepare('SELECT COALESCE(SUM(pool), 0) s FROM matches WHERE ts >= ? AND training = 0').get(dayAgo).s,
  })
})

// The battle the front page shows. Null when nothing is running - the landing
// page says so rather than inventing one.
app.get('/api/spotlight', (_req, res) => {
  res.json({ battle: manager.spotlight(), online: conns.size })
})

// Public tournament board: the three standing lobbies + recent results.
app.get('/api/tournaments', (_req, res) => {
  res.json({ lobbies: tourneys.publicState(), recent: tourneys.recentResults(10) })
})

// Public feed of recent real-money results (for the home page).
app.get('/api/recent', (_req, res) => {
  const rows = db.prepare(`
    SELECT id, ts, mode, stake, name_a, name_b, outcome_a, payout_a, payout_b
    FROM matches WHERE training = 0 ORDER BY ts DESC LIMIT 12
  `).all()
  res.json({
    matches: rows.map((r) => ({
      id: r.id, ts: r.ts, mode: r.mode, stake: r.stake,
      winner: r.outcome_a === 'win' ? r.name_a : r.outcome_a === 'loss' ? r.name_b : null,
      payout: Math.max(r.payout_a, r.payout_b),
      players: [r.name_a, r.name_b],
    })),
  })
})

app.get('/api/leaderboard', (req, res) => {
  const period = req.query.period || 'all'
  const cut = period === 'day' ? Date.now() - 864e5 : period === 'week' ? Date.now() - 7 * 864e5 : 0
  const training = req.query.board === 'training' ? 1 : 0
  const rows = db.prepare('SELECT * FROM matches WHERE training = ? AND ts >= ? ORDER BY ts ASC').all(training, cut)
  const players = new Map()
  const bump = (userId, name, outcome, net) => {
    if (userId == null) return // bots don't rank
    const p = players.get(userId) || { name, matches: 0, wins: 0, losses: 0, draws: 0, earned: 0, streak: 0, bestStreak: 0, biggestWin: 0 }
    p.name = name
    p.matches++
    if (outcome === 'win') { p.wins++; p.streak++; p.bestStreak = Math.max(p.bestStreak, p.streak); p.earned += net; p.biggestWin = Math.max(p.biggestWin, net) }
    else if (outcome === 'loss') { p.losses++; p.streak = 0; p.earned += net }
    else p.draws++
    players.set(userId, p)
  }
  for (const r of rows) {
    const outcomeB = r.outcome_a === 'win' ? 'loss' : r.outcome_a === 'loss' ? 'win' : 'draw'
    bump(r.user_a, r.name_a, r.outcome_a, r.outcome_a === 'win' ? r.payout_a - (training ? 0 : r.stake) : r.outcome_a === 'loss' ? (training ? 0 : -r.stake) : 0)
    bump(r.user_b, r.name_b, outcomeB, outcomeB === 'win' ? r.payout_b - (training ? 0 : r.stake) : outcomeB === 'loss' ? (training ? 0 : -r.stake) : 0)
  }
  const list = [...players.entries()].map(([id, p]) => {
    const u = getUser(id)
    return { ...p, avatar: u?.avatar || '🔥', winRate: p.matches ? (p.wins / p.matches) * 100 : 0 }
  })
  res.json({ players: list })
})

// ---- challenges ----

// A private link expires in half an hour because somebody is waiting on it. A
// board posting is the opposite: its whole purpose is to sit there until
// someone wanders past, so it gets the rest of the day.
const CHALLENGE_TTL = 30 * 60 * 1000
const LISTED_TTL = 12 * 60 * 60 * 1000

app.post('/api/challenges', authed, async (req, res) => {
  const { mode, stake, duration, target, pool, picks, listed } = req.body || {}
  const cfg = { mode, stake: Number(stake), duration: Number(duration), pool, training: false }
  const bad = validateConfig(cfg)
  if (bad) return res.status(400).json({ error: bad })
  let targetUser = null
  if (target) {
    targetUser = getUserByName(target)
    if (!targetUser) return res.status(400).json({ error: `No player named "${target}".` })
    if (targetUser.id === req.user.id) return res.status(400).json({ error: 'You cannot challenge yourself.' })
  }
  // Posting to the board means committing a portfolio now, because the battle
  // will start without you. Validated here with the same function the pick
  // phase uses - a board entry must not be able to smuggle in a lineup the
  // live terminal would have refused.
  const onBoard = !!listed && !targetUser
  let storedPicks = null
  if (onBoard) {
    if (!Array.isArray(picks)) return res.status(400).json({ error: 'A public challenge has to carry your three coins.' })
    const pickErr = validatePicks(picks, cfg)
    if (pickErr) return res.status(400).json({ error: pickErr })
    storedPicks = JSON.stringify(picks.map((p) => ({ tokenId: p.tokenId, pct: Math.round(p.pct) })))
  }
  // Classic takes any chain's dollars: the house holds nothing there and the two
  // stakes settle against each other. Live does not - it spends only money
  // already standing on the pool's own chain, because a stake that cannot buy
  // its own basket would have to be fronted out of other players' deposits.
  // This is the same rule the queue applies; it was missing here while a
  // challenge could only be Classic, and stayed missing after Live tables
  // arrived on the board.
  const fund = cfg.mode === 'live' ? poolFund(cfg.pool) : null
  const funded = await ensureFunded(req.user.id, cfg.stake, fund)
  if (funded.error) return res.status(400).json(funded)
  const code = randomBytes(4).toString('hex').toUpperCase()
  const lock = lockStake(req.user.id, cfg.stake, 'challenge:' + code, fund)
  if (!lock.ok) return res.status(400).json({ error: lock.why })
  const expires = Date.now() + (onBoard ? LISTED_TTL : CHALLENGE_TTL)
  db.prepare('INSERT INTO challenges (code, from_user, target, mode, stake, duration, pool, created, expires, picks, listed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(code, req.user.id, targetUser ? targetUser.name : null, cfg.mode, cfg.stake, cfg.duration, cfg.pool, Date.now(), expires, storedPicks, onBoard ? 1 : 0)
  manager.pushWallet(req.user.id)
  if (targetUser) {
    hub.send(targetUser.id, {
      type: 'challenge.incoming',
      code, from: { name: req.user.name, avatar: req.user.avatar },
      mode: cfg.mode, stake: cfg.stake, duration: cfg.duration, pool: cfg.pool, expires,
    })
  }
  // A table posted onto a board where somebody is ALREADY standing in the queue
  // on exactly these terms starts right now instead of sitting there. The
  // searcher's stake was collected on their way into the queue and this poster's
  // was collected above, so both sides are paid up and the room can open.
  let matched = false
  if (onBoard) {
    matched = !!manager.matchListingToQueue(db.prepare('SELECT * FROM challenges WHERE code = ?').get(code))
    broadcastAll({ type: 'board.changed' })
  }
  res.json({ code, expires, listed: onBoard, matched })
})

// A poster's arena record, so the board reads as a room full of people rather
// than a list of prices. Training battles are excluded - they cost nothing and
// say nothing about who you are about to put money against.
const challengeRecord = (userId) => {
  const r = db.prepare(`SELECT
      SUM(CASE WHEN (user_a = ?1 AND outcome_a = 'win') OR (user_b = ?1 AND outcome_a = 'loss') THEN 1 ELSE 0 END) w,
      COUNT(*) n
    FROM matches WHERE (user_a = ?1 OR user_b = ?1) AND training = 0`).get(userId)
  return { played: r?.n || 0, won: r?.w || 0 }
}

// The open board. Public on purpose - a visitor without an account should be
// able to see that real tables are waiting, which is the entire point of it.
// Picks are NEVER served here: they are locked, not published.
app.get('/api/challenges', (req, res) => {
  // Not behind `authed`: signed-out visitors get the board too. The viewer is
  // resolved by hand only to mark their own postings.
  const me = sessionUser((req.headers.authorization || '').replace(/^Bearer\s+/i, ''))
  const rows = db.prepare(`SELECT c.*, u.name AS from_name, u.avatar AS from_avatar
                           FROM challenges c JOIN users u ON u.id = c.from_user
                           WHERE c.status = 'open' AND c.listed = 1 AND c.expires > ?
                           ORDER BY c.created DESC LIMIT 60`).all(Date.now())
  res.json({
    open: rows.map((c) => ({
      code: c.code, mode: c.mode, stake: c.stake, duration: c.duration, pool: c.pool,
      from: { name: c.from_name, avatar: c.from_avatar },
      created: c.created, expires: c.expires,
      mine: !!me && me.id === c.from_user,
      record: challengeRecord(c.from_user),
    })),
  })
})

app.get('/api/challenges/:code', (req, res) => {
  const c = db.prepare('SELECT * FROM challenges WHERE code = ?').get(String(req.params.code).toUpperCase())
  if (!c) return res.status(404).json({ error: 'Challenge not found.' })
  const from = getUser(c.from_user)
  res.json({
    challenge: {
      code: c.code, mode: c.mode, stake: c.stake, duration: c.duration, pool: c.pool,
      from: { name: from.name, avatar: from.avatar },
      expires: c.expires, status: c.status,
      creatorOnline: hub.online(c.from_user),
      // Posted to the board, portfolio already committed - so "they're offline"
      // is not a reason this cannot start.
      listed: !!c.listed, standing: !!c.picks,
      record: challengeRecord(c.from_user),
    },
  })
})

app.post('/api/challenges/:code/cancel', authed, (req, res) => {
  const c = db.prepare('SELECT * FROM challenges WHERE code = ? AND from_user = ?').get(String(req.params.code).toUpperCase(), req.user.id)
  if (!c || c.status !== 'open') return res.status(400).json({ error: 'No open challenge with that code.' })
  db.prepare(`UPDATE challenges SET status = 'cancelled' WHERE code = ?`).run(c.code)
  releaseLock(req.user.id, { refund: true, note: 'Challenge cancelled - stake refunded' })
  manager.pushWallet(req.user.id)
  res.json({ ok: true })
})

// ---- wallet ----

app.get('/api/wallet', authed, (req, res) => {
  const txs = db.prepare('SELECT ts, type, amount, note, coin FROM txs WHERE user_id = ? ORDER BY ts DESC LIMIT 50').all(req.user.id)
  res.json({
    balance: balanceOf(req.user.id),
    balanceCoin: balanceCoinOf(req.user.id),
    coinUsd: ledgerPriceUsd(),
    coin: LEDGER_COIN,
    funds: chainFunds(req.user.id),
    txs,
  })
})

app.get('/api/holdings', authed, (req, res) => {
  res.json({ holdings: holdingsView(req.user.id, (id) => getPrice(id)) })
})

app.post('/api/holdings/sell', authed, async (req, res) => {
  const { token, amount } = req.body || {}
  const r = await sellHolding(req.user.id, String(token || ''), amount)
  if (r.error) return res.status(400).json({ error: r.error })
  manager.pushWallet(req.user.id)
  res.json(r)
})

// Free play: no treasury, no withdrawals - only the paper hedge and the book.
app.get('/api/admin/rails', authed, adminOnly, (_req, res) => {
  res.json({
    hedge: hedgeOverview(),
    liveMaxStake: getSetting('liveMaxStake'),
    tokenSource: tokenSourceStats(),
  })
})

// ---- admin ----

app.get('/api/admin/overview', authed, adminOnly, (req, res) => {
  res.json({
    settings: {
      classicPaused: getSetting('classicPaused'),
      livePaused: getSetting('livePaused'),
      feeTiers: getSetting('feeTiers'),
      signupCredit: getSetting('signupCredit'),
      achieveRebatePct: getSetting('achieveRebatePct'),
      manualPayouts: getSetting('manualPayouts'),
      autoWithdrawMax: walletMeta().autoMax,
    },
    overrides: getOverrides(),
    activeRooms: manager.activeRooms(),
    activeTourneys: tourneys.activeSummary(),
    flagged: db.prepare('SELECT id, ts, mode, stake, name_a, name_b, ret_a, ret_b FROM matches WHERE flagged = 1 ORDER BY ts DESC LIMIT 30').all(),
    recent: db.prepare('SELECT id, ts, mode, stake, training, name_a, name_b, outcome_a, payout_a, payout_b FROM matches ORDER BY ts DESC LIMIT 30').all(),
    users: db.prepare('SELECT id, name, avatar, balance, blocked, training_done, created FROM users ORDER BY created DESC LIMIT 100').all(),
    log: db.prepare('SELECT ts, actor, msg FROM admin_log ORDER BY ts DESC LIMIT 100').all(),
  })
})

app.post('/api/admin/settings', authed, adminOnly, (req, res) => {
  const { classicPaused, livePaused, feeTiers, signupCredit, liveMaxStake, achieveRebatePct, manualPayouts, autoWithdrawMax } = req.body || {}
  if (typeof classicPaused === 'boolean') { setSetting('classicPaused', classicPaused); adminLog(req.user.name, `Classic Arena ${classicPaused ? 'paused' : 'resumed'}`) }
  // Logged loudly on both edges: turning it OFF is the moment money starts
  // moving on its own again, and that belongs in the record as much as the
  // moment it stopped.
  if (typeof manualPayouts === 'boolean') {
    setSetting('manualPayouts', manualPayouts)
    adminLog(req.user.name, manualPayouts
      ? 'MANUAL PAYOUTS ON - winnings are held as balance and every withdrawal needs approval'
      : 'Manual payouts OFF - winnings pay out automatically again')
  }
  // Dollars per request that go out without a person looking. Zero means every
  // withdrawal waits, which is a different thing from the lockdown above: this
  // is the routine ceiling, that is the emergency stop.
  if (typeof autoWithdrawMax === 'number' && autoWithdrawMax >= 0 && autoWithdrawMax <= 100000) {
    setSetting('autoWithdrawMax', Math.round(autoWithdrawMax * 100) / 100)
    adminLog(req.user.name, autoWithdrawMax > 0
      ? `Auto-withdrawal limit set to $${autoWithdrawMax} per request - anything larger waits for approval`
      : 'Auto-withdrawal limit set to $0 - every withdrawal now waits for approval')
  }
  if (typeof livePaused === 'boolean') { setSetting('livePaused', livePaused); adminLog(req.user.name, `Live Arena ${livePaused ? 'paused' : 'resumed'}`) }
  if (feeTiers && typeof feeTiers === 'object') { setSetting('feeTiers', feeTiers); adminLog(req.user.name, `Fee tiers set to ${JSON.stringify(feeTiers)}`) }
  if (typeof signupCredit === 'number' && signupCredit >= 0) { setSetting('signupCredit', signupCredit); adminLog(req.user.name, `Signup credit set to $${signupCredit}`) }
  if (typeof liveMaxStake === 'number' && STAKES.includes(liveMaxStake)) { setSetting('liveMaxStake', liveMaxStake); adminLog(req.user.name, `Live Arena stake cap set to $${liveMaxStake}`) }
  // Refused above 90 at the door as well as clamped in achievements.js. The
  // clamp is what makes the guarantee unbreakable; this is what stops the panel
  // from quietly accepting a number it will not honour.
  if (typeof achieveRebatePct === 'number' && achieveRebatePct >= 0 && achieveRebatePct <= 90) {
    setSetting('achieveRebatePct', achieveRebatePct)
    adminLog(req.user.name, `Achievement rebate set to ${achieveRebatePct}% of each player's paid fees`)
  }
  res.json({ ok: true })
})

app.post('/api/admin/token/:id', authed, adminOnly, (req, res) => {
  const id = req.params.id
  const patch = req.body || {}
  if (patch.clear) {
    setOverride(id, null)
    adminLog(req.user.name, `Token ${id}: overrides cleared`)
  } else {
    const cur = getOverrides()[id] || {}
    const next = { ...cur }
    if (typeof patch.category === 'string') next.category = patch.category
    if (typeof patch.maxStake === 'number') next.maxStake = patch.maxStake
    if (typeof patch.paused === 'boolean') next.paused = patch.paused
    setOverride(id, next)
    adminLog(req.user.name, `Token ${id}: ${JSON.stringify(next)}`)
  }
  res.json({ ok: true })
})

app.post('/api/admin/block', authed, adminOnly, (req, res) => {
  const { name, blocked } = req.body || {}
  const u = getUserByName(name || '')
  if (!u) return res.status(404).json({ error: 'No such user.' })
  db.prepare('UPDATE users SET blocked = ? WHERE id = ?').run(blocked ? 1 : 0, u.id)
  if (blocked) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id)
  adminLog(req.user.name, `${blocked ? 'Blocked' : 'Unblocked'} user ${u.name}`)
  res.json({ ok: true })
})

app.post('/api/admin/void', authed, adminOnly, (req, res) => {
  const ok = manager.voidRoom(req.body?.roomId, req.user.name)
  if (!ok) return res.status(400).json({ error: 'No active room with that id.' })
  res.json({ ok: true })
})

app.post('/api/admin/refund', authed, adminOnly, (req, res) => {
  const { name, amount, note } = req.body || {}
  const u = getUserByName(name || '')
  if (!u) return res.status(404).json({ error: 'No such user.' })
  if (!(amount > 0)) return res.status(400).json({ error: 'Amount must be positive.' })
  credit(u.id, amount, 'refund', note || `Manual refund by ${req.user.name}`)
  adminLog(req.user.name, `Manual refund $${amount} to ${u.name}${note ? ` (${note})` : ''}`)
  manager.pushWallet(u.id)
  res.json({ ok: true })
})

// ---- static frontend + SEO shell (production: one process serves everything) ----
//
// Routing left the hash for real paths, which makes every screen a real URL -
// but only if the server answers for it. Three jobs here:
//   1. static files, with immutable caching for the hashed bundle
//   2. robots.txt + sitemap.xml, origin taken from the request so the same
//      build answers correctly on localhost and on the real domain
//   3. the SPA fallback: any path that is a screen gets the shell, with the
//      RIGHT title/description/social card injected for that route - this is
//      what a crawler and a link unfurler actually read, since neither waits
//      for the bundle to render.
//
// Everything injected is escaped: token names and player
// names are user- or chain-supplied and must never reach the HTML raw.
const seoEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
const seoOrigin = (req) => {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim()
  return `${proto}://${req.get('host')}`
}

const SEO_DEFAULT_TITLE = 'SolArena - Pick your coins. Beat your opponent. Take the pool.'
const SEO_DEFAULT_DESC = 'Free-to-play 1v1 Solana memecoin battles: pick three coins, beat your opponent, highest return takes the pool. No wallet, no real money.'

// Screens a crawler is welcome on, with what to say about each. Anything not
// here is either gated behind login (noindex) or not a screen at all (404).
const SEO_PUBLIC = {
  '': { title: SEO_DEFAULT_TITLE, desc: SEO_DEFAULT_DESC },
  play: { title: 'Battle - 1v1 crypto duels | SolArena', desc: 'Pick three coins, set a stake and a duration, and face an opponent. Highest portfolio return when the clock runs out takes the pool.' },
  board: { title: 'Challenge Board - open tables | SolArena', desc: 'Open challenges waiting for an opponent: stake, duration and locked portfolio visible before you sit down. Take a table without waiting for a queue.' },
  tokens: { title: 'Tokens - the live book | SolArena', desc: 'Every Solana memecoin you can battle with: live prices, depth, volume, holders and safety checks, seconds old.' },
  token: { title: 'Token - SolArena', desc: 'Live price, liquidity, volume and battle stats for this token on SolArena.' },
  leaderboard: { title: 'Leaderboard - top fighters | SolArena', desc: 'The best records in the arena: wins, profit and streaks, updated live.' },
  match: { title: 'Battle log - SolArena', desc: 'The full log of a settled battle: both portfolios, every price tick, and how the pool was paid.' },
  rules: { title: 'Rules & Safety | SolArena', desc: 'How battles settle, the fee schedule, token safety checks, and what happens when something goes wrong. The whole rulebook, public.' },
  terms: { title: 'Terms of Service | SolArena', desc: 'The terms SolArena operates under: fees, settlement, refunds and voids, spelled out.' },
  privacy: { title: 'Privacy Policy | SolArena', desc: 'What SolArena stores, what it never asks for, and what leaves the server.' },
}
// Public but pointless in an index (thin or ephemeral): crawlable for the
// social card, marked noindex so search results stay clean.
const SEO_NOINDEX = new Set(['login', 'duel', 'history', 'profile', 'wallet', 'training', 'tournaments', 'challenge-new', 'challenge', 'admin', 'achievements'])
const SEO_NOINDEX_META = {
  login: { title: 'Log in - SolArena', desc: 'Log in or create a fighter to battle for real stakes.' },
  tournaments: { title: 'Tournaments - SolArena', desc: '5-10 players, one Classic battle, top of the field takes the pot.' },
  challenge: { title: 'You have been challenged - SolArena', desc: 'Someone picked their three coins and put money on them. Take the other side.' },
}

// The per-route lookup. Parts arrive decoded; anything user-supplied that ends
// up in the strings is escaped at render time, not here.
const seoMetaFor = (parts) => {
  const screen = parts[0] || ''
  const image = '/og.jpg'
  if (SEO_NOINDEX.has(screen)) {
    let meta = SEO_NOINDEX_META[screen] || { title: 'SolArena', desc: SEO_DEFAULT_DESC }
    if (screen === 'challenge' && parts[1]) {
      try {
        const c = db.prepare('SELECT stake, mode FROM challenges WHERE code = ?').get(String(parts[1]).toUpperCase())
        if (c) meta = { ...meta, title: `A $${c.stake} ${c.mode === 'live' ? 'Live' : 'Classic'} challenge is waiting - SolArena` }
      } catch { /* keep the generic card */ }
    }
    return { status: 200, noindex: true, image, ...meta }
  }
  if (screen === 'token' && parts[1]) {
    try {
      const t = allTokensEff().find((x) => x.id === parts[1])
      if (t) return { status: 200, image, title: `${t.ticker} - live price, depth & battles | SolArena`, desc: `${t.name || t.ticker} on SolArena: live price from the chain, liquidity, 24h volume and safety checks - and every battle it has fought in.` }
    } catch { /* fall through */ }
    return { status: 404, image, ...SEO_PUBLIC.token, noindex: true }
  }
  if (screen === 'match' && parts[1]) {
    try {
      const m = db.prepare('SELECT name_a, name_b FROM matches WHERE id = ?').get(parts[1])
      if (m) return { status: 200, image, title: `${m.name_a} vs ${m.name_b} - battle log | SolArena`, desc: SEO_PUBLIC.match.desc }
    } catch { /* fall through */ }
    return { status: 404, image, ...SEO_PUBLIC.match, noindex: true }
  }
  if (SEO_PUBLIC[screen]) return { status: 200, image, ...SEO_PUBLIC[screen] }
  // Not a screen. The shell still renders (the app lands on Battle), but the
  // status must say 404 or every typo becomes its own "page" in an index.
  return { status: 404, image, title: SEO_DEFAULT_TITLE, desc: SEO_DEFAULT_DESC, noindex: true }
}

const seoBlockFor = (req, meta) => {
  const origin = seoOrigin(req)
  const url = origin + req.path
  const lines = [
    `<meta name="description" content="${seoEsc(meta.desc)}" />`,
    meta.noindex ? '<meta name="robots" content="noindex" />' : `<link rel="canonical" href="${seoEsc(url)}" />`,
    '<meta property="og:site_name" content="SolArena" />',
    '<meta property="og:type" content="website" />',
    `<meta property="og:url" content="${seoEsc(url)}" />`,
    `<meta property="og:title" content="${seoEsc(meta.title)}" />`,
    `<meta property="og:description" content="${seoEsc(meta.desc)}" />`,
    `<meta property="og:image" content="${seoEsc(origin + meta.image)}" />`,
    '<meta property="og:image:width" content="1200" />',
    '<meta property="og:image:height" content="630" />',
    '<meta name="twitter:card" content="summary_large_image" />',
  ]
  if (req.path === '/') {
    lines.push(`<script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org', '@type': 'WebSite', name: 'SolArena', url: origin + '/',
      description: SEO_DEFAULT_DESC,
    })}</script>`)
  }
  return lines.join('\n    ')
}

// Predict was retired on 23 Sep 2026. Links to it are still out there (shared
// markets, duels, the old social card), so they land on the arena instead of
// a 404 - permanently, so indexes drop them.
app.get(/^\/predict(\/.*)?$/, (_req, res) => res.redirect(301, '/play'))

// Routes the sitemap advertises. Tokens ride along - they are the pages
// people actually search for - rebuilt on every request so the map is never
// staler than the book.
app.get('/robots.txt', (req, res) => {
  const block = [...SEO_NOINDEX].filter((s) => !['login', 'challenge'].includes(s)).map((s) => `Disallow: /${s}`).join('\n')
  res.type('text/plain').send(`User-agent: *\nAllow: /\n${block}\n\nSitemap: ${seoOrigin(req)}/sitemap.xml\n`)
})

app.get('/sitemap.xml', (req, res) => {
  const origin = seoOrigin(req)
  const urls = ['/', '/play', '/board', '/tokens', '/leaderboard', '/rules', '/terms', '/privacy']
  try { for (const t of allTokensEff()) urls.push('/token/' + encodeURIComponent(t.id)) } catch { /* book not warm yet - statics still stand */ }
  const body = urls.map((u) => `  <url><loc>${seoEsc(origin + u)}</loc></url>`).join('\n')
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`)
})

if (existsSync('dist')) {
  // index:false - '/' must fall through to the shell handler below, or the
  // homepage would be the one page that ships without its meta. The bundle
  // files carry their content hash in the name, so they can cache forever.
  app.use(express.static('dist', {
    index: false,
    setHeaders: (res, filePath) => {
      if (filePath.includes('assets')) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    },
  }))

  // The shell, re-read only when the build changes underneath a running server.
  let shellCache = { mtime: 0, html: '' }
  const shellHtml = () => {
    const st = statSync('dist/index.html')
    if (st.mtimeMs !== shellCache.mtime) shellCache = { mtime: st.mtimeMs, html: readFileSync('dist/index.html', 'utf8') }
    return shellCache.html
  }

  // Everything that is not the API, the socket or a bundle file gets the shell.
  // A path whose last segment has an extension is a missing FILE, not a screen
  // - it must stay a 404, or a broken image link would download a page of HTML.
  app.get(/^\/(?!api(?:\/|$)|assets\/|ws$).*/, (req, res) => {
    const last = req.path.split('/').pop()
    if (last.includes('.')) return res.status(404).type('text/plain').send('Not found')
    const parts = req.path.split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s) } catch { return s } })
    const meta = seoMetaFor(parts)
    const html = shellHtml()
      .replace(/<title>[\s\S]*?<\/title>/, `<title>${seoEsc(meta.title)}</title>`)
      .replace(/<!--seo:start-->[\s\S]*?<!--seo:end-->/, seoBlockFor(req, meta))
    res.status(meta.status).set('Cache-Control', 'no-cache').type('html').send(html)
  })
}

// ---- ws wiring ----
const server = createServer(app)
const wss = new WebSocketServer({ server, path: '/ws' })

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x')
  const user = sessionUser(url.searchParams.get('token'))
  if (!user) { ws.close(4001, 'auth'); return }
  const userId = user.id

  let set = conns.get(userId)
  if (!set) { set = new Set(); conns.set(userId, set) }
  set.add(ws)

  // hello: identity + wallet + any active battle (resume after reload).
  // A tournament past its lobby phase resumes exactly like a duel - the
  // snapshot is duel-shaped on purpose.
  const room = manager.roomOf(userId)
  const tourney = tourneys.byUser(userId)
  const hello = {
    type: 'hello',
    user: { name: user.name, avatar: user.avatar, bio: user.bio, isAdmin: !!user.is_admin },
    balance: balanceOf(userId),
    balanceCoin: balanceCoinOf(userId),
    coinUsd: ledgerPriceUsd(),
    funds: chainFunds(userId),
    trainingDone: !!user.training_done,
    inQueue: manager.inQueue(userId),
    duel: room ? manager.snapshotFor(room, manager.sideOf(room, userId))
      : tourney && tourney.phase !== 'lobby' ? tourneys.snapshotFor(tourney, userId) : null,
    tourneys: tourneys.publicState(),
    feed: getFeedStatus(),
  }
  ws.send(JSON.stringify(hello))

  ws.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(String(raw)) } catch { return }
    const fresh = getUser(userId)
    if (!fresh || fresh.blocked) { ws.close(4003, 'blocked'); return }
    // Entering a paid battle now collects the stake on-chain, so some handlers
    // answer with a promise. Errors must surface the same way whether the
    // handler was sync or async, or a failed stake pull would look like silence.
    const fail = (e) => {
      console.error('[ws] handler error:', e)
      try { ws.send(JSON.stringify({ type: 'error', msg: 'Server error.', re: msg.type })) } catch { /* socket gone */ }
    }
    const answer = (reply) => {
      if (reply?.error) {
        try { ws.send(JSON.stringify({ type: 'error', msg: reply.error, re: msg.type, needsApproval: reply.needsApproval || undefined, chain: reply.chain || undefined })) } catch { /* socket gone */ }
      }
    }
    try {
      const reply = handleWs(fresh, msg, ws)
      if (reply && typeof reply.then === 'function') reply.then(answer, fail)
      else answer(reply)
    } catch (e) {
      fail(e)
    }
  })

  ws.on('close', () => {
    marketSubs.delete(ws)
    const s = conns.get(userId)
    if (s) {
      s.delete(ws)
      if (!s.size) {
        conns.delete(userId)
        // last tab closed: leaving the queue / a tournament lobby is safe
        // (full refund); active rooms and started tournaments continue
        manager.leaveQueue(userId, { silent: true })
        tourneys.leaveLobbyOnClose(userId)
      }
    }
  })
})

const handleWs = (user, msg, ws) => {
  switch (msg.type) {
    case 'queue.join': return manager.joinQueue(user, msg)
    case 'queue.leave': manager.leaveQueue(user.id); return { ok: true }
    case 'queue.offerReply': return manager.acceptNearest(user.id, msg.accept === true)
    case 'training.start': return manager.startTraining(user, msg)
    // A user is in a duel OR a tournament, never both (one stake lock each),
    // so lock/cancel route to whichever holds them.
    case 'duel.lock': return tourneys.byUser(user.id) ? tourneys.lockPicks(user.id, msg.picks) : manager.lockPicks(user.id, msg.picks)
    case 'duel.cancel': return tourneys.byUser(user.id) ? tourneys.leave(user.id) : manager.cancelByPlayer(user.id)
    case 'tourney.join': return tourneys.join(user, String(msg.tier || ''), String(msg.pool || ''))
    case 'tourney.leave': return tourneys.leave(user.id)
    case 'challenge.accept': return (async () => {
      const c = db.prepare('SELECT * FROM challenges WHERE code = ?').get(String(msg.code || '').toUpperCase())
      if (!c || c.status !== 'open') return { error: 'Challenge not found or no longer open.' }
      if (c.expires < Date.now()) return { error: 'This challenge has expired.' }
      if (c.from_user === user.id) return { error: 'You cannot accept your own challenge.' }
      if (c.target && c.target.toLowerCase() !== user.name.toLowerCase()) return { error: 'This challenge is for a different player.' }
      // A board posting already carries its author's locked portfolio, so it
      // needs nothing from them to run - that asynchrony is the whole feature.
      // A private link still does: nobody has picked for that side yet, and a
      // pick phase with an empty chair only ends in a refund for both.
      const preset = c.picks ? JSON.parse(c.picks) : null
      if (!preset && !hub.online(c.from_user)) return { error: 'The challenger is not online right now.' }
      if (manager.roomOf(c.from_user)) return { error: 'The challenger is already in a battle.' }
      if (manager.roomOf(user.id)) return { error: 'You already have an active battle.' }
      // Same rule as posting one: a Live table is paid for on the chain its
      // basket is bought on, or it is not paid for at all.
      const fund = c.mode === 'live' ? poolFund(c.pool) : null
      const funded = await ensureFunded(user.id, c.stake, fund)
      if (funded.error) return funded
      // The pull took seconds; re-check that the challenge and both players are
      // still where they were, and leave the money as balance if not.
      const still = db.prepare('SELECT status FROM challenges WHERE code = ?').get(c.code)
      if (still?.status !== 'open') return { error: 'That challenge was just taken - the collected stake is in your balance.' }
      if (manager.roomOf(user.id) || manager.roomOf(c.from_user)) {
        return { error: 'One of you just entered another battle - the collected stake is in your balance.' }
      }
      // The challenger's lock holds COIN from posting day; the battle charges
      // dollars now. Exact coin back, stake re-taken at the current price - and
      // if their re-priced money no longer covers the table, the challenge dies
      // with the refund standing instead of starting a half-funded battle.
      const re = resettleLock(c.from_user, c.stake, fund)
      if (!re.ok) {
        db.prepare(`UPDATE challenges SET status = 'cancelled' WHERE code = ?`).run(c.code)
        manager.pushWallet(c.from_user)
        if (c.listed) broadcastAll({ type: 'board.changed' })
        return { error: 'The challenger can no longer fund this table - it was withdrawn and their stake returned. Your money was not touched.' }
      }
      const lock = lockStake(user.id, c.stake, 'challenge-accept', fund)
      if (!lock.ok) return { error: lock.why }
      db.prepare(`UPDATE challenges SET status = 'used' WHERE code = ?`).run(c.code)
      const creator = getUser(c.from_user)
      manager.createRoom(
        { mode: c.mode, stake: c.stake, duration: c.duration, pool: c.pool, training: false },
        [creator, user], preset ? 'open board' : 'private challenge',
        preset ? { [creator.id]: preset } : null,
      )
      manager.pushWallet(user.id)
      if (c.listed) broadcastAll({ type: 'board.changed' })
      return { ok: true }
    })()
    // A new subscriber gets the whole picture at once; the per-second stream
    // after it carries only changes.
    case 'market.sub':
      marketSubs.add(ws)
      try { ws.send(JSON.stringify({ type: 'market.tick', prices: marketSnapshot({ full: true }), feed: getFeedStatus() })) } catch { /* it will get the next full resync */ }
      return { ok: true }
    case 'market.unsub': marketSubs.delete(ws); return { ok: true }
    default: return { error: 'Unknown message type: ' + msg.type }
  }
}

// ---- vitals, for the deaths exit.log cannot catch ----
//
// bye() covers every exit the process gets a say in. It does NOT cover a V8
// fatal OOM (abort(), no handlers run) or a TerminateProcess, and those leave
// nothing at all behind: no exit.log line, no Windows error event, no dump.
// One such death is already on record - 22:54:17Z, 38 minutes of uptime, and
// the only thing that could be said about it afterwards was what was ABSENT.
//
// So: rewrite the last VITALS_KEEP samples to <db-dir>/vitals.log on a timer.
// The file is small and fixed-size (rewritten, not appended), and after a hard
// kill it is the memory ramp leading up to it - which is the difference between
// "it OOMed" and "something killed it", the two cases that look identical from
// the outside. unref() so it never holds the process open by itself.
const VITALS_MS = 30_000
const VITALS_KEEP = 60 // 30 minutes of history at the sample rate above
const vitals = []
const vitalsPath = join(dirname(process.env.HOOD_DB || 'server/data/hoodarena.db'), 'vitals.log')
// The ceiling this process actually got, recorded alongside the ramp so a
// final "heap 2010MB" reads as "at the wall" and not as a bare number.
const heapCapMB = Math.round(getHeapStatistics().heap_size_limit / 1048576)
setInterval(() => {
  const m = process.memoryUsage()
  const mb = (b) => Math.round(b / 1048576)
  let worst = ''
  try { worst = (blockReport().worst?.[0]?.ms ?? 0) + 'ms' } catch { /* best-effort */ }
  vitals.push(`${new Date().toISOString()} up=${Math.round(process.uptime())}s rss=${mb(m.rss)}MB` +
    ` heap=${mb(m.heapUsed)}/${mb(m.heapTotal)}MB ext=${mb(m.external)}MB worstStall=${worst}`)
  if (vitals.length > VITALS_KEEP) vitals.shift()
  try { writeFileSync(vitalsPath, `pid=${process.pid} heapCap=${heapCapMB}MB\n${vitals.join('\n')}\n`) }
  catch { /* never let the log be the thing that kills us */ }
}, VITALS_MS).unref()

server.listen(PORT, () => {
  console.log(`[hoodarena] server on http://localhost:${PORT}  (feed: ${getFeedStatus()}, speed: ${process.env.HOOD_SPEED || 1}x)`)
})
