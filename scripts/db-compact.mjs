// Give the disk back what the database is no longer using.
//
// SQLite never returns freed pages to the filesystem on its own. It marks them
// reusable and the file stays at its highest-ever size forever. Measured here on
// 2 Aug 2026: a 4.68 GB file holding 0.9 GB of data - 3.8 GB of it free pages
// left behind when raw-swap retention was cut from 3 days to 6 hours. The data
// was already small; only the file was not.
//
// auto_vacuum is deliberately NOT enabled (owner's call). FULL rewrites pages on
// every commit, and this server writes ~116k swap rows an hour on the main
// thread - it already loses whole seconds to ingest, and a battle clock once ran
// into overtime because of it. Paying that tax on every commit to avoid a
// scheduled few-minute stop is the wrong trade. Retention keeps the data small;
// this reclaims the file when it drifts.
//
// VACUUM takes an exclusive lock and rebuilds into a temp file, so:
//   • the server MUST be stopped first - this refuses to run otherwise
//   • the filesystem needs room for a second copy of the live DATA (not of the
//     bloated file), which this checks before starting
//
// Usage: npm run db:compact           (report only)
//        npm run db:compact -- --apply
import { statSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'

const APPLY = process.argv.includes('--apply')
const { db } = await import('../server/db.js')
db.exec('PRAGMA busy_timeout = 20000')

const DB_PATH = process.env.HOOD_DB || 'server/data/hoodarena.db'
const say = (...a) => console.log('[compact]', ...a)
const mb = (b) => (b / 1048576).toFixed(0) + ' MB'
const gb = (b) => (b / 1073741824).toFixed(2) + ' GB'

const pageSize = db.prepare('PRAGMA page_size').get().page_size
const pages = () => db.prepare('PRAGMA page_count').get().page_count
const free = () => db.prepare('PRAGMA freelist_count').get().freelist_count

const fileBefore = statSync(DB_PATH).size
const usedBefore = (pages() - free()) * pageSize
say(`file        : ${gb(fileBefore)}`)
say(`real data   : ${gb(usedBefore)}`)
say(`free pages  : ${gb(free() * pageSize)}  (${(free() / pages() * 100).toFixed(0)}% of the file)`)

// A second writer means the server is up. VACUUM would either block for minutes
// or fail; either way it must not be attempted behind the server's back.
let locked = false
try {
  db.exec('BEGIN IMMEDIATE')
  db.exec('ROLLBACK')
} catch { locked = true }
if (locked) {
  say('REFUSING: something else is writing to this database - stop the server first.')
  process.exit(1)
}

if (!APPLY) {
  say(`would reclaim about ${gb(fileBefore - usedBefore)}. Re-run with --apply to do it.`)
  process.exit(0)
}

// The rebuild needs room for a fresh copy of the DATA. Checking against the
// bloated file size would refuse jobs that fit comfortably.
try {
  const drive = process.cwd().slice(0, 2)
  const out = execSync(`powershell -NoProfile -Command "(Get-PSDrive ${drive[0]}).Free"`, { encoding: 'utf8' })
  const freeDisk = Number(String(out).trim())
  if (Number.isFinite(freeDisk) && freeDisk < usedBefore * 1.5) {
    say(`REFUSING: needs ~${gb(usedBefore * 1.5)} free on ${drive}, has ${gb(freeDisk)}.`)
    process.exit(1)
  }
} catch { /* not fatal: VACUUM itself fails cleanly and leaves the original intact */ }

say('vacuuming - the original is untouched until the rebuild completes…')
const t0 = Date.now()
db.exec('VACUUM')
const secs = ((Date.now() - t0) / 1000).toFixed(1)

const fileAfter = statSync(DB_PATH).size
say(`done in ${secs}s`)
say(`file        : ${gb(fileBefore)}  →  ${gb(fileAfter)}`)
say(`reclaimed   : ${gb(fileBefore - fileAfter)}`)
say(`integrity   : ${db.prepare('PRAGMA integrity_check').get().integrity_check}`)
for (const f of [DB_PATH + '-wal', DB_PATH + '-shm']) {
  if (existsSync(f)) say(`${f.endsWith('-wal') ? 'wal' : 'shm'}         : ${mb(statSync(f).size)}`)
}
