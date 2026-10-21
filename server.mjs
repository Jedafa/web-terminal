#!/usr/bin/env node
/**
 * Web Terminal — browser terminal with a real PTY.
 *
 *   node server.mjs [--port 7681] [--host 0.0.0.0] [--password secret]
 *                   [--shell /bin/bash] [--dir ~/project] [--ttl 15]
 *
 * Env equivalents: PORT, WEB_TERMINAL_PASSWORD, WEB_TERMINAL_SHELL, WEB_TERMINAL_DIR
 */
import { createServer } from 'node:http'
import { readFileSync, existsSync, statSync, realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto'
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
    ttl: { type: 'string', default: '15' }, // session keep-alive, minutes
  },
})

const PORT = Number(values.port) || 7681
const HOST = values.host
const PASSWORD = values.password || ''
const SESSION_TTL_MS = Math.max(1, Number(values.ttl) || 15) * 60 * 1000
const START_DIR = resolve(values.dir.replace(/^~(?=$|\/)/, os.homedir()))

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
}

/** Constant-time password check. */
function authOk(candidate) {
  if (!PASSWORD) return true
  const a = createHash('sha256').update(String(candidate ?? '')).digest()
  const b = createHash('sha256').update(PASSWORD).digest()
  return timingSafeEqual(a, b)
}

// ---- Static files (public/) ------------------------------------------------
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

function serveStatic(req, res) {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0])
  if (urlPath === '/') urlPath = '/index.html'
  const filePath = normalize(join(PUBLIC_DIR, urlPath))
  if (!filePath.startsWith(PUBLIC_DIR + sep) && filePath !== PUBLIC_DIR) {
    res.writeHead(403).end('Forbidden')
    return
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found')
    return
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' })
  readFile(filePath).then((buf) => res.end(buf)).catch(() => res.end())
}

const httpServer = createServer((req, res) => {
  // socket.io handles its own endpoints via path '/ws/'; everything else is static
  serveStatic(req, res)
})

// ---- socket.io -------------------------------------------------------------
const io = new Server(httpServer, {
  path: '/ws/',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 5e6,
})

// sessionId -> { pty, shell, cleanupTimer }
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

io.use((socket, next) => {
  if (authOk(socket.handshake.auth?.password)) return next()
  next(new Error('unauthorized'))
})

io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id} (${socket.handshake.address})`)

  socket.on('terminal:start', ({ sessionId, shell, cols, rows } = {}) => {
    if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9_-]{6,64}$/.test(sessionId)) {
      sessionId = `s-${randomUUID().replace(/-/g, '')}`
    }
    socket.join(sessionId)
    socket.data.sessionId = sessionId

    let s = sessions.get(sessionId)
    if (s && s.pty) {
      // Reattach: shell is still alive
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
      s = { pty: null, shell: DEFAULT_SHELL, cleanupTimer: null }
      sessions.set(sessionId, s)
    }
    if (s.cleanupTimer) {
      clearTimeout(s.cleanupTimer)
      s.cleanupTimer = null
    }
    try {
      spawnShell(sessionId, { shell, cols, rows })
    } catch (err) {
      console.error(`[${socket.id}] spawn failed:`, err)
      socket.emit('terminal:exit', { exitCode: -1, error: String(err) })
    }
  })

  socket.on('terminal:input', (data) => {
    const s = sessions.get(socket.data.sessionId)
    if (s?.pty && typeof data === 'string') s.pty.write(data)
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
      console.error(`[${socket.id}] respawn failed:`, err)
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
    console.error(`[${socket.id}] socket error:`, err)
  })
})

httpServer.listen(PORT, HOST, () => {
  console.log('')
  console.log('  ┌─────────────────────────────────────────────┐')
  console.log('  │  Web Terminal запущен                       │')
  console.log(`  │  → http://localhost:${String(PORT).padEnd(21, ' ')}│`)
  console.log(`  │  shell: ${DEFAULT_SHELL.padEnd(36, ' ')}│`)
  console.log(`  │  dir:  ${START_DIR.padEnd(37, ' ')}│`)
  console.log(`  │  auth: ${(PASSWORD ? 'включён (пароль из config)' : 'выключен').padEnd(36, ' ')}│`)
  console.log('  └─────────────────────────────────────────────┘')
  console.log('')
  if (!PASSWORD) {
    console.log('  ⚠ Пароль не задан — терминал открыт всем, у кого есть ссылка.')
    console.log('    Задайте: WEB_TERMINAL_PASSWORD=секрет node server.mjs')
    console.log('')
  }
})
