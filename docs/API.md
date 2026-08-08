# Septona Kiosk — API contract v1

Base URL: `http://<host>:8080`. All JSON is `application/json; charset=utf-8`.

Stack: Node 20 + Express + **PostgreSQL 16**, all in Docker Compose. PDF bytes live on
a mounted volume, not in the database.

## Brand tokens (use these everywhere)

```
--sep-navy:        #26307A   /* logo body, primary surfaces, headers */
--sep-navy-deep:   #1B2359   /* pressed / dark gradient stop */
--sep-navy-soft:   #3A45A0   /* hover */
--sep-blue:        #2E8BC9   /* logo wave + "cotton care", accents, active state */
--sep-blue-light:  #6FB6E3   /* soft accent, focus rings */
--sep-blue-pale:   #E8F2FA   /* tinted backgrounds */
--sep-paper:       #F7F9FC   /* app background */
--sep-white:       #FFFFFF
--sep-ink:         #1A1F36   /* body text */
--sep-ink-muted:   #5B6478
--sep-line:        #DDE4EE
--sep-ok:          #1F8A5B
--sep-warn:        #C77700
--sep-danger:      #C0392B
```

Font stack: `"Inter","Noto Sans",system-ui,"Segoe UI",Roboto,sans-serif` — must render
Cyrillic. Kiosk base font size 18px; minimum touch target 56×56 px (24" 1920×1080 panel).

---

## Authentication

Two independent principals.

**Users** (admin platform) — `POST /api/auth/login {email,password}` →
`{token, user:{id,email,name,role}}`. Bearer JWT, 12 h. Roles: `admin` (everything,
incl. users + devices), `editor` (categories + documents), `viewer` (read + audit).

**Devices** (kiosks) — a long-lived device key sent as `X-Device-Key: <key>`.
Created in the admin panel. Grants read-only access to `/api/kiosk/*` only.

Errors: `{ "error": { "code": "STRING_CODE", "message": "human text" } }` with the
matching HTTP status.

---

## Kiosk endpoints (device key)

### `GET /api/kiosk/manifest`
The single source of truth the kiosk syncs against. Everything the app needs to render
its whole UI offline, minus the PDF bytes.

```jsonc
{
  "manifestVersion": 42,              // bumps on ANY content change
  "generatedAt": "2026-08-07T11:00:00Z",
  "settings": {
    "cycleEnabled": true,
    "cycleSeconds": 45,               // per-category override wins
    "idleResumeSeconds": 90,          // resume cycling this long after last touch
    "defaultLanguage": "bg",
    "kioskTitle": "Септона — Документи",
    "syncIntervalMinutes": 15
  },
  "categories": [
    {
      "id": "cat_evac",
      "slug": "planove-evakuaciya",
      "nameBg": "Планове евакуация",
      "nameEn": "Evacuation plans",
      "icon": "exit",                 // see icon set below
      "colour": "#C0392B",            // accent for the tile
      "sortOrder": 10,
      "cycleSeconds": null,           // null → inherit settings.cycleSeconds
      "visible": true,
      "parentId": null
    }
  ],
  "documents": [
    {
      "id": "doc_a1b2",
      "categoryId": "cat_evac",
      "titleBg": "План за действие при тероризъм",
      "titleEn": "Terrorism response plan",
      "language": "bg",               // "bg" | "en" | "both"
      "tags": ["евакуация","безопасност"],
      "sortOrder": 10,
      "pinned": false,
      "versionId": "ver_9f8e",        // current version
      "versionNumber": 3,
      "sha256": "…",
      "sizeBytes": 178019,
      "pageCount": 4,
      "updatedAt": "2026-06-19T07:53:00Z",
      "fileUrl": "/api/kiosk/file/ver_9f8e"
    }
  ]
}
```

Icon set (kiosk ships these as inline SVG, no network): `exit`, `policy`, `pin`,
`book`, `shield`, `fire`, `doc`, `people`, `leaf`, `factory`, `phone`, `clipboard`.

### `GET /api/kiosk/file/{versionId}`
Returns `application/pdf`. Supports `ETag` + `If-None-Match` → `304`. Immutable: a
version's bytes never change, so the kiosk may cache forever keyed on `versionId`.

### `POST /api/kiosk/heartbeat`
`{appVersion, manifestVersion, docsCached, storageBytes}` → `{ok:true}`. Lets the
admin panel show each display's last-seen time and sync state.

---

## Admin endpoints (JWT)

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/api/categories` | viewer | flat list incl. hidden |
| POST | `/api/categories` | editor | `{nameBg,nameEn,icon,colour,sortOrder,parentId,cycleSeconds,visible}` |
| PATCH | `/api/categories/{id}` | editor | partial |
| DELETE | `/api/categories/{id}` | admin | 409 `CATEGORY_NOT_EMPTY` unless `?reassignTo=<id>` |
| POST | `/api/categories/reorder` | editor | `{order:[id,…]}` |
| GET | `/api/documents` | viewer | `?categoryId=&q=&language=&page=&pageSize=` · `?deleted=live\|include\|only` (default `live`) |
| GET | `/api/documents/{id}` | viewer | includes full `versions[]` |
| POST | `/api/documents` | editor | multipart: `file` + JSON `meta` field |
| PATCH | `/api/documents/{id}` | editor | metadata only |
| POST | `/api/documents/{id}/versions` | editor | multipart `file`, `note` → new version, becomes current |
| POST | `/api/documents/{id}/versions/{versionId}/restore` | editor | makes an old version current again |
| DELETE | `/api/documents/{id}` | admin | archives (soft). `?hard=true` deletes the rows **and** the PDF files from disk, keeping any blob still referenced by another document. Returns `{ok, hard, versions, filesRemoved}` |
| POST | `/api/documents/{id}/restore` | editor | brings an archived document back |
| GET | `/api/documents/{id}/versions/{versionId}/file` | viewer | inline preview |
| GET | `/api/audit` | viewer | `?entity=&entityId=&actorId=&from=&to=&page=` |
| GET | `/api/users` / POST / PATCH / DELETE | admin | |
| GET | `/api/devices` / POST / DELETE | admin | POST returns the plaintext key **once** |
| GET | `/api/settings` / PATCH | admin | the `settings` block above |
| GET | `/api/stats` | viewer | counts for the dashboard |

### Upload rules
`multipart/form-data`. Field `file`, plus `meta` = JSON string of the document fields.
Max 100 MB. **PDF only** — anything else is rejected with `415 UNSUPPORTED_FILE_TYPE`
and the message «Приемат се само PDF файлове.» The admin UI must state this on the
dropzone. (A headless-LibreOffice converter ships with the server but is disabled by
default; `settings.allowOfficeConversion = true` enables it, and the one-off archive
importer uses it to rescue legacy .docx/.xlsx/.ods files.)

Duplicate detection by sha256 → `409 DUPLICATE_CONTENT` with the colliding document
id (override with `?allowDuplicate=true`).

### Audit entry
```jsonc
{
  "id": 1201,
  "at": "2026-08-07T11:02:14Z",
  "actorType": "user",              // "user" | "device" | "system"
  "actorId": "usr_1", "actorName": "Стоян К.",
  "action": "document.version.create",
  "entity": "document", "entityId": "doc_a1b2",
  "summary": "Качена версия 3 на «План за действие при тероризъм»",
  "before": null, "after": {…},
  "ip": "10.0.4.22"
}
```
Actions: `auth.login`, `auth.login.failed`, `category.create|update|delete|reorder`,
`document.create|update|delete|restore`, `document.version.create|restore`,
`user.create|update|delete`, `device.create|revoke`, `settings.update`,
`kiosk.sync`. The audit log is append-only — no endpoint mutates or deletes rows.
