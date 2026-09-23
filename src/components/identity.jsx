// The identity card - name, bio, picture - the part of the profile that edits
// the account itself, kept apart from the scoreboard around it.
import React, { useRef, useState } from 'react'
import { useApp, mutate } from '../engine/store'
import { api } from '../engine/net'
import { Avatar } from './ui'
import { squareDataUrl } from './imagefile'

export const IdentityCard = ({ badge = null }) => {
  const app = useApp()
  const [name, setName] = useState(app.user.name)
  const [bio, setBio] = useState(app.user.bio)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState(null)
  const [avErr, setAvErr] = useState(null)
  const [avBusy, setAvBusy] = useState(false)
  const fileRef = useRef(null)

  const save = async (patch) => {
    setError(null)
    try {
      const r = await api('/api/profile', { method: 'POST', body: patch })
      mutate((s) => { s.user = r.user })
      setSaved(true)
    } catch (e) {
      setError(e.message)
      setSaved(false)
    }
  }

  const onAvatarFile = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = '' // same file can be re-picked after an error
    if (!file) return
    setAvErr(null)
    setAvBusy(true)
    try {
      const image = await squareDataUrl(file, 256)
      const r = await api('/api/profile/avatar', { method: 'POST', body: { image } })
      mutate((s) => { s.user = r.user })
    } catch (err) {
      setAvErr(err.message)
    } finally {
      setAvBusy(false)
    }
  }

  const removeAvatar = async () => {
    setAvErr(null)
    try {
      const r = await api('/api/profile/avatar', { method: 'DELETE' })
      mutate((s) => { s.user = r.user })
    } catch (err) {
      setAvErr(err.message)
    }
  }

  return (
    <div className="card">
      <div className="vs-row" style={{ marginBottom: 14 }}>
        <Avatar size={64} name={app.user.name}>{app.user.avatar}</Avatar>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 20 }}>{app.user.name}</div>
          <div className="small muted">{app.user.bio}</div>
        </div>
        {badge}
      </div>
      <div className="field">
        <label>Fighter name</label>
        <input type="text" value={name} maxLength={20} onChange={(e) => { setName(e.target.value); setSaved(false) }} />
      </div>
      <div className="field">
        <label>Short bio</label>
        <input type="text" value={bio} maxLength={60} onChange={(e) => { setBio(e.target.value); setSaved(false) }} />
      </div>
      <div className="field">
        <label>Profile picture</label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Avatar size={56} name={app.user.name}>{app.user.avatar}</Avatar>
          <button className="btn btn-sm" disabled={avBusy} onClick={() => fileRef.current?.click()}>
            {avBusy ? 'Uploading…' : 'Upload image'}
          </button>
          {String(app.user.avatar || '').startsWith('/api/avatar/') && (
            <button className="btn btn-sm" onClick={removeAvatar}>Remove</button>
          )}
          <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={onAvatarFile} />
        </div>
        <p className="small muted" style={{ marginTop: 6 }}>
          Any picture works. Cropped square and shrunk to 256px - centred faces work best. Without one, your monogram fights for you.
        </p>
        {avErr && <div className="notice notice-danger" style={{ marginTop: 8 }}>{avErr}</div>}
      </div>
      {error && <div className="notice notice-danger" style={{ marginBottom: 10 }}>{error}</div>}
      <button className="btn btn-gold" onClick={() => save({ name: name.trim(), bio })}>
        {saved ? 'Saved ✓' : 'Save profile'}
      </button>
    </div>
  )
}
