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
5-min-Scan, evalForecasts, tunerReview — anzulegen) (Letztere braucht der Deploy, um Callables/HTTP-
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

**Außerdem VOR dem nächsten Deploy nötig:** Der Deploy bindet das Secret
`ANTHROPIC_API_KEY` (KI-Staffel, §H) und scheitert sonst mit
*„secretmanager.secrets.get denied on resource (or it may not exist)"*.
Zwei Dinge fixen das:

1. **Secret anlegen** — ohne lokale CLI direkt in der Cloud-Konsole:
   *Security → Secret Manager → Create Secret*, Name exakt
   `ANTHROPIC_API_KEY`, Wert = der Key aus console.anthropic.com.
   (Alternativ lokal: `npx firebase functions:secrets:set ANTHROPIC_API_KEY
   --project <projekt-id>`.) Kein Key zur Hand? Platzhalter-Wert setzen und
   später überschreiben — die App degradiert bei ungültigem Key sichtbar
   auf regelbasiert und bleibt voll funktionsfähig.
2. **Rolle fürs Lesen/Binden:** dem Service-Account `github-deploy`
   zusätzlich **Secret Manager Admin** geben (der Deploy liest das Secret
   und erteilt der Functions-Laufzeit den Accessor-Zugriff — „Firebase
   Admin" allein deckt das nicht ab).

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
- Bis dahin überbrückt der Workflow **Scan-Watchdog**
  (`scan-watchdog.yml`): er stößt zu US-Marktzeiten alle 30 min einen Scan
  direkt am Cloud-Run-Service an — aber nur, wenn der Heartbeat älter als
  12 min ist. Sobald der echte Scheduler läuft, ist der Watchdog
  automatisch ein No-op.
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
| `tunerReview`    | KI-Review des Suchgitters                   | `meta/tuner.ts`             |

Die Felder sind **ohne Anmeldung lesbar** — fehlen sie oder ist ihr Datum alt,
hat der jeweilige Lauf nicht stattgefunden. Zwei Wege überbrücken das:

- Der Workflow **Tages-Läufe** (`daily-jobs.yml`) stößt alle drei nach
  US-Schluss direkt am Cloud-Run-Service an und prüft anschließend die Spur —
  ein HTTP-200 allein gilt ausdrücklich nicht als Erfolg. Manuell auslösen:
  *Actions → Tages-Läufe → Run workflow* (mit `force`, um das Gate zu übergehen).
- Der **Deploy** stößt zusätzlich `snapshotEquity` und `evalForecasts` an, damit
  die Karten nach einem Merge binnen Minuten gefüllt sind statt erst abends.
  `tunerReview` bleibt ausgespart — der Lauf kostet Anthropic-Guthaben.

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

## H. KI-Staffel: Anthropic-API-Key (M6, ~5 min)

Ohne Key läuft alles weiter — die KI-Tageskarte degradiert dann sichtbar auf
die regelbasierte Lexikon-Zusammenfassung (`reason: no_api_key`). Für echte
KI-Erklärungen (Haiku-Klassifikation + Sonnet-Tagessatz):

1. Key erzeugen: <https://console.anthropic.com> → *API Keys* → **Create Key**
   (eigenes Workspace „autotrd" empfohlen, dort ein **Spend-Limit** setzen —
   z. B. 5 $/Monat; die Staffel braucht bei 4 Symbolen nur Cent-Beträge).
2. Als Functions-Secret hinterlegen (einmalig, **vor** dem nächsten
   Functions-Deploy — der Deploy bindet das Secret):

   ```bash
   npx firebase functions:secrets:set ANTHROPIC_API_KEY --project <projekt-id>
   ```

3. Nächsten Functions-Deploy laufen lassen (Merge auf `main` genügt).
4. Abnahme (M6): Nach einem Scan mit News zeigt die KI-Karte „Warum bewegt
   sich X?" einen KI-Satz mit Modell-Angabe statt „regelbasiert"; in der
   Anthropic-Konsole liegen die Tageskosten im Cent-Bereich; ein zweiter
   Scan erzeugt KEINEN weiteren API-Call (Cache `market/{sym}/ai/{datum}`).
5. Optional: Tagesbudget anpassen — Firestore-Doc `admin/aiBudget`, Feld
   `dailyTokenBudget` (Default 200 000 Token/Tag). Bei Überschreitung
   degradiert die Pipeline sichtbar auf regelbasiert, nichts fällt aus.

Lokal im Emulator: `functions/.secret.local` mit
`ANTHROPIC_API_KEY=sk-ant-…` anlegen (steht in `.gitignore`, nie committen).

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
2. **Scan-Ausfall:** *Monitoring → Uptime Checks* → HTTPS-Check auf
   `https://us-central1-<projekt-id>.cloudfunctions.net/healthz` (Intervall
   5 min) + Alert bei Ausfall. Zusätzlich fällt ein stehender Scan sofort in
   der App auf (Quotes/`meta/health.lastScanAt` altern).
3. **Budget:** Billing → *Budgets & alerts* → Budget (z. B. 10 €/Monat) mit
   50/90/100 %-Mails — deckt Firestore, Functions UND ausufernde KI-Kosten ab
   (zusätzlich zum Token-Guard `admin/aiBudget` und dem Anthropic-Spend-Limit
   aus §H).

## K. Supabase-Projekt anlegen (Migration MS, ~10 min)

Ab der Migration (MILESTONES *MS*) läuft die Datenhaltung auf Supabase.
Bestehende Firebase-Daten werden **nicht** übernommen — Konten und Wallets
entstehen auf der neuen Instanz frisch.

1. **Projekt anlegen:** [supabase.com](https://supabase.com) → *New Project*
   - Name: `autotrd`
   - **Region: Frankfurt (eu-central-1)** — kurze Wege zu den Nutzern und
     Daten in der EU.
   - Datenbank-Passwort erzeugen lassen und **sicher speichern** (es wird
     unten für die Migrationen gebraucht und ist später nicht mehr einsehbar).
2. **Schlüssel abholen:** *Project Settings → API*
   - `Project URL` → z. B. `https://abcdefgh.supabase.co`
   - `anon public` → der Schlüssel für den Browser
   - `service_role` → **Vollzugriff, umgeht ALLE Sicherheitsregeln.**
     Gehört ausschließlich in GitHub-Secrets und Edge Functions, **niemals**
     in den Frontend-Build oder ins Repo.
3. **Verbindungszeichenfolge:** *Project Settings → Database → Connection
   string → URI*, das Passwort aus Schritt 1 einsetzen.
4. **Im GitHub-Repo hinterlegen** (*Settings → Secrets and variables → Actions*):

   | Art | Name | Wert |
   |-----|------|------|
   | Secret | `SUPABASE_DB_URL` | Verbindungszeichenfolge aus Schritt 3 |
   | Secret | `SUPABASE_SERVICE_ROLE_KEY` | `service_role`-Schlüssel |
   | Variable | `VITE_SUPABASE_URL` | Project URL |
   | Variable | `VITE_SUPABASE_ANON_KEY` | `anon public`-Schlüssel |

   Der `anon`-Schlüssel steht später im ausgelieferten JavaScript — das ist
   so vorgesehen und ungefährlich, weil jede Zeile zusätzlich durch Row Level
   Security geschützt ist (`supabase/migrations/0002_rls.sql`). Genau deshalb
   ist die Trennung zum `service_role`-Schlüssel so wichtig.
5. **Migrationen einspielen:** Sobald `SUPABASE_DB_URL` gesetzt ist, spielt
   der Workflow *Deploy Supabase (Migrationen)* bei jedem Push auf `main`
   alle Dateien aus `supabase/migrations/` ein (idempotent, in Reihenfolge).
   Manuell geht es genauso: `psql "$SUPABASE_DB_URL" -f supabase/migrations/0001_schema.sql`
6. **Abnahme:** In der Supabase-Konsole unter *Table Editor* stehen die
   Tabellen `profiles`, `wallets`, `positions`, `trades`, `strategies`,
   `market_symbols` … und unter *Authentication → Policies* die Regeln.
   `wallets` darf **keine** Insert/Update-Policy haben — Geld schreibt nur
   der Server.

## L. Sich selbst zum Admin machen (nach der Registrierung)

Neue Konten landen auf der Stufe `pending` — sie sehen die App, können aber
weder die Engine starten noch handeln. Das gilt auch für **dein eigenes**
Konto. Einmalig freischalten und zum Admin machen:

1. Auf autotrd.net registrieren (normale Anmeldung).
2. Supabase-Dashboard → **SQL Editor** → ausführen (E-Mail anpassen):

   ```sql
   update public.profiles
      set role = 'admin', access_level = 'approved', approved_at = now()
    where email = 'deine@mailadresse.de';
   ```

3. Neu laden — die Admin-Ansicht mit den offenen Anfragen erscheint.

Ab da geht alles über die Oberfläche: Neue Registrierungen tauchen dort auf
und werden per Klick freigeschaltet. Der SQL-Schritt ist nur für den ersten
Admin nötig — vorher gibt es ja niemanden, der freischalten könnte.

**Warum das nicht über die App geht:** Wer sich selbst freischalten könnte,
bräuchte kein Freischaltsystem. Ein Datenbank-Riegel weist genau das ab
(Testfälle 18/19) — die einzige Ausnahme ist der direkte Datenbankzugriff,
den nur du hast.

## M. E-Mails: eigener Absender + Vorlagen (gegen den Spam-Ordner)

**Warum Bestätigungsmails im Spam landen:** Nicht wegen des Textes, sondern
wegen des Absenders. Die eingebauten Mails kommen von einer generischen
Adresse des Anbieters (`noreply@mail.app.supabase.io`) — für Spamfilter
schreibt da eine fremde Domain im Namen von autotrd.net. Genau dieses Muster
bewerten sie schlecht, egal wie schön die Mail gestaltet ist.

Dazu kommt ein praktischer Grund: Der eingebaute Versand ist im kostenlosen
Tarif auf wenige Mails pro Stunde begrenzt und für echten Betrieb ohnehin
nicht gedacht.

### 1. Mail-Dienst einrichten (~15 min)

Einen Anbieter wählen (Resend, Postmark und Brevo haben brauchbare
Gratis-Kontingente), dort `autotrd.net` als Absenderdomain eintragen und die
angezeigten **DNS-Einträge bei deinem Domain-Anbieter hinterlegen**:

| Eintrag | Zweck |
|---------|-------|
| SPF (TXT) | erlaubt dem Dienst, für deine Domain zu senden |
| DKIM (CNAME/TXT) | signiert die Mails kryptografisch |
| DMARC (TXT) | sagt Empfängern, was bei Fälschungen zu tun ist |

Ohne diese drei Einträge hilft kein Design — mit ihnen landen die Mails
zuverlässig im Posteingang. Anschließend in Supabase unter
*Project Settings → Authentication → SMTP Settings* den Dienst eintragen,
Absender `noreply@autotrd.net`, Anzeigename `autotrd`.

### 2. Vorlagen einsetzen (~5 min)

Unter *Authentication → Emails* die Vorlagen aus `supabase/templates/`
einfügen:

| Supabase-Vorlage | Datei |
|------------------|-------|
| Confirm signup | `confirm-signup.html` |
| Reset password | `reset-password.html` |
| Magic Link | `magic-link.html` |

Als Betreff empfehlen sich schlichte, ehrliche Zeilen ohne Werbesprache und
ohne Ausrufezeichen — beides erhöht die Spam-Bewertung:

- „autotrd: E-Mail-Adresse bestätigen"
- „autotrd: Neues Passwort festlegen"
- „autotrd: Dein Anmeldelink"

Die Vorlagen sind bewusst als Tabellen mit Inline-Styles gebaut (viele
Mail-Programme ignorieren `<style>`-Blöcke), enthalten **keine Bilder und
keine externen Nachladungen** — auch das fließt in die Spam-Bewertung ein —
und zeigen den Ziel-Link im Klartext, statt ihn hinter Text zu verstecken.

### 3. Prüfen

Nach der Umstellung eine Testregistrierung an eine Gmail- **und** eine
Outlook-Adresse. Landet sie im Posteingang und zeigt Gmail unter „Original
anzeigen" bei SPF, DKIM und DMARC jeweils `PASS`, ist alles richtig gesetzt.

## N. Scan als Edge Function betreiben (Migration MS3)

Der Marktdaten-Scan läuft als Supabase Edge Function (`supabase/functions/scan`).
Er benutzt dieselbe Rechenlogik wie bisher — Indikatoren, Konfluenz und
Katalog kommen unverändert aus `shared/` und laufen in Deno, weil sie keine
Node-Bibliotheken benutzen.

### Einmal einrichten

1. **Zugriffs-Token** erzeugen: [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens)
   → als GitHub-Secret `SUPABASE_ACCESS_TOKEN` hinterlegen.
2. **Funktion veröffentlichen** (lokal oder über den Workflow):

   ```bash
   node scripts-ci/build-edge-shared.mjs        # leitet _shared/ ab
   npx supabase functions deploy scan --project-ref zofhylhgohxqtfostmlw
   ```

3. **Alle 5 Minuten aufrufen** — einmalig im SQL-Editor ausführen und dabei
   `DEIN-SECRET-KEY` einsetzen (der Schlüssel steht dann in der Datenbank,
   nicht im Repo):

   ```sql
   create extension if not exists pg_cron;
   create extension if not exists pg_net;

   select cron.schedule('autotrd-scan', '*/5 * * * *', $$
     select net.http_post(
       url     := 'https://zofhylhgohxqtfostmlw.supabase.co/functions/v1/scan',
       headers := '{"Authorization": "Bearer DEIN-SECRET-KEY", "Content-Type": "application/json"}'::jsonb
     );
   $$);
   ```

   Prüfen: `select * from cron.job;` · Verlauf: `select * from cron.job_run_details order by start_time desc limit 5;`

### Abnahme

`select value from public.meta where key = 'health';` zeigt `lastRunAt`,
`symbolsOk` und `source: 'supabase-edge'`. Wächst `lastRunAt` alle fünf
Minuten, läuft der Scan.
