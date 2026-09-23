// Pyth Network price oracle (Hermes HTTP API - free, no key, sub-second data).
// Primary price source for settlement; CoinGecko stays as fallback and still
// supplies 24h-change/volume metadata. Feed IDs are RESOLVED at boot by symbol
// so nothing is hardcoded; tokens Pyth doesn't cover just stay on CoinGecko.

const HERMES = process.env.HOOD_PYTH_URL || 'https://hermes.pyth.network'
const POLL_MS = 2000

// The curated pools are gone, so nothing these feeds price is in the arena any
// more - applyFeed drops ids no token registered. The poll STAYS because it is
// the feed-status heartbeat: duel/tourney void a battle after 90s of 'sim',
// and this stream (with CoinGecko as fallback) is what says 'live'.
//
// Majors tickers only, on purpose. Every one of these is permanently in the
// ingest's EXCLUDE list, so no ingested memecoin can ever claim these ids - a
// BTC feed must never bleed onto a same-ticker meme. Meme tickers (WIF,
// BONK…) must NEVER be added here: the ingest owns those ids now.
const SYMBOLS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'AVAX', 'LINK', 'DOT', 'LTC', 'ATOM']

const feeds = new Map() // token symbol -> feed id (hex)

const resolveFeeds = async () => {
  for (const sym of SYMBOLS) {
    try {
      const res = await fetch(`${HERMES}/v2/price_feeds?query=${sym.toLowerCase()}&asset_type=crypto`, { signal: AbortSignal.timeout(10000) })
      if (!res.ok) continue
      const list = await res.json()
      const hit = list.find((f) =>
        f.attributes?.base?.toUpperCase() === sym && f.attributes?.quote_currency?.toUpperCase() === 'USD')
      if (hit) feeds.set(sym, hit.id)
    } catch { /* leave symbol on CoinGecko */ }
  }
  console.log(`[pyth] resolved ${feeds.size}/${SYMBOLS.length} feeds: ${[...feeds.keys()].join(', ') || 'none'}`)
}

export const startPyth = (apply, setStatus) => {
  let up = false
  const poll = async () => {
    if (!feeds.size) return
    try {
      const q = [...feeds.values()].map((id) => 'ids[]=' + id).join('&')
      const res = await fetch(`${HERMES}/v2/updates/price/latest?${q}`, { signal: AbortSignal.timeout(8000) })
      if (!res.ok) throw new Error('http ' + res.status)
      const data = await res.json()
      const byId = new Map((data.parsed || []).map((p) => [p.id, p]))
      const out = {}
      for (const [sym, id] of feeds) {
        const p = byId.get(id)
        if (!p?.price) continue
        const price = Number(p.price.price) * 10 ** Number(p.price.expo)
        // discard stale prints (> 60s old)
        if (price > 0 && Date.now() / 1000 - Number(p.price.publish_time) < 60) {
          out[sym] = { price }
        }
      }
      if (Object.keys(out).length) {
        apply(out)
        if (!up) { up = true; console.log(`[pyth] live: ${Object.keys(out).length} symbols streaming`) }
        setStatus('live')
      }
    } catch {
      up = false // CoinGecko poller keeps its own status; no hard downgrade here
    }
  }
  resolveFeeds().then(poll)
  const timer = setInterval(poll, POLL_MS)
  return () => clearInterval(timer)
}
