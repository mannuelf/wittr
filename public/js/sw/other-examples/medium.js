/* global self, caches, fetch, Request, Headers */

'use strict'

const USER_ID = "c43e6d2b812e"
const BUILD_LABEL = "24988-26df37d"
const CLIENT_VERSION = 3

// Each build version replaces these constants with new ones.
const CacheNames = {
  VERSIONED: 'versioned-' + BUILD_LABEL, // Versioned per worker.
  API: 'api', // APIs. Shared across SWs.
  FONTS: 'fonts-v2' // Fonts that almost never change.
}
const BOOTSTRAP_URL = "https://medium.com/_/web/sw-bootstrap"
const FONT_URLS = ["https://cdn-static-1.medium.com/_/fp/css/fonts-base.by5Oi_VbnwEIvhnWIsuUjA.css"]
const STATIC_URLS = ["https://cdn-static-1.medium.com/_/fp/css/main-base.xhTjq22QBKKdkjFhfwy4NA.css","https://cdn-static-1.medium.com/_/fp/icons/favicon-medium.TAS6uQ-Y7kcKgi0xjcYHXw.ico","https://cdn-static-1.medium.com/_/fp/js/main-base.bundle.pU1hk3knX5RuSw7o0HX-Tg.js","https://cdn-static-1.medium.com/_/fp/js/main-notes.bundle.FwdDd-5HxRUbLWuf3ZGUiw.js","https://cdn-static-1.medium.com/_/fp/js/main-posters.bundle.n2Q3NpzIz40S08YRQnqsDw.js","https://cdn-static-1.medium.com/_/fp/js/main-common-async.bundle.W9VZHvTxkpTmvdkLvc83Aw.js","https://cdn-static-1.medium.com/_/fp/js/main-stats.bundle.e7N9NSjmHCCgzmlv2SKd9A.js","https://cdn-static-1.medium.com/_/fp/js/main-misc-screens.bundle.2nE8g_CIDa8rqAcJ-2RKOQ.js"]
const API_URLS = ["https://medium.com/_/web/sw-bootstrap","https://medium.com/"]
const CACHED_URLS = FONT_URLS.concat(STATIC_URLS).concat(API_URLS)

self.oninstall = function (e) {
  console.log('SW install')

  e.waitUntil(
      fillAllCaches()
          .then(function () {
            return self.skipWaiting()
          })
          .catch(function (err) {
            console.error('SW install error', err)
            throw new Error('Service worker failed to load ' + err.failedUrl + ', ' + err)
          })
  )
}

function getCacheName(uri) {
  return STATIC_URLS.indexOf(uri) != -1 || uri == BOOTSTRAP_URL ? CacheNames.VERSIONED :
      FONT_URLS.indexOf(uri) != -1 ? CacheNames.FONTS :
          API_URLS.indexOf(uri) != -1 ? CacheNames.API :
              ''
}

/**
 * NOTE(nick): There's a Chrome bug where it hits the disk cache even if you
 * tell it not to with cache: 'no-store'. This breaks static resource loading
 * because it caches a version of the resource without the Access-Control CORS
 * header.
 *
 * For now, we workaround this by adding a garbage query param.
 */
function addCacheBuster(url) {
  if (url.indexOf('?') == -1) {
    return url + '?swcachebust=1'
  } else {
    return url + '&swcachebust=1'
  }
}

function maybeAddCacheBuster(url) {
  return needsCacheBusting(url) ? addCacheBuster(url) : url
}

function maybeRemoveFillCache(url) {
  return url.replace(/\?swfillcache=1$/, '')
}

function needsCacheBusting(url) {
  return STATIC_URLS.indexOf(url) != -1 || FONT_URLS.indexOf(url) != -1
}

function fillAllCaches() {
  return Promise.all(Object.keys(CacheNames).map(function (key) {
    let cacheName = CacheNames[key]
    return caches.open(cacheName).then(function (cache) {
      return fillCache(cache, cacheName)
    })
  }))
}

