/**
 * Rewrite old Drive links across EVERY supported file type in the target tree.
 *
 * Handles four formats, in two very different ways:
 *
 *   NATIVE (edited in place through Google APIs)
 *     • Google Docs    — delegates to processDoc() from updateDocLinks.js, so
 *                        smart chips / hyperlinks / plain URLs behave exactly
 *                        as they do in the existing, proven tool.
 *     • Google Sheets  — ALL tabs. Rewrites =HYPERLINK() formulas, rich-text
 *                        run links, cell-level text links, and plain URLs.
 *
 *   OOXML (downloaded, rewritten, re-uploaded as a new revision)
 *     • .docx  • .xlsx — Office files are zipped XML. Google has no API to edit
 *                        their contents, so each is downloaded, every XML and
 *                        .rels part is rewritten, and the rebuilt file is
 *                        uploaded as a NEW REVISION of the same Drive file.
 *                        Drive keeps version history, so a bad run is
 *                        revertable from "Manage versions".
 *
 * All four share one source of truth: id-map.json (old Drive id -> new Drive id),
 * built by buildIdMap.js from path-matching the source and target trees.
 *
 * REQUIREMENTS
 *   npm install jszip          <-- new dependency, needed for .docx/.xlsx only
 *   .env: TARGET_FOLDER_ID (required), SOURCE_FOLDER_ID (to build the id-map)
 *   credentials.json + token.json (same OAuth as the rest of the toolkit)
 *
 * USAGE
 *   node updateAllLinks.js --dry-run          # report only, change nothing
 *   node updateAllLinks.js                    # apply to all four types
 *   node updateAllLinks.js --only=sheets      # docs | sheets | docx | xlsx (comma-sep)
 *   node updateAllLinks.js --skip=docx,xlsx   # inverse of --only
 *
 * OUTPUT
 *   logs/linkfix-<timestamp>/{summary.json, changes.json, failures.json}
 *   logs/links-update-error.jsonl   <-- append-only, one JSON object per line:
 *                                      every hard error and unresolved link
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { google } from 'googleapis';
import JSZip from 'jszip';
import {
  driveCall,
  isMainModule,
  runPool,
  DOC_CONCURRENCY,
} from './driveUtils.js';
import {
  authorize,
  extractDriveId,
  listTarget,
  loadOrBuildIdMap,
  processDoc,
} from './updateDocLinks.js';

/* ------------------------------------------------------------------ config */

const TARGET_FOLDER_ID = process.env.TARGET_FOLDER_ID;
const SOURCE_FOLDER_ID = process.env.SOURCE_FOLDER_ID;
const LOGS_BASE_DIR = path.join(process.cwd(), 'logs');

/**
 * Every problem this script hits — both hard failures and links it could not
 * resolve — is appended here as one JSON object per line, matching the style of
 * the migration's own errors-detail.jsonl so the same tooling can read both.
 *
 * Kept separate from index.js's log on purpose: link-rewriting problems are a
 * different class of issue from copy/delete problems and mixing them makes both
 * harder to triage.
 */
const LINK_ERROR_LOG = path.join(LOGS_BASE_DIR, 'links-update-error.jsonl');
const RUN_ID = `linkfix-${new Date().toISOString()}-${process.pid}`;

/**
 * Appends are serialized through a promise chain. Files are processed
 * concurrently (DOC_CONCURRENCY workers), and parallel fs.appendFile calls can
 * interleave mid-line and corrupt the JSONL — chaining guarantees whole lines.
 */
let errorWriteChain = Promise.resolve();
let linkErrorCount = 0;

function appendLinkError(record) {
  linkErrorCount += 1;
  const line =
    JSON.stringify({
      ts: new Date().toISOString(),
      runId: RUN_ID,
      script: 'updateAllLinks.js',
      dryRun: DRY_RUN,
      ...record,
    }) + '\n';
  errorWriteChain = errorWriteChain
    .then(() => fs.appendFile(LINK_ERROR_LOG, line, 'utf8'))
    .catch((err) => {
      console.warn(`[warn] could not write to ${LINK_ERROR_LOG}: ${err.message}`);
    });
  return errorWriteChain;
}

