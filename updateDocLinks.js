

/**
 * Add-on: rewrite old Drive links inside migrated Google Docs.
 *
 * Reuses the existing OAuth flow (credentials.json + token.json) and
 * the recursive-listing pattern from index.js / verify.js / getMissing.js.
 *
 * Inputs:
 *   - TARGET_FOLDER_ID  (env)            folder to scan for Google Docs
 *   - id-map.json                        { OLD_FILE_ID: NEW_FILE_ID, ... }
 *
 * Outputs:
 *   - id-map-detailed.json               enriched mapping with name + URLs
 *   - logs/run-<timestamp>-<pid>/       one folder per script run
 *     success.json                       per-doc successful replacements only
 *     failed.json                        per-doc failed links + reason only
 *     docs-with-links.json               every doc that had ≥1 Drive link candidate
 *                                        (replaced and/or failed — full detail)
 *     summary.json                       aggregate counters
 *
 * Editing model (see processDoc):
 *   Docs edits are index-based, and any edit that changes the document length
 *   invalidates every index after it. Edits are therefore split into two kinds:
 *
 *     non-shifting  updateTextStyle to retarget an existing hyperlink. The text
 *                   is untouched, so all indices from the walk stay valid.
 *     shifting      smart chips (which have no mutable URI, so they are deleted
 *                   and re-inserted as hyperlinked text) and runs whose visible
 *                   text contains an old URL.
 *
 *   Non-shifting edits go first, in one batch, against the walked indices.
 *   Shifting edits then go in a single batch sorted highest-index-first, so
 *   each one only moves text that later requests do not refer to. Splitting
 *   shifting edits across batches computed from the same snapshot — which is
 *   what this used to do — silently shreds the document.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { google } from 'googleapis';
import { buildIdMap } from './buildIdMap.js';
import {
  apiStats,
  appendErrorDetail,
  appendIssue,
  createStatusPrinter,
  createWalkContext,
  DOC_CONCURRENCY,
  DOCS_RATE,
  DOCS_RATE_MAX,
  driveCall,
  docsCall,
  flushIssues,
  formatDuration,
  governors,
  isMainModule,
  READ_RATE,
  READ_RATE_MAX,
  runPool,
  truncateName,
  WALK_CONCURRENCY,
  walkTrees,
} from './driveUtils.js';

// ---- Config ----
const SOURCE_FOLDER_ID = process.env.SOURCE_FOLDER_ID;
const TARGET_FOLDER_ID = process.env.TARGET_FOLDER_ID;
const CREDENTIALS_PATH =
  process.env.GOOGLE_OAUTH_CREDENTIALS || path.join(process.cwd(), 'credentials.json');
const TOKEN_PATH =
  process.env.GOOGLE_OAUTH_TOKEN || path.join(process.cwd(), 'token.json');
const ID_MAP_PATH = process.env.ID_MAP_PATH || path.join(process.cwd(), 'id-map.json');
const ID_MAP_DETAILED_PATH = path.join(process.cwd(), 'id-map-detailed.json');
const LOGS_BASE_DIR = path.join(process.cwd(), 'logs');

/** Unique folder for this run: logs/run-<iso>-<pid> (Windows-safe name). */
function createRunLogsDir() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(LOGS_BASE_DIR, `run-${stamp}-${process.pid}`);
}

const FORCE_REBUILD_DETAILED_MAP = process.env.FORCE_REBUILD_DETAILED_MAP === '1';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DOC_MIME = 'application/vnd.google-apps.document';

// ---- Auth ----
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

// ---- Concurrent walk: collect Google Docs AND every other item.
// Single pass so we can build a name-index of the target tree for the
// MISSING_IN_ID_MAP fallback resolver.
//
// Drained by WALK_CONCURRENCY workers through the shared read governor, so
// listing is paced adaptively instead of by a fixed sleep per page.
export async function listTarget(
  drive,
  folderId,
  prefix = '',
  out = { docs: [], allItems: [] },
  { onStatus } = {},
) {
  const ctx = createWalkContext({
    scan: { tree: { folders: 0, files: 0 } },
    onFolder(side, fullPath, f) {
      out.allItems.push({ id: f.id, name: f.name, mimeType: f.mimeType, path: fullPath });
    },
    onFile(side, fullPath, f) {
      out.allItems.push({ id: f.id, name: f.name, mimeType: f.mimeType, path: fullPath });
      if (f.mimeType === DOC_MIME) {
        out.docs.push({ id: f.id, name: f.name, path: fullPath });
      }
    },
  });

  const status = onStatus ? onStatus(ctx) : null;
  status?.start();
  try {
    await walkTrees(drive, [{ side: 'tree', id: folderId, path: prefix }], ctx);
    ctx.done = true;
  } finally {
    status?.stop();
  }

  if (ctx.stats.errors) {
    console.warn(
      `[warn] ${ctx.stats.errors} folders could not be listed — the scan is incomplete.`,
    );
  }

  return out;
}

