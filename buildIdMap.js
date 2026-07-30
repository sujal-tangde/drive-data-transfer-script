/**
 * Build id-map.json by matching files between SOURCE and TARGET folders by
 * full path (folder structure + name). This recovers the OLD_ID -> NEW_ID
 * mapping that index.js produced implicitly during migration.
 *
 * Reuses the auth + recursive-listing pattern from getMissing.js / verify.js.
 *
 * Inputs (env):
 *   SOURCE_FOLDER_ID  — original folder
 *   TARGET_FOLDER_ID  — migrated folder
 *
 * Output:
 *   id-map.json  — { "<sourceFileId>": "<targetFileId>", ... }
 *                  (includes both files and folders)
 *
 * Can be run directly:    node buildIdMap.js
 * Or imported as a module: import { buildIdMap } from './buildIdMap.js'
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { google } from 'googleapis';
import dotenv from 'dotenv';
dotenv.config();

const CREDENTIALS_PATH =
  process.env.GOOGLE_OAUTH_CREDENTIALS || path.join(process.cwd(), 'credentials.json');
const TOKEN_PATH =
  process.env.GOOGLE_OAUTH_TOKEN || path.join(process.cwd(), 'token.json');
const ID_MAP_PATH = path.join(process.cwd(), 'id-map.json');

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const REQUEST_DELAY_MS = Math.max(0, Number(process.env.DRIVE_REQUEST_DELAY_MS) || 200);
const MAX_RETRIES = Math.max(1, Number(process.env.DRIVE_MAX_RETRIES) || 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Retry helper ----
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
  const errors = err?.response?.data?.error?.errors;
  if (Array.isArray(errors)) {
    return errors.some(
      (e) =>
        e?.reason === 'userRateLimitExceeded' ||
        e?.reason === 'rateLimitExceeded' ||
        String(e?.message ?? '').toLowerCase().includes('rate'),
    );
  }
  const msg = String(err?.response?.data?.error?.message ?? err?.message ?? '').toLowerCase();
  return msg.includes('rate limit') || msg.includes('quota');
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
      const rl403 = isUserRateLimitError(err);
      const retryable =
        status === 429 ||
        rl403 ||
        status === 500 ||
        status === 502 ||
        status === 503 ||
        status === 504 ||
        err?.message?.includes?.('ECONNRESET') ||
        err?.message?.includes?.('ETIMEDOUT');
      if (!retryable || attempt === MAX_RETRIES - 1) throw err;
      const fromHeader = parseRetryAfterMs(err?.response?.headers);
      const base = rl403 ? 2000 * 2 ** attempt : 500 * 2 ** attempt;
      const backoff = fromHeader ?? Math.min(rl403 ? 120_000 : 60_000, base);
      const jitter = Math.floor(Math.random() * (rl403 ? 2000 : 250));
      console.warn(
        `[retry] ${label} failed (${status ?? err?.message}). Waiting ${backoff + jitter}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
      );
      await sleep(backoff + jitter);
      attempt += 1;
    }
  }
  throw lastErr;
}

// ---- Auth (same pattern as getMissing.js) ----
export async function authorize() {
  const credentials = JSON.parse(await fs.readFile(CREDENTIALS_PATH, 'utf8'));
  const { client_id, client_secret, redirect_uris } =
    credentials.installed || credentials.web;
  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    (redirect_uris && redirect_uris[0]) || 'http://localhost',
  );
  const token = JSON.parse(await fs.readFile(TOKEN_PATH, 'utf8'));
  oAuth2Client.setCredentials(token);
  return oAuth2Client;
}

// ---- Recursive listing: returns Maps keyed by full slash-path ----
export async function mapAll(
  drive,
  folderId,
  prefix = '',
  files = new Map(),
  folders = new Map(),
) {
  let pageToken;
  do {
    const res = await withRetry('files.list', () =>
      drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType)',
        pageSize: 1000,
        pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      }),
    );

    for (const f of res.data.files || []) {
      if (!f.id || !f.name) continue;
      const fullPath = prefix ? `${prefix}/${f.name}` : f.name;
      if (f.mimeType === FOLDER_MIME) {
        if (!folders.has(fullPath)) {
          folders.set(fullPath, { id: f.id, name: f.name });
        }
        await mapAll(drive, f.id, fullPath, files, folders);
      } else {
        if (!files.has(fullPath)) {
          files.set(fullPath, { id: f.id, name: f.name, mimeType: f.mimeType });
        }
      }
    }
    pageToken = res.data.nextPageToken;
    if (REQUEST_DELAY_MS) await sleep(REQUEST_DELAY_MS);
  } while (pageToken);

  return { files, folders };
}

/**
 * Build (and persist) id-map.json by matching SOURCE -> TARGET on full path.
 *
 * @param {import('googleapis').drive_v3.Drive} drive
 * @param {{
 *   sourceFolderId: string,
 *   targetFolderId: string,
 *   outputPath?: string,   // defaults to ./id-map.json
 *   write?: boolean,       // if false, don't write to disk
 * }} opts
 */
