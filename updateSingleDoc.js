/**
 * Update Drive links in one Google Doc (no folder scan).
 * Usage: node updateSingleDoc.js <Google Docs URL>
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { google } from 'googleapis';
import dotenv from 'dotenv';
import {
  authorize,
  extractDriveId,
  listTarget,
  loadOrBuildIdMap,
  processDoc,
} from './updateDocLinks.js';

dotenv.config();

const DOC_MIME = 'application/vnd.google-apps.document';
const SOURCE_FOLDER_ID = process.env.SOURCE_FOLDER_ID;
const TARGET_FOLDER_ID = process.env.TARGET_FOLDER_ID;

async function main() {
  const url = process.argv[2];
  if (!url?.trim()) {
    console.error('Usage: node updateSingleDoc.js <Google Docs URL>');
    process.exit(1);
  }

  const docId = extractDriveId(url.trim());
  if (!docId) {
    console.error('Could not extract document id from URL');
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

  let meta;
  try {
    const res = await drive.files.get({
      fileId: docId,
      fields: 'id, name, mimeType',
      supportsAllDrives: true,
    });
    meta = res.data;
  } catch (err) {
    console.error(`Drive files.get failed: ${err?.message ?? err}`);
    process.exit(1);
  }

  if (meta.mimeType !== DOC_MIME) {
    console.error(`Not a Google Doc (mime: ${meta.mimeType})`);
    process.exit(1);
  }

  const fileEntry = {
    id: meta.id,
    name: meta.name || docId,
    path: meta.name || docId,
  };

  let targetIdSet;
  let sourceIdSet = new Set();
  if (TARGET_FOLDER_ID) {
    const { allItems } = await listTarget(drive, TARGET_FOLDER_ID);
    targetIdSet = new Set(allItems.map((i) => i.id));
  }
  if (SOURCE_FOLDER_ID) {
    const { allItems: srcItems } = await listTarget(drive, SOURCE_FOLDER_ID);
    sourceIdSet = new Set(srcItems.map((i) => i.id));
  }

  const ctx = {
    idMap,
    targetNameIndex: new Map(),
    targetIdSet,
    sourceIdSet,
    oldIdMetaCache: new Map(),
    fallbackResolutions: new Map(),
    fallbackMeta: new Map(),
    ambiguousOldIds: new Set(),
  };

  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.join(process.cwd(), 'logs', `run-${runId}`);
  await fs.mkdir(runDir, { recursive: true });

  const successLog = [];
  const failedLog = [];
  let totalReplaced = 0;
  let totalFailed = 0;
  let totalResolvedByName = 0;
  let totalLinksFound = 0;
  let modified = false;

  try {
    const { successReplacements, failures, modified: didModify } = await processDoc(
      docs,
      drive,
      fileEntry,
      ctx,
    );
    modified = didModify;
    totalReplaced = successReplacements.length;
    totalFailed = failures.length;
    totalLinksFound = totalReplaced + totalFailed;
    for (const r of successReplacements) {
      if (r.matchedBy === 'name-fallback') totalResolvedByName += 1;
    }
    if (totalReplaced > 0) {
      successLog.push({
        docName: fileEntry.name,
        docId: fileEntry.id,
        path: fileEntry.path,
        replacements: successReplacements,
      });
    }
    if (totalFailed > 0) {
      failedLog.push({
        docName: fileEntry.name,
        docId: fileEntry.id,
        path: fileEntry.path,
        failures,
      });
    }
  } catch (err) {
    failedLog.push({
      docName: fileEntry.name,
      docId: fileEntry.id,
      path: fileEntry.path,
      failures: [
        {
          url: '',
          reason: 'PROCESSING_ERROR',
          paragraphIndex: -1,
          textSnippet: String(err?.message ?? err),
        },
      ],
    });
    totalFailed = 1;
  }

  const summary = {
    totalDocsScanned: 1,
    docsModified: modified ? 1 : 0,
    totalLinksFound,
    totalReplaced,
    totalResolvedByNameFallback: totalResolvedByName,
    totalFailed,
    ambiguousOldIds: [...ctx.ambiguousOldIds],
    docId: fileEntry.id,
    docName: fileEntry.name,
  };

  await fs.writeFile(
    path.join(runDir, 'success.json'),
    JSON.stringify(successLog, null, 2),
    'utf8',
  );
  await fs.writeFile(
    path.join(runDir, 'failed.json'),
    JSON.stringify(failedLog, null, 2),
    'utf8',
  );
  await fs.writeFile(
    path.join(runDir, 'summary.json'),
    JSON.stringify(summary, null, 2),
    'utf8',
  );

  console.log(`Replaced: ${totalReplaced}, Failed: ${totalFailed}`);
}

const isDirectRun =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  main().catch((err) => {
    console.error(err.response?.data ?? err);
    process.exit(1);
  });
}
