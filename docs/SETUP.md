# SETUP.md — Einmalige Einrichtung von Deploy & Betrieb

Schritt-für-Schritt-Checkliste für den Owner, um den Entwicklungs-Flow
scharfzuschalten:

> **Branch → PR → CI grün → Merge auf `main` → GitHub Actions deployen
> automatisch:** Frontend per **FTPS** zu webgo (autotrd.net), Functions +
> Firestore-Rules zu **Firebase**.

Die Workflows liegen in `.github/workflows/` und überspringen Deploys sauber
(gelbe Warnung statt rot), solange die Secrets unten fehlen.

---

## A. Firebase-Projekt anlegen (~10 min)

1. <https://console.firebase.google.com> → **Projekt hinzufügen** → Name
   `autotrd`. Die tatsächlich vergebene **Projekt-ID** notieren (z. B.
   `autotrd` oder `autotrd-a1b2c`) — sie wird in Schritt B gebraucht.
   Google Analytics: nicht nötig → deaktivieren.
2. **Blaze-Plan aktivieren** (nötig für Cloud Functions mit ausgehenden
   HTTP-Calls): Zahnrad → *Nutzung und Abrechnung* → *Details & Einstellungen*
   → auf **Blaze** upgraden.
3. **Budget-Alarm setzen** (ARCHITECTURE.md §1 — Pflicht!): Im verknüpften
   Google-Cloud-Billing-Konto → *Budgets & Benachrichtigungen* → Budget z. B.
   **10 €/Monat** mit E-Mail-Alarm bei 50 / 90 / 100 %.
4. **Authentication**: *Build → Authentication → Jetzt starten* →
   Sign-in-Methoden:
   - **E-Mail/Passwort** aktivieren
   - **Google** aktivieren (Support-E-Mail auswählen)
5. **Firestore**: *Build → Firestore Database → Datenbank erstellen* →
   **Produktionsmodus** → Region **europe-west3 (Frankfurt)**.
   ⚠️ Die Region ist später nicht änderbar.
6. **Web-App registrieren**: Projektübersicht → Web-Symbol `</>` → Name
   `autotrd web` (Firebase Hosting NICHT nötig) → die angezeigte
   `firebaseConfig` kopieren: `apiKey`, `authDomain`, `projectId`, `appId`.
7. **Authorized Domains** (für Google-Login vom Live-Frontend):
   *Authentication → Settings → Authorized domains* → `autotrd.net` hinzufügen.

## B. Projekt-ID im Repo eintragen

`.firebaserc` enthält den Platzhalter `autotrd`. Falls die echte Projekt-ID
anders lautet: per PR ändern —

```json
{ "projects": { "default": "<echte-projekt-id>" } }
```

## C. Service-Account für den Firebase-Deploy (~5 min)

1. <https://console.cloud.google.com> → Projekt auswählen → *IAM & Verwaltung
   → Dienstkonten* → **Dienstkonto erstellen** → Name `github-deploy`.
2. Rollen zuweisen:
   - **Firebase Admin** (`roles/firebase.admin`)
   - **Service Account User** (`roles/iam.serviceAccountUser`)
3. Beim Dienstkonto: *Schlüssel → Schlüssel hinzufügen → Neuen Schlüssel
   erstellen → JSON* → Datei wird heruntergeladen.
4. GitHub: Repo → *Settings → Secrets and variables → Actions* →
   **New repository secret**:
   - Name: `FIREBASE_SERVICE_ACCOUNT`
   - Wert: **kompletter Inhalt** der JSON-Datei (Copy&Paste)
5. Die lokale JSON-Datei danach löschen (sie ist ein Vollzugriffs-Secret!).

> Beim allerersten Functions-Deploy aktiviert Firebase mehrere GCP-APIs
> (Cloud Build, Artifact Registry, …) — das kann einmalig 1–2 Minuten extra
> dauern oder beim ersten Versuch fehlschlagen. Dann einfach den Workflow
> unter *Actions* per **Re-run** neu starten.

