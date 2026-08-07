# Septona Kiosk

Offline-first document board for the **Iiyama ProLite TW2424AS-B3P** touch panel, with a
web management platform for publishing and revising the documents it shows.

The panel keeps a complete local copy of every published PDF. It reads from that copy at
all times, so page turns are instant and the board keeps working through a network
outage. The network is used only to pull new or revised documents from the server.

The panel app is **portrait-first**, matching the wall-mounted orientation of the
display. The same interface is also served as a **web app at `/kiosk`**, so any browser
on the network is an equivalent viewer.

---

## What is in here

| Folder | What it is |
| --- | --- |
| `server/` | Node 20 + Express + PostgreSQL. Sync API for the panels, admin API, version store, audit log. |
| `admin/` | Management platform (React + Vite). Upload and revise PDFs, manage categories, users, devices, view the audit trail. |
| `kiosk/` | The panel app (React + Vite + pdf.js), wrapped with Capacitor into an Android APK. |
| `deploy/` | Container image for the server, plus `install.sh` — the one-command Ubuntu installer. |
| `docs/` | `DEPLOYMENT.md` — Proxmox/Ubuntu install guide (BG). `API.md` — the API and brand contract. `OPERATIONS.md` — day-to-day runbook. |
| `dist/` | Prebuilt, signed `septona-kiosk-1.0.2.apk`, with the current document set already embedded. |

---

## Quick start

### 1. Server

On a fresh Ubuntu Server 22.04 / 24.04 machine — installs Docker, generates strong
secrets and starts everything:

```bash
curl -fsSL https://raw.githubusercontent.com/SKuytov/septona-kiosk/main/deploy/install.sh | sudo bash
```

It prints the generated administrator password at the end. See
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for the Proxmox VM setup, backups and
troubleshooting.

Manually, if you already run Docker:

```bash
cp .env.example .env
# edit .env: set JWT_SECRET and POSTGRES_PASSWORD
docker compose up -d --build
```

Either way the management platform is at `http://<server-ip>:8080` and the browser
version of the kiosk at `http://<server-ip>:8080/kiosk/`.

### 2. Register the panel

In the admin platform, go to **Устройства → Ново устройство**. A device key is shown
**once** — copy it.

### 3. Install the app

Copy `dist/septona-kiosk-1.0.4.apk` to the panel and install it (allow installation from
unknown sources). Open it, then:

1. Press and hold the Septona logo in the top-left for **3 seconds**. If holding does
   not work on a particular panel, tapping the logo **five times** within four seconds
   does the same thing.
2. Enter the service PIN — `2470`.
3. Enter the server address (e.g. `http://192.168.1.50:8080`) and the device key.
4. Press **Проверка на връзката**, then **Запази**.

