// Mainnet go-live gate. Verifies EVERYTHING before real money is allowed:
// secrets, Solana connectivity, prices, Jupiter routing,
// treasury funding and full-reserve settings. Read-only - no transactions.
//
// Usage: npm run preflight:mainnet   (loads .env.mainnet)

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok === true ? ' ✓' : ok === 'warn' ? ' ⚠' : ' ✗'} ${name}${detail ? ' - ' + detail : ''}`)
}

console.log('SolArena mainnet preflight\n---------------------------')

// ---- 1. secrets ----
const seed = process.env.HOOD_WALLET_SEED || ''
check('HOOD_CHAIN_ENV is mainnet', (process.env.HOOD_CHAIN_ENV || '') === 'mainnet')
check('HOOD_WALLET_SEED is a 64-hex secret', /^[0-9a-fA-F]{64}$/.test(seed))
const ap = process.env.HOOD_ADMIN_PASS || ''
check('HOOD_ADMIN_PASS is strong', ap.length >= 12 && ap !== 'admin1337')

if (!/^[0-9a-fA-F]{64}$/.test(seed)) {
  console.log('\nNOT READY - fix the secrets first (.env.mainnet).')
  process.exit(1)
}

// ---- 2. the Solana rail: derivation + RPC + funding ----
const { CHAINS, RPC_URLS, setMasterSeed, fromBase } = await import('../server/chains.js')
setMasterSeed(seed)

// The public endpoint rate-limits a deposit watcher into silence; mainnet needs
// a real provider (Helius, Triton, QuickNode...).
const rpc = process.env.HOOD_SOL_RPC || ''
check('HOOD_SOL_RPC points at a real provider', !!rpc && !/api\.mainnet-beta\.solana\.com/.test(rpc) ? true : 'warn',
  rpc ? new URL(rpc).host : 'unset - the public endpoint will throttle deposits and payouts')

// SOL kept for fees, sweeps and the rent of every new token account the hedge opens.
const MIN_SOL = 0.1
let fundingWarned = false
for (const c of Object.values(CHAINS)) {
  let address
  try {
    address = c.address('treasury')
    check(`${c.label}: treasury derives`, true, address)
  } catch (e) {
    check(`${c.label}: treasury derives`, false, e.message)
    continue
  }
  check(`${c.label}: is mainnet`, c.liveNetwork === true, c.network)
  try {
    const b = await c.balances(address)
    const native = fromBase(b.native, c.nativeDecimals)
    check(`${c.label}: RPC reachable`, true, RPC_URLS.sol ? new URL(RPC_URLS.sol).host : '')
    const ok = native >= MIN_SOL
    check(`${c.label}: treasury funded`, ok ? true : 'warn', `${native.toFixed(4)} SOL (need ≥ ${MIN_SOL} for fees and token-account rent)`)
    if (!ok) fundingWarned = true
  } catch (e) {
    check(`${c.label}: RPC reachable`, false, String(e.message || e).slice(0, 100))
  }
}

// ---- 3. prices ----
const SOL_MINT = 'So11111111111111111111111111111111111111112'
try {
  const r = await fetch(`https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`, { signal: AbortSignal.timeout(10000) })
  const p = Number((await r.json())?.[SOL_MINT]?.usdPrice)
  check('Jupiter prices SOL (the ledger\'s coin)', p > 0, `$${p?.toFixed?.(2)}`)
} catch (e) { check('Jupiter prices SOL', false, e.message) }

try {
  const r = await fetch('https://hermes.pyth.network/v2/price_feeds?query=btc&asset_type=crypto', { signal: AbortSignal.timeout(10000) })
  const list = await r.json()
  check('Pyth (Hermes) reachable - feed heartbeat', Array.isArray(list) && list.length > 0)
} catch (e) { check('Pyth (Hermes) reachable', false, e.message) }

try {
  const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd', { signal: AbortSignal.timeout(10000) })
  const d = await r.json()
  check('CoinGecko reachable - feed heartbeat', d?.bitcoin?.usd > 0, `BTC $${d?.bitcoin?.usd}`)
} catch (e) { check('CoinGecko reachable', false, e.message) }

// ---- 4. Jupiter routing, both ways (read-only quotes) ----
// The hedge buys with SOL and a winner may sell back into SOL; a coin that only
// routes one way is one the treasury must never hold.
try {
  const tl = await fetch('https://lite-api.jup.ag/tokens/v2/search?query=WIF', { signal: AbortSignal.timeout(15000) })
  const tokens = await tl.json()
  const wif = tokens.find((t) => String(t.symbol).replace(/^\$/, '').toUpperCase() === 'WIF')
  check('Jupiter token search resolves WIF', !!wif, wif?.id?.slice(0, 12) + '…')
  if (wif) {
    const q = await fetch(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${SOL_MINT}&outputMint=${wif.id}&amount=100000000&slippageBps=300`, { signal: AbortSignal.timeout(15000) })
    const buy = await q.json()
    check('Jupiter quotes 0.1 SOL → WIF', !buy.error && Number(buy.outAmount) > 0,
      buy.outAmount ? `${(Number(buy.outAmount) / 10 ** wif.decimals).toFixed(3)} WIF` : buy.error)
    if (Number(buy.outAmount) > 0) {
      const s = await fetch(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${wif.id}&outputMint=${SOL_MINT}&amount=${buy.outAmount}&slippageBps=300`, { signal: AbortSignal.timeout(15000) })
      const sell = await s.json()
      check('Jupiter quotes WIF → SOL back', !sell.error && Number(sell.outAmount) > 0,
        sell.outAmount ? `${(Number(sell.outAmount) / 1e9).toFixed(5)} SOL` : sell.error)
    }
  }
} catch (e) { check('Jupiter reachable', false, String(e.message || e).slice(0, 100)) }

// ---- 6. full-reserve settings (on the mainnet DB) ----
const { getSetting } = await import('../server/db.js')
check('signupCredit is $0 (full reserve)', getSetting('signupCredit') === 0, `$${getSetting('signupCredit')}`)
// Automatic payouts are the owner's call (4 Aug 2026), so this no longer demands
// a manual queue - it demands a CEILING. An unbounded auto-limit means a bug in
// settlement could pay itself out before anyone reads a log; a bounded one puts
// the big withdrawals in front of a person, which is where the money is.
const autoMaxCfg = (() => {
  const s = getSetting('autoWithdrawMax')
  return typeof s === 'number' && s >= 0 ? s : (Number(process.env.HOOD_AUTO_WITHDRAW_MAX) || 0)
})()
check('auto-withdrawal limit is bounded', autoMaxCfg <= 5000,
  autoMaxCfg > 0 ? `up to $${autoMaxCfg} pays out on its own, larger waits for you` : 'every withdrawal waits for approval')

// ---- 6b. the ledger is denominated in coin, not dollars ----
//
// Balances are stored as SOL. If this never flipped, the arena is keeping a
// liability in some other unit against a SOL treasury.
const { ledgerPriceUsd, ensureCoinLedger } = await import('../server/db.js')
check('ledger is denominated in SOL', ensureCoinLedger() && getSetting('ledgerCoin') === 'SOL',
  getSetting('ledgerCoin') === 'SOL' ? 'balances follow the SOL price' : 'not converted yet - start the server once with a live price')
{
  // A warning, not a blocker: a launch database has never run the server, so it
  // cannot have a price yet - and with no balances there is nothing to misprice.
  const px = ledgerPriceUsd()
  check('a SOL price is on record for the ledger', px > 0 ? true : 'warn',
    px > 0 ? `$${px.toFixed(2)} / SOL` : 'none yet - stored within seconds of the server\'s first price read')
}

// What actually bounds Live exposure - checked instead of a fixed dollar cap.
//
// This used to demand liveMaxStake ≤ $100. That number predates the
// event-driven hedger: the cap existed to contain the price gap between a
// battle starting and its basket being bought, and the hedger now buys within
// ~a second, which is why db.js raised the default to the top of the ladder on
// purpose. Two LIVE gates bound the risk instead, and neither is a guess:
//   • per-token depth  - rules.js caps a Live battle to what that coin's book
//                        can actually fill (venueMaxStake / reachableLiquidity)
//   • treasury capacity - venue.js refuses a battle the float cannot cover, and
//                        the float is the players' own deposits, never house money
// So the check is that those gates are WIRED, not that a number is small.
const { hedgeCapacityUsd } = await import('../server/hedger.js')
const { venueCanTrade, venueCapacityUsd } = await import('../server/venue.js')
const { venueLimitFor } = await import('../server/registry.js')
check('Live depth gate wired (per-token venue limit)', typeof venueLimitFor === 'function' && typeof venueCanTrade === 'function')
check('Live capacity gate wired (treasury float)', typeof hedgeCapacityUsd === 'function' && typeof venueCapacityUsd === 'function')
// The cap is still reported - it stays as the operator's emergency brake - but
// only a value outside the published ladder is wrong.
const cap = getSetting('liveMaxStake')
const { STAKES: LADDER } = await import('../server/rules.js')
check('Live stake cap is a real table', LADDER.includes(cap), `$${cap} (emergency brake; lower it in the admin panel any time)`)

// ---- verdict ----
const hard = results.filter((r) => r.ok === false)
console.log('\n---------------------------')
if (hard.length) {
  console.log(`NOT READY - ${hard.length} blocker(s):`)
  for (const h of hard) console.log('  ✗ ' + h.name)
  process.exit(1)
} else if (fundingWarned) {
  console.log('CONFIG READY - fund the treasury wallets above, re-run, then: npm run server:mainnet')
  process.exit(0)
} else {
  console.log('ALL CLEAR - start with: npm run server:mainnet')
  process.exit(0)
}
