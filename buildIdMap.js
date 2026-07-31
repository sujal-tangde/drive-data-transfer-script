/**
 * Build id-map.json by matching files between SOURCE and TARGET folders by
 * full path (folder structure + name). This recovers the OLD_ID -> NEW_ID
 * mapping that index.js produced implicitly during migration.
 *
 * Read-only: files.list is the only API used.
 *
 * Concurrency model (shared with index.js / verify.js / getMissing.js via
 * driveUtils.js): both trees are walked by one pool of WALK_CONCURRENCY
 * workers, so the source and target listings overlap, and every request is
 * paced by the adaptive read governor instead of a fixed sleep.
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
import { google } from 'googleapis';
import {
  apiStats,
  createStatusPrinter,
  createWalkContext,
  flushIssues,
  formatDuration,
  governors,
  isMainModule,
  ISSUE_LOG,
  READ_RATE,
  READ_RATE_MAX,
  truncateName,
  WALK_CONCURRENCY,
  walkTrees,
} from './driveUtils.js';

const CREDENTIALS_PATH =
  process.env.GOOGLE_OAUTH_CREDENTIALS || path.join(process.cwd(), 'credentials.json');
const TOKEN_PATH =
  process.env.GOOGLE_OAUTH_TOKEN || path.join(process.cwd(), 'token.json');
const ID_MAP_PATH = path.join(process.cwd(), 'id-map.json');

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

/**
 * Walks one or more trees concurrently, returning per-side Maps keyed by full
 * slash-path. First entry wins for a given path, matching the old recursive
 * walker's `if (!map.has(path))` behaviour.
 *
 * @param {import('googleapis').drive_v3.Drive} drive
 * @param {Array<{side: string, id: string, prefix?: string, files?: Map, folders?: Map}>} roots
 * @returns {Promise<{collected: Record<string, {files: Map, folders: Map}>, ctx: object}>}
 */
async function mapTrees(drive, roots, { onStatus } = {}) {
  const collected = {};
  const scan = {};
  for (const r of roots) {
    collected[r.side] = { files: r.files ?? new Map(), folders: r.folders ?? new Map() };
    scan[r.side] = { folders: 0, files: 0 };
  }

  const ctx = createWalkContext({
    scan,
    onFile(side, fullPath, f) {
      const { files } = collected[side];
      if (!files.has(fullPath)) {
        files.set(fullPath, { id: f.id, name: f.name, mimeType: f.mimeType });
      }
    },
    onFolder(side, fullPath, f) {
      const { folders } = collected[side];
      if (!folders.has(fullPath)) {
        folders.set(fullPath, { id: f.id, name: f.name });
      }
    },
  });

  const status = onStatus ? onStatus(ctx) : null;
  status?.start();
  try {
    await walkTrees(
      drive,
      roots.map((r) => ({ side: r.side, id: r.id, path: r.prefix ?? '' })),
      ctx,
    );
    ctx.done = true;
  } finally {
    status?.stop();
  }

  return { collected, ctx };
}

/**
 * Single-tree listing keyed by full slash-path. Kept for API compatibility —
 * `buildIdMap` walks both trees together instead of calling this twice.
 */
export async function mapAll(
  drive,
  folderId,
  prefix = '',
  files = new Map(),
  folders = new Map(),
) {
  const { collected } = await mapTrees(drive, [
    { side: 'root', id: folderId, prefix, files, folders },
  ]);
  return collected.root;
}

/** Two-line status block: [progress] per-tree counts, [scan] queue + API health. */
function createStatusLogger(ctx, sides) {
  const startedAt = Date.now();

  return createStatusPrinter(() => {
    const progress = sides.map((side, i) => {
      const s = ctx.scan[side];
      return `${i === 0 ? '[progress] ' : ''}${side} ${s.files} files / ${s.folders} folders`;
    });
    if (ctx.stats.errors) progress.push(`${ctx.stats.errors} errors`);
    progress.push(`elapsed ${formatDuration(Date.now() - startedAt)}`);

    const scan = [
      ctx.done ? '[scan] mapping complete' : '[scan] mapping…',
      `queue: ${ctx.queues.folders.size} folders`,
      `api ${governors.read.rate.toFixed(1)}/s read`,
    ];
    if (apiStats.retries) scan.push(`${apiStats.retries} retries`);
    scan.push(`in: ${truncateName(ctx.runtime.currentFolder || '/', 40)}`);

    return [progress.join(' | '), scan.join(' | ')];
  });
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

  // Both trees share one walker pool, so the two listings overlap.
  console.log('📂 Mapping source…');
  console.log('📂 Mapping target…');
  console.log(
    `   ${WALK_CONCURRENCY} walkers | rate: ${READ_RATE}→${READ_RATE_MAX}/s read (adaptive)`,
  );

  const { collected, ctx } = await mapTrees(
    drive,
    [
      { side: 'source', id: sourceFolderId },
      { side: 'target', id: targetFolderId },
    ],
    { onStatus: (c) => createStatusLogger(c, ['source', 'target']) },
  );

  const { files: srcFiles, folders: srcFolders } = collected.source;
  const { files: tgtFiles, folders: tgtFolders } = collected.target;

  console.log(`   Source: ${srcFiles.size} files, ${srcFolders.size} folders`);
  console.log(`   Target: ${tgtFiles.size} files, ${tgtFolders.size} folders`);

  if (ctx.stats.errors) {
    // A folder we could not list means its paths were never seen, so anything
    // under it would be reported as unmatched rather than genuinely missing.
    console.log(
      `\n⚠️  ${ctx.stats.errors} folders could not be listed — the map is INCOMPLETE (see ${ISSUE_LOG})`,
    );
    for (const line of ctx.failures.slice(0, 10)) console.log(`  - ${line}`);
  }
  await flushIssues();

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

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err.response?.data ?? err);
    process.exit(1);
  });
}
