// Opens a pulled backup and proves it is a real, readable HoodArena database.
// A backup nobody has ever opened is a hope, not a backup - and the failure mode
// this catches is the quiet one: a truncated transfer produces a file of exactly
// the right name and roughly the right size that SQLite refuses at restore time,
// six weeks later, when it is the only copy left.
//
// Usage: node scripts/verify-backup.mjs <file.db>
//   exit 0 = restorable   exit 1 = do not trust it   exit 2 = bad invocation

import { DatabaseSync } from 'node:sqlite'
import { statSync } from 'node:fs'

const path = process.argv[2]
if (!path) {
  console.error('usage: node scripts/verify-backup.mjs <file.db>')
  process.exit(2)
}

const fail = (msg) => { console.error('NEISPRAVNA KOPIJA - ' + msg); process.exit(1) }

let size = 0
try { size = statSync(path).size } catch (e) { fail('fajl ne postoji: ' + e.message) }
if (size < 1_000_000) fail(`samo ${size} bajtova - prenos je prekinut`)

// A .backup copy carries WAL mode in its header but arrives without its -wal
// sidecar. Most builds open that read-only without complaint; the ones that
// insist on writing a header get the second try rather than a false alarm.
let db
try {
  db = new DatabaseSync(path, { readOnly: true })
} catch {
  try { db = new DatabaseSync(path) } catch (e) { fail('ne otvara se: ' + e.message) }
}

const scalar = (sql) => Object.values(db.prepare(sql).get())[0]

const integrity = scalar('PRAGMA integrity_check')
if (integrity !== 'ok') fail('integrity_check kaze: ' + integrity)

const tables = scalar("SELECT count(*) FROM sqlite_master WHERE type='table'")
if (tables < 16) fail(`samo ${tables} tabela - ovo nije cela baza`)

// Empty is legitimate on a young arena; MISSING is not. These five are where the
// money lives, so their absence means the copy is of something else entirely.
for (const t of ['users', 'txs', 'chain_funds', 'holdings', 'settings']) {
  try { db.prepare(`SELECT count(*) FROM ${t}`).get() } catch { fail('nedostaje tabela ' + t) }
}

const n = (t) => scalar(`SELECT count(*) FROM ${t}`)
console.log(
  `ISPRAVNA  ${(size / 1e6).toFixed(0)} MB · ${tables} tabela · ` +
  `users=${n('users')} txs=${n('txs')} matches=${n('matches')} tourneys=${n('tourneys')}`
)
db.close()