const MIME = {
  DOC: 'application/vnd.google-apps.document',
  SHEET: 'application/vnd.google-apps.spreadsheet',
  DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const KIND_BY_MIME = {
  [MIME.DOC]: 'docs',
  [MIME.SHEET]: 'sheets',
  [MIME.DOCX]: 'docx',
  [MIME.XLSX]: 'xlsx',
};

const DRY_RUN = process.argv.includes('--dry-run');

function listArg(flag) {
  const hit = process.argv.find((a) => a.startsWith(`${flag}=`));
  if (!hit) return null;
  return new Set(
    hit
      .slice(flag.length + 1)
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}
const ONLY = listArg('--only');
const SKIP = listArg('--skip');

function kindEnabled(kind) {
  if (ONLY) return ONLY.has(kind);
  if (SKIP) return !SKIP.has(kind);
  return true;
}

/* ------------------------------------------------------------- URL helpers */

/** Any docs.google.com / drive.google.com URL sitting in free text. */
const GOOGLE_URL_REGEX =
  /https?:\/\/(?:docs|drive)\.google\.com\/[^\s)>"'<\]}]+/gi;

/** Same host rule the Docs tool uses — only Google Drive/Docs links migrate. */
function isDocsOrDriveUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    return host === 'docs.google.com' || host === 'drive.google.com';
  } catch {
    return false;
  }
}

function replaceIdInUrl(url, oldId, newId) {
  const i = url.indexOf(oldId);
  if (i === -1) return url;
  return url.slice(0, i) + newId + url.slice(i + oldId.length);
}

/**
 * Resolver shared by Sheets and OOXML.
 *
 * `idMap`     old id -> new id (from buildIdMap.js)
 * `targetIds` every id that already lives in the target tree. Without this, a
 *             link that was ALREADY migrated looks "unknown" (its id is a
 *             value in the map, never a key) and would be reported as a
 *             failure on every re-run. Treating it as already-correct makes
 *             the script safely idempotent.
 *
 * Returns: null (leave alone) | {newUrl} (rewrite) | {unresolved:true} (report)
 */
export function makeResolver(idMap, targetIds = new Set()) {
  return function resolve(url) {
    if (!url || !isDocsOrDriveUrl(url)) return null;
    const oldId = extractDriveId(url);
    if (!oldId) return null;

    const newId = idMap[oldId];
    if (newId && newId !== oldId) {
      return { newUrl: replaceIdInUrl(url, oldId, newId), oldId, newId };
    }
    if (newId === oldId) return null; // map says it is unchanged
    if (targetIds.has(oldId)) return null; // already points into the target
    return { unresolved: true, oldId, url, reason: 'MISSING_IN_ID_MAP' };
  };
}

/**
 * Rewrites every Drive URL inside an arbitrary string.
 *
 * Deliberately conservative: a URL is only rewritten when its id resolves.
 * Unknown ids are left untouched and reported — never guessed, because a wrong
 * id silently points a link at the wrong document.
 *
 * @returns {{ text: string, changes: Array, unresolved: Array }}
 */
function rewriteUrlsInText(text, resolve) {
  if (!text || typeof text !== 'string') {
    return { text, changes: [], unresolved: [] };
  }
  const changes = [];
  const unresolved = [];

  const out = text.replace(GOOGLE_URL_REGEX, (url) => {
    // Trailing punctuation often gets swept into a bare URL match.
    const trailing = url.match(/[.,;:!?)\]}'"]+$/);
    const clean = trailing ? url.slice(0, -trailing[0].length) : url;
    const tail = trailing ? trailing[0] : '';

    const r = resolve(clean);
    if (!r) return url;
    if (r.unresolved) {
      unresolved.push({ url: clean, oldId: r.oldId, reason: r.reason });
      return url;
    }
    changes.push({ from: clean, to: r.newUrl });
    return r.newUrl + tail;
  });

  return { text: out, changes, unresolved };
}

