/**
 * Rewrite old Drive links across EVERY supported file type in the target tree.
 *
 * Handles four formats, in two very different ways:
 *
 *   NATIVE (edited in place through Google APIs)
 *     • Google Docs    — hyperlinks, plain-text URLs, and smart chips (which
 *                        become ordinary hyperlinks labelled with the file
 *                        name). Body, tables, headers, footers and footnotes.
 *     • Google Sheets  — ALL tabs. Rewrites =HYPERLINK() formulas, rich-text
 *                        run links, cell-level text links, plain URLs, and
 *                        smart chips (also converted to name-labelled links).
 *
 *   OOXML (downloaded, rewritten, re-uploaded as a new revision)
 *     • .docx  • .xlsx — Office files are zipped XML. Google has no API to edit
 *                        their contents, so each is downloaded, every XML and
 *                        .rels part is rewritten, and the rebuilt file is
 *                        uploaded as a NEW REVISION of the same Drive file.
 *                        Drive keeps version history, so a bad run is
 *                        revertable from "Manage versions".
 *
 * All four share one source of truth: id-map.json (old Drive id -> new Drive id).
 * It is REBUILT FROM SCRATCH on every run — the old file is deleted first and a
 * fresh one written by path-matching the source and target trees. A map carried
 * over between runs is the single most dangerous input this script can have: it
 * still resolves, but its values name files an earlier migration created and
 * later replaced, so every "fixed" link silently points at a deleted file.
 * Deriving it fresh each time removes that failure mode entirely.
 *
 * REQUIREMENTS
 *   npm install jszip
 *   .env: SOURCE_FOLDER_ID and TARGET_FOLDER_ID (both required — the map is
 *         rebuilt every run, which needs both trees)
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
  createStatusPrinter,
  docsCall,
  driveCall,
  formatDuration,
  isMainModule,
  runPool,
  DOC_CONCURRENCY,
  LOG_INTERVAL_MS,
  VERBOSE,
} from './driveUtils.js';
import { buildIdMap } from './buildIdMap.js';

/* ------------------------------------------------------------------ config */

const TARGET_FOLDER_ID = process.env.TARGET_FOLDER_ID;
const SOURCE_FOLDER_ID = process.env.SOURCE_FOLDER_ID;
const LOGS_BASE_DIR = path.join(process.cwd(), 'logs');
const ID_MAP_PATH = process.env.ID_MAP_PATH || path.join(process.cwd(), 'id-map.json');

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

/* -------------------------------------------------------------------- auth */

const CREDENTIALS_PATH =
  process.env.GOOGLE_OAUTH_CREDENTIALS || path.join(process.cwd(), 'credentials.json');
const TOKEN_PATH =
  process.env.GOOGLE_OAUTH_TOKEN || path.join(process.cwd(), 'token.json');

async function authorize() {
  const credentials = JSON.parse(await fs.readFile(CREDENTIALS_PATH, 'utf8'));
  const { client_id, client_secret, redirect_uris } =
    credentials.installed || credentials.web;
  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    (redirect_uris && redirect_uris[0]) || 'http://localhost',
  );
  oAuth2Client.setCredentials(JSON.parse(await fs.readFile(TOKEN_PATH, 'utf8')));
  return oAuth2Client;
}

/** First id-looking token in a Drive URL: /d/<id>, ?id=<id>, or /folders/<id>. */
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

/* ----------------------------------------------------------- Google Docs */

/**
 * Docs edits are index-based, and any edit that changes the document length
 * invalidates every index after it. processDoc therefore splits edits in two:
 *
 *   non-shifting  updateTextStyle to retarget an existing hyperlink. The text
 *                 is untouched, so all indices from the walk stay valid.
 *   shifting      smart chips (which have no mutable URI, so they are deleted
 *                 and re-inserted as hyperlinked text) and runs whose visible
 *                 text contains an old URL.
 *
 * Non-shifting edits go first, in one batch, against the walked indices.
 * Shifting edits then go in a single batch sorted highest-index-first, so each
 * one only moves text that later requests do not refer to. Splitting shifting
 * edits across batches computed from the same snapshot silently shreds the
 * document — that bug is what this ordering exists to prevent.
 */

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
 * from them must carry it too.
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
  return cleaned.length <= maxLen ? cleaned : cleaned.slice(0, maxLen - 1) + '…';
}

