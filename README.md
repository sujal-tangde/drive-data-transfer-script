# Drive folder migration

Signs in as the **target** Google account and **recursively copies** a **source folder shared with that account** into a destination folder you own. Uses `drive.files.list`, `drive.files.create` (folders), and `drive.files.copy` (files). **Google Docs, Sheets, Slides, etc. stay native** — no export to Office formats.

After migration, companion scripts can **verify** the copy, **rebuild an old→new file ID map**, and **rewrite Drive links inside migrated Google Docs**.

## Scripts

| Script | Purpose |
|--------|---------|
| `index.js` | Main recursive copy (resume-safe) |
| `verify.js` | Compare source vs target by path; list missing / extra files |
| `getMissing.js` | Copy only files missing from the target (by path) |
| `buildIdMap.js` | Build `id-map.json` (`sourceId` → `targetId`) by matching paths |
| `updateDocLinks.js` | Rewrite old Drive links in all Docs under the target folder |
| `updateSingleDoc.js` | Same link rewrite for one Doc URL |

## Prerequisites

- Node.js 18+
- A Google Cloud project with OAuth credentials
- Source folder shared with the **target** account (Viewer is usually enough to copy)

## 1. Google Cloud setup

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create or select a project.
2. **APIs & Services → Library** — enable:
   - **Google Drive API** (required for copy)
   - **Google Docs API** (required for link rewriting)
3. **APIs & Services → OAuth consent screen**
   - Choose **External** (or **Internal** for org-only Workspace apps).
   - Fill app name, support email, developer contact.
   - Add scopes:
     - `https://www.googleapis.com/auth/drive`
     - `https://www.googleapis.com/auth/documents`
   - If the app stays in **Testing**, add the target account under **Test users**.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   - Application type: **Desktop app**
   - Download the JSON and save it as **`credentials.json`** in this project folder.

## 2. Share the source folder

In the source account, share the top folder with the **target** account (Viewer or Editor). The scripts run as the target account and must be able to see that folder.

## 3. Configure folder IDs

Open a folder in Drive. The URL looks like:

`https://drive.google.com/drive/folders/FOLDER_ID_HERE`

Create a `.env` file in the project root:

```env
SOURCE_FOLDER_ID=your_source_folder_id
TARGET_FOLDER_ID=your_target_folder_id
```

Copies are created **inside** `TARGET_FOLDER_ID` (subfolders and files). You can also set the IDs as shell environment variables instead of `.env`.

## 4. Install and run

```bash
cd "path/to/Drive Data Transfer Script"
npm install
```

```bash
npm start
# same as: node index.js
```

Or with an explicit resume flag:

```bash
node index.js --continue-if-incomplete
```

The first run prints a URL — open it, sign in as the **target** account, approve access. If the browser redirects to `localhost` and the page does not load, copy the `code=` value from the address bar and paste it when prompted. A `token.json` file is saved for later runs (until you revoke the app or delete the file).

### Migration CLI flags

| Flag | Meaning |
|------|---------|
| *(default)* / `--continue-if-incomplete` | Skip files that already exist in the target by name; copy only missing |
| `--continue-with-re-copy` | Delete same-named **target** files, then re-copy from source (source is never deleted) |
| `--verbose` / `-v` | Add a per-file log line on top of the status block |
| `--skip-scan` | Skip the background source file count (no %/ETA in the status block) |

Do not pass both `--continue-if-incomplete` and `--continue-with-re-copy`.

### Environment variables

| Variable | Default | Meaning |
|----------|---------|---------|
| `SOURCE_FOLDER_ID` | — | Source folder ID (required) |
| `TARGET_FOLDER_ID` | — | Destination folder ID (required) |
| `GOOGLE_OAUTH_CREDENTIALS` | `./credentials.json` | Path to OAuth client JSON |
| `GOOGLE_OAUTH_TOKEN` | `./token.json` | Where to store tokens |
| `DRIVE_REQUEST_DELAY_MS` | `200` | Pause after copy/create/delete API calls |
| `SCAN_REQUEST_DELAY_MS` | `min(50, delay)` | Pause during read-only source scan |
| `DRIVE_MAX_RETRIES` | `10` | Retries for 429 / rate-limit 403 / 5xx / network errors |
| `LOG_INTERVAL_MS` | `1000` | How often the two-line status block is printed (min `200`) |
| `VERBOSE` | — | Set to `1` for verbose logs |
| `SKIP_PRE_SCAN` | — | Set to `1` to skip the source pre-scan |
| `ID_MAP_PATH` | `./id-map.json` | Path used by link-rewrite scripts |
| `FORCE_REBUILD_DETAILED_MAP` | — | Set to `1` to rebuild `id-map-detailed.json` |

## Typical workflow

### 1. Migrate

```bash
npm start
# or resume after interruption:
node index.js --continue-if-incomplete
```

### 2. Verify (optional)

```bash
node verify.js
```

Lists files present in source but missing in target (and extras in target), matched by full path.

### 3. Copy only missing files (optional)

```bash
node getMissing.js
```

Maps both trees by path and copies only what is still missing (creates missing folders as needed). Prefer `index.js --continue-if-incomplete` for most resume cases.

### 4. Build ID map + rewrite Doc links (optional)

After a successful copy, Drive links inside Google Docs still point at **old** file IDs. Fix them with:

```bash
# Build id-map.json alone (also auto-built by updateDocLinks if missing)
node buildIdMap.js

# Rewrite links in every Google Doc under TARGET_FOLDER_ID
node updateDocLinks.js

# Or rewrite one document
node updateSingleDoc.js "https://docs.google.com/document/d/DOC_ID/edit"
```

`updateDocLinks.js` writes:

- `id-map.json` / `id-map-detailed.json` — ID mappings
- `logs/run-<timestamp>-<pid>/` — `success.json`, `failed.json`, `docs-with-links.json`, `summary.json`

Smart chips (rich links) are replaced by deleting the chip and inserting a normal hyperlink (Docs API limitation).

## Behavior notes

- **Source is read-only** for migration: list + copy only. Deletes (in `--continue-with-re-copy`) apply only to duplicate files in the **target**.
- **Trashed** items are skipped (`trashed = false`).
- **Shortcuts** are skipped and logged; copy their targets manually if needed.
- Existing **folders** in the target with the same name are reused (not duplicated).
- Status is printed as a two-line block once per second (`[progress]` + `[scan]`); a background scan counts source files for %/ETA (unless `--skip-scan`). A scan failure is reported on the `[scan]` line and does not stop the copy.
- **Rate limits**: increase `DRIVE_REQUEST_DELAY_MS` and re-run with `--continue-if-incomplete`.
- **Shared drives**: listing/copy use `supportsAllDrives` / `includeItemsFromAllDrives`.

## Security

Do **not** commit `credentials.json`, `token.json`, or `.env`. They are listed in `.gitignore`.