/** Two-line status block for the folder scan. */
function createScanStatusLogger(ctx, label) {
  const startedAt = Date.now();

  return createStatusPrinter(() => {
    const s = ctx.scan.tree;
    const progress = [
      `[progress] ${label}: ${s.files} files / ${s.folders} folders`,
    ];
    if (ctx.stats.errors) progress.push(`${ctx.stats.errors} errors`);
    progress.push(`elapsed ${formatDuration(Date.now() - startedAt)}`);

    const scan = [
      ctx.done ? '[scan] scan complete' : '[scan] scanning…',
      `queue: ${ctx.queues.folders.size} folders`,
      `api ${governors.read.rate.toFixed(1)}/s read`,
    ];
    if (apiStats.retries) scan.push(`${apiStats.retries} retries`);
    scan.push(`in: ${truncateName(ctx.runtime.currentFolder || '/', 40)}`);

    return [progress.join(' | '), scan.join(' | ')];
  });
}

function buildNameIndex(allItems) {
  /** @type {Map<string, Array<{id:string,name:string,mimeType:string,path:string}>>} */
  const index = new Map();
  for (const item of allItems) {
    const arr = index.get(item.name);
    if (arr) arr.push(item);
    else index.set(item.name, [item]);
  }
  return index;
}

// ---- URL utilities ----
const GOOGLE_URL_REGEX =
  /https?:\/\/(?:docs|drive)\.google\.com\/[^\s)>"'<\]]+/gi;

/**
 * Only https://docs.google.com and https://drive.google.com links are migrated.
 * Other domains (and other google.com hosts) are left unchanged and not reported as failures.
 */
function isDocsOrDriveUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const u = new URL(url.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    return host === 'docs.google.com' || host === 'drive.google.com';
  } catch {
    return false;
  }
}

export function extractDriveId(url) {
  if (!url) return null;
  let m = url.match(/\/d\/([a-zA-Z0-9_-]{15,})/);
  if (m) return m[1];
  m = url.match(/[?&]id=([a-zA-Z0-9_-]{15,})/);
  if (m) return m[1];
  m = url.match(/\/folders\/([a-zA-Z0-9_-]{15,})/);
  if (m) return m[1];
  return null;
}

function replaceIdInUrl(originalUrl, oldId, newId) {
  const idx = originalUrl.indexOf(oldId);
  if (idx === -1) return originalUrl;
  return (
    originalUrl.slice(0, idx) + newId + originalUrl.slice(idx + oldId.length)
  );
}

function viewerUrlForMime(id, mimeType) {
  switch (mimeType) {
    case 'application/vnd.google-apps.document':
      return `https://docs.google.com/document/d/${id}/edit`;
    case 'application/vnd.google-apps.spreadsheet':
      return `https://docs.google.com/spreadsheets/d/${id}/edit`;
    case 'application/vnd.google-apps.presentation':
      return `https://docs.google.com/presentation/d/${id}/edit`;
    case 'application/vnd.google-apps.form':
      return `https://docs.google.com/forms/d/${id}/edit`;
    case FOLDER_MIME:
      return `https://drive.google.com/drive/folders/${id}`;
    default:
      return `https://drive.google.com/file/d/${id}/view`;
  }
}

// ---- id-map-detailed.json builder ----
// One files.get per entry, run through the shared read governor with
// WALK_CONCURRENCY workers. runPool returns results in input order, so the
// written file keeps the same entry order as the id-map it came from.
async function buildDetailedMap(drive, idMap) {
  const entries = Object.entries(idMap);

  return runPool(entries, WALK_CONCURRENCY, async ([oldId, newId], i) => {
    let name = '';
    let mimeType = '';
    try {
      const res = await driveCall('read', `files.get ${newId}`, () =>
        drive.files.get({
          fileId: newId,
          fields: 'id, name, mimeType',
          supportsAllDrives: true,
        }),
      );
      name = res.data.name || '';
      mimeType = res.data.mimeType || '';
    } catch (err) {
      console.warn(
        `[warn] could not fetch metadata for ${newId} (${i + 1}/${entries.length}): ${err?.message ?? err}`,
      );
    }
    return {
      oldId,
      newId,
      name,
      oldUrl: viewerUrlForMime(oldId, mimeType),
      newUrl: viewerUrlForMime(newId, mimeType),
    };
  });
}

// ---- Doc body walker ----
function* walkParagraphs(structuralElements, state = { pIndex: 0 }, segmentId = '') {
  for (const block of structuralElements || []) {
    if (block.paragraph) {
      yield { paragraph: block.paragraph, paragraphIndex: state.pIndex, segmentId };
      state.pIndex += 1;
    } else if (block.table) {
      for (const row of block.table.tableRows || []) {
        for (const cell of row.tableCells || []) {
          yield* walkParagraphs(cell.content || [], state, segmentId);
        }
      }
    } else if (block.tableOfContents) {
      yield* walkParagraphs(block.tableOfContents.content || [], state, segmentId);
    }
  }
}

