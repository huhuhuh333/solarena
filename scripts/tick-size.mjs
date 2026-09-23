// Proves the per-second market tick is a DELTA, not the whole book: connects as
// a real logged-in client, subscribes, and weighs what actually crosses the wire.
// Usage: node scripts/tick-size.mjs [http://localhost:8787]
import { WebSocket } from 'ws'

const BASE = process.argv[2] || 'http://localhost:8787'
const name = 'ticksize_probe_' + Math.floor(Number(process.env.HOOD_PROBE_N) || 1)

const post = (path, body) => fetch(BASE + path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then((r) => r.json())

let auth = await post('/api/login', { name, password: 'probe_pass_123' })
if (!auth.token) auth = await post('/api/register', { name, password: 'probe_pass_123' })
if (!auth.token) { console.error('could not authenticate:', JSON.stringify(auth)); process.exit(1) }

const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws?token=${auth.token}`)
let n = 0, fullBytes = 0, fullIds = 0
const deltas = []

ws.on('open', () => ws.send(JSON.stringify({ type: 'market.sub' })))
ws.on('message', (buf) => {
  let msg
  try { msg = JSON.parse(String(buf)) } catch { return }
  if (msg.type !== 'market.tick') return
  const ids = Object.keys(msg.prices).length
  if (n === 0) { fullBytes = buf.length; fullIds = ids; console.log(`full snapshot on subscribe: ${ids} ids, ${(buf.length / 1024).toFixed(1)} KB`) }
  else deltas.push({ ids, bytes: buf.length })
  if (++n >= 15) {
    const avgIds = deltas.reduce((a, b) => a + b.ids, 0) / deltas.length
    const avgKb = deltas.reduce((a, b) => a + b.bytes, 0) / deltas.length / 1024
    console.log(`deltas: ${avgIds.toFixed(0)} ids avg (${((avgIds / fullIds) * 100).toFixed(1)}% of the book), ${avgKb.toFixed(1)} KB/s`)
    console.log(`without deltas this stream would be ${(fullBytes / 1024).toFixed(1)} KB every second - ${(fullBytes / 1024 / Math.max(avgKb, 0.01)).toFixed(0)}x more`)
    ws.close()
  }
})
ws.on('error', (e) => { console.error('ws error:', e.message); process.exit(1) })
