/**
 * Migrates a shared folder tree into the authenticated (target) user's Drive
 * using drive.files.list + drive.files.create (folders) + drive.files.copy (files).
 * Native Google Workspace files stay native (no export/import).
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { google } from 'googleapis';
import dotenv from 'dotenv';
dotenv.config();

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

/** Delay between successful API calls to reduce rate limits on huge trees (ms). */
const REQUEST_DELAY_MS = Math.max(0, Number(process.env.DRIVE_REQUEST_DELAY_MS) || 200);

/** Max retries per API call for transient errors. */
const MAX_RETRIES = Math.max(1, Number(process.env.DRIVE_MAX_RETRIES) || 10);

const FOLDER_MIME = 'application/vnd.google-apps.folder';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
 */
async function listChildren(drive, folderId) {
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
    if (REQUEST_DELAY_MS) await sleep(REQUEST_DELAY_MS);
  } while (pageToken);

  return all;
}

const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';

/**
 * @param {import('googleapis').drive_v3.Drive} drive
 * @param {object} stats
 */
async function deleteTargetFileIfExists(drive, fileId, label) {
  await withRetry(`files.delete ${label}`, () =>
    drive.files.delete({
      fileId,
      supportsAllDrives: true,
    }),
  );
}

async function copyFolderTree(drive, sourceFolderId, targetParentId, stats, depth = 0) {
  const indent = '  '.repeat(depth);
  const children = await listChildren(drive, sourceFolderId);
  const targetChildren = await listChildren(drive, targetParentId);

  for (const item of children) {
    const { id, name, mimeType } = item;
    if (!id || !name) continue;

    if (mimeType === FOLDER_MIME) {
      const existingFolders = targetChildren.filter(
        (c) => c.name === name && c.mimeType === FOLDER_MIME,
      );
      let newFolderId;
      if (existingFolders.length > 0) {
        newFolderId = existingFolders[0].id;
        if (!newFolderId) throw new Error(`Existing folder has no id for ${name}`);
        console.log(`${indent}Using existing folder: ${name}`);
        stats.foldersReused += 1;
        if (existingFolders.length > 1) {
          console.warn(
            `${indent}[warn] ${existingFolders.length} target folders named "${name}"; continuing in first match`,
          );
        }
      } else {
        console.log(`${indent}Created folder: ${name}`);
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

      await copyFolderTree(drive, id, newFolderId, stats, depth + 1);
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
    for (const existing of existingSameName) {
      if (!existing.id) continue;
      console.log(`${indent}Replacing file: ${name}`);
      await deleteTargetFileIfExists(drive, existing.id, name);
      stats.filesReplaced += 1;
      if (REQUEST_DELAY_MS) await sleep(REQUEST_DELAY_MS);
    }

    console.log(`${indent}Copying file: ${name}`);
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
    filesReplaced: 0,
    skippedShortcuts: 0,
  };

  console.log('Starting recursive copy…');
  console.log(`  Source folder: ${SOURCE_FOLDER_ID}`);
  console.log(`  Target parent: ${TARGET_FOLDER_ID}`);
  await copyFolderTree(drive, SOURCE_FOLDER_ID, TARGET_FOLDER_ID, stats);

  console.log('\nDone.');
  console.log(`  Folders created: ${stats.foldersCreated}`);
  console.log(`  Folders reused:  ${stats.foldersReused}`);
  console.log(`  Files copied:    ${stats.filesCopied}`);
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
