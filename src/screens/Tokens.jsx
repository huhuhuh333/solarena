import React, { useState } from 'react'
import { allTokens } from '../engine/store'
import { marketScore } from '../engine/tokens'
import { fmtCompact, fmtNum } from '../engine/format'
import { useMarket, TokenLogo, CatBadge, Section, LivePrice, LiveDay, Pct } from '../components/ui'
import { SocialLinks, fmtAge } from '../components/tokeninfo'

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'verified', label: 'Arena Verified' },
  { key: 'degen', label: 'Degen Approved' },
  { key: 'fresh', label: 'Fresh Launch' },
  { key: 'flagged', label: 'Flagged' },
]

const SORTS = {
  // Depth and turnover together - the column a terminal opens on.
  trend: (t) => marketScore(t),
  liq: (t) => t.liquidity || 0,
  mcap: (t) => t.marketCap || 0,
  vol: (t) => t.vol24 ?? t.volume24 ?? 0,
  age: (t) => t.ageHours ?? Infinity,
  chg: (t) => (Number.isFinite(t.priceChange?.h24) ? t.priceChange.h24 : -Infinity),
  txns: (t) => (t.txns24 ? t.txns24.buys + t.txns24.sells : 0),
}

const ChgCell = ({ v }) => (v != null && Number.isFinite(v) ? <Pct v={v} digits={1} /> : <span className="muted num">-</span>)

export default function Tokens() {
  useMarket()
  const [filter, setFilter] = useState('all')
  const [q, setQ] = useState('')
  // Neither depth nor trades alone - see marketScore. A liquidity sort opens on
  // a wall of untouched launchpad clones (all seeded at the same ~$58k); a
  // trades sort opens on $3k dust that bots churn. The product of the two is
  // the only ordering that puts real markets first.
  const [sort, setSort] = useState({ key: 'trend', dir: -1 })

  const clickSort = (key) => setSort((s) => ({ key, dir: s.key === key ? -s.dir : -1 }))
  const arrow = (key) => (sort.key === key ? (sort.dir < 0 ? ' ↓' : ' ↑') : '')

  const needle = q.trim().toUpperCase()
  const list = allTokens()
    .filter((t) =>
      filter === 'all' ? true :
      filter === 'flagged' ? (['suspended', 'ineligible'].includes(t.category) || t.safety?.statsCoherent === false) :
      t.category === filter)
    .filter((t) => !needle || t.ticker.includes(needle) || (t.name || '').toUpperCase().includes(needle) || (t.address || '').toUpperCase() === needle)
    .sort((a, b) => (SORTS[sort.key](b) - SORTS[sort.key](a)) * -sort.dir)

  const Head = ({ k, children, cls = '' }) => (
    <span className={`gm-sort ${cls}`} onClick={() => clickSort(k)} role="button">{children}{arrow(k)}</span>
  )

  return (
    <Section eyebrow="The arsenal · Solana's deepest live memecoin markets · prices seconds old" title="Supported tokens"
      right={<input className="gm-search" placeholder="Search name / ticker / address…" value={q} onChange={(e) => setQ(e.target.value)} />}>
      <div className="tabs">
        {FILTERS.map((f) => (
          <button key={f.key} className={filter === f.key ? 'on' : ''} onClick={() => setFilter(f.key)}>{f.label}</button>
        ))}
      </div>

      <div className="card gm-scroll" style={{ padding: '6px 4px' }}>
        <div className="gm-row gm-row-head">
          <span /><span><Head k="trend">Token</Head></span><span>Price</span>
          <span>5m</span><span>1h</span><span>6h</span><span><Head k="chg">24h</Head></span>
          <span><Head k="liq">Liq</Head></span><span><Head k="mcap">MCap</Head></span>
          <span><Head k="vol">Vol 24h</Head></span><span><Head k="txns">Txns</Head></span>
          <span><Head k="age">Age</Head></span><span>Status</span>
        </div>
        {list.map((t) => {
          const pc = t.priceChange || {}
          return (
            <a key={t.id} className="gm-row" href={'/token/' + t.id} style={{ cursor: 'pointer' }}>
              <TokenLogo token={t} size={36} />
              <span>
                <span className="tok-name">{t.ticker}{t.paused && <span className="down small"> · paused</span>}</span>
                <div className="tok-sub">{t.name}</div>
                <SocialLinks token={t} small />
              </span>
              <span className="num"><LivePrice id={t.id} /></span>
              <span><ChgCell v={pc.m5} /></span>
              <span><ChgCell v={pc.h1} /></span>
              <span><ChgCell v={pc.h6} /></span>
              <span>{Number.isFinite(pc.h24) ? <ChgCell v={pc.h24} /> : <LiveDay id={t.id} />}</span>
              <span className="num">{fmtCompact(t.liquidity)}</span>
              <span className="num">{t.marketCap ? fmtCompact(t.marketCap) : '-'}</span>
              <span className="num">{fmtCompact(t.vol24 ?? t.volume24)}</span>
              <span className="num">
                {t.txns24 ? <><span className="up">{fmtNum(t.txns24.buys)}</span><span className="muted">/</span><span className="down">{fmtNum(t.txns24.sells)}</span></> : '-'}
              </span>
              <span className="num">{fmtAge(t.ageHours)}</span>
              <span><CatBadge cat={t.category} small /></span>
            </a>
          )
        })}
        {!list.length && <p className="small muted" style={{ padding: 14 }}>No tokens match.</p>}
      </div>
      <p className="small muted" style={{ marginTop: 12 }}>
        Nobody hand-picks this list, but it is not every coin on Solana either. The arena reads Jupiter's whole verified
        token list and its live trading feeds - thousands of coins - and carries the strongest memecoin markets among them,
        ranked by depth against real turnover. Stablecoins, staking tokens, tokenised stocks and protocol tokens are left
        out; a coin with no liquidity and no trades is a deployment, not a market, so it never appears. A new coin can list
        minutes after it starts trading, and from there its badge is its own doing: a Fresh Launch (including anything still
        on its launchpad bonding curve) plays free battles until it earns Degen, then Verified.
      </p>
    </Section>
  )
}
