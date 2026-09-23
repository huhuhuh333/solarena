// Who is freezing the clock?
//
// Everything the server does runs on one thread with the per-second market
// tick. Any synchronous stretch longer than a second shows up to a player as a
// duel timer that stops. This watches the event loop and, when it stalls,
// names whatever was marked as running - so the answer is measured, not
// guessed at.

const st = { last: Date.now(), current: null, phase: null, worst: [], enabled: true }
const SAMPLE_MS = 200
const REPORT_MS = 900

// Mark a synchronous stretch: mark('label', () => …). Nested marks keep the
// innermost label, which is the one that actually did the work.
export const mark = (label, fn) => {
  const prev = st.current
  st.current = label
  const t0 = Date.now()
  try { return fn() } finally {
    const ms = Date.now() - t0
    if (ms > REPORT_MS) note(label, ms)
    st.current = prev
  }
}

// Async version. It deliberately does NOT claim the current label: an await
// lasting a minute would otherwise be blamed for every unrelated stall that
// happened during it, which is exactly how the first pass at this mislabelled
// its findings. It only records that the phase is in flight.
export const markAsync = async (label, fn) => {
  st.phase = label
  try { return await fn() } finally { if (st.phase === label) st.phase = null }
}

const note = (label, ms) => {
  const full = st.phase && label === '(unmarked)' ? `(unmarked, while ${st.phase} was in flight)` : label
  st.worst = [...st.worst, { label: full, ms, at: Date.now() }]
    .sort((a, b) => b.ms - a.ms).slice(0, 8)
  console.log(`[loop] BLOCKED ${ms}ms during: ${full}`)
}

export const startBlockWatch = () => {
  setInterval(() => {
    const now = Date.now()
    const lag = now - st.last - SAMPLE_MS
    if (lag > REPORT_MS) note(st.current || '(unmarked)', lag)
    st.last = now
  }, SAMPLE_MS).unref?.()
  console.log('[loop] block watch on - stalls over 0.9s will be named')
}

export const blockReport = () => ({ worst: st.worst, current: st.current, phase: st.phase })
