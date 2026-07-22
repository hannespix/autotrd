# frontend/ — SPA für autotrd.net

**Status: Skeleton — wird in M1 aufgesetzt (siehe [MILESTONES.md](../MILESTONES.md)).**

- Stack: Vite + TypeScript + Firebase JS-SDK (Auth + Firestore `onSnapshot`).
- **UI-Seed:** `../reference/scripts/static/index.html` — das bestehende
  Frosted-Aurora-Dashboard. Der Kern (Look, Charts, Modals, Responsive-Verhalten)
  wird in M3 hierher portiert, **nicht neu erfunden**.
- Konventionen aus [CLAUDE.md](../CLAUDE.md) §6 gelten: Lightweight Charts
  **v4.2.0** gepinnt, keine Top-Level-CDN-Referenz, `data-theme` Light/Dark,
  `prefers-reduced-motion`, responsive bis 360 px.
- Es gibt **kein** eigenes Backend mehr: Daten kommen aus Firestore,
  Aktionen laufen über Callable Functions. Keine Business-Logik hier.
- Build (`npm run build --workspace frontend`) → `dist/` → FTPS-Deploy zu
  webgo via `.github/workflows/deploy-frontend.yml`.