The shipped APK already contains the published document set, so the board is complete
the moment it opens — before step 1 has even been done. Registering it against a server
adds updates on top; see [Preloaded documents](#preloaded-documents).

### Reading a document

On anything 760 CSS pixels wide or more — the 24" panel, and an 11" tablet in either
orientation — opening a document splits the screen: the documents of the current
category stay in a narrow column on the left, the page fills the rest. The panel button
in the top-left of the document bar collapses that column so the page takes the full
width, and the expand button next to it hides the header and category rail as well.

The page can be pinched to zoom with two fingers, dragged with one, and double-tapped to
alternate between fit-to-width and 200%. Swiping left and right turns the page, and the
footer keeps the same controls as buttons for panels without a touchscreen.

A swipe and a drag share the one finger, so they are told apart the way a photo viewer
does it: a sideways drag pans while the page still has room to move that way, and turns
the page only once it has run out. At fit-to-width there is never any room, so a swipe
always turns. Zoomed in, the swipe reaches the edge of the page first and the next one
turns it. Past the first or last page the drag follows the finger a little and springs
back, so the panel visibly answers the gesture. A short slow drag springs back too; a
quick flick turns the page without having to travel the full width. Below 760 pixels — a phone — the document opens over the board
instead, because a split of that width leaves neither half usable.

### 4. Or open it in a browser

`http://<server-ip>:8080/kiosk/` runs the identical interface. It needs a device key
too; either enter it through the same service screen, or hand it over once in the URL:

```
http://<server-ip>:8080/kiosk/?key=sk_xxxxxxxx_xxxxxxxxxxxx
```

The key is saved locally and removed from the address bar. The browser version is meant
for desktops and phones on the network — the wall panels should run the APK, which is
the build that is genuinely offline-capable.

---

## How content reaches the panel

```
admin uploads PDF  →  new immutable version row  →  manifestVersion++  
                                                          │
panel polls /api/kiosk/manifest every 15 min  ←───────────┘
     │  manifest version changed?
     └─→ download only the versions it does not already hold  →  IndexedDB
```

Because document bytes are addressed by an **immutable version id**, a cached file can
never be stale — it can only be superseded. When a new version appears the panel
downloads it and prunes the old one. Nothing is re-downloaded unnecessarily, so a
revision to one policy costs one file transfer, not a full resync.

If the server is unreachable the panel logs the failure, shows an "Офлайн режим"
indicator in the header, and carries on serving from its local copy.

---

## Version control and audit trail

Every document is a chain of versions. Uploading a revision creates version *n+1* and
leaves *n* intact; any earlier version can be previewed and restored from the document
detail page. Restoring does not delete anything — it appends a new version pointing at
the older bytes, so the history stays complete.

The audit log is **append-only** — there is no API that updates or deletes a row. It
records logins, category and document changes, version creation and restoration,
deletions, user and device changes, and settings changes, each with actor, timestamp and
client IP.

Deleting a document is a soft delete. It disappears from the panels and from the default
admin list, but the row and all its versions remain in the database.

## User access

Three roles:

| Role | Can do |
| --- | --- |
| `viewer` | Read the catalogue and the audit trail. |
| `editor` | Everything a viewer can, plus create/edit/upload documents, versions and categories. |
| `admin` | Everything, plus manage users, devices and settings. |

Panels do not use accounts. They authenticate with a per-device key sent as
`X-Device-Key`, which grants read-only access to published content and nothing else. A
key can be revoked from **Устройства** without touching the panel.

---

## Categories

The four categories are seeded from the folder names in the original archive:

- Планове евакуация
- Политики
- Постоянно видими
- ОСНОВНО УПЪТВАНЕ

They are ordinary rows, not code. Rename them, reorder them, change their colour and
icon, hide them, or add new ones from **Категории** in the admin platform. Deleting a
category that still holds documents is refused until you say where those documents
should go.

## Languages

Each document is tagged `bg`, `en` or `both`. The panel header has a **БГ / EN** switch
that filters the whole board; a category with nothing to show in the selected language is
hidden rather than shown empty, so the automatic cycle never lands on a blank screen.

## Automatic cycling

Categories advance on their own — 45 seconds each by default, configurable globally and
per category. Touching the screen pauses the cycle; it resumes after 90 seconds of
inactivity. It never advances while somebody has a document open or the search panel up.
An operator can also pause it explicitly from the control at the right of the category
bar.

---

## Preloaded documents

The APK can ship with the published set embedded, so a panel shows the full board on
first power-up with no server, no network and no configuration. On first launch the
bundle is copied into IndexedDB; after that it is ordinary cached content.

Generate the bundle against a running server, then build:

```bash
cd kiosk
SEED_SERVER=http://192.168.1.50:8080 \
SEED_DEVICE_KEY=sk_xxxxxxxx_xxxxxxxxxxxx \
  node scripts/make-seed.mjs      # -> kiosk/public/seed/  (~13 MB for 55 documents)
npm run build
npx cap copy android && cd android && ./gradlew assembleRelease
```

Each file is checked for PDF magic bytes and against the size in the manifest before it
is embedded, and the bundled manifest lists only what was actually written — a panel
never shows a card it cannot open.

### Byte validation on the device

Build-time checks are not enough on their own. Inside the APK the documents are served by
Capacitor's asset server, whose responses carry no `Content-Length`, so a short or
interrupted read looks like a perfectly ordinary success: the response is "ok" and
`arrayBuffer()` simply resolves with fewer bytes than the file has. Version 1.0.1 stored
whatever came back, which is why the board could show cards whose documents then failed
to open.

Every PDF is therefore validated again on the device before it is stored or opened —
header, `%%EOF` trailer and exact length against the manifest (`kiosk/src/lib/pdfBytes.ts`).
If a read is short it is retried through `XMLHttpRequest`, which takes a different path
through the asset layer. Consequences:

- A bad byte stream is never stored silently; the document is skipped and the reason kept.
- Opening a document whose stored copy is damaged repairs it from the bundled copy.
- Panels that already hold an unvalidated copy re-import once on upgrade (`seedGeneration`
  in `kiosk/src/lib/seed.ts`), so no cache wipe is needed on site. A panel that has synced
  with a server is never touched.

### Diagnostics

The maintenance screen (hold the logo 3 s, service code) has a **Диагностика** panel that
checks the whole path a document travels — WebView version, module-worker support, the
manifest, every stored file, a read straight from the APK, and an end-to-end test open —
and reports the first thing that is actually broken. Use it before escalating any "document
cannot be opened" report. When a document does fail, the viewer now shows the technical
reason under the message instead of a generic network hint.

To build a panel that must be configured on site instead:

```bash
node scripts/make-seed.mjs --clean
```

`kiosk/public/seed/` is generated output and is not tracked in git.

### How it is replaced by the server

Nothing special happens on handover. Sync saves the server's manifest and deletes every
cached file the server's manifest does not reference, which is the same reconciliation
that retires superseded revisions. So pointing a seeded panel at a server converges on
exactly the server's set — with no duplication — even when that server assigned
different version ids to the same documents.

A deliberate cache wipe from the service screen is not undone: the import runs once and
records that it did.

---

## Building from source

Requirements: Node 20, JDK 17, Android SDK (platform 34, build-tools 34.0.0).

```bash
# Panel app + signed APK
cd kiosk
npm install
npm run build
npx cap sync android
cd android && ./gradlew assembleRelease
# → app/build/outputs/apk/release/app-release.apk
```

### Screen orientation

The APK is built **portrait** — the orientation the TW2424AS is wall-mounted in. It is a
Gradle property, so a landscape build needs no source change:

```bash
./gradlew assembleRelease -PkioskOrientation=landscape
```

The default lives in `kiosk/android/app/build.gradle` as a manifest placeholder. The
layout itself is responsive and handles both — the category bar wraps to two rows and
the document grid drops to two columns in portrait — so this only pins which one the
panel is locked to.

> **Do not** point `android:screenOrientation` at a string resource. It is an *enum*
> attribute, so the platform reads it as an integer; a resource reference makes the
> package parser reject the whole APK at install time with the unhelpful message
> *"There was a problem parsing the package"*. `aapt2 dump xmltree` should show
> `screenOrientation(0x0101001e)=1`, a literal int — not `@0x7f...`.

### Shipping a pre-configured APK

To hand an installer a panel that needs no on-site setup, bake the connection in at
build time:

```bash
cd kiosk
VITE_DEFAULT_SERVER="http://192.168.1.50:8080" \
VITE_DEFAULT_DEVICE_KEY="sk_xxxxxxxx_..." \
npm run build && npx cap sync android && cd android && ./gradlew assembleRelease
```

A key entered later through the service screen always overrides the baked-in one.

### Signing

`kiosk/android/keystore.properties` points at a demo keystore committed for
reproducibility. **Generate your own before deploying**, and keep it safe — Android
refuses to install an update signed with a different key, which would mean uninstalling
every panel by hand.

```bash
keytool -genkeypair -v -keystore septona-kiosk.jks -alias septona \
        -keyalg RSA -keysize 4096 -validity 10950
```

---

## Importing an existing folder tree

`server/scripts/import-archive.js` performs a one-off import of a folder of documents,
using top-level folder names as categories and detecting language from folder and file
names. Office formats are converted to PDF via LibreOffice during import.

```bash
cd server
DATABASE_URL=... DATA_DIR=... node scripts/import-archive.js /path/to/KIOSK_DOCS
```

On a Docker installation use the wrapper instead — it unpacks a `.zip`, copies the tree
into the container and runs the importer there:

```bash
sudo bash /opt/septona-kiosk/deploy/import-docs.sh ~/KIOSK_DOCS.zip   # or a folder
```

Note the asymmetry: the importer accepts Office files, but the **HTTP upload path is
PDF-only** and rejects anything else with `415 UNSUPPORTED_FILE_TYPE`. That is
deliberate — silent server-side conversion of a policy document can reflow pagination,
and a policy that renders differently on the wall than in the file the author approved is
worse than a rejected upload.

---

## Panel setup notes

Set the app as the device **Home app** (Settings → Apps → Default apps → Home app) so a
power cut brings the board straight back with no Android home screen in between. The app
runs fine as an ordinary app too.

The activity holds the screen awake, locks to landscape and uses sticky immersive mode,
so the status and navigation bars stay hidden even after an edge swipe. The hardware back
button closes the topmost layer inside the app and never exits it.

See [`docs/OPERATIONS.md`](docs/OPERATIONS.md) for the day-to-day runbook and
[`docs/API.md`](docs/API.md) for the full API reference.
