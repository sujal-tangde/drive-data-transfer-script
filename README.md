# Drive folder migration

Signs in as the **target** Google account and **recursively copies** a **source folder shared with that account** into a destination folder you own. Uses `drive.files.list`, `drive.files.create` (folders), and `drive.files.copy` (files). **Google Docs, Sheets, Slides, etc. stay native** — no export to Office formats.

After migration, companion scripts can **verify** the copy, **rebuild an old→new file ID map**, and **rewrite Drive links inside migrated Google Docs**.

## Scripts

| Script | Purpose |
|--------|---------|
| `index.js` | Main recursive copy (resume-safe) |
| `verify.js` | Compare source vs target by path; list missing / extra files |
| `getMissing.js` | Copy only files missing from the target (by path) |
| `driveUtils.js` | Shared plumbing: rate governor, retries, queue, walker, status block |
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

Do not pass both `--continue-if-incomplete` and `--continue-with-re-copy`.

`--skip-scan` was removed — there is no longer a separate pre-scan pass to skip. Passing it prints a note and is ignored.

### Environment variables

| Variable | Default | Meaning |
|----------|---------|---------|
| `SOURCE_FOLDER_ID` | — | Source folder ID (required) |
| `TARGET_FOLDER_ID` | — | Destination folder ID (required) |
| `GOOGLE_OAUTH_CREDENTIALS` | `./credentials.json` | Path to OAuth client JSON |
| `GOOGLE_OAUTH_TOKEN` | `./token.json` | Where to store tokens |
| `WALK_CONCURRENCY` | `6` | Folder-walker workers (listing) |
| `COPY_CONCURRENCY` | `8` | File-copy workers |
| `READ_RATE` / `READ_RATE_MAX` | `15` / `40` | Read requests per second: starting rate and ceiling |
| `WRITE_RATE` / `WRITE_RATE_MAX` | `6` / `20` | Write requests per second: starting rate and ceiling |
| `FILE_QUEUE_MAX` | `20000` | Backpressure cap on queued-but-uncopied files |
| `DRIVE_MAX_RETRIES` | `10` | Retries for 429 / rate-limit 403 / 5xx / network errors |
| `LOG_INTERVAL_MS` | `1000` | How often the two-line status block is printed (min `200`) |
| `MAX_WALK_DEPTH` | `100` | Depth cap for the path walk in `verify.js` / `getMissing.js` / `buildIdMap.js` / `updateDocLinks.js` |
| `DOC_CONCURRENCY` | `4` | Google Docs processed at once by `updateDocLinks.js` (max `8`) |
| `DOCS_RATE` / `DOCS_RATE_MAX` | `3` / `8` | Docs API requests per second: starting rate and ceiling |
| `VERBOSE` | — | Set to `1` for verbose logs |
| `ID_MAP_PATH` | `./id-map.json` | Path used by link-rewrite scripts |
| `FORCE_REBUILD_DETAILED_MAP` | — | Set to `1` to rebuild `id-map-detailed.json` |

The concurrency, rate, retry and logging variables apply to **every script** — `index.js`, `verify.js`, `getMissing.js`, `buildIdMap.js` and `updateDocLinks.js` all share `driveUtils.js`, so tuning `READ_RATE` once changes all of them. Exceptions:

- `FILE_QUEUE_MAX` only affects `index.js`. It exists to stop walkers outrunning copiers, and only `index.js` overlaps those two phases (see below).
- `COPY_CONCURRENCY` does nothing in `verify.js`, `buildIdMap.js` or `updateDocLinks.js`, none of which copy files.
- `DOC_CONCURRENCY`, `DOCS_RATE` and `DOCS_RATE_MAX` only affect `updateDocLinks.js` (and `updateSingleDoc.js`, which processes one doc).

The **Docs API has its own governor**, separate from the Drive read/write buckets. Docs quota is much tighter than Drive's, and the two must not throttle each other: a Docs 429 slows only doc rewriting, and a Drive 429 slows only listing. Defaults are deliberately conservative.

`DRIVE_REQUEST_DELAY_MS` and `SCAN_REQUEST_DELAY_MS` are retired **everywhere, including `buildIdMap.js` and `updateDocLinks.js`** — no script sleeps a fixed amount after a successful call any more. Pacing is the adaptive governor's job. Setting them has no effect.

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

**Read-only** — it never copies, creates or deletes, and only ever charges the read quota. Both trees are walked **concurrently in one pool of `WALK_CONCURRENCY` workers**, so the source and target listings overlap instead of running one after the other. Progress is a two-line status block (`[progress]` per-tree counts + `[scan]` queue and API health).

Missing/extra lists are **sorted** rather than printed in traversal order: a concurrent walk has no stable order between runs, and sorting groups each folder's files together.

If any folder cannot be listed, the failure goes to `logs/issues.log`, the walk continues, and the run ends with a loud `results are INCOMPLETE` warning plus a non-zero exit — an unreadable folder means its files were never seen, so they would otherwise be silently reported as missing.

### 3. Copy only missing files (optional)

```bash
node getMissing.js
```

Maps both trees by path and copies only what is still missing (creates missing folders as needed). Prefer `index.js --continue-if-incomplete` for most resume cases.

Runs in two phases:

1. **Map** — both trees walked concurrently by `WALK_CONCURRENCY` workers, building path → file maps and a path → folder-id cache of what already exists in the target.
2. **Copy** — `COPY_CONCURRENCY` workers drain the missing-file queue.

