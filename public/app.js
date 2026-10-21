/* Web Terminal — vanilla frontend (no build step required) */
/* eslint-disable no-undef */
(() => {
  'use strict'

  const LS_PASSWORD = 'wt-password'
  const LS_TABS = 'wt-tabs'
  const LS_SHELL = 'wt-shell'
  const MAX_TABS = 8

  const QUICK_COMMANDS = ['uname -a', 'df -h', 'free -h', 'whoami', 'ls -la ~/.local/bin']

  const XTERM_THEME = {
    background: '#0a0a0b',
    foreground: '#e7e7ea',
    cursor: '#34d399',
    cursorAccent: '#0a0a0b',
    selectionBackground: '#3f3f4666',
    black: '#27272a',
    red: '#f87171',
    green: '#4ade80',
    yellow: '#facc15',
    blue: '#7dd3fc',
    magenta: '#f0abfc',
    cyan: '#67e8f9',
    white: '#e4e4e7',
    brightBlack: '#52525b',
    brightRed: '#fca5a5',
    brightGreen: '#86efac',
    brightYellow: '#fde047',
    brightBlue: '#bae6fd',
    brightMagenta: '#f5d0fe',
    brightCyan: '#a5f3fc',
    brightWhite: '#fafafa',
  }

  // ---- DOM ------------------------------------------------------------------
  const $ = (id) => document.getElementById(id)
  const authEl = $('auth')
  const authForm = $('auth-form')
  const authPass = $('auth-pass')
  const authError = $('auth-error')
  const appEl = $('app')
  const statusDot = $('status-dot')
  const statusText = $('status-text')
  const hostBadge = $('host-badge')
  const tabsEl = $('tabs')
  const tabbarEl = $('tabbar')
  const shellSelect = $('shell-select')
  const termArea = $('term-area')
  const quickbar = $('quickbar')

  // ---- State ----------------------------------------------------------------
  let hostInfo = null
  let tabs = []
  let activeTabId = ''
  const sockets = new Map()  // tabId -> socket
  const terms = new Map()    // tabId -> { term, fit, ro }
  const containers = new Map() // tabId -> HTMLElement

  // ---- Helpers ----------------------------------------------------------------
  const basename = (s) => (s || '').split('/').pop() || 'shell'

  const uid = () =>
    (window.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : 't-' + Math.random().toString(36).slice(2) + Date.now().toString(36)

  function loadTabs() {
    try {
      const raw = JSON.parse(localStorage.getItem(LS_TABS) || '[]')
      if (Array.isArray(raw) && raw.length && raw.every((t) => t && typeof t.id === 'string')) {
        return raw.slice(0, MAX_TABS).map((t) => ({ id: t.id, shell: t.shell || '' }))
      }
    } catch { /* corrupted storage */ }
    return [{ id: uid(), shell: '' }]
  }

  function persistTabs() {
    localStorage.setItem(LS_TABS, JSON.stringify(tabs))
    if (shellSelect.value) localStorage.setItem(LS_SHELL, shellSelect.value)
  }

  function banner(term, shell, reattached) {
    const s = basename(shell)
    term.writeln('\x1b[1;32m  ▄▄▄· ▄▄· ▄▄▄ .▄▄▄      Web Terminal\x1b[0m')
    term.writeln('\x1b[1;32m  ▐█ ▄█▐█ ▌▪▀▄.▀·▀▄.▀     реальный shell в браузере\x1b[0m')
    term.writeln('\x1b[2m  ─────────────────────────────────────────────────\x1b[0m')
    if (reattached) {
      term.writeln(`\x1b[2m  Сессия восстановлена, shell (${s}) всё ещё работает\x1b[0m`)
    } else {
      term.writeln(`\x1b[2m  Shell: ${s} · exit завершит shell · «Новый shell» перезапустит\x1b[0m`)
    }
    term.writeln('')
  }

  function setStatus(cls, text) {
    statusDot.className = `dot ${cls}`
    statusText.textContent = text
  }

  function setConn(connected, connecting) {
    if (connected) setStatus('dot-green', 'на связи')
    else if (connecting) setStatus('dot-amber', 'подключение…')
    else setStatus('dot-red', 'нет связи')
  }

  // ---- Sockets ----------------------------------------------------------------
  function ensureSocket(tab, defaultShell) {
    if (sockets.has(tab.id)) return
    const socket = io({
      path: '/ws/',
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 8,
      reconnectionDelay: 1000,
      timeout: 10000,
      auth: { password: localStorage.getItem(LS_PASSWORD) || '' },
    })
    sockets.set(tab.id, socket)

    socket.on('connect', () => {
      setConn(true, false)
      socket.emit('terminal:start', {
        sessionId: tab.id,
        shell: tab.shell || defaultShell,
        cols: 80,
        rows: 24,
      })
    })

    socket.on('disconnect', () => {
      markAlive(tab.id, false)
      if (tab.id === activeTabId) setConn(false, false)
    })

    socket.on('connect_error', (err) => {
      if (String(err && err.message || '').includes('unauthorized')) {
        sockets.forEach((s) => s.close())
        showAuth(localStorage.getItem(LS_PASSWORD) ? 'Неверный пароль' : '')
      }
    })

    socket.on('terminal:ready', ({ info: i, shell, reattached }) => {
      hostInfo = i
      renderHostBadge()
      renderShellOptions()
      markAlive(tab.id, true)
      if (tab.id === activeTabId) setConn(true, false)
      const entry = terms.get(tab.id)
      if (entry) {
        if (!reattached) {
          entry.term.reset()
          banner(entry.term, shell, false)
        } else {
          entry.term.writeln('\x1b[2m─ сессия восстановлена ─\x1b[0m\r\n')
        }
      }
    })

    socket.on('terminal:output', (data) => {
      const entry = terms.get(tab.id)
      if (entry) entry.term.write(data)
    })

    socket.on('terminal:exit', ({ exitCode }) => {
      markAlive(tab.id, false)
      const entry = terms.get(tab.id)
      if (entry) {
        entry.term.write(`\r\n\x1b[2m─ shell завершён (код ${exitCode}). «Новый shell» — запустить снова ─\r\n\x1b[0m`)
      }
    })
  }

  function markAlive(tabId, on) {
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab) return
    tab.alive = on
    renderTabs()
  }

  // ---- xterm ----------------------------------------------------------------
  function ensureTerm(tabId) {
    if (terms.has(tabId)) return terms.get(tabId)
    const container = containers.get(tabId)
    if (!container) return null

    const term = new window.Terminal({
      fontFamily: "'JetBrains Mono', 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 14,
      lineHeight: 1.25,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 8000,
      theme: XTERM_THEME,
    })
    const fit = new window.FitAddon.FitAddon()
    term.loadAddon(fit)
    term.open(container)
    term.onData((data) => {
      const s = sockets.get(tabId)
      if (s) s.emit('terminal:input', data)
    })

    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
        const s = sockets.get(tabId)
        if (s) s.emit('terminal:resize', { cols: term.cols, rows: term.rows })
      } catch { /* transient */ }
    })
    ro.observe(container)

    const entry = { term, fit, ro }
    terms.set(tabId, entry)
    return entry
  }

  function activateTab(tabId) {
    activeTabId = tabId
    renderTabs()
    containers.forEach((el, id) => {
      el.style.display = id === tabId ? 'block' : 'none'
    })
    requestAnimationFrame(() => {
      const entry = ensureTerm(tabId)
      if (!entry) return
      try {
        entry.fit.fit()
        const s = sockets.get(tabId)
        if (s) s.emit('terminal:resize', { cols: entry.term.cols, rows: entry.term.rows })
      } catch { /* not laid out yet */ }
      entry.term.focus()
    })
  }

  // ---- Rendering ----------------------------------------------------------------
  function renderTabs() {
    tabsEl.innerHTML = ''
    tabs.forEach((tab, i) => {
      const el = document.createElement('div')
      el.className = 'tab ' + (tab.id === activeTabId ? 'active ' : '') + (tab.alive ? 'on' : 'off')
      el.setAttribute('role', 'tab')
      el.setAttribute('aria-selected', String(tab.id === activeTabId))

      const dot = document.createElement('span')
      dot.className = 'dot'
      el.appendChild(dot)

      const name = document.createElement('span')
      name.className = 'tab-name'
      name.textContent = `${basename(tab.shell || (hostInfo && hostInfo.defaultShell) || 'shell')}·${i + 1}`
      el.appendChild(name)

      if (tabs.length > 1) {
        const close = document.createElement('button')
        close.className = 'tab-close'
        close.setAttribute('aria-label', `Закрыть вкладку ${i + 1}`)
        close.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>'
        close.addEventListener('click', (e) => {
          e.stopPropagation()
          closeTab(tab.id)
        })
        el.appendChild(close)
      }

      el.addEventListener('click', () => activateTab(tab.id))
      tabsEl.appendChild(el)
    })
  }

  function renderHostBadge() {
    if (!hostInfo) return
    hostBadge.textContent = `${hostInfo.user}@${hostInfo.host} · ${hostInfo.platform}/${hostInfo.arch} · ${hostInfo.cpus} vCPU · ${hostInfo.memGB} GB`
    hostBadge.classList.remove('hidden')
  }

  function renderShellOptions() {
    if (!hostInfo) return
    const current = shellSelect.value || localStorage.getItem(LS_SHELL) || ''
    shellSelect.innerHTML = '<option value="">shell: default</option>'
    for (const s of hostInfo.shells || []) {
      const opt = document.createElement('option')
      opt.value = s
      opt.textContent = basename(s)
      shellSelect.appendChild(opt)
    }
    if (current && (hostInfo.shells || []).includes(current)) shellSelect.value = current
  }

  function renderQuickCommands() {
    for (const cmd of QUICK_COMMANDS) {
      const btn = document.createElement('button')
      btn.className = 'quick-cmd'
      btn.textContent = cmd
      btn.addEventListener('click', () => {
        const s = sockets.get(activeTabId)
        if (s && tabs.find((t) => t.id === activeTabId)?.alive) {
          s.emit('terminal:input', cmd + '\r')
          const entry = terms.get(activeTabId)
          if (entry) entry.term.focus()
        }
      })
      quickbar.appendChild(btn)
    }
  }

  // ---- Tab actions ----------------------------------------------------------------
  function addTab() {
    if (tabs.length >= MAX_TABS) return
    const tab = { id: uid(), shell: shellSelect.value || '' }
    tabs.push(tab)
    persistTabs()

    const pane = document.createElement('div')
    pane.className = 'term-pane'
    pane.style.display = 'none'
    pane.setAttribute('role', 'region')
    pane.setAttribute('aria-label', 'Терминал ' + basename(tab.shell))
    pane.addEventListener('click', () => {
      const entry = terms.get(tab.id)
      if (entry) entry.term.focus()
    })
    termArea.appendChild(pane)
    containers.set(tab.id, pane)

    ensureSocket(tab, (hostInfo && hostInfo.defaultShell) || '')
    setConn(false, true)
    renderTabs()
    activateTab(tab.id)
  }

  function closeTab(id) {
    const s = sockets.get(id)
    if (s) {
      s.emit('terminal:close')
      s.disconnect()
    }
    sockets.delete(id)
    const entry = terms.get(id)
    if (entry) {
      entry.ro.disconnect()
      entry.term.dispose()
      terms.delete(id)
    }
    const pane = containers.get(id)
    if (pane) pane.remove()
    containers.delete(id)

    const idx = tabs.findIndex((t) => t.id === id)
    tabs = tabs.filter((t) => t.id !== id)
    persistTabs()

    if (id === activeTabId && tabs.length) {
      activateTab(tabs[Math.min(idx, tabs.length - 1)].id)
    } else {
      renderTabs()
    }
  }

  // ---- Auth ----------------------------------------------------------------
  function showAuth(errorText) {
    appEl.classList.add('hidden')
    authEl.classList.remove('hidden')
    if (errorText) {
      authError.textContent = errorText
      authError.classList.remove('hidden')
    } else {
      authError.classList.add('hidden')
    }
    authPass.focus()
  }

  authForm.addEventListener('submit', (e) => {
    e.preventDefault()
    const pass = authPass.value.trim()
    if (!pass) return
    localStorage.setItem(LS_PASSWORD, pass)
    window.location.reload()
  })

  // ---- Header actions ----------------------------------------------------------------
  $('btn-clear').addEventListener('click', () => {
    const entry = terms.get(activeTabId)
    if (entry) {
      entry.term.clear()
      entry.term.focus()
    }
  })

  $('btn-newshell').addEventListener('click', () => {
    const entry = terms.get(activeTabId)
    const tab = tabs.find((t) => t.id === activeTabId)
    if (!entry || !tab) return
    entry.term.reset()
    const s = sockets.get(activeTabId)
    if (s) {
      s.emit('terminal:new', {
        shell: tab.shell || (hostInfo && hostInfo.defaultShell) || '',
        cols: entry.term.cols,
        rows: entry.term.rows,
      })
    }
  })

  $('btn-addtab').addEventListener('click', addTab)

  // ---- Boot ----------------------------------------------------------------
  function boot() {
    renderQuickCommands()
    tabs = loadTabs()
    shellSelect.value = localStorage.getItem(LS_SHELL) || ''

    appEl.classList.remove('hidden')
    setConn(false, true)

    // Build terminal panes for restored tabs
    for (const tab of tabs) {
      const pane = document.createElement('div')
      pane.className = 'term-pane'
      pane.style.display = 'none'
      pane.setAttribute('role', 'region')
      pane.setAttribute('aria-label', 'Терминал ' + basename(tab.shell))
      pane.addEventListener('click', () => {
        const entry = terms.get(tab.id)
        if (entry) entry.term.focus()
      })
      termArea.appendChild(pane)
      containers.set(tab.id, pane)
    }

    const defaultShell = localStorage.getItem(LS_SHELL) || ''
    for (const tab of tabs) ensureSocket(tab, defaultShell)
    activateTab(tabs[0].id)
    persistTabs()
  }

  boot()
})()
