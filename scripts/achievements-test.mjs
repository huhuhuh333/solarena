// Achievements unit test - and above all, a PROOF of the one rule the feature
// exists to respect:
//
//   the arena can never end up down on a player because of achievements.
//
// Everything a player is ever paid comes out of a fraction of the fees that same
// player already paid, so for every account, at every moment:
//
//   rewards_paid  <=  RATIO * fees_paid       with RATIO < 1
//   =>  fees_paid - rewards_paid  >  0        whenever any fee was ever paid
//
// The last section brute-forces that: random fee histories, random claim orders,
// hostile settings, every achievement in the catalogue claimed as fast as it is
// allowed - then asserts the arena is still up on every single player.
//
// Usage: node scripts/achievements-test.mjs

import { rmSync, mkdirSync } from 'node:fs'

const DB_DIR = 'server/data/achievements-test'
rmSync(DB_DIR, { recursive: true, force: true })
mkdirSync(DB_DIR, { recursive: true })
process.env.HOOD_DB = `${DB_DIR}/test.db`

const { db, setSetting, balanceOf } = await import('../server/db.js')
const {
  achievementsFor, claimAchievement, feesPaidBy, rewardsPaidTo,
  rebateFor, rebateRatio, rebateAudit, publicBadgesFor,
} = await import('../server/achievements.js')

const log = (...a) => console.log('[achv]', ...a)
const fail = (msg) => { console.error('[FAIL]', msg); process.exitCode = 1 }
const assert = (cond, msg) => { if (!cond) fail(msg); else log('ok:', msg) }
// Quiet variant for the fuzz loop - thousands of passing assertions is noise,
// a single failing one is the whole point.
const check = (cond, msg) => { if (!cond) { fail(msg); throw new Error(msg) } }

const near = (a, b, eps = 0.005) => Math.abs(a - b) <= eps

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

let uid = 0
const newUser = (name) => {
  const r = db.prepare(`INSERT INTO users (name, pass_hash, avatar, bio, created, balance)
                        VALUES (?, 'x', '🔥', 'test', ?, 0)`).run(name, Date.now())
  return Number(r.lastInsertRowid)
}

let matchSeq = 0
let clock = 1_700_000_000_000
const addMatch = (userId, o = {}) => {
  const {
    mode = 'classic', stake = 100, fee = 16, outcome = 'win', training = 0,
    duration = 300, tokens = ['AAA', 'BBB', 'CCC'], payout = 184,
    // The record the new conditions read: who the opponent was (diversity),
    // both final returns (photo finish), per-token returns (craft), and the
    // clutch block duel.js writes at settlement (comebacks).
    oppName = 'bot', retA = 1, retB = 0, tokenRets = null, clutch = null,
  } = o
  const id = `m${++matchSeq}`
  clock += 1000
  db.prepare(`INSERT INTO matches (id, ts, mode, stake, duration, training, tournament_id,
      user_a, user_b, name_a, name_b, ret_a, ret_b, outcome_a, payout_a, payout_b,
      fee, pool, flagged, data)
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, 'me', ?, ?, ?, ?, ?, 0, ?, ?, 0, ?)`)
    .run(id, clock, mode, stake, duration, training, userId, oppName, retA, retB, outcome,
      outcome === 'win' ? payout : outcome === 'draw' ? stake : 0,
      fee, stake * 2, JSON.stringify({
        tokensA: tokens.map((t, i) => ({ tokenId: t, pct: 33, ret: tokenRets ? tokenRets[i] : 1 })),
        ...(clutch ? { clutch } : {}),
      }))
  return id
}

const byKey = (view, k) => view.achievements.find((a) => a.key === k)

let tourneySeq = 0
const addTourney = (userId, { stake = 100, feePct = 8, rank = 5, prize = 0, players = 5, status = 'done' } = {}) => {
  const id = `t${++tourneySeq}`
  clock += 1000
  const pot = stake * players
  db.prepare(`INSERT INTO tourneys (id, ts, tier, stake, pool, duration, status, settled, pot, fee, fee_pct, data)
              VALUES (?, ?, 'mid', ?, 'eth', 300, ?, ?, ?, ?, ?, '{}')`)
    .run(id, clock, stake, status, clock, pot, Math.round(pot * feePct) / 100, feePct)
  db.prepare(`INSERT INTO tourney_players (tourney_id, user_id, name, avatar, picks, ret, rank, prize, outcome)
              VALUES (?, ?, 'me', '🔥', '[]', 1, ?, ?, 'x')`).run(id, userId, rank, prize)
  return id
}

