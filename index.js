/**
 * Migrates a shared folder tree into the authenticated (target) user's Drive
 * using drive.files.list + drive.files.create (folders) + drive.files.copy (files).
 * Native Google Workspace files stay native (no export/import).
 *
 * The SOURCE folder is read-only: list + copy only. Deletes apply to TARGET
 * duplicates only in --continue-with-re-copy mode, never to source items.
 *
 * Resume modes:
 *   --continue-if-incomplete   skip files already present in target (default)
 *   --continue-with-re-copy    delete+re-copy same-named target files, then continue
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { google } from 'googleapis';
import dotenv from 'dotenv';
import cliProgress from 'cli-progress';
dotenv.config();

const VERBOSE =
  process.argv.includes('--verbose') ||
  process.argv.includes('-v') ||
  process.env.VERBOSE === '1';

const SKIP_PRE_SCAN =
  process.argv.includes('--skip-scan') ||
  process.env.SKIP_PRE_SCAN === '1';

const WANT_CONTINUE_IF_INCOMPLETE = process.argv.includes('--continue-if-incomplete');
const WANT_CONTINUE_WITH_RE_COPY = process.argv.includes('--continue-with-re-copy');

if (WANT_CONTINUE_IF_INCOMPLETE && WANT_CONTINUE_WITH_RE_COPY) {
  console.error(
    'Use only one of --continue-if-incomplete or --continue-with-re-copy (not both).',
  );
  process.exit(1);
}

/** 'skip' = resume without re-copying; 'recopy' = replace existing target files. */
const COPY_MODE = WANT_CONTINUE_WITH_RE_COPY ? 'recopy' : 'skip';

const SCOPES = ['https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/documents'
];

const SOURCE_FOLDER_ID = process.env.SOURCE_FOLDER_ID;
const TARGET_FOLDER_ID = process.env.TARGET_FOLDER_ID;
const CREDENTIALS_PATH =
  process.env.GOOGLE_OAUTH_CREDENTIALS || path.join(process.cwd(), 'credentials.json');
const TOKEN_PATH = process.env.GOOGLE_OAUTH_TOKEN || path.join(process.cwd(), 'token.json');

console.log({
  CREDENTIALS_PATH,
  SOURCE_FOLDER_ID,
  TARGET_FOLDER_ID,
  TOKEN_PATH
})

/** Delay between successful API calls during copy/create/delete (ms). */
const REQUEST_DELAY_MS = Math.max(0, Number(process.env.DRIVE_REQUEST_DELAY_MS) || 200);

/** Faster delay during read-only source scan (ms). */
const SCAN_REQUEST_DELAY_MS =
  process.env.SCAN_REQUEST_DELAY_MS != null && process.env.SCAN_REQUEST_DELAY_MS !== ''
    ? Math.max(0, Number(process.env.SCAN_REQUEST_DELAY_MS))
    : Math.min(50, REQUEST_DELAY_MS);

/** Max retries per API call for transient errors. */
const MAX_RETRIES = Math.max(1, Number(process.env.DRIVE_MAX_RETRIES) || 10);

const FOLDER_MIME = 'application/vnd.google-apps.folder';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function truncateName(name, max = 45) {
  if (name.length <= max) return name;
  return `${name.slice(0, max - 1)}…`;
}

function createScanReporter() {
  let lastWrite = 0;
  let lastLog = 0;
  return (acc) => {
    const now = Date.now();
    if (now - lastWrite >= 300) {
      lastWrite = now;
      process.stdout.write(
        `\r[scan] ${acc.folders} folders, ${acc.files} files…`,
      );
    }
    if (now - lastLog >= 5000) {
      lastLog = now;
      finishScanLine();
      console.log(`[scan] still counting… ${acc.folders} folders, ${acc.files} files`);
    }
  };
}

function finishScanLine() {
  process.stdout.write('\n');
}

function parseRetryAfterMs(headers) {
  const raw = headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (raw == null) return null;
  const sec = Number(raw);
  if (!Number.isFinite(sec)) return null;
  return Math.min(120_000, Math.max(0, sec * 1000));
}

function isUserRateLimitError(err) {
  const status = err?.response?.status ?? err?.code;
  if (status !== 403) return false;
  const msg = String(err?.response?.data?.error?.message ?? err?.message ?? '').toLowerCase();
  if (msg.includes('rate limit') || msg.includes('quota')) return true;
  const errors = err?.response?.data?.error?.errors;
  if (Array.isArray(errors)) {
    return errors.some(
      (e) =>
        e?.reason === 'userRateLimitExceeded' ||
        e?.reason === 'rateLimitExceeded' ||
        String(e?.message ?? '').toLowerCase().includes('rate'),
    );
  }
  return false;
}

