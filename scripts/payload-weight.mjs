// The two numbers that decide how many tokens the arena can carry:
// the 15s /api/tokens poll and the 1s websocket tick, per client.
// Run this before raising HOOD_TOKENS_PER_POOL.
// Usage: node scripts/payload-weight.mjs [http://localhost:8787]
const BASE = process.argv[2] || 'http://localhost:8787'

const raw = await fetch(`${BASE}/api/tokens`).then((r) => r.text())
const toks = JSON.parse(raw).tokens
const per = raw.length / toks.length
console.log(`/api/tokens : ${(raw.length / 1024 / 1024).toFixed(2)} MB for ${toks.length} tokens (${Math.round(per)} B each, polled every 15s)`)

const weight = {}
for (const t of toks) for (const [k, v] of Object.entries(t)) weight[k] = (weight[k] || 0) + JSON.stringify(v ?? null).length
console.log('\nheaviest fields:')
for (const [k, v] of Object.entries(weight).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`  ${k.padEnd(14)} ${(v / 1024).toFixed(0).padStart(5)} KB  ${((v / raw.length) * 100).toFixed(1)}%`)
}

// A full tick is every surfaced id; the wire normally carries only what moved.
const full = JSON.stringify(Object.fromEntries(toks.map((t) => [t.id, { p: t.base, day: -3.21 }])))
console.log(`\nws tick (full resync, every 30s): ${(full.length / 1024).toFixed(1)} KB`)
console.log('deltas in between carry only changed prices - measure live with scripts/tick-size.mjs')
console.log('\nprojection at a bigger book:')
for (const n of [1200, 2400, 4000]) {
  console.log(`  ${String(n).padStart(4)} tokens → poll ${((per * n) / 1024 / 1024).toFixed(1)} MB/15s · full tick ${((full.length / toks.length) * n / 1024).toFixed(0)} KB`)
}