// ---------------------------------------------------------------------------
// 1. the fee base counts only what the house actually kept
// ---------------------------------------------------------------------------

// The rate the arena actually ships with. Asserted before anything overrides it,
// because every guarantee below is only as good as the shipped default staying
// under 100 - and this is the number a reader will want to see stated once.
assert(rebateRatio() === 0.4, 'the shipped default hands back 40% - the arena keeps the other 60%')
assert(rebateRatio() < 1, 'and it is under 100%, which is the whole guarantee in one line')

setSetting('achieveRebatePct', 25)

const u1 = newUser('feebase')
addMatch(u1, { mode: 'classic', stake: 100, fee: 16, outcome: 'win' })
assert(near(feesPaidBy(u1), 8), 'classic win: player pays half the pool fee ($8 of $16)')

addMatch(u1, { mode: 'classic', stake: 100, fee: 16, outcome: 'draw' })
assert(near(feesPaidBy(u1), 8), 'classic DRAW adds nothing - duel.js waives the fee and returns both stakes')

addMatch(u1, { mode: 'live', stake: 100, fee: 16, outcome: 'draw' })
assert(near(feesPaidBy(u1), 16), 'live draw DOES pay - the fee leaves the entry before any coin is bought')

addMatch(u1, { mode: 'classic', stake: 100, fee: 16, outcome: 'win', training: 1 })
assert(near(feesPaidBy(u1), 16), 'training battles add nothing - there is no fee')

addTourney(u1, { stake: 100, feePct: 8 })
assert(near(feesPaidBy(u1), 24), 'tournament adds this seat\'s share of the pot fee (stake x pct)')

addTourney(u1, { stake: 100, feePct: 8, status: 'running' })
assert(near(feesPaidBy(u1), 24), 'an unsettled tournament adds nothing - a cancelled lobby refunds')

// ---------------------------------------------------------------------------
// 2. the gate: a reward is refused until the player's own fees cover it
// ---------------------------------------------------------------------------

const u2 = newUser('gated')
addMatch(u2, { stake: 10, fee: 2, outcome: 'win' }) // $1 of fee -> $0.25 allowance

let view = achievementsFor(u2)
const firstBlood = view.achievements.find((a) => a.key === 'first-blood')
assert(firstBlood.earned, 'won a battle -> First Blood is earned')
assert(!firstBlood.claimable, 'earned but NOT claimable: $1 reward, $0.25 balance')
assert(near(firstBlood.shortBy, 0.75), 'the screen says exactly how much balance is missing ($0.75)')
assert(firstBlood.waiting, '...and marks it as waiting on balance, not as unearned')

// ---- the player payload must not carry the mechanic behind the balance ----
// Removing the wording from the screen is not enough: anything served here is
// one devtools tab away from being read.
const shown = achievementsFor(u2)
assert(shown.rebate === undefined, 'the player payload carries no "rebate" block at all')
assert(!('feeBase' in shown.rewards) && !('ratio' in shown.rewards) && !('allowance' in shown.rewards),
  'the rewards block exposes no fee base and no rate')
assert(Object.keys(shown.rewards).sort().join(',') === 'available,claimed,unlocked',
  'it serves exactly three player-facing numbers: available, claimed, unlocked')
assert(!/fee/i.test(JSON.stringify(shown)), 'the word "fee" appears nowhere in what a player is served')
assert(!/rebate/i.test(JSON.stringify(shown)), '...and neither does "rebate"')

let r = claimAchievement(u2, 'first-blood')
assert(!!r.error, 'claiming past the allowance is refused')
assert(near(balanceOf(u2), 0), '...and pays nothing')
assert(rewardsPaidTo(u2) === 0, '...and writes no ledger row (the refusal rolled the claim back)')
assert(achievementsFor(u2).achievements.find((a) => a.key === 'first-blood').claimed === false,
  '...so it stays claimable later, once the fees are there')

