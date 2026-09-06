# ops/ — Installation und Betrieb auf einem VPS

Zielbild: **ein** Node-22-Prozess als systemd-Dienst, Secrets in
`/etc/autotrd/.env`, Config in `/etc/autotrd/config.yaml`, State (Journal,
Bars-Cache, Champion, Reports) in `/var/lib/autotrd`. Kein Frontend, kein
offener Port. Alternativ als Container (unten).

Die fachliche Seite (Tagesablauf, Kommandos, typische Fehler) steht in
[docs/BETRIEB.md](../docs/BETRIEB.md).

## 1. Voraussetzungen

- Linux-VPS (Debian/Ubuntu), 1 vCPU / 1 GB RAM reichen; die Engine ist I/O-,
  nicht CPU-gebunden. Der nächtliche Optimierer profitiert von 2 vCPU.
- **Node.js ≥ 22.18** (natives TypeScript-Stripping wird nur für die
  Entwicklung gebraucht; produktiv läuft `dist/`). Installation über
  NodeSource, dann liegt `node` unter `/usr/bin/node` — genau der Pfad in
  der Unit. Bei nvm o. ä. den `ExecStart`-Pfad anpassen.
- Uhr per NTP synchron (`timedatectl`): Sitzungsgrenzen und Bar-Buckets
  hängen an der Systemzeit.
- Ausgehend HTTPS/WSS zu `*.alpaca.markets` (und `api.telegram.org`, wenn
  Telegram genutzt wird). Eingehend braucht nichts offen zu sein.

## 2. Installation

```bash
# Systemnutzer ohne Login, ohne Home in /home
sudo useradd --system --home-dir /opt/autotrd --shell /usr/sbin/nologin autotrd

# Programm
sudo git clone https://github.com/<owner>/autotrd.git /opt/autotrd
cd /opt/autotrd
sudo npm ci                # alle Abhängigkeiten (Build braucht typescript)
sudo npm run build         # → dist/
sudo npm prune --omit=dev  # Dev-Abhängigkeiten wieder entfernen
sudo chown -R autotrd:autotrd /opt/autotrd

# Config + Secrets
sudo mkdir -p /etc/autotrd
sudo cp config/config.example.yaml /etc/autotrd/config.yaml
sudo cp .env.example /etc/autotrd/.env
sudo chown autotrd:autotrd /etc/autotrd/.env
sudo chmod 600 /etc/autotrd/.env         # Keys: nur der Dienstnutzer liest
sudoedit /etc/autotrd/.env               # ALPACA_API_KEY (PK…), ALPACA_SECRET_KEY, optional TELEGRAM_*
sudoedit /etc/autotrd/config.yaml        # Symbole, Zeitrahmen, Risiko — jede Option ist kommentiert

# State-Verzeichnis (legt systemd über StateDirectory auch selbst an)
sudo mkdir -p /var/lib/autotrd && sudo chown autotrd:autotrd /var/lib/autotrd

# Dienst
sudo install -m 644 ops/autotrd.service /etc/systemd/system/autotrd.service
sudo systemctl daemon-reload
```

Vor dem ersten Start die Umgebung prüfen — als Dienstnutzer, mit derselben
Config und denselben Secrets, die der Dienst sieht:

```bash
sudo -u autotrd env $(grep -v '^#' /etc/autotrd/.env | xargs) AUTOTRD_HOME=/var/lib/autotrd \
  node /opt/autotrd/dist/cli.js doctor --config /etc/autotrd/config.yaml
```

`doctor` prüft Keys (Präfix PK/AK gegen den Modus), Konto, Uhr, Kalender,
Datenfeed und Schreibrechte. Erst wenn `doctor` grün ist, den Dienst starten.

Tipp: Ein kleiner Wrapper spart die lange Zeile:

```bash
sudo tee /usr/local/bin/autotrd >/dev/null <<'SH'
#!/bin/sh
exec sudo -u autotrd env $(grep -v '^#' /etc/autotrd/.env | xargs) AUTOTRD_HOME=/var/lib/autotrd \
  node /opt/autotrd/dist/cli.js "$@" --config /etc/autotrd/config.yaml
SH
sudo chmod 755 /usr/local/bin/autotrd
```

Alle Beispiele unten benutzen diesen Wrapper (`autotrd status` usw.).

## 3. Start, Stopp, Status

```bash
sudo systemctl enable --now autotrd    # beim Boot starten + jetzt starten
sudo systemctl status autotrd
sudo systemctl stop autotrd            # SIGINT → geordneter Stopp (≤ 30 s)
sudo systemctl restart autotrd
```

Ein Stopp stellt **nicht** glatt: Positionen bleiben offen, ihre Schutz-Stops
liegen beim Broker und wirken auch ohne laufenden Prozess. Wer flach sein
will, ruft vorher `autotrd flatten` (siehe Not-Aus).

Status ohne Broker-Zugriff (liest `state.json`):

