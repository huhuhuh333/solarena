// Path routing, in one place. The app used to live behind a hash (#/play) -
// invisible to search engines, which see a fragment as one page. Routes are
// real paths now (/play, /challenge/CODE); the server serves the shell for
// any of them, so a refresh or a shared link lands exactly where it points.
//
// Old #/ links keep working forever: index.html rewrites the hash into a path
// before anything reads the URL, and the hashchange listener below catches any
// runtime straggler that still assigns location.hash.

// Same shape useRoute always produced: parts are NOT decoded, exactly as they
// weren't under the hash - consumers that need a decoded segment already call
// decodeURIComponent themselves, and decoding twice would corrupt names that
// legitimately contain a % sequence.
export const parseRoute = () => {
  const parts = location.pathname.replace(/^\//, '').split('/').filter(Boolean)
  return { screen: parts[0] || '', params: parts.slice(1) }
}

// Fired after every programmatic navigation; useRoute listens for it. popstate
// is deliberately separate: on back/forward the browser restores the scroll
// position itself, and scrolling to top there would fight it.
const NAV_EVENT = 'app:navigate'

export const nav = (path) => {
  const to = String(path).startsWith('/') ? String(path) : '/' + String(path)
  // Same-route click is a no-op, as it was when assigning an identical hash.
  if (location.pathname === to) return
  history.pushState(null, '', to)
  window.dispatchEvent(new Event(NAV_EVENT))
}

export const listenRoute = (onChange) => {
  const onPop = () => onChange(parseRoute())
  const onNav = () => { onChange(parseRoute()); window.scrollTo(0, 0) }
  window.addEventListener('popstate', onPop)
  window.addEventListener(NAV_EVENT, onNav)
  return () => {
    window.removeEventListener('popstate', onPop)
    window.removeEventListener(NAV_EVENT, onNav)
  }
}

// One document-level interceptor instead of an onClick on every <a>: any
// same-origin path link becomes an in-app navigation, and a link this file has
// never heard of still works - it just rides a full page load through the
// server's SPA fallback instead of breaking.
export const initRouter = () => {
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    const a = e.target instanceof Element ? e.target.closest('a') : null
    if (!a || a.target || a.hasAttribute('download')) return
    const href = a.getAttribute('href')
    // Only rooted paths. '//host' is protocol-relative (external), anything
    // else (https:, mailto:, plain '#') keeps its native behaviour.
    if (!href || !href.startsWith('/') || href.startsWith('//')) return
    e.preventDefault()
    nav(href)
  })

  // Runtime shim: code that still assigns location.hash = '/x' (or an old
  // bookmark script) turns into a clean path navigation instead of a broken
  // half-state. replaceState, not push - the hash version of the URL is not a
  // place anyone should be able to go "back" to.
  window.addEventListener('hashchange', () => {
    if (!location.hash.startsWith('#/')) return
    history.replaceState(null, '', location.hash.slice(1))
    window.dispatchEvent(new Event(NAV_EVENT))
  })
}