function fillCache(cache, name) {
  let urls = CACHED_URLS.filter(function (url) {
    return name == getCacheName(url)
  })
  return Promise.all(urls.map(function (url) {
    return addToCacheIfMissing(cache, url)
  }))
}

// We wrap cache.add* because its error reporting is terrible
// and doesn't work for no-cors requests.
// https://bugs.chromium.org/p/chromium/issues/detail?id=623063
function addToCacheIfMissing(cache, url) {
  let request = new Request(maybeAddCacheBuster(url), getOptionsForCachedUrl(url))
  return cache.match(request)
      .then(function (response) {
        if (response) {
          return true
        }
        return cache.add(request)
      })
      .catch(function (err) {
        console.error('SW cache add error', url, err)
        err.failedUrl = url
        throw err
      })
}

// See notes above about cache.add
function addToCache(cache, url) {
  let request = new Request(maybeAddCacheBuster(url), getOptionsForCachedUrl(url))
  return cache.add(request)
      .catch(function (err) {
        console.error('SW cache add error', url, err)
        err.failedUrl = url
        throw err
      })
}

// Fill the cache and return the response.
function fillCacheFromOnFetch(cache, url) {
  let request = new Request(maybeAddCacheBuster(url), getOptionsForCachedUrl(url))
  return fetch(request)
      .then(function (response) {
        if (response && response.ok) {
          cache.put(request, response.clone())
        }
        return response
      })
      .catch(function (err) {
        console.error('SW cache fill error', url, err)
        err.failedUrl = url
        throw err
      })
}

self.onactivate = function (e) {
  console.log('SW activate')
  var validCaches = {}
  Object.keys(CacheNames).forEach(function (key) {
    return validCaches[CacheNames[key]] = true
  })

  e.waitUntil(
      caches.keys()
          .then(function (currentCaches) {
            return Promise.all(currentCaches.map(function (cache) {
              if (!validCaches[cache]) {
                return caches.delete(cache)
              }
            }))
          })
          .then(function () {
            return self.clients.claim()
          })
          .catch(function (err) {
            console.error('SW onactivate', err)
            throw err
          }))
}

self.onmessage = function (e) {
  let data = e.data
  if (data['messageType'] == 'recache') {
    let uri = data['uri']
    let cacheName = getCacheName(uri)
    if (cacheName) {
      console.log('SW recaching ' + uri)
      caches.open(cacheName).then(function (cache) {
        addToCache(cache, uri)
      })
          .catch(function (err) {
            console.error('SW error recaching', err)
            throw err
          })
    }
  }

}

self.onfetch = function (e) {
  // If the user is going thru the auth flow, kill all resources with
  // credentials and disable the service worker immediately
  if (isLoginFlow(e)) {
    clearPrivilegedCache().then(kill)
    return
  }

  if (shouldServeCachedUrl(e, e.request.url)) {
    let request = e.request
    let url = request.url
    if (needsCacheBusting(url)) {
      request = new Request(addCacheBuster(url), getOptionsForCachedUrl(url))
    }
    e.respondWith(
        caches.match(request)
            .then(function (response) {
              return response || fetch(e.request)
            }, function (err) {
              // Cache match error. Fall back to a normal request.
              console.error('SW cache error', err)
              return fetch(e.request)
            }))
    return
  }

  let fillCacheUrl = shouldFillCachedUrl(e)
  if (fillCacheUrl) {
    let cacheName = getCacheName(fillCacheUrl)
    console.log('SW backfilling cache', fillCacheUrl)
    e.respondWith(
        caches.open(cacheName).then(function (cache) {
          return fillCacheFromOnFetch(cache, fillCacheUrl)
        }))
    return
  }

  if (shouldBootstrapLoad(e)) {
    console.log('SW bootstrap offline from ', e.request.url)
    e.respondWith(
        caches.match(BOOTSTRAP_URL)
            .then(function (response) {
              return response || fetch(e.request)
            }, function (err) {
              // Cache match error. Fall back to a normal request.
              console.error('SW bootstrap error', err)
              return fetch(e.request)
            }))
    return
  }
}

/**
 * Some URLs require JSON.
 */
