#!/usr/bin/env node
/**
 * Web Terminal — browser terminal with a real PTY.
 *
 *   node server.mjs [--port 7681] [--host 0.0.0.0] [--password secret]
 *                   [--shell /bin/bash] [--dir ~/project] [--ttl 15]
 *                   [--prefix /secret-path] [--allowed-origins https://a,https://b]
 *
 * Env equivalents: PORT, WEB_TERMINAL_PASSWORD, WEB_TERMINAL_SHELL, WEB_TERMINAL_DIR,
 *                  WEB_TERMINAL_PATH_PREFIX, WEB_TERMINAL_ALLOWED_ORIGINS
 *
 * Security model (v1.1):
 *  - Password -> POST /auth/login (same-origin AJAX) -> HttpOnly session cookie.
 *    The password never touches localStorage; WebSocket handshake requires the cookie.
 *  - Anti-curl guards: Origin + Sec-Fetch-Site + User-Agent + X-Requested-With.
 *  - Login rate limiting: 8 failures / 5 min -> 15 min lock per IP.
 *  - WebSocket Origin validation (anti-CSWSH, CWE-1385).
 *  - Hardened response headers (CSP, nosniff, DENY framing, no-referrer...).
 *  - Optional secret URL prefix (WEB_TERMINAL_PATH_PREFIX) to hide from scanners.
 */
import { createServer } from 'node:http'
import { readFileSync, existsSync, statSync, realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createHash, timingSafeEqual, randomBytes, randomUUID } from 'node:crypto'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import os from 'node:os'
import { Server } from 'socket.io'
import pty from 'node-pty'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

// ---- CLI + env config ------------------------------------------------------
const { values } = parseArgs({
  options: {
    port: { type: 'string', default: process.env.PORT || '7681' },
    host: { type: 'string', default: process.env.HOST || '0.0.0.0' },
    password: { type: 'string', default: process.env.WEB_TERMINAL_PASSWORD || '' },
    shell: { type: 'string', default: process.env.WEB_TERMINAL_SHELL || '' },
    dir: { type: 'string', default: process.env.WEB_TERMINAL_DIR || os.homedir() },
    ttl: { type: 'string', default: '15' }, // PTY keep-alive, minutes
    prefix: { type: 'string', default: process.env.WEB_TERMINAL_PATH_PREFIX || '' },
    'allowed-origins': { type: 'string', default: process.env.WEB_TERMINAL_ALLOWED_ORIGINS || '' },
    'legacy-browsers': { type: 'boolean', default: process.env.WEB_TERMINAL_LEGACY_BROWSERS === '1' },
  },
})

const PORT = Number(values.port) || 7681
const HOST = values.host
const PASSWORD = values.password || ''
const SESSION_TTL_MS = Math.max(1, Number(values.ttl) || 15) * 60 * 1000
const START_DIR = resolve(values.dir.replace(/^~(?=$|\/)/, os.homedir()))
const PREFIX = values.prefix ? '/' + values.prefix.replace(/^\/+|\/+$/g, '') : ''
const ALLOWED_ORIGINS = (values['allowed-origins'] || '')
  .split(',').map((s) => s.trim()).filter(Boolean)
const LEGACY_BROWSERS = values['legacy-browsers'] === true

const COOKIE_NAME = 'wt_session'
const AUTH_TTL_MS = 12 * 60 * 60 * 1000 // cookie session lifetime (sliding)
const LOGIN_WINDOW_MS = 5 * 60 * 1000
const LOGIN_MAX_ATTEMPTS = 8
const MAX_PTYS_PER_IP = 16

if (!existsSync(START_DIR)) {
  console.error(`[web-terminal] start dir does not exist: ${START_DIR}`)
  process.exit(1)
}

