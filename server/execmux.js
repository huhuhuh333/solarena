// Execution multiplexer - one hedger, several venues.
//
// The treasury now trades on two unrelated chains: Solana through Jupiter and
// the Robinhood L2 through the 1inch aggregator. The hedger only ever holds one
// executor, so this routes each token to the venue that can actually fill it
// and sends everything else to the paper book, where it stays visible as
// internal rather than pretending to be hedged.

import { tokenById } from '../src/engine/tokens.js'
import { dynamicById } from './registry.js'

const poolOf = (tokenId) => (tokenById(tokenId) || dynamicById(tokenId) || {}).pool || null

export const makeExecMux = ({ byPool, fallback }) => ({
  venue: `mux(${Object.entries(byPool).map(([p, e]) => `${p}:${e.venue}`).join(' ')})`,

  canTrade(token) {
    const exec = byPool[token?.pool]
    return exec ? exec.canTrade?.(token) === true : false
  },

  // Every venue gets shown the whole batch; each ignores what isn't its chain.
  async learn(tokens) {
    for (const exec of Object.values(byPool)) {
      if (exec.learn) await exec.learn(tokens).catch(() => {})
    }
  },

  trade(tokenId, side, usd, oraclePrice) {
    const exec = byPool[poolOf(tokenId)]
    return (exec || fallback).trade(tokenId, side, usd, oraclePrice)
  },

  // Re-read every venue's spendable cash before the hedger acts on it.
  async refresh() {
    for (const exec of Object.values(byPool)) {
      if (exec.refresh) await exec.refresh().catch(() => {})
    }
  },

  // A pool with no real venue spends nothing real, so it is not capped.
  spendableUsd(pool) {
    const exec = byPool[pool]
    return exec?.spendableUsd ? exec.spendableUsd() : Infinity
  },

  assetOf(tokenId) {
    const exec = byPool[poolOf(tokenId)]
    return exec?.assetOf ? exec.assetOf(tokenId) : null
  },

  stats: () => Object.fromEntries(Object.entries(byPool).map(([p, e]) => [p, e.stats?.() ?? { venue: e.venue }])),
})