/**
 * Every paragraph in the document — body first, then headers, footers and
 * footnotes.
 *
 * Docs indices are per-SEGMENT, not document-wide: index 42 in a header is a
 * different character from index 42 in the body. Every yielded paragraph
 * therefore carries the segmentId its indices belong to, and any range built
 * from them must carry it too. Walking only the body (as this used to) meant
 * links in headers and footers were never seen.
 */
function* walkDocument(doc, state = { pIndex: 0 }) {
  yield* walkParagraphs(doc.body?.content || [], state, '');
  for (const group of ['headers', 'footers', 'footnotes']) {
    for (const [segmentId, segment] of Object.entries(doc[group] || {})) {
      yield* walkParagraphs(segment.content || [], state, segmentId);
    }
  }
}

/** Docs Range/Location omit segmentId for the body and require it elsewhere. */
function docRange(segmentId, startIndex, endIndex) {
  return segmentId ? { segmentId, startIndex, endIndex } : { startIndex, endIndex };
}

function docLocation(segmentId, index) {
  return segmentId ? { segmentId, index } : { index };
}

/** Replace every occurrence of `find` in `text` — no regex escaping needed. */
function replaceAllLiteral(text, find, replacement) {
  return text.split(find).join(replacement);
}

function snippetFromText(text, maxLen = 80) {
  if (!text) return '';
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen - 1) + '…';
}

/**
 * Resolve an old Drive ID: id-map, cached name-fallback, folder membership,
 * then name-based fallback against the target tree.
 *
 * - `already-in-target`: rewrite link anyway (logged as success) even when id unchanged.
 * - `already-in-source`: not a failure and not rewritten (link still lives in source tree).
 *
 * Returns null only when unreachable (typically id not under source/target and not mapped).
 *
 * @returns {Promise<{newId: string, source: 'id-map'|'name-fallback'|'already-in-target'|'already-in-source', oldName?: string} | null>}
 */
async function resolveOldId(drive, oldId, ctx) {
  if (!oldId) return null;
  if (ctx.idMap[oldId]) {
    return { newId: ctx.idMap[oldId], source: 'id-map' };
  }
  if (ctx.fallbackResolutions.has(oldId)) {
    const newId = ctx.fallbackResolutions.get(oldId);
    return {
      newId,
      source: 'name-fallback',
      oldName: ctx.oldIdMetaCache.get(oldId)?.name,
    };
  }

  if (ctx.targetIdSet?.has(oldId)) {
    return { newId: oldId, source: 'already-in-target' };
  }
  if (ctx.sourceIdSet?.has(oldId)) {
    return { newId: oldId, source: 'already-in-source' };
  }

  // Look up the OLD file's metadata once and cache the result.
  let meta;
  if (ctx.oldIdMetaCache.has(oldId)) {
    meta = ctx.oldIdMetaCache.get(oldId);
  } else {
    // With DOC_CONCURRENCY docs in flight, several can want the same old id at
    // once. The first claims the lookup and the rest await it, so a given id
    // costs one files.get per run rather than one per doc that references it.
    ctx.oldIdMetaInflight ??= new Map();
    let inFlight = ctx.oldIdMetaInflight.get(oldId);
    if (!inFlight) {
      inFlight = (async () => {
        try {
          const res = await driveCall('read', `files.get(old) ${oldId}`, () =>
            drive.files.get({
              fileId: oldId,
              fields: 'id, name, mimeType',
              supportsAllDrives: true,
            }),
          );
          return { name: res.data.name || '', mimeType: res.data.mimeType || '' };
        } catch {
          return null;
        }
      })();
      ctx.oldIdMetaInflight.set(oldId, inFlight);
    }
    meta = await inFlight;
    ctx.oldIdMetaCache.set(oldId, meta);
    ctx.oldIdMetaInflight.delete(oldId);
  }
  if (!meta || !meta.name) return null;

  const candidates = ctx.targetNameIndex.get(meta.name) || [];
  if (candidates.length === 0) return null;

  // Prefer same mimeType, fall back to a unique single candidate.
  const sameMime = candidates.filter((c) => c.mimeType === meta.mimeType);
  let chosen = null;
  if (sameMime.length === 1) chosen = sameMime[0];
  else if (sameMime.length === 0 && candidates.length === 1) chosen = candidates[0];

  if (!chosen) {
    // Ambiguous (multiple same-mime, or multiple cross-mime candidates) — skip.
    ctx.ambiguousOldIds.add(oldId);
    return null;
  }

  ctx.idMap[oldId] = chosen.id;
  ctx.fallbackResolutions.set(oldId, chosen.id);
  ctx.fallbackMeta.set(oldId, { name: meta.name, mimeType: meta.mimeType, newId: chosen.id });
  return { newId: chosen.id, source: 'name-fallback', oldName: meta.name };
}