/* --------------------------------------------------------- Google Sheets */

/**
 * Rewrites links across EVERY tab of a spreadsheet.
 *
 * Links hide in four different places in a Sheets cell, and each needs its own
 * write path — this is why Sheets is more involved than Docs:
 *
 *   1. =HYPERLINK("url", "label")   -> userEnteredValue.formulaValue
 *   2. plain URL typed in a cell     -> userEnteredValue.stringValue
 *   3. rich-text partial links       -> textFormatRuns[].format.link.uri
 *   4. whole-cell text link          -> userEnteredFormat.textFormat.link.uri
 *
 * The read is scoped with a field mask so we don't pull entire grids of
 * unrelated formatting back over the wire.
 */
async function processSheet(sheetsApi, fileEntry, resolve) {
  const changes = [];
  const unresolved = [];

  const res = await driveCall('read', `sheets.get ${fileEntry.name}`, () =>
    sheetsApi.spreadsheets.get({
      spreadsheetId: fileEntry.id,
      includeGridData: true,
      fields:
        'sheets(properties(sheetId,title),data(startRow,startColumn,rowData(values(' +
        'userEnteredValue,textFormatRuns,userEnteredFormat.textFormat.link))))',
    }),
  );

  const requests = [];

  for (const sheet of res.data.sheets ?? []) {
    const sheetId = sheet.properties?.sheetId;
    const title = sheet.properties?.title ?? '(untitled)';

    for (const grid of sheet.data ?? []) {
      const baseRow = grid.startRow ?? 0;
      const baseCol = grid.startColumn ?? 0;

      (grid.rowData ?? []).forEach((row, rOff) => {
        (row.values ?? []).forEach((cell, cOff) => {
          if (!cell) return;
          const rowIndex = baseRow + rOff;
          const colIndex = baseCol + cOff;
          const where = `${title}!R${rowIndex + 1}C${colIndex + 1}`;

          const newValue = {};
          const fieldsTouched = [];
          let cellChanged = false;

          // --- 1 & 2: formula or plain string content ---
          const uev = cell.userEnteredValue ?? {};
          if (typeof uev.formulaValue === 'string') {
            const r = rewriteUrlsInText(uev.formulaValue, resolve);
            if (r.changes.length) {
              newValue.formulaValue = r.text;
              fieldsTouched.push('userEnteredValue');
              cellChanged = true;
              r.changes.forEach((c) => changes.push({ where, kind: 'formula', ...c }));
            }
            r.unresolved.forEach((u) => unresolved.push({ where, ...u }));
          } else if (typeof uev.stringValue === 'string') {
            const r = rewriteUrlsInText(uev.stringValue, resolve);
            if (r.changes.length) {
              newValue.stringValue = r.text;
              fieldsTouched.push('userEnteredValue');
              cellChanged = true;
              r.changes.forEach((c) => changes.push({ where, kind: 'text', ...c }));
            }
            r.unresolved.forEach((u) => unresolved.push({ where, ...u }));
          }

          // --- 3: rich-text runs, each of which can carry its own link ---
          const runs = cell.textFormatRuns;
          if (Array.isArray(runs) && runs.length) {
            let runsChanged = false;
            const newRuns = runs.map((run) => {
              const uri = run?.format?.link?.uri;
              const r = uri ? resolve(uri) : null;
              if (r?.unresolved) {
                unresolved.push({ where, kind: 'richtext', url: uri, oldId: r.oldId });
                return run;
              }
              if (!r) return run;
              runsChanged = true;
              changes.push({ where, kind: 'richtext', from: uri, to: r.newUrl });
              return {
                ...run,
                format: { ...run.format, link: { uri: r.newUrl } },
              };
            });
            if (runsChanged) {
              newValue.textFormatRuns = newRuns;
              fieldsTouched.push('textFormatRuns');
              cellChanged = true;
            }
          }

          // --- 4: whole-cell text link ---
          const cellLink = cell.userEnteredFormat?.textFormat?.link?.uri;
          if (cellLink) {
            const r = resolve(cellLink);
            if (r?.unresolved) {
              unresolved.push({ where, kind: 'cell-link', url: cellLink, oldId: r.oldId });
            } else if (r) {
              newValue.userEnteredFormat = {
                textFormat: { link: { uri: r.newUrl } },
              };
              fieldsTouched.push('userEnteredFormat.textFormat.link');
              cellChanged = true;
              changes.push({ where, kind: 'cell-link', from: cellLink, to: r.newUrl });
            }
          }

          if (!cellChanged) return;

          requests.push({
            updateCells: {
              start: { sheetId, rowIndex, columnIndex: colIndex },
              rows: [{ values: [newValue] }],
              fields: fieldsTouched.join(','),
            },
          });
        });
      });
    }
  }

  if (requests.length && !DRY_RUN) {
    // Chunked: a spreadsheet with thousands of linked cells would otherwise
    // exceed the batchUpdate request-size limit.
    const CHUNK = 500;
    for (let i = 0; i < requests.length; i += CHUNK) {
      const slice = requests.slice(i, i + CHUNK);
      await driveCall('write', `sheets.batchUpdate ${fileEntry.name}`, () =>
        sheetsApi.spreadsheets.batchUpdate({
          spreadsheetId: fileEntry.id,
          requestBody: { requests: slice },
        }),
      );
    }
  }

  return { changes, unresolved, modified: requests.length > 0 };
}

