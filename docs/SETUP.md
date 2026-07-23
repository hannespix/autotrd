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

## D. webgo: FTP-Zugang & Domain (~10 min)

1. webgo-Kundenportal → **FTP** → FTP-Benutzer anlegen (oder vorhandenen
   nehmen). **Wichtig:** Das Home-/Zielverzeichnis des FTP-Users direkt auf
   den DocumentRoot von `autotrd.net` zeigen lassen — der Workflow lädt
   `frontend/dist/` ins FTP-Wurzelverzeichnis hoch.
2. webgo → **Domains**: `autotrd.net` auf genau dieses Verzeichnis routen.
3. **SSL aktivieren** (Let's Encrypt im webgo-Panel) + HTTPS-Weiterleitung an.
4. GitHub Secrets (wie in C.4):
   - `FTP_HOST` — Servername aus dem webgo-Panel (z. B. `sXX.goserver.host`)
   - `FTP_USERNAME` — der FTP-Benutzer
   - `FTP_PASSWORD` — dessen Passwort

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
