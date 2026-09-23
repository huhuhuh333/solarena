// Accounts: scrypt password hashing, opaque session tokens.

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { db, getUserByName, getSetting, credit } from './db.js'

const hashPassword = (password) => {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, 64).toString('hex')
  return `${salt}$${hash}`
}

const verifyPassword = (password, stored) => {
  const [salt, hash] = String(stored).split('$')
  if (!salt || !hash) return false
  const got = scryptSync(password, salt, 64)
  const want = Buffer.from(hash, 'hex')
  return got.length === want.length && timingSafeEqual(got, want)
}

const NAME_RE = /^[a-zA-Z0-9_]{3,20}$/

export const register = (name, password) => {
  if (!NAME_RE.test(name || '')) return { error: 'Username: 3-20 chars, letters/digits/underscore only.' }
  if (!password || password.length < 8) return { error: 'Password must be at least 8 characters.' }
  if (getUserByName(name)) return { error: 'That username is taken.' }
  const r = db.prepare('INSERT INTO users (name, pass_hash, created) VALUES (?, ?, ?)')
    .run(name, hashPassword(password), Date.now())
  const userId = Number(r.lastInsertRowid)
  const startCredit = getSetting('signupCredit')
  if (startCredit > 0) credit(userId, startCredit, 'deposit', 'Welcome arena credits')
  return { session: createSession(userId) }
}

export const login = (name, password) => {
  const u = getUserByName(name || '')
  if (!u || !verifyPassword(password || '', u.pass_hash)) return { error: 'Wrong username or password.' }
  if (u.blocked) return { error: 'This account is blocked. Contact support.' }
  return { session: createSession(u.id) }
}

const createSession = (userId) => {
  const token = randomBytes(32).toString('hex')
  db.prepare('INSERT INTO sessions (token, user_id, created) VALUES (?, ?, ?)').run(token, userId, Date.now())
  return { token, userId }
}

export const sessionUser = (token) => {
  if (!token) return null
  const row = db.prepare(`
    SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?
  `).get(String(token))
  if (!row || row.blocked) return null
  return row
}

export const logout = (token) => {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(String(token))
}

// Ensure an admin account exists. Password comes from HOOD_ADMIN_PASS;
// falls back to a dev default with a loud warning.
export const ensureAdmin = () => {
  const pass = process.env.HOOD_ADMIN_PASS || 'admin1337'
  if (!process.env.HOOD_ADMIN_PASS) {
    console.warn('[auth] HOOD_ADMIN_PASS not set - admin password is the dev default "admin1337". Set it before real deploy!')
  }
  const existing = getUserByName('admin')
  if (existing) {
    db.prepare('UPDATE users SET pass_hash = ?, is_admin = 1 WHERE id = ?').run(hashPassword(pass), existing.id)
  } else {
    db.prepare('INSERT INTO users (name, pass_hash, created, is_admin) VALUES (?, ?, ?, 1)')
      .run('admin', hashPassword(pass), Date.now())
  }
}