### Troubleshooting: erster Functions-Deploy (APIs freischalten)

Der allererste Functions-Deploy scheitert typischerweise mit
*„Cloud Functions deployment requires the Cloud Build API to be enabled.
The current credentials do not have permission to enable APIs"* — der
Deploy-Service-Account darf keine Google-APIs aktivieren. Zwei Wege:

**Empfohlen (einmalig, zukunftssicher):** dem Service-Account
`github-deploy` zusätzlich die Rollen **Service Usage Admin**,
**Cloud Run Admin** und **Cloud Scheduler Admin** geben (Scheduler
braucht der Deploy, um die Zeitpläne der scheduled Functions —
5-min-Scan, evalForecasts, snapshotEquity, autoTune, momentumRun — anzulegen) (Letztere braucht der Deploy, um Callables/HTTP-
Functions öffentlich aufrufbar zu machen — fehlt sie, antworten die
Functions mit 403 ohne CORS-Header und das Frontend meldet CORS-Fehler)
(IAM-Konsole → Service-Account bearbeiten → Rolle hinzufügen). Danach
schaltet `firebase deploy` alle benötigten APIs selbst frei — auch die,
die künftige Features brauchen (Cloud Run, Eventarc, Scheduler, …).

**Alternativ (manuell klicken):** diese APIs im Projekt aktivieren
(Links aus dem Fehler-Log, `?project=<projekt-id>` anhängen):
`cloudbuild.googleapis.com` · `cloudfunctions.googleapis.com` ·
`artifactregistry.googleapis.com` · `run.googleapis.com` ·
`eventarc.googleapis.com` · `pubsub.googleapis.com` ·
`cloudscheduler.googleapis.com` · `secretmanager.googleapis.com`

**Kein KI-Secret mehr nötig** (seit 28.07.): Der Scan ruft keine
Anthropic-API mehr auf. News, Sentiment und die KI-Tageserklärung sind aus
dem Handelspfad entfernt — sie hatten nachweislich keinen Einfluss auf die
Handelsentscheidung (die Sentiment-Stimme hatte live nie eine bewertete
Prognose), kosteten aber bei jedem 5-Minuten-Scan Feed-Abrufe und
Claude-Aufrufe. Ein bereits angelegtes `ANTHROPIC_API_KEY`-Secret stört
nicht, wird aber nicht mehr gebunden.

Danach: *Actions → Deploy Functions (Firebase) → Re-run all jobs* — oder
einfach den nächsten PR mergen.

### Scans laufen nicht (kein Heartbeat `meta/health`)

Der Deploy-Step **„Scheduler-Diagnose + Scan-Force-Run"** heilt sich selbst,
so weit die Rechte reichen, und schreibt die Diagnose ins Actions-Log:

- Meldet er `Deploy-SA hat KEINE Cloud-Scheduler-Berechtigung`, wurde die
  Rolle **Cloud Scheduler Admin** nicht (oder dem falschen Principal)
  vergeben. Fix: IAM-Konsole → dem Service-Account mit der **im Log
  ausgegebenen E-Mail** (`Deploy-SA: …`) die Rolle geben, dann den Deploy
  re-runnen. Der Step legt den fehlenden 5-min-Job dann selbst an.
- Früher überbrückte das ein Workflow „Scan-Watchdog". Er ist am 28.07.
  entfallen: Seit die Rolle vergeben ist, feuert der Cloud Scheduler selbst
  im 5-Minuten-Takt, und der Watchdog lief nur noch zusätzlich (doppelte
  Scans, doppelte Kosten). Nachweis war der Heartbeat um 12:35 UTC —
  frisch, obwohl das Watchdog-Fenster erst um 13:00 UTC begann.
- Existiert `meta/health` trotz allem nicht, schlägt die Function selbst
  fehl → Cloud-Logging des `scanmarket`-Services prüfen.

### Performance-Kurve / Prognose-Genauigkeit / Prognose-Labor bleiben leer

