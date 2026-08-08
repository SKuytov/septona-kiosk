# Operations runbook

Day-to-day tasks for the Septona document board.

---

## Publishing a new document

1. Sign in to the management platform.
2. **Документи → Нов документ**.
3. Pick the category, enter the Bulgarian title and, if there is one, the English title.
4. Set the language tag:
   - `bg` — shows only when the panel is in Bulgarian
   - `en` — shows only when the panel is in English
   - `both` — always shows
5. Drop in the PDF and save.

Panels pick it up on their next poll — within 15 minutes by default. To push it out
immediately, walk to the panel and use **Синхронизирай сега** in the service screen.

## Revising a document

Open the document and use **Нова версия**. The previous version stays in the history.
Panels download only the changed file, not the whole catalogue.

Do not create a second document for a revision. Uploading a new version keeps the audit
chain intact and means the panel replaces the old file instead of showing both.

## Rolling back

Open the document → **История на версиите** → **Възстанови** on the version you want.
This appends a new version pointing at the older bytes; nothing is destroyed, and the
rollback itself appears in the audit log.

## Removing a document

Each row in **Документи** has a bin icon, and so does the document's own page. It offers
two different things, and the difference matters.

**Архивирай** is the safe one, and the default. The document leaves the panels at their
next sync and leaves the document list. Every version, and the whole audit trail, stay in
the database. Use it for a policy that has been withdrawn — you keep the evidence that it
existed and what it said.

To find an archived document again, switch the list from **Активни** to **Архив**.
**Върни** puts it straight back on the panels.

**Изтрий окончателно** is only reachable from **Архив**, and it asks you to type the
document's title before it will do anything. It deletes the rows *and* the PDF files from
the server's disk. Nothing brings it back. The audit trail entry survives, so there is
still a record that someone deleted something and when.

Two things worth knowing:

- A panel that is currently offline keeps its cached copy of the PDF until it next reaches
  the server. Deleting a document does not reach out and wipe the displays.
- If two documents were uploaded from byte-identical files, the server stores the file
  once. Deleting one of them permanently leaves the file in place for the other. The
  toast tells you how many files actually left the disk.

Only an **admin** can archive or delete. An editor can upload and revise, but not remove.

To empty a whole category, tick the header checkbox and use **Архивирай избраните**.

---

## Categories

**Категории** lets you rename, reorder (drag), recolour, change the icon, hide, create
and delete.

- **Hiding** a category is the reversible option — it disappears from the panels but
  keeps its documents.
- **Deleting** a category that still holds documents is refused. The dialog asks which
  category to move them to first.
- Per-category `cycleSeconds` overrides the global cycle time — useful for a category
  with a single large evacuation plan that people need longer to read.

---

## Adding a panel

1. **Устройства → Ново устройство**. Give it a name that identifies its physical
   location, e.g. "Производство — вход A".
2. Copy the device key. **It is shown once and cannot be retrieved afterwards.** If it
   is lost, delete the device and create a new one.
3. On the panel: hold the logo 3 s → PIN `2470` → enter server address and key →
   **Проверка на връзката** → **Запази**.

The device list shows each panel's last heartbeat, app version and cached content
version, so you can confirm from your desk that every board is on current content.

## Retiring or replacing a panel

Delete the device in **Устройства**. Its key stops working at the next request. The
panel keeps showing its local copy until someone reconfigures or uninstalls it — so
physically decommission it as well if the content is sensitive.

---

## Users

**Потребители** → **Нов потребител**. Assign the lowest role that does the job:

- `viewer` for auditors and inspectors who need to see what is published and who changed
  what, without being able to change anything.
- `editor` for the people who actually maintain documents.
- `admin` only for those who need to manage users, devices and settings.

You cannot remove your own admin role or delete your own account — this prevents locking
everyone out.

---

## Settings

**Настройки** controls panel behaviour globally:

| Setting | Meaning |
| --- | --- |
| `kioskTitle` | Text in the panel header next to the logo. |
| `defaultLanguage` | Language a freshly installed panel starts in. |
| `cycleEnabled` | Master switch for automatic category cycling. |
| `cycleSeconds` | Default seconds per category (45). |
| `idleResumeSeconds` | Inactivity before cycling resumes after a touch (90). |
| `syncIntervalMinutes` | How often panels poll for changes (15). |

Lowering `syncIntervalMinutes` makes updates land faster at the cost of more polling.
Below about 5 minutes there is little benefit — the poll is a small request, but the
manifest check is not free on a large fleet.

---

## Troubleshooting

**Panel shows "Офлайн режим"**  
It cannot reach the server but is still serving its local copy — the board is not down.
Check the network, then the server address in the service screen. The panel retries on
its normal schedule and whenever the network comes back.

**Panel shows "Не е конфигурирано"**  
No server address or device key. Configure it via the service screen.

**A document is missing from the panel**  
Check, in order: is it published rather than archived; does its language tag match the
panel's current БГ/EN selection; is its category visible; has the panel synced since the
document was added (check the last-sync time in the header).

**Upload rejected with "Приемат се само PDF файлове."**  
The upload path is PDF-only by design. Export the document to PDF and upload that —
that way what is approved is exactly what appears on the wall.

**Upload rejected as a duplicate**  
A file with identical bytes already exists in that document's history. If you meant to
publish a genuinely new revision, check you exported the right file.

**Panel is out of date but says it synced**  
Compare the panel's content version (service screen → **Версия на съдържанието**) with
the one in the admin dashboard. If they match, the panel is current and the document you
are looking for was probably never published.

**Screen went to sleep**  
The app holds a wake lock while it is in the foreground. If the panel sleeps anyway,
something else is in the foreground — set the app as the device Home app so it is always
the active window.

---

## Backup

Two things need backing up, and both must be taken together to be consistent:

```bash
# Database — categories, documents, version history, audit log, users
docker compose exec -T db pg_dump -U septona septona_kiosk | gzip > septona-db.sql.gz

# Document bytes
docker run --rm -v septona-kiosk_files:/data -v "$PWD":/backup alpine \
  tar czf /backup/septona-files.tar.gz -C /data .
```

The database alone is not enough — it holds the metadata and the content hashes, but the
PDF bytes live on the `files` volume.

## Upgrading the server

```bash
git pull
docker compose up -d --build
```

The schema is created and migrated on start. Documents live on a named volume and are
untouched by a rebuild. Panels are unaffected — they keep serving their local copy while
the server restarts.

## Upgrading the panel app

Build a new APK with an incremented `versionCode` in `kiosk/android/app/build.gradle`,
sign it **with the same keystore**, and install it over the existing app. Cached
documents and the configured server address survive the upgrade.
