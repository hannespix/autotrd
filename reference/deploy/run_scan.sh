#!/usr/bin/env bash
# Auto-trading scan cycle — invoked by cron every N minutes.
# Runs one scan; executes paper trades only when the engine is "running"
# (toggled via the dashboard Start/Stop). State lives in ~/.hermes/trading/.
#
# US market-hours gate: skip entirely outside Mon-Fri 09:30-16:00 ET so the
# engine never acts on stale (last-close) prices. Pass --force to bypass.

if [ "$1" != "--force" ]; then
    dow=$(TZ=America/New_York date +%u)      # 1=Mon .. 7=Sun
    hm=$(TZ=America/New_York date +%H%M)      # e.g. 0930
    hm=$((10#$hm))                            # strip leading zero for arithmetic
    if [ "$dow" -gt 5 ] || [ "$hm" -lt 930 ] || [ "$hm" -ge 1600 ]; then
        echo "$(date '+%F %T') 🔒 Markt geschlossen (ET $hm, dow $dow) — uebersprungen."
        exit 0
    fi
fi

exec ~/.hermes/hermes-agent/venv/bin/python \
    ~/.hermes/skills/daytrading/scripts/cron_task.py