/**
 * Anchor text to give a smart chip once it becomes a plain hyperlink.
 *
 * Preference order:
 *   1. the TARGET file's current name — authoritative, since that is the file
 *      the rewritten link actually points at;
 *   2. the chip's own title — the source file's name as Docs last rendered it,
 *      used when the target is outside the scanned tree;
 *   3. the URL — last resort, so a chip is never turned into an empty link.
 *
 * Names for everything inside the target tree come from the listing already in
 * hand, so the common case costs no API call. Anything else is fetched once and
 * cached; concurrent docs referencing the same chip share one lookup.
 */
async function chipDisplayText(drive, newId, props, fallbackUrl, ctx) {
  const fromListing = ctx.targetNameById?.get(newId);
  if (fromListing) return fromListing;

  const title = (props.title || '').trim();
  if (title) return title;

  if (!drive) return fallbackUrl;

  ctx.newIdNameCache ??= new Map();
  if (!ctx.newIdNameCache.has(newId)) {
    ctx.newIdNameCache.set(
      newId,
      driveCall('read', `files.get(name) ${newId}`, () =>
        drive.files.get({ fileId: newId, fields: 'name', supportsAllDrives: true }),
      )
        .then((res) => res.data.name || null)
        .catch(() => null),
    );
  }
  return (await ctx.newIdNameCache.get(newId)) || fallbackUrl;
}

/**
 * Resolve an old Drive id to its replacement.
 *
 * The map is rebuilt every run, so it is authoritative; the remaining cases are
 * ids the map has nothing to say about. An id already living in the target is
 * treated as correct (that is what makes re-runs no-ops), and an id still in
 * the source tree is left alone rather than guessed at.
 *
 * @returns {Promise<{newId: string, source: string} | null>} null = unresolvable
 */
async function resolveOldId(drive, oldId, ctx) {
  if (!oldId) return null;
  if (ctx.idMap[oldId]) return { newId: ctx.idMap[oldId], source: 'id-map' };
  if (ctx.targetIdSet?.has(oldId)) return { newId: oldId, source: 'already-in-target' };
  if (ctx.sourceIdSet?.has(oldId)) return { newId: oldId, source: 'already-in-source' };
  return null;
}

