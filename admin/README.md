# Septona Kiosk — Admin platform

React 18 + TypeScript administrative interface for the Septona document kiosk system.

## Run locally

```bash
npm install
npm run build
```

The static production bundle is written to `dist/` and uses a relative Vite base (`./`), so it can be hosted from any path. The interface calls the API at the current origin by default; set `VITE_API_BASE_URL` at build time when the API is hosted elsewhere.

## Included

- JWT login and role-based navigation (`admin`, `editor`, `viewer`)
- Dashboard, categories, documents and PDF-version history, audit log, users, devices, and kiosk settings
- PDF-only drag-and-drop uploads with 100 MB validation, upload progress, duplicate-content retry, and server error handling
- Bulgarian UI, accessible confirmation dialogs, loading skeletons, empty/error states, toast notifications, and responsive sidebar layout

`npm run build` has been run successfully for this deliverable.