Dieselbe Wurzel, andere Symptome (Owner-Meldung 27.07.): Ohne
Cloud-Scheduler-Rolle existiert **kein einziger** geplanter Job — also laufen
auch die drei täglichen Funktionen nie, und die drei Karten im Dashboard haben
schlicht keine Datenquelle:

| Funktion | füttert | Nachweis in Firestore |
|---|---|---|
| `snapshotEquity` | Equity-Kurve + Sharpe/Drawdown/Profit-Faktor | `meta/health.equitySnapshot` |
| `evalForecasts`  | Prognose-Genauigkeit + Prognose-Labor       | `meta/health.forecastEval`  |

Die Felder sind **ohne Anmeldung lesbar** — fehlen sie oder ist ihr Datum alt,
hat der jeweilige Lauf nicht stattgefunden. Zwei Wege überbrücken das:

- Beide laufen als Cloud-Scheduler-Jobs (`check-scheduler.mjs` legt sie beim
  Deploy an). Der frühere Stopgap-Workflow „Tages-Läufe" ist am 28.07.
  entfallen — er lief seit der Scheduler-Rolle doppelt.
- Der **Deploy** stößt `snapshotEquity` und `evalForecasts` zusätzlich einmal
  an, damit die Karten nach einem Merge binnen Minuten gefüllt sind statt
  erst abends.

Das Gate unterscheidet dabei „heute gelaufen" von „heute **nach US-Schluss**
gelaufen" (ab 20:00 UTC): Ein Mittags-Snapshot füllt die Karte sofort, verdrängt
aber den Abend-Lauf nicht — sonst stünde in der Equity-Serie dauerhaft ein
Zwischenstand statt des Schlusskurses, und Sharpe und Drawdown rechneten auf
falscher Grundlage.

Zwei Dinge bleiben auch danach normal und sind **kein** Fehler:

- Die Equity-**Kurve** braucht mindestens **zwei** Snapshot-Tage, Sharpe 30
  entsprechend ~30. Vorher zeigt die Karte bewusst `--` statt einer Scheinzahl.
- Tages-Prognosen werden erst bewertet, wenn ihr Horizont **vollständig
  realisiert** ist (Lookahead-Gate, ARCHITECTURE §5) — nach einem Neustart der
  Datenerhebung dauert das rund eine Handelswoche. Intraday-Trefferquoten
  erscheinen deutlich früher, sie hängen huckepack am 5-Minuten-Scan.

## D. webgo: FTP-Zugang & Domain (~10 min)

1. webgo-Kundenportal → **FTP** → FTP-Benutzer anlegen (oder vorhandenen
   nehmen).
2. webgo → **Domains**: `autotrd.net` auf den Site-Ordner routen
   (typisch `www/autotrd.net`).