/** Shells available on this machine (from /etc/shells, existing binaries only). */
function availableShells() {
  const fallback = ['/bin/bash', '/bin/sh'].filter((s) => existsSync(s))
  try {
    const list = readFileSync('/etc/shells', 'utf8')
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('#') && existsSync(s))
      .filter((s, i, arr) => {
        try {
          return arr.findIndex((x) => existsSync(x) && existsSync(s) && realpathSync(x) === realpathSync(s)) === i
        } catch {
          return false
        }
      })
      .sort()
    return list.length ? list : fallback
  } catch {
    return fallback
  }
}

const SHELLS = availableShells()
const DEFAULT_SHELL = SHELLS.includes(values.shell) ? values.shell : (SHELLS[0] || '/bin/sh')

const info = {
  host: os.hostname(),
  user: os.userInfo().username,
  arch: os.arch(),
  platform: os.platform(),
  cpus: os.cpus().length,
  memGB: Math.round(os.totalmem() / 1024 ** 3),
  cwd: START_DIR,
  shells: SHELLS,
  defaultShell: DEFAULT_SHELL,
  authEnabled: Boolean(PASSWORD),
  version: '1.1.0',
}

/** Constant-time password check. */
function authOk(candidate) {
  if (!PASSWORD) return true
  const a = createHash('sha256').update(String(candidate ?? '')).digest()
  const b = createHash('sha256').update(PASSWORD).digest()
  return timingSafeEqual(a, b)
}

// ---------------------------------------------------------------------------
// Security helpers
// ---------------------------------------------------------------------------
function getIp(req) {
  const fwd = req.headers['x-forwarded-for']
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim()
  return req.socket?.remoteAddress || 'unknown'
}

function isHttps(req) {
  return (
    req.socket?.encrypted === true ||
    req.headers['x-forwarded-proto'] === 'https' ||
    (typeof req.headers['x-forwarded-proto'] === 'string' &&
      req.headers['x-forwarded-proto'].includes('https'))
  )
}

/**
 * Origin validation.
 *  1. Sec-Fetch-Site (forbidden header name — page JS cannot fake it):
 *     accept 'same-origin'/'none', reject 'cross-site'/'same-site'.
 *     Same-origin GET fetches carry no Origin at all, so behind
 *     origin-stripping proxies this is the only reliable browser signal.
 *  2. Legacy clients (no Sec-Fetch): Origin must match Host/X-Forwarded-Host
 *     or be in the WEB_TERMINAL_ALLOWED_ORIGINS allowlist.
 *  3. Neither signal -> non-browser client (curl, scripts) -> deny.
 */
function sameOriginOk(req) {
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string') {
    return site === 'same-origin' || site === 'none'
  }
  const origin = req.headers.origin
  if (origin && typeof origin === 'string') {
    try {
      const host = req.headers['x-forwarded-host'] || req.headers.host || ''
      if (new URL(origin).host === host) return true
    } catch {
      return false
    }
    return ALLOWED_ORIGINS.includes(origin)
  }
  return false
}

/** Reject bare HTTP clients (curl, wget, python-requests, scanners). */
function browserishOk(req) {
  const ua = req.headers['user-agent']
  if (!ua || typeof ua !== 'string' || ua.length < 4 || ua.length > 400) return false
  const site = req.headers['sec-fetch-site']
  if (site && !['same-origin', 'none'].includes(String(site))) return false
  const mode = req.headers['sec-fetch-mode']
  if (mode && !['navigate', 'cors', 'same-origin', 'websocket'].includes(String(mode))) return false
  return true
}

const API_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
}

const STATIC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    'img-src \'self\' data:; font-src \'self\'; connect-src \'self\' ws: wss:; ' +
    "frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
}

function setHeaders(res, map) {
  for (const [k, v] of Object.entries(map)) res.setHeader(k, v)
}

function json(res, status, body, extra = {}) {
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function parseCookies(header) {
  const out = {}
  if (!header || typeof header !== 'string') return out
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim())
  }
  return out
}