export async function processDoc(docs, drive, fileEntry, ctx) {
  const docResp = await docsCall(`docs.get ${fileEntry.name}`, () =>
    docs.documents.get({ documentId: fileEntry.id }),
  );
  const doc = docResp.data;
  const dryRun = Boolean(ctx.dryRun);

  /**
   * NON-SHIFTING edits: { segmentId, startIndex, endIndex, url }
   * updateTextStyle only — the visible text never changes.
   */
  const retargets = [];

  /**
   * SHIFTING edits: { segmentId, startIndex, endIndex, text, style, fields }
   * delete → insert → restyle, applied highest-index-first.
   */
  const rewrites = [];

  const successReplacements = [];
  const failures = [];

  /**
   * Links that already point at the right file. Neither a failure nor a
   * replacement: emitting an edit would rewrite a URL to itself, burn a
   * revision, and report "N links replaced" on a run that changed nothing.
   */
  let alreadyCorrect = 0;

  const isRewritable = (resolved, oldId) =>
    resolved &&
    resolved.source !== 'already-in-source' &&
    (resolved.newId !== oldId || resolved.source === 'already-in-target');

  for (const { paragraph, paragraphIndex, segmentId } of walkDocument(doc)) {
    const elements = paragraph.elements || [];
    const snippet = snippetFromText(
      elements
        .map((e) => e.textRun?.content || e.richLink?.richLinkProperties?.title || '')
        .join(''),
    );

    for (const el of elements) {
      // ---- Smart chips (richLink) ----
      if (el.richLink) {
        const props = el.richLink.richLinkProperties || {};
        const uri = props.uri;
        if (!uri || !isDocsOrDriveUrl(uri)) continue; // e.g. a YouTube chip

        const oldId = extractDriveId(uri);
        const resolved = await resolveOldId(drive, oldId, ctx);
        if (!resolved) {
          failures.push({ url: uri, reason: 'MISSING_IN_ID_MAP', paragraphIndex, textSnippet: snippet });
          continue;
        }
        if (!isRewritable(resolved, oldId)) continue;

        const newUrl = replaceIdInUrl(uri, oldId, resolved.newId);
        if (newUrl === uri) {
          alreadyCorrect += 1; // chip already points into the target
          continue;
        }

        // The chip becomes a normal hyperlink labelled with the file's name, so
        // the paragraph still reads as prose instead of a wall of URL.
        const displayText = await chipDisplayText(drive, resolved.newId, props, newUrl, ctx);

        // A chip is one index unit; it becomes a URL-length string, so this
        // always lengthens the segment — strictly a shifting edit.
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
        continue;
      }

      if (el.person) continue; // person chips carry no doc URL
      if (!el.textRun) continue;

      const tr = el.textRun;
      const content = tr.content || '';
      const linkUrl = tr.textStyle?.link?.url;

      // ---- The run's hyperlink target (where the text points) ----
      let newLinkUrl = null;
      if (linkUrl && isDocsOrDriveUrl(linkUrl)) {
        const oldId = extractDriveId(linkUrl);
        const resolved = await resolveOldId(drive, oldId, ctx);
        if (!resolved) {
          failures.push({ url: linkUrl, reason: 'MISSING_IN_ID_MAP', paragraphIndex, textSnippet: snippet });
        } else if (isRewritable(resolved, oldId)) {
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
      // Other domains are out of scope and left alone.

      // ---- Drive URLs sitting in the run's VISIBLE TEXT ----
      // A URL that is also the run's link target was already resolved and
      // logged above; reuse that result rather than reporting it twice.
      let newContent = content;
      for (const url of content.match(GOOGLE_URL_REGEX) || []) {
        let newUrl;
        if (linkUrl && url === linkUrl) {
          newUrl = newLinkUrl;
        } else {
          const oldId = extractDriveId(url);
          const resolved = await resolveOldId(drive, oldId, ctx);
          if (!resolved) {
            failures.push({ url, reason: 'MISSING_IN_ID_MAP', paragraphIndex, textSnippet: snippet });
            continue;
          }
          if (!isRewritable(resolved, oldId)) continue;
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
        // The text itself has to change: delete → insert → restyle. The whole
        // run is replaced in one edit, which keeps every shifting edit on a
        // disjoint range and makes the descending-order pass below sound.
        let startIndex = el.startIndex;
        let endIndex = el.endIndex;
        let text = newContent;

        // A run that ends a paragraph includes the paragraph mark. Deleting it
        // merges this paragraph into the next, so keep it out of the range.
        if (content.endsWith('\n')) {
          endIndex -= 1;
          text = text.slice(0, -1);
        }

        if (endIndex > startIndex && text.length > 0) {
          // insertText inherits formatting from the preceding character, so the
          // run's own style is captured and re-applied over the inserted range —
          // otherwise bold/size/colour would be lost on every rewrite.
          const style = { ...(tr.textStyle || {}) };
          const finalLink = newLinkUrl || linkUrl;
          if (finalLink) style.link = { url: finalLink };
          else delete style.link;
          const fields = [...new Set([...Object.keys(style), 'link'])].join(',');

          rewrites.push({ segmentId, startIndex, endIndex, text, style, fields });
        }
      } else if (newLinkUrl) {
        // Text unchanged — only the link target moves. updateTextStyle does that
        // without touching a character, so it neither loses the anchor text nor
        // shifts any index.
        let endIndex = el.endIndex;
        if (content.endsWith('\n')) endIndex -= 1;
        if (endIndex > el.startIndex) {
          retargets.push({ segmentId, startIndex: el.startIndex, endIndex, url: newLinkUrl });
        }
      }
    }
  }

  const modified = retargets.length > 0 || rewrites.length > 0;
  if (dryRun) return { successReplacements, failures, modified, alreadyCorrect };

  // ---- Batch 1: retargets (non-shifting) ----
  // Must go FIRST, while the document still matches what the walk saw.
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
  // Requests inside one batchUpdate apply in array order, and an edit only moves
  // indices AFTER it. Sorting descending (within each segment, since indices are
  // per-segment) keeps every later request pointing at the character it was
  // computed from — no re-fetch, no arithmetic.
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

  return { successReplacements, failures, modified, alreadyCorrect };
}

/* --------------------------------------------------------- Google Sheets */

/** The literal text a cell displays, which is what chip runs index into. */
function uevText(cell) {
  return cell.userEnteredValue?.stringValue ?? cell.formattedValue ?? '';
}

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
 *   5. SMART CHIPS                   -> chipRuns[].chip.richLinkProperties.uri
 *
 * (5) is the one that hides: a chip's URL lives in `chipRuns`, a field that is
 * not returned unless the mask asks for it, so a scan that omits it reports a
 * clean sheet while every chip still points at the source file. Chips are
 * converted to ordinary rich-text hyperlinks labelled with the file name —
 * the same treatment Docs chips get.
 *
 * The read is scoped with a field mask so we don't pull entire grids of
 * unrelated formatting back over the wire.
 */
export async function processSheet(sheetsApi, fileEntry, resolve, nameById = new Map()) {
  const changes = [];
  const unresolved = [];

  const res = await driveCall('read', `sheets.get ${fileEntry.name}`, () =>
    sheetsApi.spreadsheets.get({
      spreadsheetId: fileEntry.id,
      includeGridData: true,
      fields:
        'sheets(properties(sheetId,title),data(startRow,startColumn,rowData(values(' +
        'userEnteredValue,chipRuns,textFormatRuns,userEnteredFormat.textFormat.link))))',
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

          // --- 5: smart chips -> rich-text hyperlinks labelled by file name ---
          // Handled first and, when it fires, exclusively: it rewrites the
          // cell's text and runs wholesale, so letting the text-based cases
          // below also touch this cell would fight over the same fields.
          const chipRuns = cell.chipRuns;
          if (Array.isArray(chipRuns) && chipRuns.length) {
            const text = typeof uevText(cell) === 'string' ? uevText(cell) : '';

            // chipRuns are positional: run i covers [start_i, start_{i+1}).
            const segments = chipRuns.map((run, i) => ({
              start: run.startIndex ?? 0,
              end: i + 1 < chipRuns.length ? (chipRuns[i + 1].startIndex ?? 0) : text.length,
              chip: run.chip,
            }));

            let convertible = false; // at least one chip actually needs rewriting
            let blocked = false;     // something in this cell must not be disturbed

            for (const seg of segments) {
              if (!seg.chip) continue; // plain text between chips
              const uri = seg.chip.richLinkProperties?.uri;
              if (!uri) {
                // A person chip (or any other non-link chip). chipRuns can only
                // be cleared for the whole cell, so converting here would
                // destroy it — leave the cell alone entirely.
                blocked = true;
                break;
              }
              if (!isDocsOrDriveUrl(uri)) continue; // e.g. a YouTube chip
              const r = resolve(uri);
              if (r?.unresolved) {
                // Never half-convert: dropping chipRuns would strip this chip
                // of its link without being able to repoint it.
                unresolved.push({ where, kind: 'chip', url: uri, oldId: r.oldId, reason: r.reason });
                blocked = true;
                break;
              }
              if (r) {
                seg.newUrl = r.newUrl;
                seg.newId = r.newId;
                convertible = true;
              }
            }

            if (blocked || !convertible) return;

            // Character formatting already on the cell is carried across, so
            // converting a chip does not silently drop bold/size/colour on the
            // text around it.
            const existingRuns = Array.isArray(cell.textFormatRuns) ? cell.textFormatRuns : [];
            const formatAt = (idx) => {
              let fmt = {};
              for (const r of existingRuns) {
                if ((r.startIndex ?? 0) <= idx) fmt = r.format ?? {};
                else break;
              }
              return fmt;
            };

            // Rebuild the cell text and the run boundaries together, because a
            // chip's label may change length when it takes the target file's
            // current name.
            let newText = '';
            const runs = [];
            for (const seg of segments) {
              const original = text.slice(seg.start, seg.end);
              const url = seg.newUrl ?? seg.chip?.richLinkProperties?.uri ?? null;
              // Prefer the target file's live name; fall back to the chip's own
              // rendered text so the cell never ends up blank.
              const label = seg.chip
                ? (seg.newId && nameById.get(seg.newId)) || original || url || ''
                : original;

              // A chip run list often ends with a zero-width trailing segment
              // (startIndex === text.length). Emitting a run for it is rejected:
              // a TextFormatRun must start strictly inside the string.
              if (!label) continue;

              const run = { startIndex: newText.length, format: { ...formatAt(seg.start) } };
              if (seg.chip && url) run.format.link = { uri: url };
              else delete run.format.link;
              if (run.startIndex === 0) delete run.startIndex; // first run implies 0
              runs.push(run);

              newText += label;
              if (seg.chip && url) {
                changes.push({
                  where,
                  kind: 'chip',
                  from: seg.chip.richLinkProperties.uri,
                  to: url,
                  displayText: label,
                });
              }
            }

            if (!newText || !runs.length) return; // nothing renderable left

            requests.push({
              updateCells: {
                start: { sheetId, rowIndex, columnIndex: colIndex },
                rows: [{ values: [{ userEnteredValue: { stringValue: newText }, textFormatRuns: runs }] }],
                // chipRuns is listed but absent from the payload, which is how
                // updateCells clears it — the chips become plain linked text.
                fields: 'userEnteredValue,textFormatRuns,chipRuns',
              },
            });
            return;
          }

          // --- 1 & 2: formula or plain string content ---
          // These go inside userEnteredValue, not at the top of CellData —
          // a bare {stringValue} is rejected as "Unknown name" and takes the
          // whole (atomic) batch down with it.
          const uev = cell.userEnteredValue ?? {};
          if (typeof uev.formulaValue === 'string') {
            const r = rewriteUrlsInText(uev.formulaValue, resolve);
            if (r.changes.length) {
              newValue.userEnteredValue = { formulaValue: r.text };
              fieldsTouched.push('userEnteredValue');
              cellChanged = true;
              r.changes.forEach((c) => changes.push({ where, kind: 'formula', ...c }));
            }
            r.unresolved.forEach((u) => unresolved.push({ where, ...u }));
          } else if (typeof uev.stringValue === 'string') {
            const r = rewriteUrlsInText(uev.stringValue, resolve);
            if (r.changes.length) {
              newValue.userEnteredValue = { stringValue: r.text };
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
  if (!TARGET_FOLDER_ID || !SOURCE_FOLDER_ID) {
    console.error(
      'Both SOURCE_FOLDER_ID and TARGET_FOLDER_ID must be set in .env.\n' +
        'The id-map is rebuilt from scratch on every run, which needs both trees.',
    );
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

  /**
   * The id-map is DERIVED DATA, rebuilt from the two live trees on every run.
   *
   * The old file is deleted before the build rather than overwritten, so a build
   * that fails partway leaves no map at all instead of a stale one that would
   * still resolve — and would resolve to files that no longer exist. Losing it
   * costs nothing: the next run rebuilds it anyway.
   */
  console.log('\nRebuilding id-map from SOURCE/TARGET…');
  await fs.rm(ID_MAP_PATH, { force: true });

  const built = await buildIdMap(drive, {
    sourceFolderId: SOURCE_FOLDER_ID,
    targetFolderId: TARGET_FOLDER_ID,
    outputPath: ID_MAP_PATH,
    write: true,
  });
  const idMap = built.idMap;

  // The build already walked the target tree; reuse that listing instead of
  // paying for a second identical walk.
  const allItems = built.targetItems;

  // Belt and braces: the map was just derived from this listing, so a value
  // outside it means the walk was incomplete (a folder that failed to list).
  // Writing links from a partial map is the failure this whole design avoids.
  const knownIds = new Set(allItems.map((i) => i.id));
  knownIds.add(TARGET_FOLDER_ID); // the root is never listed as its own child
  const stale = Object.entries(idMap).filter(([, newId]) => !knownIds.has(newId));
  if (stale.length > 0) {
    console.error(
      `\n${stale.length}/${Object.keys(idMap).length} freshly built id-map entries point at ids ` +
        'that are not in the target tree.\nThe target scan was incomplete — aborting before any write.',
    );
    for (const [oldId, newId] of stale.slice(0, 10)) {
      console.error(`    ${oldId}  ->  ${newId}   (missing)`);
    }
    process.exit(1);
  }
  console.log(`id-map:  ${Object.keys(idMap).length} entries, all verified present`);

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
  // id -> name across the target tree. Used to label a converted smart chip
  // (Docs or Sheets) with the name of the file it actually points at.
  const targetNameById = new Map(allItems.map((i) => [i.id, i.name]));
  const resolve = makeResolver(idMap, targetIds);

  /** Shared context handed to processDoc for every target doc. */
  const docCtx = {
    dryRun: DRY_RUN,
    idMap,
    targetIdSet: targetIds,
    targetNameById,
    sourceIdSet: null,
  };

  const changesLog = [];
  const failuresLog = [];

  /** Live counters, rendered by the status block and reused in the final report. */
  const stats = {
    processed: 0,
    modified: 0,
    unchanged: 0,
    linksReplaced: 0,
    linksUnresolved: 0,
    errors: 0,
    byKind: { docs: 0, sheets: 0, docx: 0, xlsx: 0 },
  };
  const ctl = { aborted: false, inFlight: new Set() };
  const startedAt = Date.now();

  // Same two-line status block style as index.js, on the same LOG_INTERVAL_MS.
  const status = createStatusPrinter(() => {
    const elapsed = Date.now() - startedAt;
    const rate = stats.processed / Math.max(1, elapsed / 1000);
    const remaining = Math.max(0, targets.length - stats.processed);
    const pct = targets.length ? (stats.processed / targets.length) * 100 : 0;

    const l1 = [
      `[progress] ${stats.processed}/${targets.length} (${pct.toFixed(1)}%)`,
      `${stats.modified} modified`,
      `${stats.unchanged} unchanged`,
      `${stats.linksReplaced} links replaced`,
    ];
    if (stats.linksUnresolved) l1.push(`${stats.linksUnresolved} unresolved`);
    if (stats.errors) l1.push(`${stats.errors} errors`);
    l1.push(
      `${rate.toFixed(1)} files/s`,
      `elapsed ${formatDuration(elapsed)}`,
      `ETA ${rate > 0 ? formatDuration((remaining / rate) * 1000) : '--:--:--'}`,
    );

    const l2 = [
      `[types]    docs ${stats.byKind.docs}`,
      `sheets ${stats.byKind.sheets}`,
      `docx ${stats.byKind.docx}`,
      `xlsx ${stats.byKind.xlsx}`,
    ];
    const active = [...ctl.inFlight].slice(0, 2).join(', ');
    if (active) l2.push(`| now: ${active}`);

    return [l1.join(', '), l2.join(', ')];
  });

  // Ctrl+C finishes in-flight files rather than truncating a half-written
  // upload — the same graceful-abort contract index.js uses.
  const onInterrupt = () => {
    if (ctl.aborted) return;
    ctl.aborted = true;
    console.log('\n[abort] Finishing in-flight files… (Ctrl+C again to force quit)');
  };
  process.on('SIGINT', onInterrupt);

  console.log(`Status printed every ${LOG_INTERVAL_MS}ms.\n`);
  status.start();

  await runPool(targets, DOC_CONCURRENCY, async (file) => {
    const kind = KIND_BY_MIME[file.mimeType];
    if (ctl.aborted) return;
    ctl.inFlight.add(file.name);
    try {
      let result;
      if (kind === 'docs') {
        // processDoc honours ctx.dryRun: it still walks and reports, but sends
        // no batchUpdate, so a dry run covers Docs like every other type.
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
      } else if (kind === 'sheets') {
        result = await processSheet(sheetsApi, file, resolve, targetNameById);
      } else {
        result = await processOoxml(drive, file, resolve);
      }

      if (result.modified) {
        stats.modified += 1;
        stats.byKind[kind] += 1;
        if (VERBOSE) {
          console.log(`  [${kind}] ${file.name}: ${result.changes.length} link(s) updated`);
        }
      } else {
        stats.unchanged += 1;
      }
      stats.linksReplaced += result.changes.length;
      stats.linksUnresolved += result.unresolved.length;

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
      stats.errors += 1;
      console.warn(`  ! [${kind}] ${file.name}: ${err?.message ?? err}`);
    } finally {
      stats.processed += 1;
      ctl.inFlight.delete(file.name);
    }
  });

  status.stop();
  process.off('SIGINT', onInterrupt);

  /* ---- logs ---- */
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(LOGS_BASE_DIR, `linkfix-${stamp}`);
  await fs.mkdir(dir, { recursive: true });

  const totalChanges = changesLog.reduce((n, f) => n + f.changes.length, 0);
  const elapsedMs = Date.now() - startedAt;
  const summary = {
    ranAt: new Date().toISOString(),
    runId: RUN_ID,
    dryRun: DRY_RUN,
    aborted: ctl.aborted,
    types: enabled,
    elapsedMs,
    filesScanned: targets.length,
    filesProcessed: stats.processed,
    filesByType: byKind,
    filesModified: stats.modified,
    filesUnchanged: stats.unchanged,
    modifiedByType: stats.byKind,
    linksReplaced: totalChanges,
    linksUnresolved: stats.linksUnresolved,
    fileErrors: stats.errors,
    filesWithUnresolved: failuresLog.length,
    errorsLogged: linkErrorCount,
    errorLog: path.relative(process.cwd(), LINK_ERROR_LOG),
  };

  await fs.writeFile(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
  await fs.writeFile(path.join(dir, 'changes.json'), JSON.stringify(changesLog, null, 2));
  await fs.writeFile(path.join(dir, 'failures.json'), JSON.stringify(failuresLog, null, 2));

  // Every queued append must hit disk before we report or exit.
  await errorWriteChain;

  console.log(ctl.aborted ? '\nInterrupted.' : '\nDone.');
  console.log(`  Mode:             ${DRY_RUN ? 'DRY RUN (nothing written)' : 'APPLY'}`);
  console.log(`  Elapsed:          ${formatDuration(elapsedMs)}`);
  console.log(`  Files scanned:    ${targets.length}`);
  console.log(`  Files processed:  ${stats.processed}`);
  console.log(`  Files modified:   ${stats.modified}`);
  console.log(`  Files unchanged:  ${stats.unchanged}`);
  console.log(
    `    by type:        docs ${stats.byKind.docs}, sheets ${stats.byKind.sheets}, ` +
      `docx ${stats.byKind.docx}, xlsx ${stats.byKind.xlsx}`,
  );
  console.log(`  Links replaced:   ${totalChanges}`);
  if (stats.linksUnresolved) {
    console.log(
      `  Links unresolved: ${stats.linksUnresolved} (id not in id-map — left untouched)`,
    );
  }
  if (stats.errors) {
    console.log(`  File errors:      ${stats.errors}`);
  }
  console.log(`  Run logs:         ${path.relative(process.cwd(), dir)}`);
  if (linkErrorCount > 0) {
    console.log(
      `  Error log:        ${path.relative(process.cwd(), LINK_ERROR_LOG)} (+${linkErrorCount} line(s))`,
    );
  }

  if (DRY_RUN) {
    console.log('\nDRY RUN — nothing was written. Re-run without --dry-run to apply.');
  } else if (stats.byKind.docx || stats.byKind.xlsx) {
    console.log('\n.docx/.xlsx changes were uploaded as new revisions —');
    console.log('revert from Drive → right-click file → Manage versions.');
  }

  if (ctl.aborted) process.exitCode = 130;
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error('\nFatal:', err?.message ?? err);
    process.exit(1);
  });
}