// Pay more fees; now it fits.
for (let i = 0; i < 3; i++) addMatch(u2, { stake: 10, fee: 2, outcome: 'win' })
assert(near(feesPaidBy(u2), 4), 'four $10 battles = $4 of fees paid')
view = achievementsFor(u2)
assert(view.achievements.find((a) => a.key === 'first-blood').claimable, 'now claimable at exactly $1 allowance')

r = claimAchievement(u2, 'first-blood')
assert(r.ok && near(r.reward, 1), 'claim pays the $1')
assert(near(balanceOf(u2), 1), 'balance went up by the reward')
assert(near(rewardsPaidTo(u2), 1), 'ledger records the dollars actually paid')

// ---------------------------------------------------------------------------
// 3. a claim happens once, ever
// ---------------------------------------------------------------------------

r = claimAchievement(u2, 'first-blood')
assert(!!r.error, 'second claim of the same achievement is refused')
assert(near(balanceOf(u2), 1), '...and the balance did not move')
assert(near(rewardsPaidTo(u2), 1), '...and the ledger did not grow')

// Fire a burst of claims at one key: whatever the ordering, the primary key on
// (user_id, key) means exactly one of them can ever have paid.
const u3 = newUser('burst')
for (let i = 0; i < 20; i++) addMatch(u3, { stake: 100, fee: 16, outcome: 'win' })
let paidCount = 0
for (let i = 0; i < 25; i++) if (claimAchievement(u3, 'first-blood').ok) paidCount++
assert(paidCount === 1, '25 claims of one achievement -> exactly one payment')
assert(near(rewardsPaidTo(u3), 1), '...and exactly one dollar left the house')

assert(!claimAchievement(u3, 'not-a-real-key').ok, 'unknown achievement key is refused')
assert(!!claimAchievement(u3, 'graduate').error, 'a badge with no reward has nothing to claim')
assert(!!claimAchievement(u3, 'whale').error, 'an unearned achievement is refused even with allowance to spare')

// ---------------------------------------------------------------------------
// 4. earning is derived from the record, and never un-earns itself
// ---------------------------------------------------------------------------

const u4 = newUser('record')
addMatch(u4, { mode: 'live', stake: 5000, fee: 250, outcome: 'win', duration: 86400 })
view = achievementsFor(u4)
const earned = new Set(view.achievements.filter((a) => a.earned).map((a) => a.key))
assert(earned.has('first-battle') && earned.has('first-blood'), 'one battle earns the opening badges')
assert(earned.has('live-debut'), 'a live battle earns the live debut')
assert(earned.has('high-roller') && earned.has('whale'), '$5,000 earns both stake badges')
assert(earned.has('marathon-win'), 'winning a 24h battle earns Diamond Hands')
assert(!earned.has('sprint-win'), 'a 24h win does not earn the 5-minute badge')
assert(publicBadgesFor(u4).length === earned.size, 'the public profile shows the same badges, without any money')
assert(publicBadgesFor(u4).every((b) => !('reward' in b) && !('shortBy' in b)),
  '...and the public payload carries no fee or rebate figures at all')

// Losses after the fact must not take a badge away.
for (let i = 0; i < 5; i++) addMatch(u4, { stake: 10, fee: 2, outcome: 'loss' })
const stillEarned = new Set(achievementsFor(u4).achievements.filter((a) => a.earned).map((a) => a.key))
assert([...earned].every((k) => stillEarned.has(k)), 'every badge survives a later losing run - the tests are monotonic')

// Comeback: three losses then a win.
addMatch(u4, { stake: 10, fee: 2, outcome: 'win' })
assert(achievementsFor(u4).achievements.find((a) => a.key === 'comeback').earned,
  'a win straight after three losses earns Comeback')

// ---------------------------------------------------------------------------
// 4b. the pressure/clutch/craft/ladder catalogue reads the record correctly
// ---------------------------------------------------------------------------