/* ------------------------------------------------------- .docx / .xlsx */

/**
 * Parts of an OOXML package that may contain a Drive URL.
 *
 * Two distinct locations matter:
 *   • *.rels  — real hyperlinks live here as Relationship Target="<url>"
 *   • *.xml   — URLs typed as literal text (body text, shared strings,
 *               HYPERLINK() formulas) live in the XML content itself
 *
 * Everything else in the zip (images, fonts, binary blobs) is copied through
 * untouched — we only ever rewrite text parts.
 */
function isRewritableOoxmlPart(name) {
  const lower = name.toLowerCase();
  return lower.endsWith('.xml') || lower.endsWith('.rels');
}

async function downloadFileBuffer(drive, fileId, label) {
  const res = await driveCall('read', `files.get(media) ${label}`, () =>
    drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' },
    ),
  );
  return Buffer.from(res.data);
}

/**
 * Rewrites an in-memory OOXML package. Pure function over a Buffer, which is
 * what makes it unit-testable without touching Drive.
 */
export async function rewriteOoxmlBuffer(buffer, resolve) {
  const zip = await JSZip.loadAsync(buffer);
  const changes = [];
  const unresolved = [];

  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir || !isRewritableOoxmlPart(name)) continue;
    const xml = await entry.async('string');
    const r = rewriteUrlsInText(xml, resolve);
    r.changes.forEach((c) => changes.push({ part: name, ...c }));
    r.unresolved.forEach((u) => unresolved.push({ part: name, ...u }));
    if (r.changes.length) {
      // Preserve the original compression settings for the part.
      zip.file(name, r.text, { binary: false });
    }
  }

  if (changes.length === 0) return { buffer: null, changes, unresolved };

  const out = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  return { buffer: out, changes, unresolved };
}

async function processOoxml(drive, fileEntry, resolve) {
  const original = await downloadFileBuffer(drive, fileEntry.id, fileEntry.name);
  const { buffer, changes, unresolved } = await rewriteOoxmlBuffer(original, resolve);

  if (buffer && !DRY_RUN) {
    // Uploads as a NEW REVISION of the same file id — the Drive link, sharing
    // and comments are preserved, and the previous bytes stay in version
    // history so the change can be reverted from the Drive UI.
    await driveCall('write', `files.update(media) ${fileEntry.name}`, () =>
      drive.files.update({
        fileId: fileEntry.id,
        media: {
          mimeType: fileEntry.mimeType,
          body: Readable.from(buffer),
        },
        supportsAllDrives: true,
        fields: 'id',
      }),
    );
  }

  return { changes, unresolved, modified: Boolean(buffer) };
}

