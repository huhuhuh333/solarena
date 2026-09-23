// Achievements - badges players earn from the record, and a cash rebate that is
// paid out of the fees THAT SAME PLAYER already handed the arena.
//
// The one rule this whole module exists to enforce:
//
//   for every player:  SUM(rewards paid)  <=  RATIO * SUM(fees they paid),  RATIO < 1
//
// so the arena can never end up down on anyone through achievements. It is not
// a promise made by the catalogue below being carefully priced - it is a gate
// every single dollar goes through, checked inside the same transaction that
// moves the money. Add a reckless achievement tomorrow and the gate still holds:
// the worst it can do is refuse to pay.
//
// Two properties of the surrounding system make the guarantee real rather than
// approximate, and both were verified before this was written:
//
//   * the fee base is APPEND-ONLY. Nothing in the codebase deletes or rewrites a
//     settled `matches` / `tourneys` row, so fees already paid can never shrink
//     out from under a reward that was justified by them.
//   * the reward ledger is the `achievements` table itself, whose primary key
//     makes a double claim impossible.
//
// Everything here counts CONSERVATIVELY. Where it was unclear whether a dollar
// really stayed with the house, it is left out of the fee base - a smaller base
// means smaller rebates, which is the safe direction to be wrong in.

import { db, getSetting, credit, txn, adminLog } from './db.js'

// ---------------------------------------------------------------------------
// The fee base: what the house actually KEPT from this player
// ---------------------------------------------------------------------------
//
// Counted:
//   1v1 battles   - the player's half of the pool fee (both sides pay half).
//   tournaments   - stake * fee_pct/100, which is exactly this player's share
//                   of the pot fee (fee = n*stake*pct/100, so fee/n = that).
//
// NOT counted, on purpose:
//   training battles      - fee is zero, nothing was taken.
//   CLASSIC DRAWS         - duel.js returns both stakes in full and waives the
//                           fee, so no dollar was collected. (Live draws DO pay:
//                           there the fee is taken from the entry before any
//                           coin is bought, whatever the outcome - which is why
//                           the exclusion is narrowed to classic.)
//   deposit/withdraw fees - those are flat NETWORK fees; they pay sweep and
//                           payout gas, they are not arena revenue.
//   swap cost (0.3%/side) - goes to the DEX, not to the house.
//   price impact          - kept by the house, but as the buffer that absorbs
//                           the real fill. Treating it as profit would be
//                           spending money that is already spoken for.
//   unsettled tournaments - only status 'done' rows; a cancelled lobby refunds.
const MATCH_FEES_SQL = `
  SELECT COALESCE(SUM(
    CASE
      WHEN training = 1 THEN 0
      WHEN mode = 'classic' AND outcome_a = 'draw' THEN 0
      ELSE fee / 2.0
    END
  ), 0) AS s
  FROM matches WHERE user_a = ? OR user_b = ?`

const TOURNEY_FEES_SQL = `
  SELECT COALESCE(SUM(t.stake * t.fee_pct / 100.0), 0) AS s
  FROM tourney_players tp JOIN tourneys t ON t.id = tp.tourney_id
  WHERE tp.user_id = ? AND t.status = 'done'`

export const feesPaidBy = (userId) => {
  const a = db.prepare(MATCH_FEES_SQL).get(userId, userId)?.s ?? 0
  const b = db.prepare(TOURNEY_FEES_SQL).get(userId)?.s ?? 0
  return Math.round((a + b) * 100) / 100
}

export const rewardsPaidTo = (userId) =>
  Math.round((db.prepare('SELECT COALESCE(SUM(reward), 0) s FROM achievements WHERE user_id = ?')
    .get(userId)?.s ?? 0) * 100) / 100

// The setting is clamped here, not just documented. A fat-fingered 500 in the
// admin panel must not be able to turn the rebate into a loss, so the value the
// maths actually uses can never reach 1.0 whatever the database says.
const RATIO_MAX_PCT = 90
export const rebateRatio = () => {
  const pct = Number(getSetting('achieveRebatePct'))
  if (!Number.isFinite(pct) || pct <= 0) return 0
  return Math.min(pct, RATIO_MAX_PCT) / 100
}