The phases do not overlap, unlike `index.js`: a source file is only "missing" once the *entire* target map is known, so neither the missing count nor any copy can be decided before both walks finish. (`index.js` can overlap because it decides folder by folder, from a listing it already has in hand.)

Folder creation is safe under concurrency: the first copier to need a path owns its creation and every other copier awaits that same in-flight create, so `COPY_CONCURRENCY` workers racing into the same new folder still create it exactly once. Existing target folders are reused from the pre-seeded cache and never duplicated.

If the mapping phase hits a folder it cannot list, the script **stops before copying anything** — an incomplete target map would make already-copied files look missing and copy them a second time. Failures during the copy phase are logged per file and do not abort the run; re-running retries them.

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

#### `buildIdMap.js`

**Read-only** (`files.list` only). Source and target are walked **concurrently in one pool of `WALK_CONCURRENCY` workers** and paced by the adaptive read governor, with a two-line status block while mapping. Matching is by full slash-path, exactly as before; `id-map.json` is still `{ sourceId: targetId }` covering both files and folders, and unmatched source files/folders are still reported.

The module API is unchanged — `authorize()`, `buildIdMap(drive, { sourceFolderId, targetFolderId, outputPath, write })` and `mapAll()` all keep their signatures, so `updateDocLinks.js`'s auto-build path still works. If any folder fails to list, the run says so and the map is flagged INCOMPLETE (paths under an unlistable folder would otherwise be reported as unmatched).

#### `updateDocLinks.js`

Two phases, both faster:

1. **Scan** — the target tree (and the source tree, when `SOURCE_FOLDER_ID` is set) is walked by `WALK_CONCURRENCY` workers instead of one sequential recursion. Still a single pass collecting both the Google Docs list and every item, since the name-fallback resolver needs a name-index of the whole tree.
2. **Rewrite** — up to `DOC_CONCURRENCY` docs are processed at once.

**Per-document behaviour is unchanged.** Each doc still goes through the same `processDoc()`: the same non-shifting batch first, then smart-chip edits applied strictly one at a time in descending index order (they shift the indices of everything before them), then text replacements. Only the *outer* loop over documents is parallel. A doc that throws is logged to `failed.json` as `PROCESSING_ERROR` and to `logs/issues.log`, and the run continues.

Documents are processed in sorted path order and the log files are written in that same order regardless of which worker finished first — the previous DFS order depended on the order Drive returned children, which is not guaranteed stable between runs.

Old-ID metadata lookups are shared across concurrent docs: the first document to need an unknown ID owns the `files.get` and the rest await it, so an ID referenced by 50 docs costs one lookup, not 50.

`id-map-detailed.json` is built concurrently too (one `files.get` per entry through the read governor) and keeps the same entry order as the id-map it came from.

## Behavior notes

- **Source is read-only** for migration: list + copy only. Deletes (in `--continue-with-re-copy`) apply only to duplicate files in the **target**.
- **Trashed** items are skipped (`trashed = false`).
- **Shortcuts** are skipped and logged; copy their targets manually if needed.
- Existing **folders** in the target with the same name are reused (not duplicated).
- Status is printed as a two-line block once per second (`[progress]` + `[scan]`). Totals and ETA firm up as the walk discovers the tree; percentages are prefixed `~` until discovery finishes.
- **Concurrent**, with duplicate-safety by construction: a folder queue is drained by `WALK_CONCURRENCY` walkers, and each source folder is enqueued exactly once, so exactly one worker ever writes into a given target folder. Walkers feed a file queue drained by `COPY_CONCURRENCY` copiers, overlapping traversal with copying.
- **Rate limits** are handled by an adaptive governor with separate read/write token buckets. A 403/429 cuts the rate for every worker at once (coalesced, so one episode is one cut) and the rate creeps back up once things are calm. You should not need to tune this by hand. The governor is process-wide, so running `index.js` and `getMissing.js` at the same time does **not** coordinate them — they will each push their own rate up and compete for the same quota.
- **Shared plumbing**: every script (`index.js`, `verify.js`, `getMissing.js`, `buildIdMap.js`, `updateDocLinks.js`, `updateSingleDoc.js`) imports the governor, retry policy, queue, paginated listing, concurrent walker and status block from `driveUtils.js`, so tuning or fixing any of it applies everywhere instead of drifting between copies.
- **Path matching vs. name matching**: `index.js` walks and dedupes by folder **id** (it copies each folder once). `verify.js` and `getMissing.js` compare by **full path**, so a folder reachable by two paths is two entries and is walked once per distinct path; their visit key is `(id, path)`. `MAX_WALK_DEPTH` bounds that walk in case a pathological multi-parent graph nests without end.
- **Shortcuts** are counted as ordinary files by `verify.js` / `getMissing.js`, because a shortcut occupies a path. Since `index.js` does not copy shortcuts, source shortcuts legitimately show up as missing in `verify.js`; the count is reported separately at the end.
- **Only one run at a time**: `.migrate.lock` prevents two concurrent migrations, which would each duplicate what the other creates. Delete it manually if a process died hard.
- **Failures do not abort the run.** Per-file and per-folder errors are logged to `logs/issues.log` (along with skipped shortcuts and ambiguous folder names), and the process exits non-zero so you know to re-run with `--continue-if-incomplete`.
- **Ctrl+C** stops cleanly after in-flight requests finish; press it twice to force quit.
- **Shared drives**: listing/copy use `supportsAllDrives` / `includeItemsFromAllDrives`.

## Security

Do **not** commit `credentials.json`, `token.json`, or `.env`. They are listed in `.gitignore`.