// ---- Per-doc processing ----
export async function processDoc(docs, drive, fileEntry, ctx) {
  const idMap = ctx.idMap;
  const docResp = await docsCall(`docs.get ${fileEntry.name}`, () =>
    docs.documents.get({ documentId: fileEntry.id }),
  );
  const doc = docResp.data;

  const dryRun = Boolean(ctx.dryRun);

  /**
   * Every edit is sorted into exactly one of two buckets, because the only way
   * to keep Docs indices valid is to know which edits move them.
   *
   * NON-SHIFTING — retargeting an existing hyperlink with updateTextStyle. The
   * visible text is untouched, so the document length does not change and every
   * index captured during the walk stays valid. Safe to send as one batch.
   *
   *   { segmentId, startIndex, endIndex, url }
   */
  const retargets = [];

  /**
   * SHIFTING — anything that rewrites visible text: a smart chip becoming a
   * hyperlink, or a run whose text literally contains an old Drive URL. Each is
   * delete → insert → restyle, which changes the document length, so they are
   * applied highest-index-first in a single batch AFTER the non-shifting one.
   *
   *   { segmentId, startIndex, endIndex, text, style, fields }
   */
  const rewrites = [];

  const successReplacements = [];
  const failures = [];

  /**
   * Links that already point at the right file. They are neither a failure nor
   * a replacement: emitting an edit for them would rewrite a URL to itself,
   * burn a revision, and report "N links replaced" on a run that changed
   * nothing — which is precisely the kind of false green that hides real
   * breakage. Counted, not acted on.
   */
  let alreadyCorrect = 0;

  function skipSilentSameIdResolved(resolved, oldId) {
    return (
      resolved?.newId === oldId &&
      resolved.source === 'already-in-source'
    );
  }

  function shouldRewriteOrLogSuccess(resolved, oldId) {
    return (
      resolved &&
      (resolved.newId !== oldId || resolved.source === 'already-in-target')
    );
  }

  for (const { paragraph, paragraphIndex, segmentId } of walkDocument(doc)) {
    const elements = paragraph.elements || [];
    const paraText = elements
      .map(
        (e) =>
          e.textRun?.content ||
          e.richLink?.richLinkProperties?.title ||
          '',
      )
      .join('');
    const snippet = snippetFromText(paraText);

    for (const el of elements) {
      // ---- Smart chips (richLink) ----
      if (el.richLink) {
        const props = el.richLink.richLinkProperties || {};
        const uri = props.uri;

        if (!uri || !isDocsOrDriveUrl(uri)) {
          // Non-docs/drive chip (e.g. YouTube) — leave alone
          continue;
        }

        const oldId = extractDriveId(uri);
        const resolved = await resolveOldId(drive, oldId, ctx);

        if (!resolved) {
          failures.push({
            url: uri,
            reason: 'MISSING_IN_ID_MAP',
            paragraphIndex,
            textSnippet: snippet,
          });
          continue;
        }
        if (skipSilentSameIdResolved(resolved, oldId)) {
          continue;
        }

        const newUrl = replaceIdInUrl(uri, oldId, resolved.newId);
        // const displayText = props.title ? props.title : newUrl;
        const displayText = newUrl;

        if (shouldRewriteOrLogSuccess(resolved, oldId)) {
          if (newUrl === uri) {
            alreadyCorrect += 1; // chip already points into the target
            continue;
          }
          // A chip is one index unit; it becomes a hyperlinked URL string, so
          // this always lengthens the segment — strictly a shifting edit.
          rewrites.push({
            segmentId,
            startIndex: el.startIndex,
            endIndex: el.endIndex,
            text: displayText,
            style: { link: { url: newUrl } },
            fields: 'link',
          });

          successReplacements.push({
            originalUrl: uri,
            newUrl,
            replacedAs: 'SMART_CHIP_CONVERTED_TO_HYPERLINK',
            matchedBy: resolved.source,
            displayText,
            paragraphIndex,
            textSnippet: snippet,
          });
        }
        continue;
      }

      // Person smart chips don't carry doc URLs — skip silently
      if (el.person) continue;

      if (!el.textRun) continue;

      const tr = el.textRun;
      const content = tr.content || '';
      const linkUrl = tr.textStyle?.link?.url;

      // ---- The run's hyperlink target (what the text points at) ----
      let newLinkUrl = null;
      if (linkUrl && isDocsOrDriveUrl(linkUrl)) {
        const oldId = extractDriveId(linkUrl);
        const resolved = await resolveOldId(drive, oldId, ctx);
        if (!resolved) {
          failures.push({
            url: linkUrl,
            reason: 'MISSING_IN_ID_MAP',
            paragraphIndex,
            textSnippet: snippet,
          });
        } else if (
          !skipSilentSameIdResolved(resolved, oldId) &&
          shouldRewriteOrLogSuccess(resolved, oldId)
        ) {
          const candidate = replaceIdInUrl(linkUrl, oldId, resolved.newId);
          if (candidate === linkUrl) {
            alreadyCorrect += 1;
          } else {
            newLinkUrl = candidate;
            successReplacements.push({
              originalUrl: linkUrl,
              newUrl: newLinkUrl,
              replacedAs: 'HYPERLINK_RETARGETED',
              matchedBy: resolved.source,
              paragraphIndex,
              textSnippet: snippet,
            });
          }
        }
      }
      // Else if linkUrl: other domains — ignore (not in scope for this migration)

      // ---- Drive URLs sitting in the run's VISIBLE TEXT ----
      // A URL that is also the run's link target was already resolved and
      // logged above; reuse that result rather than resolving (and reporting)
      // the same link twice.
      let newContent = content;
      for (const url of content.match(GOOGLE_URL_REGEX) || []) {
        let newUrl;
        if (linkUrl && url === linkUrl) {
          newUrl = newLinkUrl;
        } else {
          const oldId = extractDriveId(url);
          const resolved = await resolveOldId(drive, oldId, ctx);
          if (!resolved) {
            failures.push({
              url,
              reason: 'MISSING_IN_ID_MAP',
              paragraphIndex,
              textSnippet: snippet,
            });
            continue;
          }
          if (
            skipSilentSameIdResolved(resolved, oldId) ||
            !shouldRewriteOrLogSuccess(resolved, oldId)
          ) {
            continue;
          }
          newUrl = replaceIdInUrl(url, oldId, resolved.newId);
          if (newUrl === url) {
            alreadyCorrect += 1;
            continue;
          }
          successReplacements.push({
            originalUrl: url,
            newUrl,
            replacedAs: 'TEXT_URL_REWRITTEN',
            matchedBy: resolved.source,
            paragraphIndex,
            textSnippet: snippet,
          });
        }
        if (newUrl && newUrl !== url) {
          newContent = replaceAllLiteral(newContent, url, newUrl);
        }
      }

      if (newContent !== content) {
        // The text itself has to change, so this is a delete → insert → restyle.
        // The whole run is replaced in one edit, which keeps every shifting edit
        // on a disjoint range and makes the descending-order pass below sound.
        let startIndex = el.startIndex;
        let endIndex = el.endIndex;
        let text = newContent;

        // A run that ends a paragraph includes the paragraph mark. Deleting it
        // merges this paragraph into the next one, so keep it out of the range.
        if (content.endsWith('\n')) {
          endIndex -= 1;
          text = text.slice(0, -1);
        }

        if (endIndex > startIndex && text.length > 0) {
          // insertText inherits formatting from the preceding character, so the
          // run's own style is captured and re-applied over the inserted range —
          // otherwise bold/size/colour would be silently lost on every rewrite.
          const style = { ...(tr.textStyle || {}) };
          const finalLink = newLinkUrl || linkUrl;
          if (finalLink) style.link = { url: finalLink };
          else delete style.link;
          const fields = [...new Set([...Object.keys(style), 'link'])].join(',');

          rewrites.push({ segmentId, startIndex, endIndex, text, style, fields });
        }
      } else if (newLinkUrl) {
        // Text unchanged — only the link target moves. updateTextStyle does that
        // without touching a single character, so it neither loses the anchor
        // text nor shifts any index.
        let endIndex = el.endIndex;
        if (content.endsWith('\n')) endIndex -= 1;
        if (endIndex > el.startIndex) {
          retargets.push({
            segmentId,
            startIndex: el.startIndex,
            endIndex,
            url: newLinkUrl,
          });
        }
      }
    }
  }

  const modified = retargets.length > 0 || rewrites.length > 0;

  if (dryRun) {
    return { successReplacements, failures, modified, alreadyCorrect };
  }

  // ---- Batch 1: retargets (non-shifting) ----
  // updateTextStyle never changes the document length, so every index captured
  // during the walk is still exactly right when this batch runs. It must go
  // FIRST, while the document still matches what the walk saw.
  if (retargets.length > 0) {
    await docsCall(`docs.batchUpdate(retarget) ${fileEntry.name}`, () =>
      docs.documents.batchUpdate({
        documentId: fileEntry.id,
        requestBody: {
          requests: retargets.map((r) => ({
            updateTextStyle: {
              range: docRange(r.segmentId, r.startIndex, r.endIndex),
              textStyle: { link: { url: r.url } },
              fields: 'link',
            },
          })),
        },
      }),
    );
  }

  // ---- Batch 2: every length-changing edit, highest index first ----
  // Requests inside one batchUpdate are applied in array order, and an edit only
  // moves the indices of content AFTER it. Sorting descending (within each
  // segment, since indices are per-segment) therefore keeps every later request
  // pointing at the character it was computed from — no re-fetch, no arithmetic.
  //
  // This ordering is the whole ballgame: mixing these edits with the batch above,
  // or splitting them across batches computed from the same original snapshot,
  // is what shreds the document.
  if (rewrites.length > 0) {
    rewrites.sort((a, b) =>
      a.segmentId === b.segmentId
        ? b.startIndex - a.startIndex
        : a.segmentId < b.segmentId
          ? -1
          : 1,
    );

    const requests = [];
    for (const e of rewrites) {
      requests.push(
        { deleteContentRange: { range: docRange(e.segmentId, e.startIndex, e.endIndex) } },
        { insertText: { location: docLocation(e.segmentId, e.startIndex), text: e.text } },
        {
          updateTextStyle: {
            range: docRange(e.segmentId, e.startIndex, e.startIndex + e.text.length),
            textStyle: e.style,
            fields: e.fields,
          },
        },
      );
    }

    await docsCall(`docs.batchUpdate(rewrite) ${fileEntry.name}`, () =>
      docs.documents.batchUpdate({
        documentId: fileEntry.id,
        requestBody: { requests },
      }),
    );
  }

  return {
    successReplacements,
    failures,
    modified,
    alreadyCorrect,
  };
}