// Floored runs: a win below the floor breaks the run for that floor.
const u7 = newUser('pressure')
addMatch(u7, { stake: 20, fee: 4, outcome: 'win' })
addMatch(u7, { stake: 10, fee: 2, outcome: 'win' }) // a WIN - but under the $20 floor
addMatch(u7, { stake: 20, fee: 4, outcome: 'win' })
addMatch(u7, { stake: 20, fee: 4, outcome: 'win' })
let a = byKey(achievementsFor(u7), 'threepeat')
assert(!a.earned && a.have === 2, 'a win below the floor breaks the floored run (2/3 after 20, 10✗, 20, 20)')
addMatch(u7, { stake: 50, fee: 10, outcome: 'win' })
assert(byKey(achievementsFor(u7), 'threepeat').earned, 'three consecutive $20+ wins earn Threepeat - higher stakes count too')

// Diversity: ten in a row is not enough without five different opponents.
const u8 = newUser('diversity')
for (let i = 0; i < 10; i++) addMatch(u8, { stake: 100, fee: 16, outcome: 'win', oppName: `opp${i % 4}` })
a = byKey(achievementsFor(u8), 'perfect-ten')
assert(!a.earned, '10 straight $100 wins against only 4 different players do NOT earn Perfect Ten')
assert(a.have === 9, '...and the tile caps at 9/10 - a full bar that is not earned would be a lie')
addMatch(u8, { stake: 100, fee: 16, outcome: 'win', oppName: 'opp5' })
assert(byKey(achievementsFor(u8), 'perfect-ten').earned, 'an 11th win against a 5th player completes it (the window slides)')

// Clutch: derived from the clutch block the settlement writes - never guessed.
const u9 = newUser('clutch')
addMatch(u9, { stake: 100, fee: 16, outcome: 'win', retA: 2, retB: 1, tokenRets: [1, -0.5, 1] })
assert(!byKey(achievementsFor(u9), 'comeback-king').earned, 'a win with no clutch record earns no comeback - old rows never lie')
addMatch(u9, { stake: 100, fee: 16, outcome: 'win', retA: 2, retB: 1, tokenRets: [1, -0.5, 1],
  clutch: { at75: [-0.5, 1.2], trailedLate: [false, false] } })
assert(byKey(achievementsFor(u9), 'comeback-king').earned, 'trailing at the 75% mark then winning $100+ earns Comeback King')
assert(!byKey(achievementsFor(u9), 'leviathan').earned, '...but not Leviathan - that comeback must be at $5,000+')
addMatch(u9, { stake: 300, fee: 36, outcome: 'win', retA: 2, retB: 1.8, tokenRets: [1, -0.5, 1],
  clutch: { at75: [1, 0], trailedLate: [true, false] } })
assert(byKey(achievementsFor(u9), 'last-minute-hero').earned, 'trailing inside the final 10% then winning $300+ earns Last-Minute Hero')

// Photo finish and the craft of the win, from stored returns.
addMatch(u9, { stake: 200, fee: 32, outcome: 'win', retA: 1.1, retB: 0.9, tokenRets: [1, -0.5, 1] })
assert(byKey(achievementsFor(u9), 'photo-finish').earned, 'a $200 win by 0.20% is a Photo Finish')
assert(!byKey(achievementsFor(u9), 'clean-sweep').earned, 'no Clean Sweep yet - every win so far had a red coin')
addMatch(u9, { stake: 150, fee: 24, outcome: 'win', tokenRets: [-1, -2, 9] })
assert(byKey(achievementsFor(u9), 'against-the-odds').earned, 'winning $150+ with two coins red earns Against The Odds')
addMatch(u9, { stake: 100, fee: 16, outcome: 'win', tokenRets: [0.5, 1, 2] })
assert(byKey(achievementsFor(u9), 'clean-sweep').earned, 'winning $100+ with all three green earns Clean Sweep')