async function withRetry(label, fn) {
  let attempt = 0;
  let lastErr;
  while (attempt < MAX_RETRIES) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err?.response?.status ?? err?.code;
      const rateLimit403 = isUserRateLimitError(err);
      const retryable =
        status === 429 ||
        rateLimit403 ||
        status === 500 ||
        status === 502 ||
        status === 503 ||
        status === 504 ||
        err?.message?.includes?.('ECONNRESET') ||
        err?.message?.includes?.('ETIMEDOUT');

      if (!retryable || attempt === MAX_RETRIES - 1) throw err;

      const fromHeader = parseRetryAfterMs(err?.response?.headers);
      const base = rateLimit403 ? 2000 * 2 ** attempt : 500 * 2 ** attempt;
      const backoff = fromHeader ?? Math.min(rateLimit403 ? 120_000 : 60_000, base);
      const jitter = Math.floor(Math.random() * (rateLimit403 ? 2000 : 250));
      console.warn(
        `[retry] ${label} failed (${status ?? err?.message}). Waiting ${backoff + jitter}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
      );
      await sleep(backoff + jitter);
      attempt += 1;
    }
  }
  throw lastErr;
}

async function loadSavedCredentials() {
  try {
    const raw = await fs.readFile(TOKEN_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveCredentials(token) {
  await fs.writeFile(TOKEN_PATH, JSON.stringify(token, null, 2), 'utf8');
}

function isInvalidGrant(err) {
  const data = err?.response?.data;
  return (
    data?.error === 'invalid_grant' ||
    err?.code === 'invalid_grant' ||
    String(err?.message ?? '').toLowerCase().includes('invalid_grant')
  );
}

async function requestNewCredentials(oAuth2Client) {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });

  console.log('Authorize this app (sign in as the TARGET account):');
  console.log(authUrl);
  const rl = readline.createInterface({ input, output });
  try {
    const code = await rl.question('Enter the authorization code here: ');
    const { tokens } = await oAuth2Client.getToken(code.trim());
    oAuth2Client.setCredentials(tokens);
    await saveCredentials(tokens);
  } finally {
    rl.close();
  }

  return oAuth2Client;
}

async function authorize() {
  const content = await fs.readFile(CREDENTIALS_PATH, 'utf8');
  const keys = JSON.parse(content);
  const { client_secret, client_id, redirect_uris } = keys.installed ?? keys.web ?? {};
  if (!client_id || !client_secret) {
    throw new Error(
      `Invalid OAuth client file at ${CREDENTIALS_PATH}. Expected "installed" or "web" with client_id and client_secret.`,
    );
  }
  const redirectUri =
    (redirect_uris && redirect_uris[0]) || 'http://localhost';

  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirectUri);

  const token = await loadSavedCredentials();
  if (token) {
    oAuth2Client.setCredentials(token);
    try {
      // Force token validation now so an expired/revoked refresh token can be
      // replaced before the migration starts.
      await oAuth2Client.getAccessToken();
      return oAuth2Client;
    } catch (err) {
      if (!isInvalidGrant(err)) throw err;

      console.warn(
        'Saved Google authorization has expired or was revoked. Starting sign-in again…',
      );
      await fs.rm(TOKEN_PATH, { force: true });
      oAuth2Client.setCredentials({});
    }
  }

  return requestNewCredentials(oAuth2Client);
}

/**
 * @param {import('googleapis').drive_v3.Drive} drive
 * @param {{ delayMs?: number }} [options]
 */
async function listChildren(drive, folderId, options = {}) {
  const delayMs = options.delayMs ?? REQUEST_DELAY_MS;
  const q = `'${folderId}' in parents and trashed = false`;
  const all = [];
  let pageToken;

  do {
    const res = await withRetry('files.list', () =>
      drive.files.list({
        q,
        pageSize: 1000,
        pageToken: pageToken || undefined,
        fields: 'nextPageToken, files(id, name, mimeType, shortcutDetails)',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      }),
    );
    const files = res.data.files ?? [];
    for (const f of files) all.push(f);
    pageToken = res.data.nextPageToken;
    if (delayMs) await sleep(delayMs);
  } while (pageToken);

  return all;
}

const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';

/**
 * Read-only scan of the source tree: counts items and records every source id
 * so deletes can never target the source folder by accident.
 * @param {import('googleapis').drive_v3.Drive} drive
 */
async function scanSourceTree(
  drive,
  folderId,
  acc = { files: 0, folders: 0, ids: new Set() },
  onProgress,
) {
  acc.ids.add(folderId);
  onProgress?.(acc);
  const children = await listChildren(drive, folderId, { delayMs: SCAN_REQUEST_DELAY_MS });

  for (const item of children) {
    if (!item.id) continue;
    acc.ids.add(item.id);

    if (item.mimeType === FOLDER_MIME) {
      acc.folders += 1;
      onProgress?.(acc);
      await scanSourceTree(drive, item.id, acc, onProgress);
      continue;
    }

    if (item.mimeType === SHORTCUT_MIME) continue;
    acc.files += 1;
    onProgress?.(acc);
  }

  return acc;
}

/**
 * Deletes a duplicate file in the TARGET folder only (never the source).
 * @param {import('googleapis').drive_v3.Drive} drive
 * @param {Set<string>} sourceIds
 */
async function deleteTargetFileIfExists(drive, fileId, label, sourceIds) {
  if (sourceIds.has(fileId)) {
    throw new Error(
      `Refusing to delete "${label}" (${fileId}): this id belongs to the source folder.`,
    );
  }
  await withRetry(`files.delete ${label}`, () =>
    drive.files.delete({
      fileId,
      supportsAllDrives: true,
    }),
  );
}

function progressDoneCount(stats) {
  return stats.filesCopied + stats.filesSkipped;
}

function bumpProgressBar(bar, progressState, stats, filename) {
  if (!bar) return;
  if (
    progressState?.scanDone &&
    progressState.totalFiles > 0 &&
    bar.getTotal() !== progressState.totalFiles
  ) {
    bar.options.format = progressState.fullBarFormat;
    bar.setTotal(progressState.totalFiles);
  }
  bar.update(progressDoneCount(stats), { filename: truncateName(filename) });
}

async function copyFolderTree(drive, sourceFolderId, targetParentId, stats, ctx = {}, depth = 0) {
  const { bar, sourceIds, progressState, copyMode } = ctx;
  const indent = '  '.repeat(depth);
  if (sourceIds) sourceIds.add(sourceFolderId);
  const children = await listChildren(drive, sourceFolderId);
  const targetChildren = await listChildren(drive, targetParentId);

  for (const item of children) {
    const { id, name, mimeType } = item;
    if (!id || !name) continue;
    if (sourceIds) sourceIds.add(id);

    if (mimeType === FOLDER_MIME) {
      const existingFolders = targetChildren.filter(
        (c) => c.name === name && c.mimeType === FOLDER_MIME,
      );
      let newFolderId;
      if (existingFolders.length > 0) {
        newFolderId = existingFolders[0].id;
        if (!newFolderId) throw new Error(`Existing folder has no id for ${name}`);
        if (VERBOSE) console.log(`${indent}Using existing folder: ${name}`);
        stats.foldersReused += 1;
        if (existingFolders.length > 1) {
          console.warn(
            `${indent}[warn] ${existingFolders.length} target folders named "${name}"; continuing in first match`,
          );
        }
      } else {
        if (VERBOSE) console.log(`${indent}Created folder: ${name}`);
        const created = await withRetry(`files.create folder ${name}`, () =>
          drive.files.create({
            requestBody: {
              name,
              mimeType: FOLDER_MIME,
              parents: [targetParentId],
            },
            fields: 'id',
            supportsAllDrives: true,
          }),
        );
        newFolderId = created.data.id;
        if (!newFolderId) throw new Error(`Folder create returned no id for ${name}`);
        stats.foldersCreated += 1;
      }
      if (REQUEST_DELAY_MS) await sleep(REQUEST_DELAY_MS);

      await copyFolderTree(drive, id, newFolderId, stats, ctx, depth + 1);
      continue;
    }

    if (mimeType === SHORTCUT_MIME) {
      const targetId = item.shortcutDetails?.targetId;
      const targetMime = item.shortcutDetails?.targetMimeType;
      console.warn(`${indent}[skip] Shortcut: ${name} -> ${targetId ?? '?'} (${targetMime ?? 'unknown'})`);
      stats.skippedShortcuts += 1;
      continue;
    }

    const existingSameName = targetChildren.filter(
      (c) => c.name === name && c.mimeType !== FOLDER_MIME,
    );

    // Resume mode: same-named file already in target → skip (no delete, no re-copy).
    if (copyMode === 'skip' && existingSameName.length > 0) {
      if (VERBOSE) console.log(`${indent}Skipping existing file: ${name}`);
      stats.filesSkipped += 1;
      bumpProgressBar(bar, progressState, stats, name);
      continue;
    }

    // Re-copy mode: remove same-named target files, then copy fresh from source.
    if (copyMode === 'recopy') {
      for (const existing of existingSameName) {
        if (!existing.id) continue;
        if (VERBOSE) console.log(`${indent}Replacing file: ${name}`);
        await deleteTargetFileIfExists(drive, existing.id, name, sourceIds);
        stats.filesReplaced += 1;
        if (REQUEST_DELAY_MS) await sleep(REQUEST_DELAY_MS);
      }
    }

    if (VERBOSE) console.log(`${indent}Copying file: ${name}`);
    await withRetry(`files.copy ${name}`, () =>
      drive.files.copy({
        fileId: id,
        requestBody: {
          name,
          parents: [targetParentId],
        },
        fields: 'id',
        supportsAllDrives: true,
      }),
    );
    stats.filesCopied += 1;
    bumpProgressBar(bar, progressState, stats, name);
    if (REQUEST_DELAY_MS) await sleep(REQUEST_DELAY_MS);
  }
}

async function main() {
  if (!SOURCE_FOLDER_ID || !TARGET_FOLDER_ID) {
    console.error(
      'Set SOURCE_FOLDER_ID and TARGET_FOLDER_ID (folder IDs from the Drive URL).\nExample (PowerShell):\n  $env:SOURCE_FOLDER_ID="..."; $env:TARGET_FOLDER_ID="..."; npm start',
    );
    process.exit(1);
  }

  const auth = await authorize();
  const drive = google.drive({ version: 'v3', auth });

  const stats = {
    foldersCreated: 0,
    foldersReused: 0,
    filesCopied: 0,
    filesSkipped: 0,
    filesReplaced: 0,
    skippedShortcuts: 0,
  };

  const sourceIds = new Set([SOURCE_FOLDER_ID]);

  const barFormats = {
    counting: 'Progress | {value} files | {filename} | total: counting…',
    full: 'Progress |{bar}| {percentage}% | {value}/{total} files | ETA: {eta_formatted} | {filename}',
  };

  /** @type {{ scanDone: boolean, totalFiles: number, fullBarFormat: string }} */
  const progressState = {
    scanDone: SKIP_PRE_SCAN,
    totalFiles: 0,
    fullBarFormat: barFormats.full,
  };

  console.log('Source folder will not be modified (list + copy only).');
  if (COPY_MODE === 'skip') {
    console.log(
      'Mode: --continue-if-incomplete (default) — skip files already in target; copy only missing.',
    );
  } else {
    console.log(
      'Mode: --continue-with-re-copy — replace same-named target files, then copy missing.',
    );
  }
  console.log('Starting recursive copy…');
  console.log(`  Source folder: ${SOURCE_FOLDER_ID}`);
  console.log(`  Target parent: ${TARGET_FOLDER_ID}`);

  /** @type {import('cli-progress').SingleBar | null} */
  let bar = null;
  if (!VERBOSE) {
    bar = new cliProgress.SingleBar(
      {
        format: barFormats.counting,
        hideCursor: true,
        clearOnComplete: false,
      },
      cliProgress.Presets.shades_classic,
    );
    bar.start(1, 0, { filename: 'starting…' });
    console.log('  Copy progress below; scan runs in parallel to compute %/ETA.');
  } else {
    console.log('  Verbose per-file logs enabled.');
  }

  let scanPromise = Promise.resolve({ files: 0, folders: 0 });
  if (!SKIP_PRE_SCAN) {
    console.log('[scan] Counting source files in background (read-only)…');
    const reportScan = createScanReporter();
    const scanAcc = { files: 0, folders: 0, ids: sourceIds };
    scanPromise = scanSourceTree(drive, SOURCE_FOLDER_ID, scanAcc, reportScan).then((result) => {
      finishScanLine();
      progressState.scanDone = true;
      progressState.totalFiles = result.files;
      console.log(`[scan] Complete: ${result.files} file(s) in ${result.folders} folder(s).`);
      if (bar && result.files > 0) {
        bar.options.format = barFormats.full;
        bar.setTotal(result.files);
        bar.update(progressDoneCount(stats));
        bar.render();
      }
      return result;
    });
  }

  try {
    await copyFolderTree(drive, SOURCE_FOLDER_ID, TARGET_FOLDER_ID, stats, {
      bar,
      sourceIds,
      progressState,
      copyMode: COPY_MODE,
    });
    await scanPromise;
  } finally {
    if (bar) bar.stop();
  }

  console.log('\nDone.');
  console.log(`  Folders created: ${stats.foldersCreated}`);
  console.log(`  Folders reused:  ${stats.foldersReused}`);
  console.log(`  Files copied:    ${stats.filesCopied}`);
  if (stats.filesSkipped) {
    console.log(`  Files skipped:   ${stats.filesSkipped} (already present in target)`);
  }
  if (stats.filesReplaced) {
    console.log(`  Files replaced:  ${stats.filesReplaced} (removed same-named target file(s) before copy)`);
  }
  if (stats.skippedShortcuts) {
    console.log(`  Shortcuts skipped: ${stats.skippedShortcuts} (copy targets manually if needed)`);
  }
}

main().catch((err) => {
  console.error(err.response?.data ?? err);
  process.exit(1);
});