```bash
autotrd status
curl -s http://127.0.0.1:8787/status | jq .    # wenn status.httpPort > 0
curl -s http://127.0.0.1:8787/health
```

Der HTTP-Status bindet nur an 127.0.0.1. Von außen: `ssh -L 8787:127.0.0.1:8787 vps`.

## 4. Logs

Die Engine schreibt JSON-Zeilen nach stdout; systemd sammelt sie im Journal:

```bash
journalctl -u autotrd -f                       # live
journalctl -u autotrd --since today            # heutiger Tag
journalctl -u autotrd -o cat | jq 'select(.level=="error")'
```

Das fachliche Journal (Entscheidungen, Orders, Fills, Halts) liegt
unabhängig davon in `/var/lib/autotrd/journal.jsonl` — append-only, wird nie
umgeschrieben. Format: docs/BETRIEB.md §4.

Secrets erscheinen in keiner der beiden Quellen: Alle Ausgaben laufen durch
die Schwärzung in `src/core/log.ts`.

## 5. Not-Aus

Drei Wege, vom sanftesten zum härtesten:

| Weg | Wirkung | Wieder aufheben |
|---|---|---|
| `autotrd halt` oder `touch /var/lib/autotrd/HALT` | Keine neuen Einstiege. Offene Positionen werden weiter geführt (Stops, Ziele, EOD-Flatten laufen). | `autotrd resume` bzw. Datei löschen |
| `autotrd flatten` | Alle Positionen per Marktorder schließen, alle Orders stornieren, dann Halt. | `autotrd resume` |
| `sudo systemctl stop autotrd` | Prozess weg. Positionen bleiben, Schutz-Stops beim Broker bleiben aktiv. | `systemctl start` |

Die HALT-Datei ist der Weg, der **immer** funktioniert — auch wenn die CLI
nicht baut oder das Konto blockiert ist; die Engine prüft sie in jedem
Zyklus. Letzte Instanz ist das Alpaca-Dashboard („Close All Positions").

Automatische Sperren (Tagesverlust, Drawdown, Fehlerserie, Abgleich) löst man
über die **Ursache**, nicht per Schalter: `autotrd resume` schreibt den
Grund ins Journal und setzt bei Drawdown den Peak neu. Es gibt bewusst keine
Option, eine Sperre zu ignorieren.

## 6. Update

```bash
cd /opt/autotrd
sudo -u autotrd git fetch --tags && sudo -u autotrd git log --oneline HEAD..origin/main
sudo systemctl stop autotrd                    # Positionen bleiben geschützt (Broker-Stops)
sudo -u autotrd git pull --ff-only
sudo -u autotrd npm ci && sudo -u autotrd npm run build && sudo -u autotrd npm prune --omit=dev
autotrd doctor                                 # Config noch gültig? (Schema kann wachsen)
sudo systemctl start autotrd
journalctl -u autotrd -n 50                    # Start sauber? „reconcile" ohne Drift?
```

Migrationen des State-Formats sind additiv; `state.json`, `journal.jsonl`
und `bars/` werden nie gelöscht. Vor größeren Sprüngen:
`sudo tar czf /root/autotrd-state-$(date +%F).tgz /var/lib/autotrd`.

Ein Update während der Handelszeit ist möglich (Reconciliation übernimmt
Positionen und Stops beim Start), aber unnötig riskant — besser nach 16:00 ET.

## 7. Container statt systemd

```bash
docker build -f ops/Dockerfile -t autotrd .
docker run -d --name autotrd --restart unless-stopped \
  --env-file /etc/autotrd/.env \
  -v /etc/autotrd/config.yaml:/etc/autotrd/config.yaml:ro \
  -v autotrd-state:/var/lib/autotrd \
  autotrd
docker logs -f autotrd
docker exec autotrd wget -qO- http://127.0.0.1:8787/status     # Status (lauscht nur im Container)
docker exec autotrd node dist/cli.js halt --config /etc/autotrd/config.yaml   # Not-Aus
docker stop autotrd          # STOPSIGNAL SIGINT, Positionen bleiben
```

Kein `-p 8787:8787`: Der Status enthält Kontodaten. Wer ihn von außen
braucht, tunnelt zum Host. Hinweis: Das Repo trägt noch keinen
`.dockerignore`; bis dahin wird das ganze Verzeichnis als Build-Kontext
gesendet — funktioniert, dauert nur länger.

## 8. Deinstallation

```bash
sudo systemctl disable --now autotrd
sudo rm /etc/systemd/system/autotrd.service && sudo systemctl daemon-reload
sudo tar czf /root/autotrd-final.tgz /var/lib/autotrd /etc/autotrd   # Journal aufheben
sudo rm -rf /opt/autotrd /var/lib/autotrd /etc/autotrd
sudo userdel autotrd
```

Vorher im Alpaca-Dashboard prüfen, dass keine Positionen und keine offenen
Orders (GTC-Stops!) mehr liegen — der Broker kennt den Dienst nicht.