export async function loadOrBuildIdMap(drive) {
  let idMap = null;
  let needsBuild = false;
  let buildReason = '';

  try {
    const raw = await fs.readFile(ID_MAP_PATH, 'utf8');
    const trimmed = raw.trim();
    if (!trimmed) {
      needsBuild = true;
      buildReason = 'id-map.json is empty';
    } else {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          idMap = {};
          for (const r of parsed) {
            if (r?.oldId && r?.newId) idMap[r.oldId] = r.newId;
          }
        } else if (parsed && typeof parsed === 'object') {
          idMap = parsed;
        } else {
          needsBuild = true;
          buildReason = 'id-map.json has unexpected shape';
        }
        if (idMap && Object.keys(idMap).length === 0) {
          needsBuild = true;
          buildReason = 'id-map.json contains 0 entries';
          idMap = null;
        }
      } catch (err) {
        needsBuild = true;
        buildReason = `id-map.json is not valid JSON (${err.message})`;
      }
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      needsBuild = true;
      buildReason = 'id-map.json not found';
    } else {
      throw new Error(`❌ Could not read ${ID_MAP_PATH}: ${err.message}`);
    }
  }

  if (needsBuild) {
    if (!SOURCE_FOLDER_ID) {
      throw new Error(
        `❌ ${buildReason}, and SOURCE_FOLDER_ID is not set.\n` +
          '   Set SOURCE_FOLDER_ID + TARGET_FOLDER_ID in .env so the map can be built,\n' +
          '   or run `node buildIdMap.js` first.',
      );
    }
    console.log(`ℹ️  ${buildReason} — building it from SOURCE/TARGET folders…`);
    const result = await buildIdMap(drive, {
      sourceFolderId: SOURCE_FOLDER_ID,
      targetFolderId: TARGET_FOLDER_ID,
      outputPath: ID_MAP_PATH,
      write: true,
    });
    idMap = result.idMap;
  }

  const mapSize = Object.keys(idMap || {}).length;
  if (mapSize === 0) {
    throw new Error(
      '❌ id-map is empty — no source/target paths matched. Nothing to replace.',
    );
  }

  return idMap;
}

