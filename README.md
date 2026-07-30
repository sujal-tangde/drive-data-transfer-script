# Drive folder migration (same account → copy tree, native Google Docs)

This script signs in as the **target** Google account and **recursively copies** everything from a **source folder that is shared with that account** into a destination folder you own. It uses `drive.files.list`, `drive.files.create` (folders only), and `drive.files.copy` (all files). **Google Docs, Sheets, Slides, etc. stay native**—there is no export to Office formats.

## Prerequisites

- Node.js 18+
- A Google Cloud project where you can enable APIs and create OAuth credentials
- The **source** folder shared with **`sujal@elecbits.in`** (Viewer is enough to copy in most cases)

## 1. Google Cloud setup

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create or select a project.
2. **APIs & Services → Library** → search **Google Drive API** → **Enable**.
3. **APIs & Services → OAuth consent screen**
   - Choose **External** (or **Internal** if the Workspace admin restricts to org-only and your target user is in that org).
   - Fill app name, support email, developer contact.
   - Add scope: `https://www.googleapis.com/auth/drive` (or add it on the consent screen “scopes” step if shown).
   - If the app stays in **Testing**, add **`sujal@elecbits.in`** under **Test users** so OAuth works for that account.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   - Application type: **Desktop app**
   - Download the JSON and save it as **`credentials.json`** in this project folder (same directory as `index.js`).

## 2. Share the source folder

In the **source** account (`sujal@gmail.com`), share the top folder with **`sujal@elecbits.in`** (Viewer or Editor). The script runs as the target account, so it must see that folder.

## 3. Folder IDs

Open the folder in Drive. The URL looks like:

`https://drive.google.com/drive/folders/SOURCE_FOLDER_ID_HERE`

Use that ID for `SOURCE_FOLDER_ID`.

Create (or pick) a **destination** folder in the **Workspace** account and use its ID for `TARGET_FOLDER_ID`. The script will create subfolders and file copies **inside** that folder.

## 4. Install and run

```bash
cd "path/to/Drive Data Transfer Script"
npm install
```

**Windows (PowerShell):**

```powershell
$env:SOURCE_FOLDER_ID = "your_source_id"
$env:TARGET_FOLDER_ID = "your_target_id"
npm start
```

**macOS / Linux:**

```bash
export SOURCE_FOLDER_ID="your_source_id"
export TARGET_FOLDER_ID="your_target_id"
npm start
```

The first run prints a URL—open it, sign in as **`sujal@elecbits.in`**, approve access. If the browser redirects to `localhost` and the page does not load, copy the **`code=`** value from the address bar and paste it when the script prompts you. A **`token.json`** file is saved for later runs (no browser again until you revoke the app or delete `token.json`).

### Optional environment variables

| Variable | Default | Meaning |
|----------|---------|---------|
| `GOOGLE_OAUTH_CREDENTIALS` | `./credentials.json` | Path to OAuth client JSON |
| `GOOGLE_OAUTH_TOKEN` | `./token.json` | Where to store tokens |
| `REQUEST_DELAY_MS` | `75` | Pause after each API call (helps avoid rate limits; increase if you see 429) |
| `MAX_RETRIES` | `6` | Retries for 429 / 5xx / network errors |

## Behavior notes

- **Trashed** items are skipped (`trashed = false` in queries).
- **Shortcuts** in Drive are **skipped** (logged); copy those targets manually if you rely on them.
- **Large migrations (~12 GB)** take time: many files mean many `copy` calls. Progress is logged per file/folder; summary counts print at the end.
- **Quotas**: If you hit rate limits, raise `REQUEST_DELAY_MS` (e.g. `200`) and re-run; already-copied files are **not** deduplicated automatically—use an empty target folder for a clean first run.
- **Shared drives**: Listing and copy use `supportsAllDrives` / `includeItemsFromAllDrives` so team drives work when your account has access.

## Security

Do **not** commit `credentials.json` or `token.json`. They are listed in `.gitignore`.
