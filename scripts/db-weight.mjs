// What is actually in the database, and which parts grow without a ceiling.
//
// A chain that mints 127k pools of which ~1k ever trade leaves the rest behind
// in our tables. Knowing WHICH tables carry that weight is the difference
// between pruning the right thing and vacuuming the wrong one.
//
// Usage: node scripts/db-weight.mjs
import { DatabaseSync } from 'node:sqlite'
import { statSync } from 'node:fs'

const PATH = process.env.HOOD_DB || 'server/data/hoodarena.db'
const db = new DatabaseSync(PATH, { readOnly: true })
const mb = (b) => (b / 1048576).toFixed(1) + ' MB'

console.log(`file: ${PATH}  ${mb(statSync(PATH).size)}`)
try { console.log(`wal : ${mb(statSync(PATH + '-wal').size)}`) } catch { /* checkpointed */ }

const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all()
const rows = []
for (const t of tables) {
  let n = 0
  try { n = db.prepare(`SELECT COUNT(*) c FROM "${t.name}"`).get().c } catch { continue }
  rows.push({ table: t.name, rows: n })
}
rows.sort((a, b) => b.rows - a.rows)
console.log('\nrows per table (top 14):')
for (const r of rows.slice(0, 14)) console.log(`  ${r.table.padEnd(22)} ${r.rows.toLocaleString().padStart(12)}`)

// dbstat gives real bytes per table when the build has it.
try {
  const sizes = db.prepare(`SELECT name, SUM(pgsize) bytes FROM dbstat GROUP BY name ORDER BY bytes DESC LIMIT 14`).all()
  console.log('\nbytes per table/index (dbstat):')
  for (const s of sizes) console.log(`  ${s.name.padEnd(28)} ${mb(s.bytes).padStart(10)}`)
} catch {
  console.log('\n(dbstat not available in this build - row counts above are the guide)')
}

// The specific question: how much of the pool table is dead weight?
try {
  const pools = db.prepare('SELECT COUNT(*) c FROM fh_pools').get().c
  const withStats = db.prepare('SELECT COUNT(*) c FROM fh_stats').get().c
  const tradable = db.prepare(`SELECT COUNT(*) c FROM fh_stats WHERE liq >= 1000 AND trades24 >= 6 AND price > 0`).get().c
  console.log(`\npools known      ${pools.toLocaleString()}`)
  console.log(`  with any stats ${withStats.toLocaleString()}  (${(withStats / pools * 100).toFixed(1)}%)`)
  console.log(`  tradable now   ${tradable.toLocaleString()}  (${(tradable / pools * 100).toFixed(2)}%)`)
  console.log(`  never traded   ${(pools - withStats).toLocaleString()}  (${((pools - withStats) / pools * 100).toFixed(1)}%)`)
} catch { /* firehose tables absent */ }

// Retention windows actually in force.
console.log(`\nretention: swaps ${process.env.HOOD_FH_KEEP_HOURS || 6}h, candles 30d (from firehose.js)`)
try {
  const s = db.prepare('SELECT MIN(ts) a, MAX(ts) b, COUNT(*) c FROM fh_swaps').get()
  if (s.c) console.log(`  fh_swaps  ${s.c.toLocaleString()} rows spanning ${((s.b - s.a) / 3600000).toFixed(1)}h`)
} catch { /* none */ }
try {
  const c = db.prepare('SELECT MIN(t) a, MAX(t) b, COUNT(*) c FROM fh_c1m').get()
  if (c.c) console.log(`  fh_c1m    ${c.c.toLocaleString()} rows spanning ${((c.b - c.a) / 86400000).toFixed(1)}d`)
} catch { /* none */ }
db.close()
