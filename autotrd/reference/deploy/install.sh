#!/usr/bin/env bash
# === autotrd — Deployment als systemd --user Dienste ===
# Installiert Dashboard-Service + Auto-Scan-Timer portabel: die Unit-Dateien
# werden mit den TATSÄCHLICHEN Pfaden dieses Repos + venv erzeugt, statt fixe
# ~/.hermes-Pfade anzunehmen. Idempotent — mehrfach ausführbar.
#
#   bash deploy/install.sh
#   systemctl --user enable --now daytrading-dashboard.service
#   systemctl --user enable --now daytrading-scan.timer
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="${AUTOTRD_PYTHON:-$HOME/.hermes/hermes-agent/venv/bin/python}"
STATE="${AUTOTRD_HOME:-$HOME/.hermes/trading}"
UNIT_DIR="$HOME/.config/systemd/user"

[ -x "$PY" ] || { echo "❌ Interpreter nicht gefunden: $PY  (AUTOTRD_PYTHON setzen)"; exit 1; }
mkdir -p "$STATE" "$UNIT_DIR"

# Live-Config anlegen, falls noch keine da ist (flaches Schema als Vorlage)
if [ ! -f "$STATE/strategy.yaml" ]; then
  cp "$REPO/config/strategy.example.yaml" "$STATE/strategy.yaml"
  echo "→ $STATE/strategy.yaml aus Vorlage erstellt"
fi

# Markt-Gate-Wrapper an einen stabilen Ort legen und Repo-Pfade einsetzen
mkdir -p "$HOME/.hermes/scripts"
SCAN="$HOME/.hermes/scripts/run_scan.sh"
sed -e "s#~/.hermes/hermes-agent/venv/bin/python#$PY#g" \
    -e "s#~/.hermes/skills/daytrading/scripts/cron_task.py#$REPO/scripts/cron_task.py#g" \
    "$REPO/deploy/run_scan.sh" > "$SCAN"
chmod +x "$SCAN"

cat > "$UNIT_DIR/daytrading-dashboard.service" <<EOF
[Unit]
Description=autotrd dashboard (FastAPI, localhost:8080)
After=network.target

[Service]
Type=simple
WorkingDirectory=$REPO
ExecStart=$PY $REPO/scripts/trading_dashboard.py
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

cat > "$UNIT_DIR/daytrading-scan.service" <<EOF
[Unit]
Description=autotrd auto-scan (paper trading, one cycle)
After=network-online.target

[Service]
Type=oneshot
ExecStart=$SCAN
EOF

cat > "$UNIT_DIR/daytrading-scan.timer" <<EOF
[Unit]
Description=Run autotrd auto-scan every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
AccuracySec=30s
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl --user daemon-reload
echo "✅ Units geschrieben nach $UNIT_DIR"
echo "   Repo:  $REPO"
echo "   Python:$PY"
echo "   State: $STATE"
echo
echo "Jetzt aktivieren:"
echo "   systemctl --user enable --now daytrading-dashboard.service"
echo "   systemctl --user enable --now daytrading-scan.timer"