// No Repeat: nine distinct coins across three straight $50+ wins.
const u10 = newUser('norepeat')
addMatch(u10, { stake: 50, fee: 10, outcome: 'win', tokens: ['A1', 'A2', 'A3'] })
addMatch(u10, { stake: 50, fee: 10, outcome: 'win', tokens: ['B1', 'B2', 'B3'] })
addMatch(u10, { stake: 50, fee: 10, outcome: 'win', tokens: ['C1', 'C2', 'A1'] })
assert(!byKey(achievementsFor(u10), 'no-repeat').earned, 'a repeated coin anywhere in the three wins blocks No Repeat')
addMatch(u10, { stake: 50, fee: 10, outcome: 'win', tokens: ['D1', 'D2', 'D3'] })
assert(byKey(achievementsFor(u10), 'no-repeat').earned, 'the window slides - the last three wins carry nine distinct coins')

// The ladder: distinct stake LEVELS won at, not battles won.
const u11 = newUser('ladder')
for (const s of [10, 20, 50, 100, 150]) addMatch(u11, { stake: s, fee: s * 0.2, outcome: 'win' })
a = byKey(achievementsFor(u11), 'stake-explorer')
assert(a.earned && a.have === 5, 'wins at 5 different stake levels earn Stake Explorer')
addMatch(u11, { stake: 100, fee: 16, outcome: 'win' })
assert(byKey(achievementsFor(u11), 'stake-explorer').have === 5, 'winning the same level again counts once')
assert(!byKey(achievementsFor(u11), 'five-hundred-club').earned, 'no $500 win yet - the rung badges want the exact table')
addMatch(u11, { stake: 500, fee: 60, outcome: 'win' })
assert(byKey(achievementsFor(u11), 'five-hundred-club').earned, 'a $500 win earns Five Hundred Club')
assert(!byKey(achievementsFor(u11), 'four-figures').earned, '...and not Four Figures - that is the $1,000 table')

// ---------------------------------------------------------------------------
// 5. a hostile setting cannot turn the rebate into a loss
// ---------------------------------------------------------------------------

const u5 = newUser('hostile')
for (let i = 0; i < 40; i++) addMatch(u5, { stake: 1000, fee: 50, outcome: 'win' })
const fees5 = feesPaidBy(u5)

setSetting('achieveRebatePct', 500) // operator fat-fingers the knob
assert(rebateFor(u5).ratio === 0.9, 'a 500% setting is clamped to 90% - the ratio can never reach 1')
assert(rebateFor(u5).allowance < fees5, '...so the allowance stays strictly under the fees paid')

setSetting('achieveRebatePct', -20)
assert(rebateFor(u5).ratio === 0, 'a negative setting turns rebates off rather than inverting them')
assert(!!claimAchievement(u5, 'first-blood').error, '...and nothing can be claimed while it is off')
assert(achievementsFor(u5).achievements.find((a) => a.key === 'first-blood').paused === true,
  '...and the screen says "paused", rather than implying more play would release it')
assert(!/fee/i.test(claimAchievement(u5, 'first-blood').error),
  '...and even the refusal message never mentions fees')

setSetting('achieveRebatePct', 25)

// ---------------------------------------------------------------------------
// 6. THE PROOF: claim everything, in every order, and the house is still up
// ---------------------------------------------------------------------------

