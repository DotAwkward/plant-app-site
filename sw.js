/**
 * Potting Bench's service worker: once the game has been opened, it opens offline.
 *
 * - Page loads: network first, so a new release is picked up whenever there is
 *   a connection, falling back to the cached copy when there isn't.
 * - Everything else from this origin: cache first. Vite gives built files
 *   content-hashed names, so a cached file is never stale. A new release just
 *   refers to new names.
 *
 * Bump VERSION whenever the caching logic in this file changes.
 */
const VERSION = 'v3'
const CACHE = `sprout-${VERSION}`

/**
 * Ignore Vary when matching. Some hosts send `Vary: Origin`, and a module
 * <script> request carries an Origin header that the request stored at install
 * time did not, so a normal lookup misses and the game fails to start
 * offline. Everything in this cache is this site's own static files, so the
 * varying header never changes what the right response is.
 */
const MATCH = { ignoreVary: true }

/** Files the page needs that the HTML itself doesn't mention. */
const EXTRAS = [
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE)
      // Cache the page and everything it references, so a single visit is
      // enough to play offline afterwards.
      const res = await fetch('./', { cache: 'no-cache' })
      const html = await res.clone().text()
      await cache.put('./', res)
      await cache.addAll([...new Set([...localRefs(html), ...EXTRAS])])
    })(),
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Cache Storage is shared by every app on this origin (dotawkward.github.io),
      // so only clear out this game's own old caches (named sprout-*).
      const names = await caches.keys()
      const old = names.filter((n) => n.startsWith('sprout-') && n !== CACHE)
      await Promise.all(old.map((n) => caches.delete(n)))
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  if (new URL(req.url).origin !== self.location.origin) return

  if (req.mode === 'navigate') {
    event.respondWith(fromNetworkThenCache(req))
    return
  }
  event.respondWith(fromCacheThenNetwork(req))
})

async function fromNetworkThenCache(req) {
  const cache = await caches.open(CACHE)
  try {
    const res = await fetch(req, { cache: 'no-cache' })
    if (res.ok) {
      await cache.put('./', res.clone())
      pruneOldAssets(cache, await res.clone().text())
    }
    return res
  } catch {
    // Offline: every page load gets the same shell, query string and all, so
    // a link like ./?fast still works without a connection.
    return (await cache.match('./', MATCH)) ?? Response.error()
  }
}

async function fromCacheThenNetwork(req) {
  const cache = await caches.open(CACHE)
  const cached = await cache.match(req, MATCH)
  if (cached) return cached
  const res = await fetch(req)
  if (res.ok) await cache.put(req, res.clone())
  return res
}

/**
 * Drop built assets the current page no longer refers to. Without this,
 * every release would leave its old bundle behind in the cache forever.
 */
async function pruneOldAssets(cache, html) {
  const wanted = new Set(localRefs(html).map((u) => new URL(u, self.location).pathname))
  for (const req of await cache.keys()) {
    const path = new URL(req.url).pathname
    if (path.includes('/assets/') && !wanted.has(path)) await cache.delete(req)
  }
}

/** Same-origin src/href values from an HTML document. */
function localRefs(html) {
  return [...html.matchAll(/(?:src|href)="([^"#]+)"/g)]
    .map((m) => m[1])
    .filter((u) => !/^([a-z]+:)?\/\//i.test(u) && !u.startsWith('data:'))
}
