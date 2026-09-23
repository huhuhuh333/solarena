// Free-play balance: what you have to play with, coins won in Live, and the
// history. Running dry never stops play - the server tops up at the table. No wallets, no deposits, no payouts.

import React, { useEffect, useState } from 'react'
import { useApp, effToken } from '../engine/store'
import { refreshWallet, api } from '../engine/net'
import { fmtUsd, timeAgo } from '../engine/format'
import { Section, TokenLogo } from '../components/ui'

const TX_ICON = { deposit: '+', stake: '⚔', win: '🏆', refund: '↩', swap: '⇄', coins: '🪙', reward: '🎖' }

export default function Wallet() {
  const app = useApp()
  const [coins, setCoins] = useState([])
  const [sellBusy, setSellBusy] = useState(null)
  const [sellMsg, setSellMsg] = useState(null)

  const loadCoins = () => api('/api/holdings').then((r) => setCoins(r.holdings || [])).catch(() => {})

  useEffect(() => {
    refreshWallet().catch(() => {})
    loadCoins()
    const t = setInterval(() => { refreshWallet().catch(() => {}); loadCoins() }, 30000)
    return () => clearInterval(t)
  }, [])

  const sellCoin = async (h) => {
    setSellMsg(null)
    setSellBusy(h.token)
    try {
      const r = await api('/api/holdings/sell', { method: 'POST', body: { token: h.token, amount: h.amount } })
      setSellMsg({ ok: true, text: `Sold ${h.ticker} for ${fmtUsd(r.usd)}.` })
      loadCoins()
      refreshWallet().catch(() => {})
    } catch (err) {
      setSellMsg({ ok: false, text: err.message })
    } finally {
      setSellBusy(null)
    }
  }

  const coinsUsd = coins.reduce((a, h) => a + (h.usd || 0), 0)

  return (
    <Section eyebrow="Free play - no real money" title="Balance">
      <div className="card wl-hero">
        <div className="eyebrow">Available to play</div>
        <div className="wl-balance num">{fmtUsd(app.wallet.balance)}</div>
        <p className="small muted wl-doctrine">
          Play credits only. They cost nothing and cannot be bought, sold or withdrawn.
          Play as much as you like - if you run short, the arena tops you up for free.
        </p>
      </div>

      <div className="wl-grid">
        <div className="wl-side">
          {coins.length > 0 && (
            <div className="card">
              <div className="vs-row" style={{ marginBottom: 6 }}>
                <div className="card-title" style={{ margin: 0 }}>Coins won in Live Arena</div>
                <span className="num up">{fmtUsd(coinsUsd)}</span>
              </div>
              <p className="small muted" style={{ marginBottom: 10 }}>
                Live pays in the coins themselves. They keep moving with the market - hold them, or sell back to credits any time.
              </p>
              {sellMsg && <div className={`notice ${sellMsg.ok ? '' : 'notice-danger'}`} style={{ marginBottom: 10 }}>{sellMsg.text}</div>}
              {coins.map((h) => (
                <div key={h.token} className="wl-coin">
                  <div className="vs-row">
                    <TokenLogo token={effToken(h.token)} size={28} />
                    <span style={{ flex: 1 }}>
                      <b>{h.ticker}</b> <span className="num small muted">{h.amount.toPrecision(6)}</span>
                    </span>
                    <span className="num">{fmtUsd(h.usd)}</span>
                    <button className="btn btn-sm" disabled={sellBusy === h.token || !h.sellable} onClick={() => sellCoin(h)}>
                      {sellBusy === h.token ? '…' : 'Sell'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="card">
            <div className="card-title">History</div>
            <div style={{ maxHeight: 420, overflow: 'auto' }}>
              {app.wallet.txs.length === 0 && <p className="small muted">Nothing yet - your first battle starts the story.</p>}
              {app.wallet.txs.map((tx, i) => (
                <div key={i} className="big-win-row">
                  <span style={{ width: 22 }}>{TX_ICON[tx.type] || '·'}</span>
                  <span style={{ flex: 1 }}>{tx.note}</span>
                  <span className={`num ${tx.amount > 0 ? 'up' : 'down'}`}>{tx.amount > 0 ? '+' : ''}{fmtUsd(tx.amount)}</span>
                  <span className="small muted">{timeAgo(tx.ts)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </Section>
  )
}