function isJsonCachedUrl(url) {
  // BOOTSTRAP_URL is the only privileged url that should accept html
  return API_URLS.indexOf(url) != -1 && url != BOOTSTRAP_URL
}

/**
 * @return {string|boolean} The url to fill, or false otherwise.
 */
function shouldFillCachedUrl(e) {
  let url = e.request.url
  let newUrl = maybeRemoveFillCache(url)
  if (url == newUrl) {
    return false
  }

  return shouldServeCachedUrl(e, newUrl) && newUrl
}

function shouldServeCachedUrl(e, url) {
  if (e.request.mode == 'navigate' || e.isReload) {
    return false
  }

  if (CACHED_URLS.indexOf(url) == -1) {
    return false
  }

  if (isJsonCachedUrl(url) && e.request.headers.get('Accept') != 'application/json') {
    return false
  }

  return true
}

function getOptionsForCachedUrl(url) {
  let headers = new Headers()
  if (isJsonCachedUrl(url)) {
    headers.append('Accept', 'application/json')
  }

  let options = {headers: headers}
  if (API_URLS.indexOf(url) != -1) {
    options.mode = 'cors'
    options.credentials = 'include'
  } else {
    options.mode = 'cors'
  }
  return options
}

function update() {
  self.registration.update()
}

function kill() {
  self.registration.unregister()
}

function clearPrivilegedCache() {
  let clearBootstrap = caches.open(CacheNames.VERSIONED)
      .then(function (cache) {
        return cache.delete(new Request(maybeAddCacheBuster(BOOTSTRAP_URL), {mode: 'cors', credentials: 'include'}))
      })

  let clearApi = caches.open(CacheNames.API)
      .then(function (cache) {
        let urls = API_URLS.filter(function (url) {
          return url != BOOTSTRAP_URL
        })
        return Promise.all(urls.map(function (url) {
          return cache.delete(new Request(maybeAddCacheBuster(url), {mode: 'cors', credentials: 'include'}))
        }))
      })


  return Promise.all([clearBootstrap, clearApi])
      .catch(function (err) {
        console.error('SW kill error', err)
      })
}

var URL_RE = new RegExp(
    '^' +
    '(?:' +
    '([^:/?#.]+)' +
    ':)?' +
    '(?://' +
    '(?:([^/?#]*)@)?' +
    '([^/#?]*?)' +
    '(?::([0-9]+))?' +
    '(?=[/#?]|$)' +
    ')?' +
    '([^?#]+)?' +
    '(?:\\?([^#]*))?' +
    '(?:#(.*))?' +
    '$');

function isLoginFlow(e) {
  if (e.request.mode != 'navigate') {
    return false
  }

  let url = e.request.url
  let match = URL_RE.exec(url)
  let path = match && match[5] || ''
  let pathSegments = path.split('/')
  let firstSegment = pathSegments[1]
  return firstSegment == 'm'
}

function shouldBootstrapLoad(e) {
  if (e.request.mode != 'navigate') {
    return false
  }

  if (e.isReload || (e.request.cache && e.request.cache != 'default')) {
    return false
  }

  let url = e.request.url
  if (url.indexOf('swoff=true') != -1 ||
      url.indexOf('format=json') != -1) {
    return false
  }

  // Check whitelisted paths. (We will probably want to eventually port the full path matcher).
  let match = URL_RE.exec(url)
  let path = match && match[5]
  if (path === '' || path === '/') { // home
    return true
  }

  let pathSegments = path.split('/')
  if (pathSegments.length <= 1 || pathSegments[0] != '') {
    return false
  }

  if (pathSegments[2] == 'export' && pathSegments[3]) { // don't enable for export downloads
    return false
  }

  let firstSegment = pathSegments[1]
  if (firstSegment == 'p') {
    return true
  }

  if (firstSegment == 'c' || firstSegment == 'browse') { // catalog
    return true
  }

  if (firstSegment == 'me' || firstSegment[0] == '@') { // profile
    return true
  }

  if (firstSegment.indexOf('-') != -1 && firstSegment.indexOf('.') == -1) { // collection
    return true
  }

  return false
}