// A player who has earned every achievement in the catalogue.
const maxPlayer = (name) => {
  const id = newUser(name)
  // 25 distinct tokens, for Scout - as live losses, which also feed live-25.
  const toks = Array.from({ length: 25 }, (_, i) => `TOK${i}`)
  for (let i = 0; i < 25; i++) {
    addMatch(id, { mode: 'live', stake: 100, fee: 16, outcome: 'loss', tokens: [toks[i], 'AAA', 'BBB'] })
  }
  for (let i = 0; i < 25; i++) addMatch(id, { mode: 'classic', stake: 100, fee: 16, outcome: 'loss' })
  // Three losses just happened -> the next win is the Comeback, and also the
  // sprint win. Deliberate wins below keep one red coin, so Clean Sweep is
  // earned by ITS battle rather than by accident.
  const red = { tokenRets: [1, -0.5, 1] }
  addMatch(id, { stake: 100, fee: 16, outcome: 'win', duration: 300, ...red })   // comeback + sprint
  addMatch(id, { stake: 100, fee: 16, outcome: 'win', duration: 86400, ...red }) // marathon
  // The clutch and craft set.
  addMatch(id, { stake: 100, fee: 16, outcome: 'win', ...red, clutch: { at75: [-1, 2], trailedLate: [false, false] } })
  addMatch(id, { stake: 300, fee: 36, outcome: 'win', retA: 2, retB: 1.9, ...red, clutch: { at75: [0, 1], trailedLate: [true, false] } })
  addMatch(id, { stake: 200, fee: 32, outcome: 'win', retA: 1.1, retB: 0.9, ...red })
  addMatch(id, { stake: 100, fee: 16, outcome: 'win' })                          // clean sweep: all green
  addMatch(id, { stake: 150, fee: 24, outcome: 'win', tokenRets: [-1, -1, 6] })  // against the odds
  // No Repeat: three straight $50 wins, nine coins, none repeated.
  addMatch(id, { stake: 50, fee: 10, outcome: 'win', tokens: ['N1', 'N2', 'N3'] })
  addMatch(id, { stake: 50, fee: 10, outcome: 'win', tokens: ['N4', 'N5', 'N6'] })
  addMatch(id, { stake: 50, fee: 10, outcome: 'win', tokens: ['N7', 'N8', 'N9'] })
  // The ladder's low rungs. The $10 win deliberately breaks every floored run -
  // the pressure stretch below is built AFTER it, unbroken.
  for (const s of [10, 20, 50, 100, 150]) addMatch(id, { stake: s, fee: s * 0.2, outcome: 'win', ...red })
  // One unbroken 15-win stretch at $200+, against 9 different rivals, walking
  // every remaining rung: Untouchable, Perfect Ten, the whole streak ladder and
  // the top of the stake ladder in one pass. The $5,000 rung is the Leviathan
  // comeback; the $10,000 rung is the all-green Titan.
  const rungs = [200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 7500, 10000, 200, 200, 200, 200]
  rungs.forEach((s, i) => {
    addMatch(id, {
      stake: s, fee: Math.round(s * 2 * 0.05), outcome: 'win', oppName: `rival${i % 9}`,
      ...(s === 5000 ? { ...red, clutch: { at75: [-2, 1], trailedLate: [false, false] } }
        : s === 10000 ? {} // default per-token rets: all green -> Titan
          : red),
    })
  })
  // Volume up to 500 battles.
  while (db.prepare('SELECT COUNT(*) c FROM matches WHERE user_a = ? AND training = 0').get(id).c < 500) {
    addMatch(id, { stake: 100, fee: 16, outcome: 'loss' })
  }
  db.prepare('UPDATE users SET training_done = 1 WHERE id = ?').run(id)
  for (let i = 0; i < 3; i++) addTourney(id, { stake: 100, feePct: 8, rank: 1, prize: 400 })
  return id
}

const u6 = maxPlayer('everything')
view = achievementsFor(u6)
assert(view.earnedCount === view.total, `a maxed player earns all ${view.total} achievements`)

const catalogueTotal = view.achievements.reduce((a, x) => a + x.reward, 0)
log(`catalogue pays at most $${catalogueTotal} over a lifetime`)

// Claim the lot, repeatedly, until nothing more will go through. Measured as a
// DELTA, so whatever else the fixture left in the balance cannot pass for
// achievement money.
const balBeforeClaims = balanceOf(u6)
let guard = 0
for (;;) {
  const claimable = achievementsFor(u6).achievements.filter((a) => a.claimable)
  if (!claimable.length || ++guard > 100) break
  for (const a of claimable) claimAchievement(u6, a.key)
}
const fees6 = feesPaidBy(u6)
const paid6 = rewardsPaidTo(u6)
assert(near(paid6, catalogueTotal), `every achievement was claimable and paid ($${paid6})`)
assert(paid6 <= rebateFor(u6).allowance + 0.005, 'total paid stays inside the allowance')
assert(fees6 - paid6 > 0, `THE HOUSE IS UP on this player: $${fees6.toFixed(2)} in fees vs $${paid6.toFixed(2)} paid back`)
assert(near(balanceOf(u6) - balBeforeClaims, paid6), 'the money that reached the player equals the ledger, to the cent')
assert(rebateAudit().breaches.length === 0, 'the audit finds no breach across every account that has claimed')