// ---- Main ----
async function main() {
  if (!TARGET_FOLDER_ID) {
    console.error('❌ Set TARGET_FOLDER_ID in .env');
    process.exit(1);
  }

  const auth = await authorize();
  const drive = google.drive({ version: 'v3', auth });
  const docs = google.docs({ version: 'v1', auth });

  let idMap;
  try {
    idMap = await loadOrBuildIdMap(drive);
  } catch (err) {
    console.error(err.message || err);
    process.exit(1);
  }

  const mapSize = Object.keys(idMap || {}).length;
  // Build (or reuse) the detailed map
  let detailedExists = false;
  try {
    await fs.access(ID_MAP_DETAILED_PATH);
    detailedExists = true;
  } catch { }
  if (!detailedExists || FORCE_REBUILD_DETAILED_MAP) {
    console.log(
      `🔧 Building id-map-detailed.json (${mapSize} entries)…${FORCE_REBUILD_DETAILED_MAP ? ' [forced rebuild]' : ''
      }`,
    );
    const detailed = await buildDetailedMap(drive, idMap);
    await fs.writeFile(
      ID_MAP_DETAILED_PATH,
      JSON.stringify(detailed, null, 2),
      'utf8',
    );
    console.log(`   Wrote ${detailed.length} entries to id-map-detailed.json`);
  } else {
    console.log(
      'ℹ️  id-map-detailed.json already exists — set FORCE_REBUILD_DETAILED_MAP=1 to rebuild.',
    );
  }

  console.log('📂 Scanning target folder…');
  console.log(
    `   ${WALK_CONCURRENCY} walkers | rate: ${READ_RATE}→${READ_RATE_MAX}/s read (adaptive)`,
  );
  const { docs: allDocs, allItems } = await listTarget(
    drive,
    TARGET_FOLDER_ID,
    '',
    { docs: [], allItems: [] },
    { onStatus: (c) => createScanStatusLogger(c, 'target') },
  );
  console.log(
    `   Found ${allDocs.length} Google Docs (across ${allItems.length} target items)`,
  );

  // A concurrent walk has no stable completion order, so fix a deterministic
  // one for the progress counter and the per-doc log files.
  allDocs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const targetIdSet = new Set(allItems.map((i) => i.id));

  let sourceIdSet = new Set();
  if (SOURCE_FOLDER_ID) {
    console.log('📂 Indexing source folder (link validity: in-tree IDs are OK)…');
    const { allItems: sourceItems } = await listTarget(
      drive,
      SOURCE_FOLDER_ID,
      '',
      { docs: [], allItems: [] },
      { onStatus: (c) => createScanStatusLogger(c, 'source') },
    );
    sourceIdSet = new Set(sourceItems.map((i) => i.id));
    console.log(`   ${sourceIdSet.size} items under SOURCE_FOLDER_ID`);
  }

  // Name index for the MISSING_IN_ID_MAP fallback resolver.
  const targetNameIndex = buildNameIndex(allItems);

  /** Shared context passed to processDoc for each target doc. */
  const ctx = {
    idMap,
    targetNameIndex,
    targetIdSet,
    sourceIdSet,
    /** oldId -> {name, mimeType} | null  (cache of files.get for OLD ids) */
    oldIdMetaCache: new Map(),
    /** oldId -> newId  (newly resolved this run, to persist back) */
    fallbackResolutions: new Map(),
    /** oldId -> {name, mimeType, newId}  (for detailed-map updates) */
    fallbackMeta: new Map(),
    /** oldId set — couldn't pick because of multiple same-name candidates */
    ambiguousOldIds: new Set(),
  };

  const runLogsDir = createRunLogsDir();
  await fs.mkdir(runLogsDir, { recursive: true });
  console.log(
    `📝 Logs for this run: ${path.relative(process.cwd(), runLogsDir) || runLogsDir}`,
  );

  const successLog = [];
  const failedLog = [];
  /** Docs where ≥1 Google Drive link was considered (replaced and/or failed). */
  const docsWithLinksLog = [];
  const modifiedPaths = [];
  let totalLinksFound = 0;
  let totalReplaced = 0;
  let totalFailed = 0;
  let totalResolvedByName = 0;

  // Docs are processed DOC_CONCURRENCY at a time. Each doc is still handled by
  // the same processDoc() — index ordering and batching *within* a doc are
  // untouched; only the outer loop is parallel. A doc that throws is recorded
  // and the run continues.
  console.log(
    `\n🔗 Rewriting links in ${allDocs.length} docs — ${DOC_CONCURRENCY} at a time | docs api ${DOCS_RATE}→${DOCS_RATE_MAX}/s (adaptive)\n`,
  );

  const perDoc = await runPool(allDocs, DOC_CONCURRENCY, async (docFile, i) => {
    const progress = `[${i + 1}/${allDocs.length}]`;
    try {
      const { successReplacements, failures, modified } = await processDoc(
        docs,
        drive,
        docFile,
        ctx,
      );

      if (modified) {
        console.log(
          `${progress} ✏️  ${docFile.path} — replaced ${successReplacements.length}, failed ${failures.length}`,
        );
      } else if (failures.length > 0) {
        console.log(
          `${progress} ⚠️  ${docFile.path} — ${failures.length} failed (no replacements)`,
        );
      } else {
        console.log(`${progress} ·  ${docFile.path} — no links to update`);
      }

      return { docFile, successReplacements, failures, modified };
    } catch (err) {
      const message = String(err?.message ?? err);
      console.error(`${progress} ❌ ${docFile.path}: ${message}`);
      appendIssue('doc-error', `${docFile.path}\t${message}`);
      appendErrorDetail(
        'doc-error',
        docFile.path,
        message,
        {
          operation: 'docs.batchUpdate',
          targetFile: { id: docFile.id, name: docFile.name },
          targetFolder: { path: docFile.path.split('/').slice(0, -1).join('/') || '/' },
          failedFileId: docFile.id,
        },
        err,
      );
      return { docFile, error: message };
    }
  });

  // Aggregate in document order — runPool returns input order, so the log files
  // do not depend on which worker happened to finish first.
  for (const result of perDoc) {
    const { docFile } = result;

    if (result.error !== undefined) {
      failedLog.push({
        docName: docFile.name,
        docId: docFile.id,
        path: docFile.path,
        failures: [
          {
            url: '',
            reason: 'PROCESSING_ERROR',
            paragraphIndex: -1,
            textSnippet: result.error,
          },
        ],
      });
      totalFailed += 1;
      continue;
    }

    const { successReplacements, failures, modified } = result;

    for (const r of successReplacements) {
      if (r.matchedBy === 'name-fallback') totalResolvedByName += 1;
    }
    totalLinksFound += successReplacements.length + failures.length;
    totalReplaced += successReplacements.length;
    totalFailed += failures.length;

    const linkCandidateCount = successReplacements.length + failures.length;
    if (linkCandidateCount > 0) {
      docsWithLinksLog.push({
        docName: docFile.name,
        docId: docFile.id,
        path: docFile.path,
        candidateLinkCount: linkCandidateCount,
        replacedCount: successReplacements.length,
        failedCount: failures.length,
        replacements: successReplacements,
        failures,
      });
    }

    if (successReplacements.length > 0) {
      successLog.push({
        docName: docFile.name,
        docId: docFile.id,
        path: docFile.path,
        replacements: successReplacements,
      });
    }
    if (failures.length > 0) {
      failedLog.push({
        docName: docFile.name,
        docId: docFile.id,
        path: docFile.path,
        failures,
      });
    }
    if (modified) modifiedPaths.push(docFile.path);
  }

  await flushIssues();

  // ---- Persist any name-fallback resolutions back to id-map.json + id-map-detailed.json ----
  if (ctx.fallbackResolutions.size > 0) {
    try {
      await fs.writeFile(ID_MAP_PATH, JSON.stringify(idMap, null, 2), 'utf8');
      console.log(
        `💾 Added ${ctx.fallbackResolutions.size} name-resolved entries to id-map.json`,
      );
    } catch (err) {
      console.warn(`[warn] could not update id-map.json: ${err?.message ?? err}`);
    }

    // Append the new resolutions to id-map-detailed.json (best-effort).
    try {
      let detailed = [];
      try {
        const raw = await fs.readFile(ID_MAP_DETAILED_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) detailed = parsed;
      } catch { }
      const knownPairs = new Set(detailed.map((d) => `${d.oldId}->${d.newId}`));
      for (const [oldId, info] of ctx.fallbackMeta) {
        const key = `${oldId}->${info.newId}`;
        if (knownPairs.has(key)) continue;
        detailed.push({
          oldId,
          newId: info.newId,
          name: info.name,
          oldUrl: viewerUrlForMime(oldId, info.mimeType),
          newUrl: viewerUrlForMime(info.newId, info.mimeType),
          resolvedBy: 'name-fallback',
        });
      }
      await fs.writeFile(
        ID_MAP_DETAILED_PATH,
        JSON.stringify(detailed, null, 2),
        'utf8',
      );
    } catch (err) {
      console.warn(
        `[warn] could not update id-map-detailed.json: ${err?.message ?? err}`,
      );
    }
  }

  const summary = {
    totalDocsScanned: allDocs.length,
    docsWithCandidateLinks: docsWithLinksLog.length,
    docsModified: modifiedPaths.length,
    totalLinksFound,
    totalReplaced,
    totalResolvedByNameFallback: totalResolvedByName,
    totalFailed,
    ambiguousOldIds: [...ctx.ambiguousOldIds],
  };

  await fs.writeFile(
    path.join(runLogsDir, 'success.json'),
    JSON.stringify(successLog, null, 2),
    'utf8',
  );
  await fs.writeFile(
    path.join(runLogsDir, 'failed.json'),
    JSON.stringify(failedLog, null, 2),
    'utf8',
  );
  await fs.writeFile(
    path.join(runLogsDir, 'summary.json'),
    JSON.stringify(summary, null, 2),
    'utf8',
  );
  await fs.writeFile(
    path.join(runLogsDir, 'docs-with-links.json'),
    JSON.stringify(docsWithLinksLog, null, 2),
    'utf8',
  );

  console.log('');
  console.log(`✅ Docs Modified:           ${summary.docsModified}`);
  console.log(`📄 Total Docs Scanned:      ${summary.totalDocsScanned}`);
  console.log(
    `🔗 Docs w/ link candidates: ${summary.docsWithCandidateLinks}  (docs-with-links.json)`,
  );
  console.log(`🔗 Total Links Found:       ${summary.totalLinksFound}`);
  console.log(`✔️  Replaced:                ${summary.totalReplaced}`);
  console.log(`   ↳ via id-map:            ${summary.totalReplaced - summary.totalResolvedByNameFallback}`);
  console.log(`   ↳ via name fallback:     ${summary.totalResolvedByNameFallback}`);
  console.log(`❌ Failed:                  ${summary.totalFailed}`);
  if (summary.ambiguousOldIds.length > 0) {
    const rel = path.relative(process.cwd(), path.join(runLogsDir, 'summary.json'));
    console.log(
      `⚠️  Ambiguous (multiple same-name targets): ${summary.ambiguousOldIds.length} — see ${rel || 'summary.json'}`,
    );
  }

  if (modifiedPaths.length > 0) {
    console.log('\nChanged Files:');
    for (const p of modifiedPaths) console.log(`- ${p}`);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err.response?.data ?? err);
    process.exit(1);
  });
}