// Cents, always rounded DOWN - float noise then costs the player a cent rather
// than costing the house one.
const floorCents = (n) => Math.floor(n * 100) / 100

// The full picture of a player's rebate account.
export const rebateFor = (userId) => {
  const feeBase = feesPaidBy(userId)
  const ratio = rebateRatio()
  const allowance = floorCents(feeBase * ratio)
  const paid = rewardsPaidTo(userId)
  return { feeBase, ratio, allowance, paid, room: Math.max(0, floorCents(allowance - paid)) }
}

// ---------------------------------------------------------------------------
// The record a badge is judged against
// ---------------------------------------------------------------------------
//
// Every test below is MONOTONIC - counts, maximums, best-ever streaks, and
// "has ever done X". None of them can go from true back to false, so an earned
// badge never un-earns itself and a claim can never be justified by a fact that
// later evaporates.
const statsFor = (userId) => {
  const rows = db.prepare(`SELECT mode, stake, duration, training, user_a, user_b,
                                  name_a, name_b, ret_a, ret_b, outcome_a,
                                  payout_a, payout_b, data
                           FROM matches WHERE user_a = ? OR user_b = ? ORDER BY ts ASC`)
    .all(userId, userId)

  const st = {
    battles: 0, wins: 0, losses: 0, draws: 0,
    classic: 0, live: 0, training: 0,
    streak: 0, bestStreak: 0, comeback: false,
    maxStake: 0, biggestWin: 0,
    sprintWin: false, marathonWin: false,
    tokens: new Set(),
    tourneys: 0, titles: 0, inMoney: 0,
    trainingDone: !!db.prepare('SELECT training_done FROM users WHERE id = ?').get(userId)?.training_done,
    // Stake-floored win runs (the "pressure" ladder). A best is kept per floor;
    // the diversity-gated ones also carry a sticky earned flag, because "N in a
    // row against M different players" is not expressible as one number.
    best20: 0, best50: 0, best100: 0, best200: 0,
    perfectTen: false, untouchable: false, noRepeat: false,
    // Clutch facts, derived from the clutch block duel.js writes at settlement.
    // Rows from before that instrumentation simply never satisfy them.
    comebackKing: false, lastMinuteHero: false, leviathan: false,
    // Craft-of-the-win facts, from the per-token returns in the match record.
    photoFinish: false, cleanSweep: false, againstOdds: false, titan: false,
    // The stake ladder: every distinct table this player has WON at.
    winStakes: new Set(), win500: false, win1000: false, win3000: false,
  }

  let lossRun = 0
  // Current run state per floor: length lives on `run`, and the diversity
  // clauses need the identities inside the run, not just its length.
  const run = { 20: 0, 50: 0, 100: 0, 200: 0 }
  const opps100 = [], opps200 = [] // opponent identity per win of the current run
  const coins50 = []               // my three tokenIds per win of the current 50-run

  for (const r of rows) {
    const iAmA = r.user_a === userId
    const outcome = iAmA ? r.outcome_a
      : r.outcome_a === 'win' ? 'loss' : r.outcome_a === 'loss' ? 'win' : 'draw'

    let data = {}
    try { data = JSON.parse(r.data) } catch { /* legacy row */ }
    const myTokens = (iAmA ? data.tokensA : data.tokensB) || []
    // Picks count from every battle including training - a badge for breadth of
    // research shouldn't care whether money was on the table.
    for (const p of myTokens) if (p?.tokenId) st.tokens.add(p.tokenId)

    if (r.training) { st.training++; continue }

    st.battles++
    st[r.mode === 'live' ? 'live' : 'classic']++
    st.maxStake = Math.max(st.maxStake, r.stake)

    // Who was on the other side. Paid battles are always human-vs-human, so the
    // id is there; the name is a fallback for anything older or odder - names
    // are unique, so it still counts diversity honestly.
    const oppKey = (iAmA ? r.user_b : r.user_a) ?? String(iAmA ? r.name_b : r.name_a).toLowerCase()

    // The floored runs. A loss breaks every run; a win below a floor breaks
    // THAT floor's run (those N wins were not all at the stake the badge names);
    // a draw leaves runs alone, exactly as it leaves the plain streak alone.
    for (const floor of [20, 50, 100, 200]) {
      if (outcome === 'win' && r.stake >= floor) run[floor]++
      else if (outcome !== 'draw') run[floor] = 0
    }
    if (outcome === 'win' && r.stake >= 100) opps100.push(oppKey); else if (outcome !== 'draw') opps100.length = 0
    if (outcome === 'win' && r.stake >= 200) opps200.push(oppKey); else if (outcome !== 'draw') opps200.length = 0
    if (outcome === 'win' && r.stake >= 50) coins50.push(myTokens.map((t) => t?.tokenId).filter(Boolean))
    else if (outcome !== 'draw') coins50.length = 0

    st.best20 = Math.max(st.best20, run[20])
    st.best50 = Math.max(st.best50, run[50])
    st.best100 = Math.max(st.best100, run[100])
    st.best200 = Math.max(st.best200, run[200])
    if (run[100] >= 10 && new Set(opps100.slice(-10)).size >= 5) st.perfectTen = true
    if (run[200] >= 15 && new Set(opps200.slice(-15)).size >= 8) st.untouchable = true
    if (run[50] >= 3) {
      const nine = coins50.slice(-3).flat()
      if (nine.length === 9 && new Set(nine).size === 9) st.noRepeat = true
    }

    if (outcome === 'win') {
      st.wins++
      // A comeback is a win that ENDS a losing run of three or more. Checked
      // before the run is cleared, obviously.
      if (lossRun >= 3) st.comeback = true
      lossRun = 0
      st.streak++
      st.bestStreak = Math.max(st.bestStreak, st.streak)
      st.biggestWin = Math.max(st.biggestWin, (iAmA ? r.payout_a : r.payout_b) - r.stake)
      if (r.duration <= 300) st.sprintWin = true
      if (r.duration >= 86400) st.marathonWin = true

      st.winStakes.add(r.stake)
      if (r.stake === 500) st.win500 = true
      if (r.stake === 1000) st.win1000 = true
      if (r.stake >= 3000) st.win3000 = true

      // Craft of the win: how the three coins actually finished.
      const allUp = myTokens.length === 3 && myTokens.every((t) => t?.ret > 0)
      const downs = myTokens.filter((t) => t?.ret < 0).length
      if (r.stake >= 100 && allUp) st.cleanSweep = true
      if (r.stake >= 10000 && allUp) st.titan = true
      if (r.stake >= 150 && downs >= 2) st.againstOdds = true
      const myRet = iAmA ? r.ret_a : r.ret_b
      const oppRet = iAmA ? r.ret_b : r.ret_a
      if (r.stake >= 200 && Number.isFinite(myRet) && Number.isFinite(oppRet)
          && Math.abs(myRet - oppRet) <= 0.25) st.photoFinish = true

      // Came from behind, as the record tells it.
      const at75 = data.clutch?.at75
      if (at75 && at75[iAmA ? 0 : 1] < at75[iAmA ? 1 : 0]) {
        if (r.stake >= 100) st.comebackKing = true
        if (r.stake >= 5000) st.leviathan = true
      }
      if (r.stake >= 300 && data.clutch?.trailedLate?.[iAmA ? 0 : 1]) st.lastMinuteHero = true
    } else if (outcome === 'loss') {
      st.losses++
      st.streak = 0
      lossRun++
    } else {
      // Draws leave both runs alone, exactly as the profile's stats do - a draw
      // is not a defeat and it does not break a streak.
      st.draws++
    }
  }

  const trows = db.prepare(`SELECT tp.rank, tp.prize, tp.picks FROM tourney_players tp
                            JOIN tourneys t ON t.id = tp.tourney_id
                            WHERE tp.user_id = ? AND t.status = 'done'`).all(userId)
  for (const r of trows) {
    st.tourneys++
    if (r.rank === 1) st.titles++
    if (r.prize > 0) st.inMoney++
    try { for (const p of JSON.parse(r.picks) || []) if (p?.tokenId) st.tokens.add(p.tokenId) } catch { /* legacy row */ }
  }

  return st
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------
//
// `reward` is a fixed dollar figure, deliberately small next to the fee flow the
// milestone implies - the point is that the gate is rarely what stops a claim,
// so the badge feels earned rather than withheld. Roughly: a milestone should be
// claimable at, or shortly after, the battle that unlocks it.
//
// A reward of 0 is a pure badge. There is nothing to claim and nothing to gate,
// which is why the cheap end of the ladder is free: a player's very first battle
// has not yet paid for a rebate, and pretending otherwise would mean showing
// them a locked reward on day one.
//
// `need`/`have` drive the progress bar; both are plain numbers so the client
// never re-implements a rule.
const list = (st) => [
  // ---- getting started ----
  { key: 'first-battle', group: 'Arena', icon: '🎯', name: 'Step Into The Ring', reward: 0,
    desc: 'Fight your first real-money battle.', have: st.battles, need: 1 },
  { key: 'graduate', group: 'Arena', icon: '🎓', name: 'Graduate', reward: 0,
    desc: 'Finish the training battle.', have: st.trainingDone ? 1 : 0, need: 1 },
  { key: 'first-blood', group: 'Arena', icon: '🩸', name: 'First Blood', reward: 1,
    desc: 'Win your first battle.', have: st.wins, need: 1 },

  // ---- volume ----
  { key: 'ten-battles', group: 'Arena', icon: '⚔️', name: 'Regular', reward: 2,
    desc: 'Fight 10 battles.', have: st.battles, need: 10 },
  { key: 'fifty-battles', group: 'Arena', icon: '🛡️', name: 'Veteran', reward: 8,
    desc: 'Fight 50 battles.', have: st.battles, need: 50 },
  { key: 'century', group: 'Arena', icon: '💯', name: 'Century', reward: 20,
    desc: 'Fight 100 battles.', have: st.battles, need: 100 },
  { key: 'five-hundred', group: 'Arena', icon: '👑', name: 'Arena Fixture', reward: 100,
    desc: 'Fight 500 battles.', have: st.battles, need: 500 },

  // ---- skill ----
  { key: 'streak-3', group: 'Skill', icon: '🔥', name: 'Hat Trick', reward: 2,
    desc: 'Win 3 battles in a row.', have: st.bestStreak, need: 3 },
  { key: 'streak-5', group: 'Skill', icon: '🔥', name: 'On Fire', reward: 6,
    desc: 'Win 5 battles in a row.', have: st.bestStreak, need: 5 },
  { key: 'streak-10', group: 'Skill', icon: '☄️', name: 'Unstoppable', reward: 25,
    desc: 'Win 10 battles in a row.', have: st.bestStreak, need: 10 },
  { key: 'comeback', group: 'Skill', icon: '📈', name: 'Comeback', reward: 3,
    desc: 'Win a battle straight after losing three.', have: st.comeback ? 1 : 0, need: 1 },

  // ---- pressure: streaks with real money on the table ----
  // The diversity-gated ones cap `have` one under `need` until the whole
  // condition holds, because earned is derived as have >= need and "10 in a row
  // against 5 players" is not one number.
  { key: 'threepeat', group: 'Pressure', icon: '🎳', name: 'Threepeat', reward: 4,
    desc: 'Win 3 in a row at $20+ stakes.', have: st.best20, need: 3 },
  { key: 'five-alive', group: 'Pressure', icon: '🖐️', name: 'Five Alive', reward: 15,
    desc: 'Win 5 in a row at $50+ stakes.', have: st.best50, need: 5 },
  { key: 'perfect-ten', group: 'Pressure', icon: '🔟', name: 'Perfect Ten', reward: 40,
    desc: 'Win 10 in a row at $100+ stakes, against at least 5 different players.',
    have: st.perfectTen ? 10 : Math.min(st.best100, 9), need: 10 },
  { key: 'untouchable', group: 'Pressure', icon: '👻', name: 'Untouchable', reward: 100,
    desc: 'Win 15 in a row at $200+ stakes, against at least 8 different players.',
    have: st.untouchable ? 15 : Math.min(st.best200, 14), need: 15 },

  // ---- clutch: wins the record says were in doubt ----
  { key: 'comeback-king', group: 'Clutch', icon: '👑', name: 'Comeback King', reward: 5,
    desc: 'Win a $100+ battle you were losing at the 75% mark.', have: st.comebackKing ? 1 : 0, need: 1 },
  { key: 'last-minute-hero', group: 'Clutch', icon: '⏳', name: 'Last-Minute Hero', reward: 10,
    desc: 'Win a $300+ battle you were losing inside the final 10%.', have: st.lastMinuteHero ? 1 : 0, need: 1 },
  { key: 'photo-finish', group: 'Clutch', icon: '📸', name: 'Photo Finish', reward: 8,
    desc: 'Win a $200+ battle by 0.25% or less.', have: st.photoFinish ? 1 : 0, need: 1 },

  // ---- the two arenas ----
  { key: 'live-debut', group: 'Arenas', icon: '⚡', name: 'Live Debut', reward: 0,
    desc: 'Play your first Live Arena battle.', have: st.live, need: 1 },
  { key: 'live-25', group: 'Arenas', icon: '⚡', name: 'Live Wire', reward: 12,
    desc: 'Play 25 Live Arena battles.', have: st.live, need: 25 },
  { key: 'classic-25', group: 'Arenas', icon: '♟️', name: 'Classicist', reward: 8,
    desc: 'Play 25 Classic Arena battles.', have: st.classic, need: 25 },

  // ---- tournaments ----
  { key: 'tourney-debut', group: 'Tournaments', icon: '🎪', name: 'Take A Seat', reward: 0,
    desc: 'Enter your first tournament.', have: st.tourneys, need: 1 },
  { key: 'tourney-title', group: 'Tournaments', icon: '🏆', name: 'Title', reward: 5,
    desc: 'Win a tournament outright.', have: st.titles, need: 1 },
  { key: 'tourney-triple', group: 'Tournaments', icon: '🏆', name: 'Triple Crown', reward: 20,
    desc: 'Win three tournaments.', have: st.titles, need: 3 },

  // ---- size ----
  { key: 'high-roller', group: 'Stakes', icon: '💵', name: 'High Roller', reward: 10,
    desc: 'Play a battle at $1,000 or above.', have: st.maxStake, need: 1000 },
  { key: 'whale', group: 'Stakes', icon: '🐋', name: 'Whale', reward: 50,
    desc: 'Play a battle at $5,000 or above.', have: st.maxStake, need: 5000 },
  // The ladder proper: WINS, table by table. Distinct stake levels won at,
  // then the named rungs on the way up.
  { key: 'stake-explorer', group: 'Stakes', icon: '🗺️', name: 'Stake Explorer', reward: 15,
    desc: 'Win at 5 different stake levels.', have: st.winStakes.size, need: 5 },
  { key: 'stake-master', group: 'Stakes', icon: '🧭', name: 'Stake Master', reward: 60,
    desc: 'Win at 10 different stake levels.', have: st.winStakes.size, need: 10 },
  { key: 'full-ladder', group: 'Stakes', icon: '🪜', name: 'Full Ladder', reward: 250,
    desc: 'Win at all 16 stake levels.', have: st.winStakes.size, need: 16 },
  { key: 'five-hundred-club', group: 'Stakes', icon: '💰', name: 'Five Hundred Club', reward: 20,
    desc: 'Win a battle at the $500 table.', have: st.win500 ? 1 : 0, need: 1 },
  { key: 'four-figures', group: 'Stakes', icon: '🏦', name: 'Four Figures', reward: 30,
    desc: 'Win a battle at the $1,000 table.', have: st.win1000 ? 1 : 0, need: 1 },
  { key: 'whale-slayer', group: 'Stakes', icon: '🐳', name: 'Whale Slayer', reward: 60,
    desc: 'Win a battle at $3,000 or above.', have: st.win3000 ? 1 : 0, need: 1 },
  { key: 'leviathan', group: 'Stakes', icon: '🐉', name: 'Leviathan', reward: 100,
    desc: 'Win a $5,000+ battle you were losing at the 75% mark.', have: st.leviathan ? 1 : 0, need: 1 },
  { key: 'titan', group: 'Stakes', icon: '🗿', name: 'Titan', reward: 150,
    desc: 'Win a $10,000 battle with all three of your coins in the green.', have: st.titan ? 1 : 0, need: 1 },

  // ---- craft ----
  { key: 'sprint-win', group: 'Craft', icon: '⏱️', name: 'Sniper', reward: 2,
    desc: 'Win a 5-minute battle.', have: st.sprintWin ? 1 : 0, need: 1 },
  { key: 'marathon-win', group: 'Craft', icon: '🌙', name: 'Diamond Hands', reward: 3,
    desc: 'Win a 24-hour battle.', have: st.marathonWin ? 1 : 0, need: 1 },
  { key: 'scout', group: 'Craft', icon: '🔭', name: 'Scout', reward: 5,
    desc: 'Pick 25 different tokens.', have: st.tokens.size, need: 25 },
  { key: 'clean-sweep', group: 'Craft', icon: '🧹', name: 'Clean Sweep', reward: 5,
    desc: 'Win a $100+ battle with all three of your coins in the green.', have: st.cleanSweep ? 1 : 0, need: 1 },
  { key: 'against-the-odds', group: 'Craft', icon: '🎲', name: 'Against The Odds', reward: 7,
    desc: 'Win a $150+ battle with two of your three coins in the red.', have: st.againstOdds ? 1 : 0, need: 1 },
  { key: 'no-repeat', group: 'Craft', icon: '🔁', name: 'No Repeat', reward: 6,
    desc: 'Win 3 in a row at $50+ without repeating a single coin.', have: st.noRepeat ? 1 : 0, need: 1 },
]

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

// Everything the achievements screen needs, in one shot.
export const achievementsFor = (userId) => {
  const st = statsFor(userId)
  const claimed = new Map(db.prepare('SELECT key, ts, reward FROM achievements WHERE user_id = ?')
    .all(userId).map((r) => [r.key, r]))
  const rebate = rebateFor(userId)

  // Each reward is measured against the WHOLE remaining balance, because each
  // one really is claimable right now. Two that fit separately but not together
  // are both offered, and the first claim takes the room - which is why the
  // screen shows the balance itself, rather than pretending the rewards are
  // independent of each other.
  const room = rebate.room
  const items = list(st).map((a) => {
    const got = claimed.get(a.key)
    const earned = a.have >= a.need
    // What it would take in fees for this specific reward to become payable.
    // Shown rather than hidden: "keep playing" is a worse answer than a number.
    const shortBy = got || !earned || !a.reward ? 0
      : Math.max(0, Math.round((a.reward - room) * 100) / 100)
    const claimable = !got && earned && a.reward > 0 && shortBy === 0
    return {
      key: a.key, group: a.group, icon: a.icon, name: a.name, desc: a.desc,
      reward: a.reward, have: a.have, need: a.need,
      earned, claimed: !!got, claimedAt: got?.ts ?? null, paid: got?.reward ?? null,
      claimable, shortBy,
      // True when the ONLY thing standing between the player and this reward is
      // balance. The screen needs to tell that apart from "not earned yet"; it
      // does not need to know why the balance is what it is.
      waiting: !got && earned && a.reward > 0 && shortBy > 0,
      // No amount of play releases it while rewards are switched off, so the
      // screen must not imply that more battles would.
      paused: rebate.ratio <= 0,
    }
  })

  return {
    achievements: items,
    // What the player is shown, and deliberately ALL they are shown. The fee
    // base and the rate behind `allowance` are house-side accounting: serving
    // them would put the whole mechanic in any browser's network tab, which is
    // the thing this shape exists to avoid. Admins get the full picture from
    // rebateAudit() instead.
    rewards: {
      unlocked: rebate.allowance,   // total reward balance earned to date
      claimed: rebate.paid,
      available: rebate.room,
    },
    earnedCount: items.filter((a) => a.earned).length,
    claimableCount: items.filter((a) => a.claimable).length,
    total: items.length,
  }
}

// The public half: badges only, no money. A profile shows what someone has
// achieved, never what the arena paid them or what they paid in fees.
export const publicBadgesFor = (userId) => {
  const st = statsFor(userId)
  return list(st).filter((a) => a.have >= a.need)
    .map((a) => ({ key: a.key, icon: a.icon, name: a.name, desc: a.desc }))
}

// ---------------------------------------------------------------------------
// Claiming - the gate
// ---------------------------------------------------------------------------

class NoRoom extends Error {
  constructor(reward, room) { super('not enough fee headroom'); this.reward = reward; this.room = room }
}

// Pays an achievement's reward, or explains why it cannot yet.
//
// Order inside the transaction matters and is deliberate:
//   1. insert the claim row  - the primary key settles any race here, before a
//                              single dollar has moved
//   2. re-read the ledger    - fees and rewards are both read INSIDE the
//                              transaction, so the numbers the gate judges are
//                              the numbers the credit is written against
//   3. gate                  - short of room throws, which rolls 1 back too:
//                              no row, no money, claimable again later
//   4. credit                - only now, and only up to the allowance
export const claimAchievement = (userId, key) => {
  const st = statsFor(userId)
  const def = list(st).find((a) => a.key === key)
  // Earned is re-derived from the record here, server-side. What the client
  // believes it has unlocked is never part of this decision.
  if (!def) return { error: 'Unknown achievement.' }
  if (def.have < def.need) return { error: 'You have not earned that one yet.' }
  if (!(def.reward > 0)) return { error: 'That one is a badge - there is nothing to claim.' }

  try {
    return txn(() => {
      db.prepare('INSERT INTO achievements (user_id, key, ts, reward) VALUES (?, ?, ?, 0)')
        .run(userId, key, Date.now())

      const feeBase = feesPaidBy(userId)
      const paid = rewardsPaidTo(userId) // this row still reads 0
      const room = floorCents(feeBase * rebateRatio() - paid)
      if (room < def.reward) throw new NoRoom(def.reward, Math.max(0, room))

      db.prepare('UPDATE achievements SET reward = ? WHERE user_id = ? AND key = ?')
        .run(def.reward, userId, key)
      // House-granted money names a chain, like every other dollar in this
      // system - credit() puts it on the operator's declared credit chain. The
      // treasury really is holding it: it was collected as fees before it was
      // ever handed back. The player-facing note says none of that.
      credit(userId, def.reward, 'reward', `Achievement reward - ${def.name}`)
      return { ok: true, key, reward: def.reward, name: def.name }
    })
  } catch (e) {
    if (e instanceof NoRoom) {
      // Says what is missing and what grows it, without describing the
      // accounting underneath.
      return {
        error: rebateRatio() <= 0
          ? 'Reward payouts are paused right now - the badge is yours, the cash can be claimed once they are back on.'
          : `${def.name} pays $${e.reward} and your reward balance is $${e.room.toFixed(2)}. `
            + `Keep battling - your balance grows with every battle you fight.`,
        shortBy: Math.round((e.reward - e.room) * 100) / 100,
      }
    }
    // The primary key doing its job: a second claim, or two arriving together.
    if (String(e.message || '').includes('UNIQUE') || String(e.message || '').includes('constraint')) {
      return { error: 'Already claimed.' }
    }
    adminLog('system', `Achievement claim failed for user ${userId} / ${key}: ${e.message}`)
    return { error: 'Could not claim that right now - try again shortly.' }
  }
}

// Admin/ops view: re-checks every account that has ever claimed.
//
// Two different questions, deliberately kept apart:
//
//   breaches      - paid MORE than that player ever paid in fees. This is the
//                   guarantee itself, it is time-independent, and it must always
//                   be empty. Anything here is a genuine bug.
//   overAllowance - paid more than TODAY'S allowance would permit. Expected and
//                   harmless after the operator lowers achieveRebatePct: those
//                   claims were legal under the rate in force when they were
//                   made, and the money is still a fraction of fees collected.
//                   Reporting it as a breach would cry wolf every time the knob
//                   moves, which is exactly how a real alarm gets ignored.
export const rebateAudit = () => {
  const rows = db.prepare('SELECT DISTINCT user_id FROM achievements').all()
  const breaches = []
  const overAllowance = []
  let thinnestMargin = null
  for (const { user_id: id } of rows) {
    const r = rebateFor(id)
    const entry = { userId: id, ...r, margin: Math.round((r.feeBase - r.paid) * 100) / 100 }
    if (r.paid > r.feeBase + 0.005) breaches.push(entry)
    else if (r.paid > r.allowance + 0.005) overAllowance.push(entry)
    if (r.paid > 0 && (thinnestMargin === null || entry.margin < thinnestMargin)) thinnestMargin = entry.margin
  }
  return { checked: rows.length, breaches, overAllowance, thinnestMargin }
}