function cookieHeader(req, token, maxAgeSeconds) {
  const parts = [
    `${COOKIE_NAME}=${token}`,
    'Path=' + (PREFIX || '/'),
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ]
  if (isHttps(req)) parts.push('Secure')
  return parts.join('; ')
}

// ---------------------------------------------------------------------------
// Auth sessions (server-side store + HttpOnly cookie)
// ---------------------------------------------------------------------------
const authSessions = new Map() // token -> { ip, ua, createdAt, lastSeen, expiresAt }

function createAuthSession(ip, ua) {
  const token = randomBytes(32).toString('base64url')
  const now = Date.now()
  authSessions.set(token, { ip, ua, createdAt: now, lastSeen: now, expiresAt: now + AUTH_TTL_MS })
  if (authSessions.size > 1000) {
    const now2 = Date.now()
    for (const [t, s] of authSessions) if (s.expiresAt < now2) authSessions.delete(t)
    while (authSessions.size > 1000) authSessions.delete(authSessions.keys().next().value)
  }
  return token
}

function getAuthSession(token) {
  if (!token || typeof token !== 'string' || token.length > 128) return null
  const s = authSessions.get(token)
  if (!s) return null
  const now = Date.now()
  if (s.expiresAt < now) {
    authSessions.delete(token)
    return null
  }
  s.lastSeen = now
  s.expiresAt = now + AUTH_TTL_MS
  return s
}

setInterval(() => {
  const now = Date.now()
  for (const [t, s] of authSessions) if (s.expiresAt < now) authSessions.delete(t)
}, 10 * 60 * 1000).unref()

// ---------------------------------------------------------------------------
// Login rate limiting
// ---------------------------------------------------------------------------
const loginFails = new Map() // ip -> { count, windowStart, lockUntil }

function loginRateOk(ip) {
  const now = Date.now()
  const st = loginFails.get(ip)
  if (!st) return { ok: true }
  if (st.lockUntil && st.lockUntil > now) {
    return { ok: false, retryAfter: Math.ceil((st.lockUntil - now) / 1000) }
  }
  if (now - st.windowStart > LOGIN_WINDOW_MS) {
    loginFails.delete(ip)
    return { ok: true }
  }
  return { ok: true }
}

function loginFail(ip) {
  const now = Date.now()
  const st = loginFails.get(ip) || { count: 0, windowStart: now, lockUntil: 0 }
  if (now - st.windowStart > LOGIN_WINDOW_MS) {
    st.count = 0
    st.windowStart = now
  }
  st.count += 1
  if (st.count >= LOGIN_MAX_ATTEMPTS) {
    st.lockUntil = now + 15 * 60 * 1000
    st.count = 0
    st.windowStart = now
  }
  loginFails.set(ip, st)
  return st
}

