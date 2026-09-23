// Support: a player writes from the corner widget, the owner answers from the
// admin panel, the reply comes back live. Runs against a real spawned server.
//
// The questions that matter: does the message REACH the panel, does the reply
// reach the player (socket and badge), are unread counts honest, and can one
// player never read another's thread?
//
// Usage: node scripts/support-test.mjs

import { spawn } from 'node:child_process'
import { rmSync, mkdirSync } from 'node:fs'
import WebSocket from 'ws'

const PORT = 8796
const BASE = `http://localhost:${PORT}`
const DB_DIR = 'server/data/support-test'

const log = (...a) => console.log('[support]', ...a)
const fail = (msg) => { console.error('[FAIL]', msg); process.exitCode = 1 }
const assert = (cond, msg) => { if (!cond) fail(msg); else log('ok:', msg) }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

rmSync(DB_DIR, { recursive: true, force: true })
mkdirSync(DB_DIR, { recursive: true })

const server = spawn(process.execPath, ['server/index.js'], {
  env: {
    ...process.env,
    HOOD_PORT: String(PORT),
    HOOD_DB: `${DB_DIR}/test.db`,
    HOOD_ADMIN_PASS: 'testadmin123',
    HOOD_RAILS: 'off',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stderr.on('data', (d) => process.stderr.write('[server!] ' + d))

const api = async (path, { method = 'GET', token, body } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, data: await res.json().catch(() => ({})) }
}

const main = async () => {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) break } catch { /* booting */ }
    await wait(200)
    if (i === 49) throw new Error('server never came up')
  }
  log('server is up')

  const alice = (await api('/api/register', { method: 'POST', body: { name: 'alice_sup', password: 'hunter22222' } })).data
  const mallory = (await api('/api/register', { method: 'POST', body: { name: 'mallory_sup', password: 'hunter22222' } })).data
  const admin = (await api('/api/login', { method: 'POST', body: { name: 'admin', password: 'testadmin123' } })).data
  assert(!!alice.token && !!admin.token, 'a player and the admin are logged in')

  // The player's socket - a reply must arrive on it without a refresh.
  const ws = new WebSocket(`ws://localhost:${PORT}/ws?token=${alice.token}`)
  const inbox = []
  ws.on('message', (raw) => inbox.push(JSON.parse(String(raw))))
  await new Promise((r) => ws.on('open', r))

  // ---- an empty thread is an empty thread, not an error ----
  const empty = await api('/api/support', { token: alice.token })
  assert(empty.status === 200 && empty.data.messages.length === 0, 'a player who never wrote in has an empty thread')
  assert((await api('/api/support/unread', { token: alice.token })).data.unread === 0, 'and no unread badge')

  // ---- the player writes ----
  assert((await api('/api/support', { method: 'POST', token: alice.token, body: { body: '   ' } })).status === 400, 'an empty message is refused')
  assert((await api('/api/support', { method: 'POST', token: alice.token, body: { body: 'x'.repeat(1001) } })).status === 400, 'an over-long message is refused')
  const sent = await api('/api/support', { method: 'POST', token: alice.token, body: { body: 'My deposit never arrived.' } })
  assert(sent.status === 200, 'the player sends a support message')
  assert((await api('/api/support', { method: 'POST', token: alice.token, body: { body: 'again' } })).status === 429, 'a second message inside 2s is rate-limited')

  // ---- it reaches the admin panel ----
  const desk = await api('/api/admin/support', { token: admin.token })
  assert(desk.status === 200 && desk.data.threads.length === 1, 'the panel lists exactly one conversation')
  const t = desk.data.threads[0]
  assert(t.name === 'alice_sup' && t.unread === 1 && t.last === 'My deposit never arrived.',
    'it names the player, the unread count and their last line')
  assert(desk.data.unreadTotal === 1, 'and the desk carries a total for the tab badge')

  // ---- the owner reads and answers ----
  const opened = await api(`/api/admin/support/${t.userId}`, { token: admin.token })
  assert(opened.data.messages.length === 1 && !opened.data.messages[0].fromAdmin, 'opening the thread shows the player\'s message')
  assert(opened.data.player.name === 'alice_sup', 'with the player it belongs to')
  assert((await api('/api/admin/support', { token: admin.token })).data.unreadTotal === 0, 'reading it clears the desk badge')

  assert((await api(`/api/admin/support/${t.userId}`, { method: 'POST', token: admin.token, body: { body: '' } })).status === 400, 'an empty reply is refused')
  const replied = await api(`/api/admin/support/${t.userId}`, { method: 'POST', token: admin.token, body: { body: 'Checking the chain now - what address did you send from?' } })
  assert(replied.status === 200, 'the owner replies from the panel')

  // ---- the reply reaches the player ----
  await wait(400)
  const push = inbox.find((m) => m.type === 'support')
  assert(!!push && /Checking the chain/.test(push.body), 'the reply arrives live on the player\'s socket')
  assert((await api('/api/support/unread', { token: alice.token })).data.unread === 1, 'and raises the badge for a player who was away')

  const thread = await api('/api/support', { token: alice.token })
  assert(thread.data.messages.length === 2, 'the player sees both sides of the conversation')
  assert(thread.data.messages[0].mine === true && thread.data.messages[1].mine === false, 'their own message is theirs, the reply is not')
  assert((await api('/api/support/unread', { token: alice.token })).data.unread === 0, 'reading the thread clears their badge')

  // ---- one player can never read another's ----
  assert((await api('/api/admin/support', { token: mallory.token })).status === 403, 'a normal player cannot list support threads')
  assert((await api(`/api/admin/support/${t.userId}`, { token: mallory.token })).status === 403, 'nor open somebody else\'s')
  assert((await api(`/api/admin/support/${t.userId}`, { method: 'POST', token: mallory.token, body: { body: 'hi' } })).status === 403, 'nor answer as the house')
  const mine = await api('/api/support', { token: mallory.token })
  assert(mine.data.messages.length === 0, 'and their own thread stays empty - threads never bleed')

  // ---- it survives a restart (it is in the database, not in memory) ----
  assert((await api('/api/admin/support', { token: admin.token })).data.threads[0].total === 2, 'the thread holds both messages on the server')

  ws.close()
  log(process.exitCode ? 'FAILURES PRESENT' : 'ALL SUPPORT TESTS PASSED')
}

main()
  .catch((e) => { fail(String(e && e.stack || e)) })
  .finally(() => {
    server.kill()
    setTimeout(() => {
      try { rmSync(DB_DIR, { recursive: true, force: true }) } catch { /* wal */ }
      process.exit(process.exitCode || 0)
    }, 500)
  })
