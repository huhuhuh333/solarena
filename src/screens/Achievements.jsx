import React, { useEffect, useState } from 'react'
import { api, refreshMe, refreshWallet } from '../engine/net'
import { fmtUsd, timeAgo } from '../engine/format'
import { Section } from '../components/ui'

// The reward balance. Leads the screen because "how much can I take right now"
// is the question players actually arrive with - and because a reward that is
// earned but not yet payable needs a number next to it, or it reads as a wall.
//
// What it does NOT do is explain where the balance comes from. That is house
// accounting (see server/achievements.js) and the API does not even send it.
const RewardRail = ({ rewards, paused }) => {
  const pct = rewards.unlocked > 0 ? Math.min(100, (rewards.claimed / rewards.unlocked) * 100) : 0
  return (
    <div className="card achv-rail">
      <div className="card-title">Your reward balance</div>
      <p className="small muted achv-rail-lede">
        {paused
          ? 'Reward payouts are paused right now - badges still unlock, and anything you have earned can be claimed once they are back on.'
          : <>Your reward balance grows with every battle you fight. Unlock an achievement,
            then claim it against your balance - the credits land in your balance straight away.</>}
      </p>
      <div className="achv-rail-nums">
        {/* The hero number - its size and phosphor come from the rail's CSS,
            so it reads as the page's own voice rather than a generic "up". */}
        <div className="achv-num achv-num-hero">
          <div className="achv-num-v">{fmtUsd(rewards.available)}</div>
          <div className="achv-num-l">Ready to claim</div>
        </div>
        <div className="achv-num">
          <div className="achv-num-v">{fmtUsd(rewards.claimed)}</div>
          <div className="achv-num-l">Claimed so far</div>
        </div>
        <div className="achv-num">
          <div className="achv-num-v">{fmtUsd(rewards.unlocked)}</div>
          <div className="achv-num-l">Balance earned to date</div>
        </div>
      </div>
      <div className="achv-bar achv-bar-lg" role="img"
        aria-label={`${fmtUsd(rewards.claimed)} of ${fmtUsd(rewards.unlocked)} claimed`}>
        <div className="achv-bar-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

const Tile = ({ a, onClaim, busy }) => {
  const progress = Math.min(100, a.need > 0 ? (a.have / a.need) * 100 : 0)
  const state = a.claimed ? 'claimed' : a.claimable ? 'claimable' : a.earned ? 'earned' : 'locked'

  return (
    <div className={`achv-tile achv-${state}`}>
      <div className="achv-head">
        <span className="achv-icon" aria-hidden="true">{a.icon}</span>
        <div className="achv-title">
          <div className="achv-name">{a.name}</div>
          <div className="small muted">{a.desc}</div>
        </div>
        {a.reward > 0 && (
          <span className={`achv-reward ${a.claimed ? 'is-paid' : ''}`}>{fmtUsd(a.claimed ? a.paid : a.reward)}</span>
        )}
      </div>

      {/* Progress is only interesting while there is progress left to make. */}
      {!a.earned && (
        <>
          <div className="achv-bar">
            <div className="achv-bar-fill" style={{ width: `${progress}%` }} />
          </div>
          <div className="achv-foot achv-progress small muted">
            <span className="num">
              {a.have >= 1000 ? a.have.toLocaleString() : a.have}
              {' / '}
              {a.need >= 1000 ? a.need.toLocaleString() : a.need}
            </span>
          </div>
        </>
      )}

      {a.earned && (
        <div className="achv-foot">
          {a.claimed ? (
            <span className="small muted">✓ Claimed {timeAgo(a.claimedAt)}</span>
          ) : a.reward > 0 ? (
            a.claimable ? (
              <button className="btn btn-gold btn-sm" disabled={busy} onClick={() => onClaim(a.key)}>
                {busy ? 'Claiming…' : `Claim ${fmtUsd(a.reward)}`}
              </button>
            ) : (
              // Not "locked" - earned, and waiting on balance. Say which, with
              // the number, so it reads as progress rather than a refusal.
              <span className="small achv-short">
                {a.paused
                  ? 'Unlocked - reward payouts are paused'
                  : <>Unlocked - {fmtUsd(a.shortBy)} more balance releases it</>}
              </span>
            )
          ) : (
            <span className="small achv-done">✓ Unlocked</span>
          )}
        </div>
      )}
    </div>
  )
}

export default function Achievements() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(null)
  const [flash, setFlash] = useState(null)

  const load = () => api('/api/achievements').then(setData).catch((e) => setError(e.message))
  useEffect(() => { load() }, [])

  const claim = async (key) => {
    setBusy(key)
    setError(null)
    try {
      const r = await api('/api/achievements/claim', { method: 'POST', body: { key } })
      setData(r) // the claim response carries the whole refreshed board
      setFlash(`${r.name} claimed - ${fmtUsd(r.reward)} added to your balance.`)
      // The money landed on the server; the header and wallet have to agree.
      refreshMe().catch(() => {})
      refreshWallet().catch(() => {})
    } catch (e) {
      setError(e.message)
      load()
    } finally {
      setBusy(null)
    }
  }

  if (error && !data) return <div className="notice notice-danger">{error}</div>
  if (!data) return <p className="small muted" style={{ marginTop: 30 }}>Loading achievements…</p>

  const groups = []
  for (const a of data.achievements) {
    const g = groups.find((x) => x.name === a.group)
    if (g) g.items.push(a)
    else groups.push({ name: a.group, items: [a] })
  }

  return (
    <div className="achv-page">
      <Section
        eyebrow={`${data.earnedCount} of ${data.total} unlocked`}
        title="Achievements"
        right={data.claimableCount > 0
          ? <span className="cat-badge cat-verified">{data.claimableCount} ready to claim</span>
          : null}
      >
        <RewardRail rewards={data.rewards} paused={data.achievements.some((a) => a.paused)} />
        {flash && <div className="notice" style={{ marginTop: 12 }}>{flash}</div>}
        {error && <div className="notice notice-danger" style={{ marginTop: 12 }}>{error}</div>}
      </Section>

      {groups.map((g) => (
        <Section key={g.name} eyebrow={`${g.items.filter((a) => a.earned).length} / ${g.items.length}`} title={g.name}>
          <div className="achv-grid">
            {g.items.map((a) => <Tile key={a.key} a={a} onClaim={claim} busy={busy === a.key} />)}
          </div>
        </Section>
      ))}
    </div>
  )
}
