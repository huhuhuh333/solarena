import React from 'react'
import { Section } from '../components/ui'

/* Factual privacy notes - lists only what the code actually collects and
   stores (server/db.js, server/auth.js). No invented compliance language. */

export default function Privacy() {
  return (
    <Section eyebrow="What we know and what we don't" title="Privacy Policy">
      <div className="card rul-doc">
        <div className="card-title">What we collect</div>
        <p>A username and a password (stored only as a hash - we cannot read it). Optionally a short bio and a profile picture you upload. That is the whole identity: no email, no phone number, no KYC data is collected by the platform itself.</p>

        <div className="card-title">What the platform records</div>
        <p>Your play-credit balance and holdings; your battles, picks and results; and an audit log of account actions (uploads, admin interventions, payouts). These records are what make results provable - they are kept as long as the account exists.</p>

        <div className="card-title">What is public by nature</div>
        <p>Your fighter name, avatar, record and battle results are visible to other players - that is the sport.</p>

        <div className="card-title">What we don't do</div>
        <p>No advertising trackers, no third-party analytics, no selling or sharing of data. Market data comes from public price providers; your session lives in a token in your own browser storage and dies on logout.</p>

        <div className="card-title">Your controls</div>
        <p>You can change your name and bio, and remove your profile picture, at any time from your profile. To close an account entirely, contact the arena and it is closed.</p>
      </div>
    </Section>
  )
}