function readBody(req, limit = 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('body_too_large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// ---------------------------------------------------------------------------
// Static files (public/)
// ---------------------------------------------------------------------------
const PUBLIC_DIR = join(__dirname, 'public')
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

async function serveStatic(res, urlPath) {
  let p = urlPath || '/'
  if (p === '/') p = '/index.html'
  const filePath = normalize(join(PUBLIC_DIR, p))
  if (!filePath.startsWith(PUBLIC_DIR + sep) && filePath !== PUBLIC_DIR) {
    res.writeHead(403).end('Forbidden')
    return
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found')
    return
  }
  setHeaders(res, STATIC_HEADERS)
  res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' })
  try {
    const buf = await readFile(filePath)
    // Inject the secret path prefix so the frontend knows where the API lives
    if (PREFIX && extname(filePath) === '.html') {
      const html = buf.toString('utf8').replace('<body', `<body data-prefix="${PREFIX}"`)
      res.end(html)
    } else {
      res.end(buf)
    }
  } catch {
    res.end()
  }
}

// ---------------------------------------------------------------------------
// HTTP API (static + /auth/*)
// ---------------------------------------------------------------------------
async function handleRequest(req, res) {
  let urlPath = (req.url || '/').split('?')[0]
  try {
    urlPath = decodeURIComponent(urlPath)
  } catch { /* keep raw */ }

  // Secret prefix gate: everything outside the prefix looks like a 404 site
  if (PREFIX) {
    if (urlPath === PREFIX) {
      // Normalize to trailing slash so relative asset URLs resolve correctly
      res.writeHead(302, { Location: PREFIX + '/' })
      res.end()
      return
    }
    if (!urlPath.startsWith(PREFIX + '/')) {
      setHeaders(res, API_HEADERS)
      return json(res, 404, { error: 'not_found' })
    }
    urlPath = urlPath.slice(PREFIX.length)
  }

  // ---- login --------------------------------------------------------------
  if (urlPath === '/auth/login' && req.method === 'POST') {
    setHeaders(res, API_HEADERS)
    const ip = getIp(req)

    if (!sameOriginOk(req)) return json(res, 403, { error: 'forbidden' })
    if (!browserishOk(req)) return json(res, 403, { error: 'forbidden' })
    if (!LEGACY_BROWSERS && !req.headers['sec-fetch-site']) {
      return json(res, 403, { error: 'forbidden' })
    }
    if (req.headers['x-requested-with'] !== 'XMLHttpRequest') {
      return json(res, 403, { error: 'forbidden' })
    }

    const rate = loginRateOk(ip)
    if (!rate.ok) {
      return json(res, 429, { error: 'too_many_attempts' }, { 'Retry-After': String(rate.retryAfter) })
    }

    let password = ''
    try {
      const raw = await readBody(req, 1024)
      const parsed = JSON.parse(raw || '{}')
      if (typeof parsed.password === 'string') password = parsed.password
    } catch (err) {
      if (err.message === 'body_too_large') return json(res, 413, { error: 'too_large' })
      return json(res, 400, { error: 'bad_json' })
    }

    if (!authOk(password)) {
      const st = loginFail(ip)
      const delay = Math.min(100 + st.count * 150, 2000)
      await new Promise((r) => setTimeout(r, delay))
      return json(res, 401, { error: 'bad_password' })
    }

    loginFails.delete(ip)
    const token = createAuthSession(ip, String(req.headers['user-agent'] || '').slice(0, 300))
    return json(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(req, token, AUTH_TTL_MS / 1000) })
  }

  // ---- check --------------------------------------------------------------
  if (urlPath === '/auth/check' && req.method === 'GET') {
    setHeaders(res, API_HEADERS)
    const site = req.headers['sec-fetch-site']
    if (site && !['same-origin', 'none'].includes(String(site))) {
      return json(res, 403, { error: 'forbidden' })
    }
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME]
    const sess = getAuthSession(token)
    if (!PASSWORD) return json(res, 200, { ok: true, auth: false, info })
    if (!sess) return json(res, 401, { error: 'unauthorized' })
    return json(res, 200, { ok: true, auth: true, info })
  }

  // ---- logout -------------------------------------------------------------
  if (urlPath === '/auth/logout' && req.method === 'POST') {
    setHeaders(res, API_HEADERS)
    if (PASSWORD && req.headers['x-requested-with'] !== 'XMLHttpRequest') {
      return json(res, 403, { error: 'forbidden' })
    }
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME]
    if (token) authSessions.delete(token)
    return json(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(req, '', 0) })
  }

  await serveStatic(res, urlPath)
}

const httpServer = createServer((req, res) => {
  handleRequest(req, res).catch(() => {
    if (!res.headersSent) json(res, 500, { error: 'internal' })
  })
})

// ---- socket.io -------------------------------------------------------------
const io = new Server(httpServer, {
  path: (PREFIX || '') + '/ws/',
  cors: { origin: ALLOWED_ORIGINS, methods: ['GET', 'POST'], credentials: true },
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e6,
})

// sessionId -> { pty, shell, cleanupTimer, ip }
const sessions = new Map()