export async function buildIdMap(drive, opts) {
  const {
    sourceFolderId,
    targetFolderId,
    outputPath = ID_MAP_PATH,
    write = true,
  } = opts;

  if (!sourceFolderId || !targetFolderId) {
    throw new Error('buildIdMap: sourceFolderId and targetFolderId are required');
  }

  console.log('📂 Mapping source…');
  const { files: srcFiles, folders: srcFolders } = await mapAll(drive, sourceFolderId);
  console.log(`   Source: ${srcFiles.size} files, ${srcFolders.size} folders`);

  console.log('📂 Mapping target…');
  const { files: tgtFiles, folders: tgtFolders } = await mapAll(drive, targetFolderId);
  console.log(`   Target: ${tgtFiles.size} files, ${tgtFolders.size} folders`);

  /** @type {Record<string, string>} */
  const idMap = {};
  const unmatchedFiles = [];
  const unmatchedFolders = [];
  let matchedFiles = 0;
  let matchedFolders = 0;

  for (const [p, src] of srcFiles) {
    const tgt = tgtFiles.get(p);
    if (tgt) {
      idMap[src.id] = tgt.id;
      matchedFiles += 1;
    } else {
      unmatchedFiles.push(p);
    }
  }

  for (const [p, src] of srcFolders) {
    const tgt = tgtFolders.get(p);
    if (tgt) {
      idMap[src.id] = tgt.id;
      matchedFolders += 1;
    } else {
      unmatchedFolders.push(p);
    }
  }

  if (write) {
    await fs.writeFile(outputPath, JSON.stringify(idMap, null, 2), 'utf8');
  }

  const totalMatched = matchedFiles + matchedFolders;
  console.log('');
  console.log(`✅ Matched files:   ${matchedFiles} / ${srcFiles.size}`);
  console.log(`✅ Matched folders: ${matchedFolders} / ${srcFolders.size}`);
  console.log(`📝 ${write ? `Wrote ${totalMatched} entries to ${path.basename(outputPath)}` : `Built ${totalMatched} entries (in-memory)`}`);

  if (unmatchedFiles.length) {
    console.log(`\n⚠️  Source files with no target match (${unmatchedFiles.length}):`);
    for (const p of unmatchedFiles.slice(0, 20)) console.log(`  - ${p}`);
    if (unmatchedFiles.length > 20) {
      console.log(`  … and ${unmatchedFiles.length - 20} more`);
    }
  }
  if (unmatchedFolders.length) {
    console.log(`\n⚠️  Source folders with no target match (${unmatchedFolders.length}):`);
    for (const p of unmatchedFolders.slice(0, 20)) console.log(`  - ${p}`);
    if (unmatchedFolders.length > 20) {
      console.log(`  … and ${unmatchedFolders.length - 20} more`);
    }
  }

  return {
    idMap,
    matchedFiles,
    matchedFolders,
    unmatchedFiles,
    unmatchedFolders,
    totalSourceFiles: srcFiles.size,
    totalSourceFolders: srcFolders.size,
  };
}

// ---- CLI entrypoint ----
async function main() {
  const SOURCE = process.env.SOURCE_FOLDER_ID;
  const TARGET = process.env.TARGET_FOLDER_ID;
  if (!SOURCE || !TARGET) {
    console.error('❌ Set SOURCE_FOLDER_ID and TARGET_FOLDER_ID in .env');
    process.exit(1);
  }
  const auth = await authorize();
  const drive = google.drive({ version: 'v3', auth });
  await buildIdMap(drive, {
    sourceFolderId: SOURCE,
    targetFolderId: TARGET,
  });
}

const isDirectRun =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  main().catch((err) => {
    console.error(err.response?.data ?? err);
    process.exit(1);
  });
}
