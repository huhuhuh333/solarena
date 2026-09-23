import React from 'react'
import { effToken } from '../engine/store'
import { fmtNum } from '../engine/format'
import { SAFETY_LABELS, eligibilityLabel, blurbFor } from '../engine/tokens'
import { useMarket } from '../components/ui'
import TokenInfoPanel from '../components/tokeninfo'

const CATEGORY_EXPLAIN = {
  verified: 'The arena can buy this one at the stakes shown without moving the price, and the buy tax is sane. That is all it means. Live Arena pays the winner the coins themselves, so the arena never has to sell - which means it is NOT saying you will be able to sell, or that the coin will not rug. Those are yours, exactly as they would be buying it on any DEX. Read the checks below and decide for yourself. Re-checked continuously; status is lost automatically if the pool drains.',
  degen: 'Tradeable and priced reliably, but the pool is too thin to buy your stake into without moving the price (or the buy tax is punitive, or the treasury has no venue for its chain). Classic Arena only - nothing is bought there, so depth stops mattering. Battles of 15 min or longer, never more than 50% of a portfolio.',
  fresh: 'Still finishing (or just finished) its launchpad migration. Available only in free battles, training and sponsored no-stake events until it builds history.',
  suspended: 'Previously eligible, but it currently fails re-checks (for example a sudden liquidity drop). Battles with this token are blocked until it recovers.',
  ineligible: 'Failed a hard safety check such as a honeypot or sell-blocking function. Not allowed anywhere in the arena.',
}

// Who holds it. Jupiter counts holders and the top-10 share for every Solana
// coin; GoPlus adds the single biggest wallet for the ones it has scanned.
const pctCell = (v) => (v != null && Number.isFinite(v) ? `${v.toFixed(1)}%` : '-')
const HolderCard = ({ token: t }) => {
  if (t.holders == null && t.top10Pct == null && t.topHolderPct == null) return null
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-title">Holders</div>
      <div className="hc-grid">
        <div><b className="num">{t.holders != null ? fmtNum(t.holders) : '-'}</b><label>holders</label></div>
        <div><b className="num">{pctCell(t.topHolderPct)}</b><label>top wallet</label></div>
        <div><b className="num">{pctCell(t.top10Pct)}</b><label>top 10 wallets</label></div>
        <div><b className="num">{t.launchpad || '-'}</b><label>launchpad</label></div>
      </div>
      <p className="small muted" style={{ marginTop: 8 }}>
        High concentration is the clearest rug signal there is - it gates nothing, you judge it.
      </p>
    </div>
  )
}

export default function TokenDetail({ nav, params }) {
  useMarket()
  const t = effToken(params[0])
  if (!t) return <div className="mm-wrap"><h2 className="display" style={{ fontSize: 30 }}>Token not found</h2></div>

  const checks = Object.entries(t.safety).map(([k, v]) => ({
    key: k, label: SAFETY_LABELS[k],
    ok: k === 'honeypot' ? !v : v, // honeypot flag is inverted: true = bad
  }))

  return (
    <>
      <div className="section">
        <TokenInfoPanel token={t} chartHeight={420}>
          <div className="small muted" style={{ marginTop: 10 }}>{eligibilityLabel(t.maxStake)}</div>
        </TokenInfoPanel>
      </div>

      <div className="grid2" style={{ marginTop: 16 }}>
        <div className="card">
          <div className="card-title">Where it can fight</div>
          <table className="fee-table">
            <tbody>
              <tr><td>Classic Arena</td><td>{['verified', 'degen'].includes(t.category) ? '✓ allowed' : '✕'}</td></tr>
              <tr><td>Live Arena</td><td>{t.liveOk !== false && ['verified', 'degen'].includes(t.category) ? '✓ allowed' : '✕ blocked'}</td></tr>
              <tr><td>Free / training battles</td><td>{['suspended', 'ineligible'].includes(t.category) ? '✕' : '✓ allowed'}</td></tr>
              <tr><td>Low-impact Live size</td><td>{t.maxStake > 0 ? 'up to $' + t.maxStake : '-'}</td></tr>
              {t.category === 'degen' && <tr><td>Extra limits</td><td>15 min+ · max 50% of portfolio</td></tr>}
            </tbody>
          </table>
          <hr className="divider" />
          <p className="small muted">{CATEGORY_EXPLAIN[t.category]}</p>
          <p className="small muted" style={{ marginTop: 8 }}>{blurbFor(t)}</p>
        </div>
        <div className="card">
          <div className="card-title">Safety checks</div>
          {checks.map((c) => (
            <div key={c.key} className="check-row">
              <span>{c.label}</span>
              <span className="check-status">{c.ok ? <span className="up">PASS</span> : <span className="down">FAIL</span>}</span>
            </div>
          ))}
        </div>
      </div>

      <HolderCard token={t} />

      <button className="btn" style={{ marginTop: 16 }} onClick={() => nav('/tokens')}>← All tokens</button>
    </>
  )
}
