import React, { useEffect, useState } from 'react'
import { useApp, effToken, allTokens } from '../engine/store'
import { queueJoin } from '../engine/net'
import { feeFor, DRAW_THRESHOLD, SWAP_COST, allowedTokenIds } from '../engine/duel'
import { POOLS, poolById } from '../engine/tokens'
import { STAKES, DURATIONS, fmtUsd, durLabel } from '../engine/format'
import { dayChange } from '../engine/prices'
import { Section, NumFlash, useMarket, TokenLogo, LivePrice, LiveDay } from '../components/ui'
import { poolMark } from '../engine/marks'

const SelBadge = ({ live }) => (
  <span className={`mode-sel ${live ? 'mode-sel-live' : ''}`}>
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M3.5 8.5l3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
    Selected
  </span>
)

// ---- the arena's own coin ---------------------------------------------------
// The arena's own Solana token. Players copy this off the page and send money
// to it, so a wrong value here is not a display bug - it is money sent to
// nobody, unrecoverable. Paste the mint only after checking it on-chain.
//
// Empty (owner, 22 Sep 2026: the Robinhood contract came off, the plate stays):
// the plate still stands in its place, but says the address is not out yet and
// offers nothing to copy - never a stand-in address someone could send to.
const ARENA_CA = ''

const CoinPlate = () => {
  const [copied, setCopied] = useState(false)
  // Only claim it was copied once the write actually resolved - a browser that
  // refuses the clipboard must not get a green tick for it.
  const copy = async () => {
    try { await navigator.clipboard.writeText(ARENA_CA) } catch { return }
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }
  if (!ARENA_CA) {
    return (
      <div className="coin-ca">
        <span className="coin-ca-tag">CA</span>
        <span className="coin-ca-addr coin-ca-soon">Not yet public</span>
      </div>
    )
  }
  // One row: the label, the address, the button. The full address
  // is the whole point of the plate, so it is shown whole and only collapses
  // to head-and-tail where the row is too narrow to hold it.
  return (
    <div className="coin-ca">
      <span className="coin-ca-tag">CA</span>
      <span className="coin-ca-addr" title={ARENA_CA}>{ARENA_CA}</span>
      <span className="coin-ca-addr is-short" title={ARENA_CA}>{`${ARENA_CA.slice(0, 6)}…${ARENA_CA.slice(-4)}`}</span>
      <button className="coin-ca-copy" type="button" onClick={copy}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

const ACK_TEXT = {
  classic: 'I understand: in Classic Arena prices are only tracked - my stake never goes into the coins, and the winner receives a fixed prize known up front.',
  live: 'I understand: in Live Arena my stake goes into my picks (in play credits) after the fee. The final prize depends on both portfolios and can be higher or lower than the starting pool. Simulated trading costs apply.',
}

export default function Play({ nav, params }) {
  const app = useApp()
  useMarket() // the battlefield pulse below shows live prices - tick once a second
  const [mode, setMode] = useState(params[0] === 'live' ? 'live' : 'classic')
  // One battlefield (Solana Memes) - there is nothing to select, but the id
  // still travels with every queue join.
  const battlePool = POOLS[0].id
  const [stake, setStake] = useState(100)
  const [duration, setDuration] = useState(900)
  const [ack, setAck] = useState(false)
  const [error, setError] = useState(null)

  const { pct, pool, fee, prize } = feeFor(stake)
  const paused = mode === 'classic' ? app.config.classicPaused : app.config.livePaused
  // A visitor without an account: everything on this page is theirs to read,
  // nothing on it is theirs to enter. The training gate, the balance and the
  // websocket are all meaningless until they have a profile, so they are not
  // consulted - the one thing missing is the account itself.
  const guest = !app.user
  // Not a gate any more - just who gets offered a free rehearsal below.
  const untrained = !guest && !app.trainingDone
  const offline = app.conn !== 'online'

  // The pool supports a table only if it has 3+ eligible tokens at that size.
  const poolOk = (p, s = stake) => allowedTokenIds({ mode, stake: s, duration, pool: p }).length >= 3
  const poolViable = poolOk(battlePool)
  // Live tables above the reserve cap stay locked until the arena's fee reserve grows.
  const stakeOpen = (s) => mode !== 'live' || s <= (app.config.liveMaxStake ?? 1000)
  // Live needs a treasury venue on the pool's chain; without one no coin can
  // back a payout, and the page says so instead of calling every stake "too thin".
  const liveVenue = mode !== 'live' || allTokens().some((t) => t.pool === battlePool && t.liveOk !== false)

  // On phones the launch button floats at the bottom of the screen while the
  // message it produced renders up in the card - so the page walks up to the
  // message. On desktop the button sits next to it and the scroll is a no-op.
  useEffect(() => {
    if (error) document.querySelector('.play-msg-err')?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [error])

  const launch = () => {
    setError(null)
    if (guest) return nav('/login')
    if (offline) return setError('No connection to the arena server right now. Hold on - reconnecting…')
    if (paused) return setError(`${mode === 'classic' ? 'Classic' : 'Live'} Arena is temporarily paused by the arena team.`)
    if (!poolViable) return setError(`${poolById(battlePool).label} doesn't have 3 eligible tokens for this table - lower the stake or change the duration.`)
    if (!ack) return setError('Confirm that you understand how the selected arena works before entering.')
    queueJoin({ mode, stake, duration, pool: battlePool })
    nav('/duel')
  }

  return (
    <>
      <section className="section">
        <div className="arena-head">
          <div className="arena-head-copy">
            <h2 className="section-title">Choose your arena</h2>
            <p className="arena-head-sub">Both arenas are fought over the same coins. What changes is whether your stake rides the coins or the prize is fixed.</p>
          </div>
          <CoinPlate />
        </div>
        <div className="arena-grid">
          <button className={`arena-card arena-classic ${mode === 'classic' ? 'is-on' : ''}`} onClick={() => { setMode('classic'); setAck(false) }}>
            {mode === 'classic' && <SelBadge />}
            <div className="arena-body">
              <div className="arena-left">
                <div className="arena-top">
                  <h3>Classic Arena</h3>
                </div>
                <p className="arena-hook">Predict better. Win a fixed prize.</p>
                <p className="arena-desc">Token prices decide the winner - your stake is never used to buy them.</p>
                <div className="arena-meta">Fixed payout<i>·</i>Prize known up front<i>·</i>Lower risk</div>
              </div>
              {/* The duel block follows the selected stake - real fee, real prize. */}
              <div className="arena-outcome">
                <div className="arena-duel">{fmtUsd(stake)} <i>VS</i> {fmtUsd(stake)}</div>
                <div className="arena-big"><NumFlash value={prize}>{fmtUsd(prize)}</NumFlash></div>
                <span className="arena-cap">Winner payout - the {pct}% fee is already included.</span>
              </div>
            </div>
          </button>
          <button className={`arena-card arena-live ${mode === 'live' ? 'is-on' : ''}`} onClick={() => {
            setMode('live')
            setAck(false)
            if (stake > (app.config.liveMaxStake ?? 1000)) setStake(app.config.liveMaxStake ?? 1000)
          }}>
            {mode === 'live' && <SelBadge live />}
            <div className="arena-body">
              <div className="arena-left">
                <div className="arena-top">
                  <h3>Live Arena</h3>
                </div>
                <p className="arena-hook">Ride the market. Fight for a dynamic pool.</p>
                <p className="arena-desc">Your stake goes into the coins you pick - the winner takes the final value of both portfolios, in those coins.</p>
                <div className="arena-meta">Coin payout<i>·</i>Dynamic prize<i>·</i>Higher upside</div>
              </div>
              <div className="arena-outcome">
                <div className="arena-duel">{fmtUsd(stake)} <i>VS</i> {fmtUsd(stake)}</div>
                <div className="arena-big"><NumFlash value={prize}>{fmtUsd(prize)}</NumFlash></div>
                <span className="arena-cap">Starting capital - the final payout follows the market, up or down.</span>
              </div>
            </div>
          </button>
        </div>
      </section>

      {/* The one battlefield - no picker, so the copy says what it IS instead
          of defending a rule nobody can break. It must not say "every memecoin
          on Solana": the book keeps the strongest ~1,500 that actually trade.
          Claiming all of them would be a lie a player can check anywhere. */}
      <Section eyebrow="No hand-picked list · the arena reads Solana's live markets and ranks what actually trades" title="The battlefield">
        {POOLS.map((p) => (
          <div key={p.id} className="mode-card pool-card on-pool pool-solo">
            <div className="pool-head">
              <TokenLogo token={poolMark(p)} size={34} />
              <h3>{p.label}</h3>
            </div>
            <p>{p.tagline}</p>
            <div className="pool-count">
              <b>{allowedTokenIds({ mode, stake: 10, duration: 900, pool: p.id }).length}</b>
              <span>battle-ready tokens</span>
            </div>
          </div>
        ))}
      </Section>

      <div className="grid2">
        <div className="play-left">
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-title">Stake per player</div>
            <div className="seg">
              {STAKES.map((s) => {
                const ok = poolOk(battlePool, s) && stakeOpen(s)
                const why = !stakeOpen(s)
                  ? `Live tables above $${app.config.liveMaxStake} unlock as the arena's reserve grows`
                  : !liveVenue
                    ? `Live Arena isn't open on ${poolById(battlePool).label} yet`
                    : `${poolById(battlePool).label} liquidity doesn't support $${s} battles`
                return (
                  <button key={s} className={stake === s ? 'on' : ''} disabled={!ok}
                    title={ok ? '' : why}
                    onClick={() => setStake(s)}>
                    ${s}<span className="seg-sub">{ok ? `${feeFor(s).pct}% fee` : !stakeOpen(s) || !liveVenue ? 'locked' : 'too thin'}</span>
                  </button>
                )
              })}
            </div>
            {!liveVenue ? (
              <p className="small muted" style={{ marginTop: 8 }}>
                Live Arena only plays coins with a tradable market, and {poolById(battlePool).label} has none yet - it opens
                when one qualifies. Classic Arena plays every coin right now.
              </p>
            ) : !poolOk(battlePool, 10000) && (
              <p className="small muted" style={{ marginTop: 8 }}>
                {poolById(battlePool).label} needs 3 coins the trading venue can execute - it opens the moment a third one qualifies.
              </p>
            )}
          </div>
          <div className="card">
            <div className="card-title">Battle duration</div>
            <div className="seg">
              {DURATIONS.map((d) => (
                <button key={d.secs} className={duration === d.secs ? 'on' : ''} onClick={() => setDuration(d.secs)}>
                  {d.label}<span className="seg-sub">{d.tag}</span>
                </button>
              ))}
            </div>
            <p className="small muted" style={{ marginTop: 10 }}>
              Shorter battles are faster and wilder; longer ones test real strategy. At one minute a single large
            trade can decide it, so pick coins with a book deep enough to survive one.
            </p>
          </div>
          {/* Pre-battle intel, not filler: the battlefield's biggest movers
              right now, on the same feed the battle will settle on. The card
              stretches so this column ends level with the summary. */}
          <div className="card pulse-card">
            <div className="card-title">Right now in {poolById(battlePool).label}</div>
            <div className="pulse-rows">
              {allowedTokenIds({ mode, stake, duration, pool: battlePool })
                .map(effToken).filter(Boolean)
                .sort((a, b) => Math.abs(dayChange(b.id)) - Math.abs(dayChange(a.id)))
                .slice(0, 6)
                .map((t) => (
                  <button key={t.id} type="button" className="pulse-row" onClick={() => nav('/token/' + t.id)}>
                    <TokenLogo token={t} size={26} />
                    <span className="pulse-tik">{t.ticker}</span>
                    <span className="pulse-px"><LivePrice id={t.id} /></span>
                    <LiveDay id={t.id} />
                  </button>
                ))}
            </div>
            <p className="small muted" style={{ marginTop: 'auto', paddingTop: 10 }}>
              Live 24h moves of your battlefield&rsquo;s biggest movers - the exact feed this battle settles on.
            </p>
          </div>
        </div>

        <div className="card summary-card">
          <div className="card-title">Battle summary</div>
          <table className="fee-table">
            <tbody>
              <tr><td>Battlefield</td><td>{poolById(battlePool).label}</td></tr>
              <tr><td>Your stake</td><td>{fmtUsd(stake)}</td></tr>
              <tr><td>Opponent stake</td><td>{fmtUsd(stake)}</td></tr>
              <tr><td>Total pool</td><td>{fmtUsd(pool)}</td></tr>
              <tr><td>SolArena fee ({pct}%)</td><td className="down">−{fmtUsd(fee)}</td></tr>
              {mode === 'classic'
                ? <tr><td>Winner prize</td><td className="up"><NumFlash value={prize}>{fmtUsd(prize)}</NumFlash></td></tr>
                : <>
                    <tr><td>Invested per player</td><td>{fmtUsd(stake - fee / 2)}</td></tr>
                    <tr><td>Swap costs (est.)</td><td className="down">~{(SWAP_COST * 100).toFixed(1)}% + price impact on thin coins</td></tr>
                    <tr><td>Winner takes</td><td className="gold">Final value of both portfolios</td></tr>
                  </>}
              <tr><td>Duration</td><td>{durLabel(duration)}</td></tr>
            </tbody>
          </table>
          <hr className="divider" />
          <p className="small muted">
            Draw rule: if the difference is under {DRAW_THRESHOLD} percentage points, the battle is a draw - {mode === 'classic'
              ? 'both players get their full stake back and the fee is waived.'
              : 'each player keeps the final value of their own portfolio.'}
            {mode === 'live' && ' Real trading adds slippage and swap costs, shown before you lock in.'}
          </p>
          <hr className="divider" />
          <label className="ack">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            <span>{ACK_TEXT[mode]}</span>
          </label>
          {error && <div className="notice notice-danger play-msg-err" style={{ marginTop: 12 }}>{error}</div>}
          {guest && (
            <div className="notice notice-info" style={{ marginTop: 12 }}>
              A battle needs two named fighters - create a profile to enter this one.
              It takes a name and a password, and you can be on a table straight after.
            </div>
          )}
          {/* A suggestion, not a gate: the training battle stopped being
              mandatory, so this offers a free rehearsal and never blocks the
              button next to it. */}
          {untrained && (
            <div className="notice notice-info" style={{ marginTop: 12 }}>
              Never done this before? A training battle is free, takes minutes and uses the same live prices.{' '}
              <button className="btn btn-sm btn-opp" style={{ marginLeft: 6 }} onClick={() => nav('/training')}>Try it first</button>
            </div>
          )}
          {/* On phones this row detaches and floats above the tab bar - the
              one action this page exists for should never be seven screens of
              scrolling away. Desktop keeps it in the card. */}
          <div className="play-cta-row" style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
            <button className="btn btn-gold btn-lg" style={{ flex: 1 }} onClick={launch}>
              {guest ? 'Create a profile to play' : 'Find an opponent'}
            </button>
            <button className="btn btn-lg" onClick={() => nav(guest ? '/login' : '/challenge-new')}>Challenge a friend</button>
          </div>
          <p className="small muted" style={{ marginTop: 10 }}>
            Auto-match pairs you with the first player at the same stake and duration - including tables
            already posted on the open board, so you never wait next to a fight that is right there. A
            private challenge creates a link (or pings a named player directly) - same rules, your chosen
            opponent.
          </p>
        </div>
      </div>
    </>
  )
}
