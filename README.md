# autotrd

**autotrd.net** — Paper-Daytrading-Plattform mit Live-Dashboard, technischer
Konfluenz-Signalgebung, self-tunender Kursprognose und
KI-News-Analyse. Multi-User, realtime, gebaut auf Firebase + TypeScript.

> ⚠️ **Kein Finanzrat.** Standard ist Paper-Trading (simuliertes Geld).
> Echtgeld-Anbindung ist bewusst mehrfach verriegelt (siehe MILESTONES M8).

## Die drei Dokumente (in dieser Reihenfolge lesen)

1. **[ARCHITECTURE.md](ARCHITECTURE.md)** — Zielarchitektur: TS-Monorepo,
   Firebase (Auth/Firestore/Functions), Frontend auf webgo/autotrd.net,
   GitHub-Actions-Deploy, Datenmodell, Security.
2. **[MILESTONES.md](MILESTONES.md)** — Fahrplan M0–M8 **und der Coding-Loop**:
   wie hier gearbeitet, verifiziert und committet wird.
3. **[CLAUDE.md](CLAUDE.md)** — Fallen & Konventionen des bestehenden Codes
   (flaches Schema, Lookahead-Gate, Wilder-RSI, Frontend-Regeln) — gelten
   fachlich auch für die TS-Portierung.

Zusätzlich: **[docs/SETUP.md](docs/SETUP.md)** — einmalige Owner-Einrichtung
(Firebase-Projekt, GitHub Secrets, webgo-FTPS), damit Merge auf `main`
automatisch deployt. Und **[docs/VISION.md](docs/VISION.md)** — die
Produktvision hinter den Ausbau-Milestones M9–M14 (Linked Workspaces,
Strategie-Studio, Tagesfilm, Alpaca-Paper, Realtime-Streamer).

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

## Lokal entwickeln (TS-Zielsystem)

```bash
npm ci                       # installiert alle Workspaces (shared/functions/frontend)

npm run lint                 # ESLint über das ganze Repo
npm run typecheck            # tsc strict in allen Workspaces
npm test                     # Vitest (shared-Tests, später Parity-Tests)
npm run build                # baut shared + functions + frontend

# Emulator-Suite (Auth :9099, Firestore :8081, Functions :5001, UI :4000).
# Ohne echtes Firebase-Projekt mit einer demo-Projekt-ID starten:
npm run build -w functions
npx firebase emulators:start --project demo-autotrd
curl localhost:5001/demo-autotrd/us-central1/healthz   # Smoke: {"ok":true,…}

# Frontend-Dev-Server (http://localhost:5173):
cp frontend/.env.example frontend/.env.local   # Werte eintragen — ODER:
# VITE_FIREBASE_USE_EMULATORS=1 setzen, dann reichen Dummy-Werte und
# Login/Registrierung laufen gegen den lokalen Auth-Emulator.
npm run dev -w frontend
```

Ohne Firebase-Web-Config zeigt das Frontend einen Einrichtungs-Hinweis statt
des Logins — fehlende Config bricht also nichts.

## Python-Referenz lokal laufen lassen

```bash
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
