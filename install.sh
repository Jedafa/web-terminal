#!/usr/bin/env bash
# Web Terminal installer — как sshx, только своё :)
#
#   curl -fsSL <сырая ссылка на этот скрипт> | bash
#   или: ./install.sh [--systemd]
#
# Ставит в ~/.web-terminal, лаунчер — в ~/.local/bin/web-terminal
set -euo pipefail

REPO_URL="${WEB_TERMINAL_REPO:-https://github.com/Jedafa/web-terminal.git}"
DEST="${WEB_TERMINAL_DIR:-$HOME/.web-terminal}"
BRANCH="${WEB_TERMINAL_BRANCH:-main}"

say()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m !!\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m xx %s\033[0m\n' "$*" >&2; exit 1; }

# ---------- проверки ----------
command -v node >/dev/null 2>&1 || die "Node.js не найден. Установите Node 18+: https://nodejs.org (или apt install nodejs npm)"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 18 ] || die "Нужен Node >= 18, у вас: $(node --version)"

command -v git >/dev/null 2>&1 || die "git не найден. Установите: apt install git (или через brew)"
command -v npm >/dev/null 2>&1 || die "npm не найден. Установите пакет npm для вашей ОС"

# ---------- скачивание / обновление ----------
if [ -d "$DEST/.git" ]; then
  say "Обновляю существующую установку в $DEST"
  git -C "$DEST" fetch --depth 1 origin "$BRANCH"
  git -C "$DEST" reset --hard "origin/$BRANCH"
else
  say "Клонирую репозиторий в $DEST"
  git clone --depth 1 -b "$BRANCH" "$REPO_URL" "$DEST"
fi

# ---------- сборка node-pty ----------
say "Ставлю зависимости (компилируется node-pty, это пару минут)"
if ! (cd "$DEST" && npm install --omit=dev --no-audit --no-fund); then
  warn "npm install упал. Чаще всего не хватает компилятора."
  warn "Debian/Ubuntu:  sudo apt install -y python3 make g++"
  warn "Fedora:         sudo dnf install -y python3 make gcc-c++"
  warn "Alpine:         apk add python3 make g++"
  warn "…и запустите установку ещё раз."
  exit 1
fi

# ---------- лаунчер ----------
BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR"
LAUNCHER="$BIN_DIR/web-terminal"
cat > "$LAUNCHER" <<EOF
#!/usr/bin/env bash
exec node "$DEST/server.mjs" "\$@"
EOF
chmod +x "$LAUNCHER"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    warn "$BIN_DIR не в PATH — добавляю строку в ~/.bashrc"
    printf '\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$HOME/.bashrc"
    ;;
esac

# ---------- systemd (опционально) ----------
if [ "${1:-}" = "--systemd" ]; then
  if command -v systemctl >/dev/null 2>&1; then
    UNIT_NAME="${WEB_TERMINAL_UNIT:-web-terminal}"
    UNIT_FILE="$HOME/.config/systemd/user/$UNIT_NAME.service"
    mkdir -p "$HOME/.config/systemd/user"
    PASSWORD_HINT='${WEB_TERMINAL_PASSWORD:-}'
    cat > "$UNIT_FILE" <<EOF
[Unit]
Description=Web Terminal (xterm.js + node-pty)
After=network.target

[Service]
ExecStart=$BIN_DIR/web-terminal --port \${PORT:-7681}
Environment=WEB_TERMINAL_PASSWORD=${WEB_TERMINAL_PASSWORD:-}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now "$UNIT_NAME"
    say "systemd-сервис '$UNIT_NAME' запущен (user-юнит: $UNIT_FILE)"
    say "Статус: systemctl --user status $UNIT_NAME"
  else
    warn "systemd не найден — пропускаю. Запускайте вручную: web-terminal"
  fi
fi

# ---------- готово ----------
say "Готово! Запуск:"
echo "    web-terminal                       # порт 7681, без пароля"
echo "    WEB_TERMINAL_PASSWORD=секрет web-terminal"
echo "    web-terminal --port 8080 --dir /path/to/project"
echo ""
echo "  Дополнительно:"
echo "    WEB_TERMINAL_PATH_PREFIX=метка     # спрятать UI за секретным путём"
echo "    WEB_TERMINAL_ALLOWED_ORIGINS=url   # если фронт на другом домене"
echo ""
echo "  Затем откройте в браузере: http://<хост>:<порт>"
echo "  (после входа выдаётся HttpOnly cookie-сессия на 12 ч)"