function sessionSockets(sessionId) {
  return io.sockets.adapter.rooms.get(sessionId) ?? new Set()
}

function killSession(sessionId, reason) {
  const s = sessions.get(sessionId)
  if (!s) return
  if (s.cleanupTimer) clearTimeout(s.cleanupTimer)
  if (s.pty) {
    try { s.pty.kill() } catch { /* already dead */ }
    s.pty = null
  }
  sessions.delete(sessionId)
  console.log(`[session] ${sessionId.slice(0, 8)} destroyed (${reason})`)
}

function countSessionsForIp(ip) {
  let n = 0
  for (const s of sessions.values()) if (s.ip === ip) n += 1
  return n
}

function spawnShell(sessionId, { shell, cols = 80, rows = 24 } = {}) {
  const s = sessions.get(sessionId)
  if (!s) return
  if (s.pty) {
    try { s.pty.kill() } catch { /* already dead */ }
    s.pty = null
  }

  const sh = SHELLS.includes(shell) ? shell : DEFAULT_SHELL
  const env = { ...process.env }
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.LANG = env.LANG || 'C.UTF-8'
  env.WEB_TERMINAL = '1'
  // Make ~/.local/bin available inside the web terminal as well
  env.PATH = `${os.homedir()}/.local/bin:${env.PATH || '/usr/local/bin:/usr/bin:/bin'}`

  const term = pty.spawn(sh, [], {
    name: 'xterm-256color',
    cols: Math.min(Math.max(cols, 2), 500),
    rows: Math.min(Math.max(rows, 2), 300),
    cwd: START_DIR,
    env,
  })

  s.pty = term
  s.shell = sh

  term.onData((data) => {
    io.to(sessionId).emit('terminal:output', data)
  })

  term.onExit(({ exitCode }) => {
    if (s.pty === term) s.pty = null
    io.to(sessionId).emit('terminal:exit', { exitCode })
    console.log(`[session] ${sessionId.slice(0, 8)} shell pid=${term.pid} exited code=${exitCode}`)
  })

  io.to(sessionId).emit('terminal:ready', {
    pid: term.pid,
    cols,
    rows,
    info,
    shell: sh,
    reattached: false,
  })
  console.log(`[session] ${sessionId.slice(0, 8)} shell spawned pid=${term.pid} shell=${sh}`)
}

// WebSocket handshake: Origin validation (anti-CSWSH) + cookie session check
io.use((socket, next) => {
  const req = socket.request
  if (!sameOriginOk(req)) return next(new Error('origin denied'))
  if (PASSWORD) {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME]
    const sess = getAuthSession(token)
    if (!sess) return next(new Error('unauthorized'))
    socket.data.ip = sess.ip
  } else {
    socket.data.ip = getIp(req)
  }
  next()
})