// Lowering the knob AFTER money was paid must not be reported as a breach: those
// claims were legal at the rate in force, and the house is still up on the
// player. It is the allowance that moved, not the guarantee.
setSetting('achieveRebatePct', 5)
const lowered = rebateAudit()
assert(lowered.breaches.length === 0, 'cutting the rebate rate later raises no breach - the guarantee is about fees, not the current rate')
assert(lowered.overAllowance.length > 0, '...but the audit does flag those accounts separately, as history rather than as an alarm')
assert(feesPaidBy(u6) - rewardsPaidTo(u6) > 0, '...and the house is still up on them')
assert(achievementsFor(u6).rewards.available === 0, 'a player past the new allowance simply has no balance left - never a negative one')
setSetting('achieveRebatePct', 25)

// Fuzz: random histories, random claim orders, hostile ratios. The invariant is
// asserted after EVERY single claim, not just at the end - a design that only
// holds when the dust settles is not the guarantee that was asked for.
const RATIOS = [40, 25, 5, 50, 90, 500, 0] // 40 first: the rate that actually ships
let claims = 0
for (let run = 0; run < 60; run++) {
  const id = newUser(`fuzz${run}`)
  setSetting('achieveRebatePct', RATIOS[run % RATIOS.length])

  const nMatches = 1 + Math.floor(Math.random() * 40)
  for (let i = 0; i < nMatches; i++) {
    const stake = [10, 100, 1000, 5000][Math.floor(Math.random() * 4)]
    addMatch(id, {
      mode: Math.random() < 0.5 ? 'live' : 'classic',
      stake,
      fee: Math.round(stake * 2 * 0.08 * 100) / 100,
      outcome: ['win', 'loss', 'draw'][Math.floor(Math.random() * 3)],
      training: Math.random() < 0.15 ? 1 : 0,
      duration: [300, 900, 3600, 86400][Math.floor(Math.random() * 4)],
      tokens: [`T${run}`, `U${i % 7}`, 'AAA'],
    })
  }
  if (Math.random() < 0.5) addTourney(id, { rank: Math.random() < 0.4 ? 1 : 3 })

  // Claim in a shuffled order, over and over, so no ordering is privileged.
  const keys = achievementsFor(id).achievements.map((a) => a.key)
  for (let pass = 0; pass < 3; pass++) {
    for (const key of keys.sort(() => Math.random() - 0.5)) {
      const res = claimAchievement(id, key)
      if (res.ok) claims++
      const fees = feesPaidBy(id)
      const paid = rewardsPaidTo(id)
      const { allowance } = rebateFor(id)
      check(paid <= allowance + 0.005, `run ${run}: rewards $${paid} exceeded allowance $${allowance}`)
      check(paid <= fees, `run ${run}: rewards $${paid} exceeded fees paid $${fees} - THE HOUSE IS DOWN`)
      check(paid === 0 || fees - paid > 0, `run ${run}: house not up on a player who was paid`)
      check(near(balanceOf(id), paid), `run ${run}: balance $${balanceOf(id)} drifted from ledger $${paid}`)
    }
  }
}
assert(true, `fuzz: 60 random players, ${claims} successful claims, invariant held after every one`)

// Every player in the database, checked one final time from a clean read, at the
// rate the arena actually ships with.
setSetting('achieveRebatePct', 40)
const everyone = db.prepare('SELECT id FROM users').all()
let worst = Infinity
for (const { id } of everyone) {
  const fees = feesPaidBy(id)
  const paid = rewardsPaidTo(id)
  if (paid > 0) worst = Math.min(worst, fees - paid)
  check(paid <= fees, `user ${id}: paid $${paid} against $${fees} of fees`)
}
assert(worst === Infinity || worst > 0,
  `across all ${everyone.length} accounts, the thinnest margin the house kept is $${worst === Infinity ? 'n/a' : worst.toFixed(2)} - never negative`)
assert(rebateAudit().breaches.length === 0, 'final audit: zero breaches')

log(process.exitCode ? 'FAILURES ABOVE' : 'all good')
