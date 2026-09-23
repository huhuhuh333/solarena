import React, { useEffect } from 'react'
import { useApp } from '../engine/store'
import { Section } from '../components/ui'
import { replayTour } from '../components/tour'

/* Rules & safety, in one place. Everything stated here mirrors what the server
   actually enforces (server/rules.js, server/duel.js) - if a rule changes in
   code, this page is the other place to touch. The fee table is not a copy at
   all: it renders the live fee tiers from /api/config. */

const SECTIONS = [
  ['battle-rules', 'Battle Rules'],
  ['fees', 'Fees'],
  ['eligibility', 'Token Eligibility'],
  ['fair-play', 'Fair Play'],
  ['risk', 'Risk Disclosure'],
]

export default function Rules({ params }) {
  const app = useApp()
  const section = params?.[0]

  useEffect(() => {
    if (section) document.getElementById('rul-' + section)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [section])

  // Live fee bands: each key is the smallest stake paying that rate. The band's
  // upper edge is the largest stake on the ladder below the next band's key.
  const tiers = app.config.feeTiers || {}
  const stakes = app.config.stakes?.length ? app.config.stakes : [10, 20, 50, 100, 150, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 7500, 10000]
  const bands = Object.keys(tiers).map(Number).filter(Number.isFinite).sort((a, b) => a - b)
  const bandRows = bands.map((b, i) => {
    const next = bands[i + 1]
    const below = next ? stakes.filter((s) => s < next) : []
    return { from: b, to: next ? below[below.length - 1] : null, pct: tiers[b] }
  })

  return (
    <Section eyebrow="How the arena is run" title="Rules & Safety">
      <div className="rul-toc">
        {SECTIONS.map(([id, label]) => (
          <a key={id} href={`/rules/${id}`} className={section === id ? 'on' : ''}>{label}</a>
        ))}
        {/* Anyone who skipped the intro and then came looking for the rules is
            exactly the person who wants it back. */}
        <button type="button" onClick={replayTour}>Replay the intro</button>
      </div>

      <div className="card" id="rul-battle-rules">
        <div className="card-title">Battle Rules</div>
        <ul className="rul-list">
          <li>Every battle is 1v1: same stake, same duration, both players against the market and each other.</li>
          <li>Every battle is fought on the same battlefield: Solana memecoins. The arena reads Jupiter's verified token list and its live trading feeds and carries the strongest memecoin markets - ranked by depth against real turnover, so a coin nobody trades never appears, and a new one that starts trading often does within minutes. No human picks the list, and no coin buys its way onto it.</li>
          <li>You pick exactly 3 different tokens and split your portfolio between them any way you like - the split must total exactly 100%, and every coin needs more than 0%.</li>
          <li>Degen Approved tokens are Classic-only, need battles of 15 minutes or longer, and can carry at most 50% of a portfolio.</li>
          <li>In Live Arena, every slice is priced as a market trade - so each slice must clear the venue minimum (about $1). On small stakes that sets a minimum percentage per coin; the pick terminal tells you the exact number.</li>
          <li>Picks stay hidden until both players lock. Both portfolios are priced from one shared set of start prices, captured at battle start.</li>
          <li>The higher portfolio return when the clock runs out wins. A margin under 0.05 percentage points is a draw: stakes are returned and the fee is waived.</li>
          <li>Classic pays a fixed prize - the pool minus the fee, known before you enter. Live pays the winner both portfolios at their final market value, in the coins themselves.</li>
          <li>If the price source goes down for 90 seconds during a battle, the battle is voided and stakes come back in full. Leaving during the pick phase also refunds both players, no penalty.</li>
        </ul>
      </div>

      <div className="card" id="rul-fees">
        <div className="card-title">Fees</div>
        <p className="small muted">One fee, charged on the pool at entry, tiered by stake. These numbers render from the live configuration - what you see here is what the server charges.</p>
        <table className="table" style={{ maxWidth: 480 }}>
          <thead><tr><th>Stake</th><th style={{ textAlign: 'right' }}>Fee (of the pool)</th></tr></thead>
          <tbody>
            {bandRows.map((r) => (
              <tr key={r.from}>
                <td>${r.from.toLocaleString()}{r.to != null && r.to !== r.from ? ` - $${r.to.toLocaleString()}` : r.to == null ? ' and up' : ''}</td>
                <td className="num" style={{ textAlign: 'right' }}>{r.pct}%</td>
              </tr>
            ))}
          </tbody>
        </table>
        <ul className="rul-list">
          <li>Draws waive the fee - both stakes go back in full.</li>
          <li>Free Battles (training) cost nothing and touch nothing.</li>
          <li>Live Arena prices trades like the real market, so roughly 0.3% per side of simulated swap cost is reflected in portfolio values - it is part of the market, not a platform fee.</li>
        </ul>
      </div>

      <div className="card" id="rul-eligibility">
        <div className="card-title">Token Eligibility</div>
        <ul className="rul-list">
          <li><b>Arena Verified</b> - passed automated safety scans (honeypot, taxes, liquidity, holders). Playable at any size in both arenas. In Live Arena a large order on a thin market pays its estimated price impact, disclosed before you lock - exactly like on any trading terminal.</li>
          <li><b>Degen Approved</b> - migrated and tradable, but riskier: Classic Arena only, 15-minute-plus battles, max 50% of a portfolio.</li>
          <li><b>Fresh Launch</b> - too new to trust with money, or still on its launchpad bonding curve. Free Battles only, until it earns Degen status.</li>
          <li><b>Suspended / Ineligible</b> - failed or lost a safety check. Not playable, anywhere.</li>
          <li>Live Arena has one extra gate: the treasury must actually be able to buy the token on-chain, and the reachable market depth caps how big a Live battle it can back. A token no venue can execute never enters Live, however good it looks.</li>
        </ul>
        <p className="small muted">The full live list, with per-token status, liquidity and depth guidance, is on the <a href="/tokens">Tokens</a> page.</p>
      </div>

      <div className="card" id="rul-fair-play">
        <div className="card-title">Fair Play</div>
        <ul className="rul-list">
          <li>Picks stay hidden until both players lock - nobody counter-picks.</li>
          <li>Both portfolios start from the same captured prices, at the same moment.</li>
          <li>Battles settle on a 30-reading time-weighted average price, never a single print - a last-second wick cannot decide a match.</li>
          <li>Degen tokens require longer battles precisely because thin coins are easiest to push around in short windows.</li>
          <li>Extreme results (over ±25%) are automatically flagged for review.</li>
          <li>Every pick, config and result is validated on the server. Nothing the browser sends is trusted.</li>
        </ul>
      </div>

      <div className="card" id="rul-risk">
        <div className="card-title">Risk Disclosure</div>
        <ul className="rul-list">
          <li>Crypto assets are volatile. You can lose your entire stake in any battle - that is the game, and it is only play credits.</li>
          <li>Live Arena follows the market: the final pool moves with live prices and includes simulated swap costs. It can end above or below the starting pool.</li>
          <li>A token can crash, freeze or lose its market during a battle. In Classic that risk is yours against your opponent's; Live is restricted to tokens the treasury can actually trade, but no restriction removes market risk.</li>
          <li><b>SolArena is free to play.</b> Balances are play credits: they cost nothing, cannot be deposited, bought, sold or withdrawn, and have no cash value.</li>
          <li>Nothing here is financial advice. Battles are entertainment between players - play for fun.</li>
        </ul>
      </div>
    </Section>
  )
}
