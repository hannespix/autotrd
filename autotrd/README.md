# autotrd

**autotrd.net** — Paper-Daytrading-Plattform mit Live-Dashboard, technischer
Konfluenz-Signalgebung, sentiment-gewichteter Kursprognose (self-tuning) und
KI-News-Analyse. Multi-User, realtime, gebaut auf Firebase + TypeScript.

> ⚠️ **Kein Finanzrat.** Standard ist Paper-Trading (simuliertes Geld).
> Echtgeld-Anbindung ist bewusst mehrfach verriegelt (siehe MILESTONES M8).

## Die drei Dokumente (in dieser Reihenfolge lesen)

1. **[ARCHITECTURE.md](ARCHITECTURE.md)** — Zielarchitektur: TS-Monorepo,
   Firebase (Auth/Firestore/Functions), Frontend auf webgo/autotrd.net,
   GitHub-Actions-Deploy, Datenmodell, Security, KI-Staffel.
2. **[MILESTONES.md](MILESTONES.md)** — Fahrplan M0–M8 **und der Coding-Loop**:
   wie hier gearbeitet, verifiziert und committet wird.
3. **[CLAUDE.md](CLAUDE.md)** — Fallen & Konventionen des bestehenden Codes
   (flaches Schema, Lookahead-Gate, Wilder-RSI, Frontend-Regeln) — gelten
   fachlich auch für die TS-Portierung.

## Repo-Layout

```
frontend/    SPA (Vite+TS, Firebase SDK) → FTPS-Deploy auf autotrd.net   [ab M1]
functions/   Cloud Functions: Scan-Engine, Forecaster, Trades, KI        [ab M1]
shared/      Geteilte Typen — das flache Strategie-/Firestore-Schema
reference/   ⭐ Lauffähige Python-Referenz (der bisherige Single-User-Bot)
             + golden/ Fixtures für Parity-Tests. Wird erst eingefroren,
             wenn TS nachweislich gleich rechnet (MILESTONES M5).
firestore.rules · firebase.json · .github/workflows/   Infrastruktur
```

## Schnellstart (Entwicklung)

```bash
# Ab M1: npm ci && firebase emulators:start   (Details folgen mit M1)

# Bis dahin — die Python-Referenz lokal laufen lassen:
cd reference
python -m venv .venv && . .venv/bin/activate      # Python 3.11–3.13
pip install -r requirements.txt
mkdir -p ~/.hermes/trading
cp config/strategy.example.yaml ~/.hermes/trading/strategy.yaml
python scripts/trading_dashboard.py               # ► http://localhost:8080
# Optional als Dienst: bash deploy/install.sh (systemd --user Units)
```

Secrets: `.env.example` → `~/.hermes/.env` (Referenz) bzw. GitHub Secrets /
Firebase Secret Manager (Zielsystem). **Nie committen.**

## Für Claude Code

> Lies ARCHITECTURE.md, CLAUDE.md und MILESTONES.md. Arbeite nach dem
> Coding-Loop aus MILESTONES.md am ersten nicht abgehakten Milestone.

## Lizenz / Haftung

Privates Projekt, alle Rechte vorbehalten. Bereitgestellt „wie besehen", ohne
Gewähr. Handel mit Finanzinstrumenten ist mit Verlustrisiko verbunden.