io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id} (${socket.data.ip || 'unknown'})`)

  let floodCount = 0
  let floodStart = Date.now()
  const FLOOD_LIMIT = 800

  socket.on('terminal:start', ({ sessionId, shell, cols, rows } = {}) => {
    if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9_-]{6,64}$/.test(sessionId)) {
      sessionId = `s-${randomUUID().replace(/-/g, '')}`
    }
    const ip = socket.data.ip || 'unknown'
    if (countSessionsForIp(ip) >= MAX_PTYS_PER_IP && !sessions.has(sessionId)) {
      socket.emit('terminal:error', { message: 'too many sessions from this address' })
      return
    }
    socket.join(sessionId)
    socket.data.sessionId = sessionId

    let s = sessions.get(sessionId)
    if (s && s.pty) {
      socket.emit('terminal:ready', {
        pid: s.pty.pid,
        cols: Number(cols) || 80,
        rows: Number(rows) || 24,
        info,
        shell: s.shell,
        reattached: true,
      })
      console.log(`[session] ${sessionId.slice(0, 8)} reattached by ${socket.id}`)
      return
    }

    if (!s) {
      s = { pty: null, shell: DEFAULT_SHELL, cleanupTimer: null, ip }
      sessions.set(sessionId, s)
    }
    s.ip = s.ip || ip
    if (s.cleanupTimer) {
      clearTimeout(s.cleanupTimer)
      s.cleanupTimer = null
    }
    try {
      spawnShell(sessionId, { shell, cols, rows })
    } catch (err) {
      console.error(`[${socket.id}] spawn failed:`, err.message)
      socket.emit('terminal:exit', { exitCode: -1 })
    }
  })

  socket.on('terminal:input', (data) => {
    const now = Date.now()
    if (now - floodStart > 5000) {
      floodStart = now
      floodCount = 0
    }
    floodCount += 1
    if (floodCount > FLOOD_LIMIT) return
    const s = sessions.get(socket.data.sessionId)
    if (s?.pty && typeof data === 'string' && data.length <= 65536) s.pty.write(data)
  })

  socket.on('terminal:resize', ({ cols, rows } = {}) => {
    const s = sessions.get(socket.data.sessionId)
    const c = Math.min(Math.max(Number(cols) || 0, 2), 500)
    const r = Math.min(Math.max(Number(rows) || 0, 2), 300)
    if (s?.pty && c >= 2 && r >= 2) {
      try { s.pty.resize(c, r) } catch { /* shell may have just exited */ }
    }
  })

  socket.on('terminal:new', ({ shell, cols, rows } = {}) => {
    const sessionId = socket.data.sessionId
    const s = sessions.get(sessionId)
    if (!s) return
    if (s.cleanupTimer) {
      clearTimeout(s.cleanupTimer)
      s.cleanupTimer = null
    }
    try {
      spawnShell(sessionId, { shell: shell || s.shell, cols, rows })
    } catch (err) {
      console.error(`[${socket.id}] respawn failed:`, err.message)
    }
  })

  socket.on('terminal:close', () => {
    const sessionId = socket.data.sessionId
    if (sessionId) killSession(sessionId, 'closed by client')
  })

  socket.on('disconnect', () => {
    const sessionId = socket.data.sessionId
    if (sessionId && sessionSockets(sessionId).size === 0) {
      const s = sessions.get(sessionId)
      if (s && !s.cleanupTimer) {
        s.cleanupTimer = setTimeout(() => killSession(sessionId, 'ttl expired'), SESSION_TTL_MS)
      }
    }
    console.log(`[disconnect] ${socket.id}`)
  })

  socket.on('error', (err) => {
    console.error(`[${socket.id}] socket error:`, err?.message || err)
  })
})

httpServer.listen(PORT, HOST, () => {
  console.log('')
  console.log('  ┌─────────────────────────────────────────────┐')
  console.log('  │  Web Terminal v1.1 запущен                  │')
  console.log(`  │  → http://localhost:${String(PORT).padEnd(21, ' ')}│`)
  console.log(`  │  shell: ${DEFAULT_SHELL.padEnd(36, ' ')}│`)
  console.log(`  │  dir:  ${START_DIR.padEnd(37, ' ')}│`)
  if (PREFIX) console.log(`  │  path: ${PREFIX.padEnd(37, ' ')}│`)
  console.log(`  │  auth: ${(PASSWORD ? 'cookie-сессия + пароль' : 'выключен').padEnd(36, ' ')}│`)
  console.log('  └─────────────────────────────────────────────┘')
  console.log('')
  if (!PASSWORD) {
    console.log('  ⚠ Пароль не задан — терминал открыт всем, у кого есть ссылка.')
    console.log('    Задайте: WEB_TERMINAL_PASSWORD=секрет node server.mjs')
    console.log('')
  }
})

process.on('SIGTERM', () => {
  console.log('[web-terminal] SIGTERM, shutting down...')
  io.disconnectSockets(true)
  httpServer.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 2000)
})
