/**
 * Copy a single Drive file (by id) into a target folder.
 *
 * Standalone: no dependency on driveUtils.js. Edit the constants below and run:
 *   node copyFileById.js
 *
 * Uses the same OAuth setup as the rest of the toolkit (credentials.json +
 * token.json in the working directory).
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { google } from 'googleapis';

// ---- Config ----
const FILE_ID = '1_9sPOhdKfZzTIlD1d-0rZ6DGCy2wqfpx';
const TARGET_FOLDER_ID = '1EIF8TEOX9vpsFqOh2fLz_9KLfTChJ-Pz';
// Name for the copy. Leave empty ('') to keep the original file's name.
const NEW_NAME = '';
// When true, skip the copy if a file with the same name already exists in the target folder.
const SKIP_IF_EXISTS = true;
// When true, Excel files (.xlsx/.xls) are converted to a native Google Sheet while copying.
// Needed for xlsx files that were exported *from* Google Sheets: the export freezes
// Google-only formulas (GOOGLEFINANCE, UNIQUE/FILTER arrays, ...) as
// __xludf.DUMMYFUNCTION placeholders with stale values. Importing into Google Sheets
// restores the original live formulas; a byte-for-byte copy cannot.
const CONVERT_EXCEL_TO_GOOGLE_SHEETS = true;
// After converting, rewrite formulas that relied on Excel's implicit intersection
// (e.g. XLOOKUP(B:B, ...) meaning "this row's B") so they keep working in Sheets.
const FIX_IMPLICIT_INTERSECTION = true;

const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');
const TOKEN_PATH = path.join(process.cwd(), 'token.json');

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHEETS_MIME = 'application/vnd.google-apps.spreadsheet';
const EXCEL_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
]);

// ---- Auth ----
async function authorize() {
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

async function findExistingByName(drive, parentId, name) {
  const safeName = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const res = await drive.files.list({
    q: `'${parentId}' in parents and trashed = false and name = '${safeName}'`,
    fields: 'files(id, name, mimeType)',
    pageSize: 10,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return res.data.files ?? [];
}

async function main() {
  if (FILE_ID.startsWith('PUT_') || TARGET_FOLDER_ID.startsWith('PUT_')) {
    throw new Error('Set FILE_ID and TARGET_FOLDER_ID at the top of copyFileById.js');
  }

  const auth = await authorize();
  const drive = google.drive({ version: 'v3', auth });

  const { data: source } = await drive.files.get({
    fileId: FILE_ID,
    fields: 'id, name, mimeType, size',
    supportsAllDrives: true,
  });
  if (source.mimeType === FOLDER_MIME) {
    throw new Error(`"${source.name}" (${FILE_ID}) is a folder; this script copies files only.`);
  }

  const { data: target } = await drive.files.get({
    fileId: TARGET_FOLDER_ID,
    fields: 'id, name, mimeType',
    supportsAllDrives: true,
  });
  if (target.mimeType !== FOLDER_MIME) {
    throw new Error(`Target ${TARGET_FOLDER_ID} ("${target.name}") is not a folder.`);
  }

  const convert = CONVERT_EXCEL_TO_GOOGLE_SHEETS && EXCEL_MIMES.has(source.mimeType);
  // A converted copy is a Google Sheet, so drop the now-misleading .xlsx/.xls extension.
  const name = NEW_NAME || (convert ? source.name.replace(/\.xlsx?$/i, '') : source.name);
  console.log(`Source: ${source.name} (${source.id})`);
  console.log(`Target: ${target.name} (${target.id})`);
  if (convert) console.log('Mode:   converting Excel -> Google Sheets (restores Google-only formulas)');

  if (SKIP_IF_EXISTS) {
    const existing = await findExistingByName(drive, TARGET_FOLDER_ID, name);
    if (existing.length > 0) {
      console.log(`Skipped: "${name}" already exists in target (id ${existing[0].id}).`);
      return;
    }
  }

  const { data: copy } = await drive.files.copy({
    fileId: FILE_ID,
    requestBody: {
      name,
      parents: [TARGET_FOLDER_ID],
      ...(convert && { mimeType: SHEETS_MIME }),
    },
    fields: 'id, name, mimeType, webViewLink',
    supportsAllDrives: true,
  });

  console.log(`Copied: ${copy.name}`);
  console.log(`New id: ${copy.id}`);
  if (copy.webViewLink) console.log(`Link:   ${copy.webViewLink}`);

  if (convert && FIX_IMPLICIT_INTERSECTION) {
    const fixed = await fixImplicitIntersection(auth, copy.id);
    console.log(`Fixed:  ${fixed} implicit-intersection formula(s)`);
  }
}

/** 0-based column index -> letters (0 -> A, 26 -> AA). */
function columnLetters(index) {
  let s = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  }
  return s;
}

/**
 * Excel evaluates a whole-column ref like B:B in a single-cell formula as the
 * same-row cell (B7 in row 7). Google's importer instead wraps such formulas as
 * ARRAY_CONSTRAIN(ARRAYFORMULA(...), 1, 1), which yields the row-1 result, so
 * e.g. XLOOKUP(B:B, ...) looks up the header and every row returns the same
 * wrong value. Rewrite those back to the same-row cell, like Excel did.
 *
 * Only relative, same-sheet column refs (B:B, not $B:$B or 'Sheet'!B:B) are
 * rewritten; text inside string literals is left alone.
 */
async function fixImplicitIntersection(auth, spreadsheetId) {
  const sheets = google.sheets({ version: 'v4', auth });
  const { data: meta } = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties.title',
  });
  const titles = meta.sheets.map((s) => s.properties.title);
  const quote = (t) => `'${t.replace(/'/g, "''")}'`;

  const { data: batch } = await sheets.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: titles.map(quote),
    valueRenderOption: 'FORMULA',
  });

  const wrapper = /^=ARRAY_CONSTRAIN\(ARRAYFORMULA\(([\s\S]*)\), 1, 1\)$/;
  const wholeColumn = /(?<![A-Za-z0-9_$!:.])([A-Z]{1,3}):\1(?![A-Za-z0-9_(:])/g;
  const updates = [];

  batch.valueRanges.forEach((range, i) => {
    (range.values ?? []).forEach((row, r) => {
      row.forEach((cell, c) => {
        if (typeof cell !== 'string') return;
        const m = cell.match(wrapper);
        if (!m) return;
        // Even segments are outside "string literals".
        const inner = m[1]
          .split('"')
          .map((seg, k) => (k % 2 ? seg : seg.replace(wholeColumn, `$1${r + 1}`)))
          .join('"');
        if (inner === m[1]) return;
        updates.push({
          range: `${quote(titles[i])}!${columnLetters(c)}${r + 1}`,
          values: [[`=${inner}`]],
        });
      });
    });
  });

  // Chunked so a huge workbook doesn't exceed request-size limits.
  for (let i = 0; i < updates.length; i += 500) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: 'USER_ENTERED', data: updates.slice(i, i + 500) },
    });
  }
  return updates.length;
}

main().catch((err) => {
  const message = err?.response?.data?.error?.message ?? err?.message ?? err;
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
