import React from 'react'
import { Section } from '../components/ui'

/* Operational terms - every statement here describes what the platform
   actually does (see server/rules.js, server/duel.js, server/wallet.js).
   Deliberately NO invented legal boilerplate: governing law, arbitration and
   similar clauses are the owner's lawyer's job, not this file's. */

export default function Terms() {
  return (
    <Section eyebrow="The deal, plainly" title="Terms of Service">
      <div className="card rul-doc">
        <div className="card-title">1. What SolArena is</div>
        <p>SolArena is a free-to-play, skill-based 1v1 crypto battle game played with play credits that have no cash value. Two players stake the same amount of credits, each builds a 3-token portfolio, and the better-performing portfolio takes the pool under the published <a href="/rules">Battle Rules</a>. Battles are contests between players - SolArena is never your counterparty and does not profit from your result beyond the published fee.</p>

        <div className="card-title">2. Your account</div>
        <p>One account per person. You are responsible for your credentials and everything done with them. We may block accounts that abuse the platform, other players, or these terms.</p>

        <div className="card-title">3. Battles and settlement</div>
        <p>The <a href="/rules">Rules &amp; Safety</a> page is part of these terms. Results settle on time-weighted average prices and are final once paid out. Battles voided by the platform (price-feed loss, cancelled matches, server restarts mid-battle) refund or return holdings as described there - a void is never a loss.</p>

        <div className="card-title">4. Fees</div>
        <p>The only platform fee is the entry fee shown in the live <a href="/rules/fees">fee schedule</a> and displayed before you enter any paid battle. Draws waive it. Fees are paid in play credits.</p>

        <div className="card-title">5. Play credits</div>
        <p>Every balance on SolArena is play credits. They are free, shown in dollars only as a score, and cannot be
          deposited, bought, sold, transferred out or withdrawn - they have no cash value. Play is unlimited: a player
          short of a stake is topped up for free. Live Arena winnings are virtual coin holdings that can be sold back to credits.</p>

        <div className="card-title">6. What is not allowed</div>
        <p>Multi-accounting, colluding with opponents, manipulating token markets to decide battles, exploiting bugs instead of reporting them, automating play, and uploading unlawful or abusive profile images. Doing any of these can void battles, forfeit fees or end the account.</p>

        <div className="card-title">7. Availability</div>
        <p>We may pause arenas, tokens or stakes at any time - safety gates do this automatically. Anything in flight when that happens resolves under the void rules, never by taking your stake.</p>

        <div className="card-title">8. No promises</div>
        <p>The service is provided as-is. Crypto assets are volatile and no outcome is guaranteed - see the <a href="/rules/risk">Risk Disclosure</a>. Nothing on SolArena is financial advice.</p>

        <div className="card-title">9. Changes</div>
        <p>These terms can change as the product does. Material changes will be visible here; continuing to play after a change means accepting it.</p>
      </div>
    </Section>
  )
}