/* ------------------------------------------------------------------- main */

async function main() {
  if (!TARGET_FOLDER_ID) {
    console.error('TARGET_FOLDER_ID is not set. Put it in .env and retry.');
    process.exit(1);
  }

  const enabled = ['docs', 'sheets', 'docx', 'xlsx'].filter(kindEnabled);
  console.log(`\nMode:    ${DRY_RUN ? 'DRY RUN (nothing will be written)' : 'APPLY'}`);
  console.log(`Types:   ${enabled.join(', ') || '(none — check --only/--skip)'}`);
  if (!enabled.length) process.exit(1);

  // Must exist before the first appendLinkError call during processing.
  await fs.mkdir(LOGS_BASE_DIR, { recursive: true });

  const auth = await authorize();
  const drive = google.drive({ version: 'v3', auth });
  const docsApi = google.docs({ version: 'v1', auth });
  const sheetsApi = google.sheets({ version: 'v4', auth });

  const idMap = await loadOrBuildIdMap(drive);
  console.log(`id-map:  ${Object.keys(idMap).length} entries`);

  console.log('\nScanning target tree…');
  const { allItems } = await listTarget(drive, TARGET_FOLDER_ID);
  const targets = allItems.filter(
    (f) => KIND_BY_MIME[f.mimeType] && kindEnabled(KIND_BY_MIME[f.mimeType]),
  );

  const byKind = {};
  for (const f of targets) {
    const k = KIND_BY_MIME[f.mimeType];
    byKind[k] = (byKind[k] ?? 0) + 1;
  }
  console.log(
    `Found:   ${targets.length} file(s) — ` +
      Object.entries(byKind).map(([k, n]) => `${k}: ${n}`).join(', '),
  );

  // Ids already living in the target tree count as "already correct", so
  // re-running the script does not re-report links it fixed last time.
  const targetIds = new Set(allItems.map((i) => i.id));
  const resolve = makeResolver(idMap, targetIds);

  // Docs reuse the existing resolver context from updateDocLinks.js (which
  // additionally does its own name-based fallback).
  const docCtx = {
    idMap,
    targetNameIndex: new Map(),
    targetIdSet: targetIds,
    sourceIdSet: null,
    oldIdMetaCache: new Map(),
    fallbackResolutions: new Map(),
    fallbackMeta: new Map(),
    ambiguousOldIds: new Set(),
  };

  const changesLog = [];
  const failuresLog = [];
  let modifiedCount = 0;
  let processed = 0;

  await runPool(targets, DOC_CONCURRENCY, async (file) => {
    const kind = KIND_BY_MIME[file.mimeType];
    try {
      let result;
      if (kind === 'docs') {
        if (DRY_RUN) {
          // processDoc writes as it goes, so it is not safe to call in dry run.
          result = { changes: [], unresolved: [], modified: false, skipped: true };
        } else {
          const r = await processDoc(docsApi, drive, file, docCtx);
          result = {
            changes: r.successReplacements.map((s) => ({
              from: s.originalUrl,
              to: s.newUrl,
              kind: s.replacedAs ?? 'link',
            })),
            unresolved: r.failures,
            modified: r.modified,
          };
        }
      } else if (kind === 'sheets') {
        result = await processSheet(sheetsApi, file, resolve);
      } else {
        result = await processOoxml(drive, file, resolve);
      }

      if (result.modified) modifiedCount += 1;
      if (result.changes.length) {
        changesLog.push({
          file: file.name,
          path: file.path,
          id: file.id,
          kind,
          changes: result.changes,
        });
      }
      if (result.unresolved.length) {
        failuresLog.push({
          file: file.name,
          path: file.path,
          id: file.id,
          kind,
          unresolved: result.unresolved,
        });
        // One line per unresolved link, so each is independently greppable.
        for (const u of result.unresolved) {
          appendLinkError({
            kind: 'unresolved-link',
            label: `${kind} ${file.name}`,
            message: u.reason ?? 'MISSING_IN_ID_MAP',
            operation: 'link.resolve',
            info: {
              file: { id: file.id, name: file.name, mimeType: file.mimeType },
              path: file.path,
              fileKind: kind,
              url: u.url,
              oldId: u.oldId ?? null,
              where: u.where ?? u.part ?? null,
              linkKind: u.kind ?? null,
            },
          });
        }
      }
    } catch (err) {
      const status = err?.response?.status ?? err?.code ?? null;
      failuresLog.push({
        file: file.name,
        path: file.path,
        id: file.id,
        kind,
        error: err?.message ?? String(err),
      });
      appendLinkError({
        kind: 'error',
        label: `${kind} ${file.name}`,
        message: err?.message ?? String(err),
        httpStatus: typeof status === 'number' ? status : null,
        errorReason: err?.response?.data?.error?.errors?.[0]?.reason ?? null,
        operation:
          kind === 'sheets'
            ? 'sheets.batchUpdate'
            : kind === 'docs'
              ? 'docs.batchUpdate'
              : 'files.update',
        info: {
          file: { id: file.id, name: file.name, mimeType: file.mimeType },
          path: file.path,
          fileKind: kind,
        },
      });
      console.warn(`  ! ${file.name}: ${err?.message ?? err}`);
    } finally {
      processed += 1;
      if (processed % 25 === 0) {
        console.log(`  …${processed}/${targets.length}`);
      }
    }
  });

  /* ---- logs ---- */
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(LOGS_BASE_DIR, `linkfix-${stamp}`);
  await fs.mkdir(dir, { recursive: true });

  const totalChanges = changesLog.reduce((n, f) => n + f.changes.length, 0);
  const summary = {
    ranAt: new Date().toISOString(),
    dryRun: DRY_RUN,
    types: enabled,
    filesScanned: targets.length,
    filesByType: byKind,
    filesModified: modifiedCount,
    linksReplaced: totalChanges,
    filesWithUnresolved: failuresLog.length,
    errorsLogged: linkErrorCount,
    errorLog: path.relative(process.cwd(), LINK_ERROR_LOG),
  };

  await fs.writeFile(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
  await fs.writeFile(path.join(dir, 'changes.json'), JSON.stringify(changesLog, null, 2));
  await fs.writeFile(path.join(dir, 'failures.json'), JSON.stringify(failuresLog, null, 2));

  // Wait for every queued append to hit disk before reporting/exiting.
  await errorWriteChain;

  console.log('\n──────── summary ────────');
  console.log(`files scanned:    ${summary.filesScanned}`);
  console.log(`files modified:   ${summary.filesModified}`);
  console.log(`links replaced:   ${summary.linksReplaced}`);
  console.log(`files w/ issues:  ${summary.filesWithUnresolved}`);
  console.log(`logs:             ${path.relative(process.cwd(), dir)}`);
  if (linkErrorCount > 0) {
    console.log(
      `errors logged:    ${linkErrorCount} -> ${path.relative(process.cwd(), LINK_ERROR_LOG)}`,
    );
  }
  if (DRY_RUN) {
    console.log('\nDRY RUN — nothing was written. Re-run without --dry-run to apply.');
    console.log('(Google Docs are skipped in dry run; use --only=docs to apply them.)');
  } else {
    console.log('\n.docx/.xlsx changes were uploaded as new revisions —');
    console.log('revert from Drive → right-click file → Manage versions.');
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error('\nFatal:', err?.message ?? err);
    process.exit(1);
  });
}