3. **SSL aktivieren** (Let's Encrypt im webgo-Panel) + HTTPS-Weiterleitung an.
4. GitHub Secrets (wie in C.4):
   - `FTP_HOST` — Servername aus dem webgo-Panel (z. B. `sXX.goserver.host`)
   - `FTP_USERNAME` — der FTP-Benutzer
   - `FTP_PASSWORD` — dessen Passwort
5. **Zielverzeichnis:** Der Workflow lädt nach `server-dir`, RELATIV zur
   FTP-Wurzel des Users — Default **`autotrd.net/`** (passend, wenn die
   FTP-Wurzel `www/` ist und die Domain auf `www/autotrd.net` zeigt).
   Weicht dein Layout ab, Repo-Variable **`FTP_SERVER_DIR`** setzen
   (Trailing-Slash Pflicht, z. B. `www/autotrd.net/`).
   > ⚠️ Vor diesem Fix lud der Workflow in die FTP-Wurzel (`www/`).
   > Dort ggf. aufräumen: `index.html`, `vite.svg` und den Ordner
   > `assets/` löschen — NUR diese Build-Artefakte, sonst nichts.

## E. Firebase-Web-Config für den Frontend-Build

Die Werte aus A.6 sind **öffentlich** (kein Secret) und kommen deshalb als
Repository-**Variablen**: Repo → *Settings → Secrets and variables → Actions*
→ Tab **Variables** → je eine Variable:

| Variable | Wert aus firebaseConfig |
|---|---|
| `VITE_FIREBASE_API_KEY` | `apiKey` |
| `VITE_FIREBASE_AUTH_DOMAIN` | `authDomain` |
| `VITE_FIREBASE_PROJECT_ID` | `projectId` |
| `VITE_FIREBASE_APP_ID` | `appId` |

## F. Flow testen (Abnahme M1)

1. Kleinen Test-PR mergen (oder *Actions* → Workflow → **Run workflow**).
2. Unter *Actions* prüfen: **Deploy Frontend (webgo)** und **Deploy Functions
   (Firebase)** laufen jetzt echt durch (keine Skip-Warnung mehr).
3. <https://autotrd.net> öffnen → Login-Screen erscheint → Konto registrieren
   → E-Mail-Login und Google-Login funktionieren.
4. `https://us-central1-<projekt-id>.cloudfunctions.net/healthz` →
   `{"ok":true,…}`.
5. Danach in `MILESTONES.md` die drei Owner-Punkte von M1 abhaken. ✅

## G. Empfohlen: Branch-Schutz für `main`

Repo → *Settings → Branches → Add branch ruleset* für `main`:
- **Require a pull request before merging**
- **Require status checks to pass** → Check `ci` auswählen

Damit ist der Flow „nur per grünem PR auf main" auch technisch erzwungen.

## H. KI-Staffel — entfällt (Stand 28.07.)

Dieser Schritt ist **nicht mehr nötig**. News-Feeds, Lexikon-Sentiment und
die KI-Tageserklärung sind aus dem System entfernt (Owner-Direktive:
„Performance Maximierung! Kosten Minimierung!"). Die Gründe, kurz:

- Die Sentiment-Stimme hat live **nie** Evidenz gesammelt
  (`meta/forecastStats.scored` stand dauerhaft auf 0) — sie beeinflusste
  also Handelsentscheidungen, ohne dass irgendjemand ihre Trefferquote
  kannte.
- Gratis-Feeds (Yahoo/Google-RSS, Reddit) sind Minuten bis Stunden alt.
  Was dort steht, ist längst im Kurs.
- Feed-Abrufe und Claude-Aufrufe liefen bei **jedem** 5-Minuten-Scan.

Ein bereits angelegtes `ANTHROPIC_API_KEY`-Secret schadet nicht, wird aber
von keiner Function mehr gebunden. Das Firestore-Doc `admin/aiBudget` wird
nicht mehr gelesen.

## I. App Check scharf schalten (M7, ~10 min)

Der Code ist vorbereitet und tut ohne Setup nichts — die Reihenfolge ist
wichtig, sonst sperrt man alle Clients aus:

1. Firebase-Konsole → *App Check* → Web-App registrieren →
   **reCAPTCHA v3** wählen → Site-Key kopieren.
2. GitHub-Repo → *Settings → Variables* → `VITE_FIREBASE_APPCHECK_SITE_KEY`
   mit dem Site-Key anlegen → Frontend-Deploy laufen lassen. Ab jetzt SENDEN
   Clients App-Check-Tokens (erzwungen wird noch nichts).
3. Ein paar Tage in der App-Check-Konsole beobachten: Anteil „verifizierte
   Anfragen" sollte gegen 100 % gehen.
4. Dann erzwingen: in `functions/.env` → `APPCHECK_ENFORCE=1` committen
   (nächster Functions-Deploy aktiviert es) **und** in der Firebase-Konsole
   App Check für **Cloud Firestore** auf *Enforce* stellen.
5. Abnahme (M7): `curl -X POST …/ensureProfile` ohne App-Check-Token →
   HTTP 401/403; die App selbst funktioniert normal weiter.

Lokale Entwicklung: mit `VITE_FIREBASE_USE_EMULATORS=1` registriert das
Frontend einen Debug-Token (erscheint in der Browser-Konsole) — diesen in
der Firebase-Konsole unter *App Check → Debug-Tokens* freischalten.

## J. Monitoring & Alarme (M7, ~15 min)

Der Scan schreibt einen Heartbeat nach `meta/health` (`lastScanAt`,
`symbolsOk`, `symbolsFailed`) — darauf bauen die Alarme auf:

1. **Function-Fehler:** GCP-Konsole → *Logging → Log-based metrics* →
   Zähler-Metrik `functions-errors` mit Filter
   `resource.type="cloud_function" severity>=ERROR` → *Monitoring → Alerting*
   → Alert bei `> 5 in 5 min`, Kanal: deine E-Mail.
2. **Scan-Ausfall:** *Monitoring → Uptime Checks* → HTTPS-Check auf die
   **run.app-URL** der Function (Intervall 5 min) + Alert bei Ausfall. Die
   URL steht im Deploy-Log hinter „Function URL (healthz)" — aktuell
   `https://healthz-6xru5z43xa-uc.a.run.app`. Achtung: Das früher hier
   dokumentierte Muster `us-central1-<projekt-id>.cloudfunctions.net/healthz`
   liefert in diesem Projekt **404** — ein Uptime-Check darauf prüft nichts
   (verifiziert 13.08.). Seit 13.08. ist `healthz` ein echter
   Totmann-Endpunkt: Er bewertet bei jedem Aufruf den Scan-Herzschlag
   (`meta/health.lastRunAt`) und antwortet **503**, wenn der Scan länger als
   20 Minuten steht oder die Kursquelle keinen einzigen Kurs mehr liefert —
   der Uptime-Check schlägt damit auch bei totem Cloud Scheduler an, nicht
   nur bei toter Function. Zweite Schicht: der `wachhund`-Scheduler (alle
   10 min) schreibt denselben Befund nach `meta/health.alarm` und als
   `logger.error` (Filter `WACHHUND` für einen eigenen Log-Alert); dritte
   Schicht: das Dashboard rechnet das Urteil clientseitig und zeigt einen
   roten Chip in „Warum handelt die Engine (nicht)?".
3. **Budget:** Billing → *Budgets & alerts* → Budget (z. B. 10 €/Monat) mit
   50/90/100 %-Mails — deckt Firestore, Functions UND ausufernde KI-Kosten ab
   (zusätzlich zum Token-Guard `admin/aiBudget` und dem Anthropic-Spend-Limit
   aus §H).

## K. Sich selbst zum Admin machen (nach der Registrierung)

Neue Konten landen auf der Stufe `pending` — sie sehen die App, können aber
weder die Engine starten noch handeln. Das gilt auch für **dein eigenes**
Konto. Einmalig freischalten und zum Admin machen:

1. Auf autotrd.net registrieren (normale Anmeldung).
2. GitHub → *Actions* → **Admin-Bootstrap** → *Run workflow*, dort die
   E-Mail des Kontos eintragen und starten.
3. Neu laden — die Admin-Ansicht mit den offenen Anfragen erscheint.

Ab da geht alles über die Oberfläche: Neue Registrierungen tauchen dort auf
und werden per Klick freigeschaltet. Der Workflow ist nur für den ersten
Admin nötig — vorher gibt es niemanden, der freischalten könnte.

**Warum das nicht über die App geht:** Wer sich selbst freischalten könnte,
bräuchte kein Freischaltsystem. Die Firestore-Regeln weisen genau das ab —
`users/{uid}.admin` ist für den Nutzer selbst nicht schreibbar. Der Workflow
umgeht das legitim, weil er mit dem Deploy-Service-Account läuft: dieselbe
Vertrauensstufe wie ein Deploy, und er braucht Repo-Schreibrecht.

## L. E-Mails: eigener Absender (gegen den Spam-Ordner)

**Warum Bestätigungsmails im Spam landen:** Nicht wegen des Textes, sondern
wegen des Absenders. Firebase Auth verschickt seine Mails per Voreinstellung
über `noreply@<projekt-id>.firebaseapp.com` — für Spamfilter schreibt da
eine fremde Domain im Namen von autotrd.net. Genau dieses Muster bewerten
sie schlecht, egal wie schön die Mail gestaltet ist.

### 1. Absenderdomain beglaubigen (~15 min)

Firebase-Konsole → *Authentication* → *Templates* → **Customize domain**.
Firebase zeigt die nötigen **DNS-Einträge**, die beim Domain-Anbieter zu
hinterlegen sind:

| Eintrag | Zweck |
|---------|-------|
| SPF (TXT) | erlaubt Firebase, für deine Domain zu senden |
| DKIM (CNAME/TXT) | signiert die Mails kryptografisch |
| DMARC (TXT) | sagt Empfängern, was bei Fälschungen zu tun ist |

Ohne diese drei Einträge hilft kein Design — mit ihnen landen die Mails
zuverlässig im Posteingang.

### 2. Vorlagen anpassen (~5 min)

Unter *Authentication → Templates* Absendername `autotrd` und Antwortadresse
setzen. Als Betreff empfehlen sich schlichte, ehrliche Zeilen ohne
Werbesprache und ohne Ausrufezeichen — beides erhöht die Spam-Bewertung:

- „autotrd: E-Mail-Adresse bestätigen"
- „autotrd: Neues Passwort festlegen"

Firebase erlaubt nur begrenztes HTML in den Vorlagen. Das ist kein Verlust:
Mails ohne Bilder und ohne externe Nachladungen werden von Spamfiltern
besser bewertet als gestaltete.

### 3. Prüfen

Nach der Umstellung eine Testregistrierung an eine Gmail- **und** eine
Outlook-Adresse. Landet sie im Posteingang und zeigt Gmail unter „Original
anzeigen" bei SPF, DKIM und DMARC jeweils `PASS`, ist alles richtig gesetzt.

## M. Echtgeld-Schlüssel in der App erlauben (~3 min)

Alpaca-Zugangsdaten liegen in `users/{uid}/private/broker`. Die
Firestore-Regeln sperren `private/**` für **jeden** Client — aber gegen einen
Datenbank-Export, ein kompromittiertes Dienstkonto oder einen Blick in die
Konsole hilft das nicht. Für ein Papierkonto ist das hinnehmbar; für echtes
Geld nicht.

Deshalb nimmt die App Echtgeld-Schlüssel (`AK…`) erst an, wenn ein
Hauptschlüssel für die verschlüsselte Ablage hinterlegt ist. Ohne ihn bleibt
alles wie bisher: Papierkonten funktionieren, Echtgeld wird mit Begründung
abgelehnt.

### 1. Hauptschlüssel erzeugen und hinterlegen

```bash
# 32 zufällige Bytes, base64 — genau diese Länge wird akzeptiert.
head -c 32 /dev/urandom | base64

# Den Wert einfügen, wenn danach gefragt wird:
firebase functions:secrets:set BROKER_MASTER_KEY
```

Den Wert **nirgends sonst speichern**. Geht er verloren, sind die
hinterlegten Schlüssel nicht mehr lesbar — dann trennt man die Verbindung in
der App und legt sie neu an. Das ist der ganze Schaden, und er ist gewollt:
Ein Hauptschlüssel mit Sicherungskopie an fünf Orten ist kein Geheimnis mehr.

### 2. Deklaration nachziehen

Erst **nach** Schritt 1: In `functions/src/callable/connectBroker.ts` und
`functions/src/scheduled/scanMarket.ts` muss `secrets: ['BROKER_MASTER_KEY']`
in den Function-Optionen stehen, sonst erreicht die Variable die Laufzeit
nie. Umgekehrte Reihenfolge bricht den Deploy mit „Secret does not exist".

### 3. Was danach möglich ist — und was nicht

Ein hinterlegter Echtgeld-Schlüssel schaltet **nichts scharf**. Orders
verlangen weiterhin alle drei Guards:

1. `broker.mode: 'live'` in den Konto-Einstellungen
2. Umgebungsvariable `ALPACA_ALLOW_LIVE=1`
3. bestandene Live-Reife-Prüfung (`shared/src/liveReadiness.ts`)

Was er sofort bringt: Der Abgleich liest das **echte** Depot und zeigt es in
der Broker-Karte. „Startklar, aber nicht scharf."

Zusätzlich verlangt das Hinterlegen eines `AK…`-Schlüssels eine Anmeldung,
die **höchstens fünf Minuten alt** ist. Das ist der zweite Faktor an der
Stelle, an der er wirkt: Nicht beim Login — dort schützt er gegen gestohlene
Passwörter, aber nicht gegen eine bereits übernommene, offene Sitzung.

## N. Tages-Einschätzung (KI) einschalten (~2 min, optional)

Die Karte „Was das System gelernt hat" arbeitet vollständig ohne KI: Die
Erkenntnis-Chronik entsteht deterministisch aus den eigenen Messwerten und
kostet nichts. Nur die **Tages-Einschätzung** darunter — ein Absatz, der die
Befunde miteinander in Beziehung setzt — braucht ein Sprachmodell.

Ohne hinterlegten Schlüssel bleibt genau diese eine Zeile leer und meldet
„nicht eingerichtet". Nichts anderes ändert sich; der Deploy bleibt grün.

### Status: bereits eingerichtet (Stand 08.08.)

**Hier ist nichts mehr zu tun.** Das Secret `ANTHROPIC_API_KEY` liegt seit dem
23.07. im Projekt — angelegt für die damalige KI-Staffel, nach deren Ausbau am
28.07. ungenutzt liegengeblieben. Die Deploy-Diagnose hat das bestätigt
(„VORHANDEN mit 1 aktiven Version"), und `functions/src/scheduled/kiBericht.ts`
bindet es seitdem über `secrets: ['ANTHROPIC_API_KEY']`.

Nur falls der Schlüssel einmal ersetzt werden muss:

```bash
firebase functions:secrets:set ANTHROPIC_API_KEY
```

Eine neue Version wird beim nächsten Deploy automatisch gebunden; an der
Deklaration ändert sich nichts.

**Reihenfolge bei WEITEREN Secrets:** erst anlegen, dann deklarieren. Eine
Deklaration für ein Secret, das es nicht gibt, bricht den GESAMTEN Deploy mit
„Secret does not exist". Ob eines existiert, sagt der Schritt
„Secret-Diagnose" in jedem Deploy-Log (`scripts-ci/check-secret.mjs`) — er
liest nur Metadaten, nie den Wert.

### Was das kostet, und was es nicht kann

Ein Aufruf pro Tag, um 18:25 ET, nachdem alle Tages-Läufe fertig sind. Die
Eingabe ist klein (Chronik plus Kennzahlen), die Antwort auf 200 Wörter
begrenzt — ein Lauf liegt im niedrigen Cent-Bereich. Zusätzlich greifen drei
Guards: idempotent je Datum (ein zweiter Aufruf am selben Tag tut nichts),
ein Monatsdeckel von 40 Läufen und ein hartes Token-Limit je Antwort.

Der Bericht **steuert nichts**. Er löst keine Order aus, ändert keine
Einstellung und befördert keine Strategie — jede solche Entscheidung braucht
weiterhin statistische Evidenz aus Auto-Tuner oder Struktursuche. Und das
Modell sieht ausschließlich selbst gerechnete Zahlen: keine Schlagzeilen,
keine Nutzertexte, nichts aus dem Netz. Damit lassen sich über die Eingabe
keine fremden Anweisungen einschleusen.
