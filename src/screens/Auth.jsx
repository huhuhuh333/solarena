import React, { useState } from 'react'
import { doLogin, doRegister } from '../engine/net'

export default function Auth({ nav }) {
  const [mode, setMode] = useState('login')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      if (mode === 'login') await doLogin(name.trim(), password)
      else await doRegister(name.trim(), password)
      // If the gate was shown in place of a protected screen (e.g. a challenge
      // link), stay there - it re-renders logged-in. Otherwise go to the arena.
      const here = location.pathname.replace(/^\//, '')
      if (!here || here === 'login') nav('/play')
    } catch (err) {
      setError(err.message || 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-wrap">
      <div className="card auth-card">
        <div className="display" style={{ fontSize: 30, marginBottom: 4 }}>
          {mode === 'login' ? 'Back for more?' : 'Step into the arena'}
        </div>
        <p className="muted small" style={{ marginBottom: 18 }}>
          {mode === 'login'
            ? 'Log in and get back to taking pools.'
            : 'One account, one fighter name. Your record is public - make it count.'}
        </p>
        <form onSubmit={submit}>
          <div className="field">
            <label>Fighter name</label>
            <input type="text" value={name} autoFocus maxLength={20} autoComplete="username"
              placeholder="letters, digits, underscore"
              onChange={(e) => { setName(e.target.value); setError(null) }} />
          </div>
          <div className="field">
            <label>Password</label>
            <input type="password" value={password} minLength={8}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              placeholder={mode === 'register' ? 'at least 8 characters' : ''}
              onChange={(e) => { setPassword(e.target.value); setError(null) }} />
          </div>
          {error && <div className="notice notice-danger" style={{ marginBottom: 12 }}>{error}</div>}
          <button className="btn btn-gold btn-block btn-lg" type="submit" disabled={busy || !name || !password}>
            {busy ? '…' : mode === 'login' ? 'Log in' : 'Create account'}
          </button>
        </form>
        <hr className="divider" />
        {mode === 'login'
          ? <p className="small muted">New here? <button className="btn-link" onClick={() => { setMode('register'); setError(null) }}>Create an account</button> - a name and a password, and you can be on a table.</p>
          : <p className="small muted">Already have an account? <button className="btn-link" onClick={() => { setMode('login'); setError(null) }}>Log in</button></p>}
      </div>
    </div>
  )
}
