// /**
//  * Deletes the duplicate TARGET folders listed in the error-detail log.
//  *
//  * Each `ambiguous-folder` entry gives two+ folder ids with the same name under
//  * the same parent. This script keeps the one that has files in it and trashes
//  * the empty one(s). (If BOTH are empty it keeps the first and trashes the rest.
//  * If BOTH have files it keeps the fuller one and trashes the other — so no
//  * folder with content is ever the sole casualty.)
//  *
//  * Deletes move to Drive Trash, so they are recoverable for ~30 days.
//  *
//  *   node deleteDuplicates.js
//  */

// import * as fs from 'node:fs/promises';
// import * as path from 'node:path';
// import * as readline from 'node:readline/promises';
// import { stdin as input, stdout as output } from 'node:process';
// import { google } from 'googleapis';
// import { driveCall, ERROR_DETAIL_LOG, listChildren } from './driveUtils.js';

// const SCOPES = [
//   'https://www.googleapis.com/auth/drive',
//   'https://www.googleapis.com/auth/documents',
// ];
// const CREDENTIALS_PATH =
//   process.env.GOOGLE_OAUTH_CREDENTIALS || path.join(process.cwd(), 'credentials.json');
// const TOKEN_PATH = process.env.GOOGLE_OAUTH_TOKEN || path.join(process.cwd(), 'token.json');

// async function authorize() {
//   const keys = JSON.parse(await fs.readFile(CREDENTIALS_PATH, 'utf8'));
//   const { client_secret, client_id, redirect_uris } = keys.installed ?? keys.web ?? {};
//   const oAuth2Client = new google.auth.OAuth2(
//     client_id,
//     client_secret,
//     (redirect_uris && redirect_uris[0]) || 'http://localhost',
//   );

//   try {
//     const token = JSON.parse(await fs.readFile(TOKEN_PATH, 'utf8'));
//     oAuth2Client.setCredentials(token);
//     await oAuth2Client.getAccessToken(); // fails if expired/revoked
//     return oAuth2Client;
//   } catch {
//     // fall through to interactive sign-in
//   }

//   const authUrl = oAuth2Client.generateAuthUrl({
//     access_type: 'offline',
//     prompt: 'consent',
//     scope: SCOPES,
//   });
//   console.log('Authorize this app (sign in as the TARGET account):');
//   console.log(authUrl);
//   const rl = readline.createInterface({ input, output });
//   const code = await rl.question('Enter the authorization code here: ');
//   rl.close();
//   const { tokens } = await oAuth2Client.getToken(code.trim());
//   oAuth2Client.setCredentials(tokens);
//   await fs.writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2), 'utf8');
//   return oAuth2Client;
// }

// /** Distinct duplicate groups from the log: (parent path + name) -> set of ids. */
// async function readGroups() {
//   const raw = await fs.readFile(ERROR_DETAIL_LOG, 'utf8');
//   const groups = new Map();
//   for (const line of raw.split('\n')) {
//     const s = line.trim();
//     if (!s) continue;
//     let rec;
//     try {
//       rec = JSON.parse(s);
//     } catch {
//       continue;
//     }
//     if (rec.kind !== 'ambiguous-folder') continue;
//     const info = rec.info ?? {};
//     const ids = info.targetFileIds ?? [];
//     if (ids.length < 2) continue;
//     const key = `${info.targetFolder?.path ?? '?'}\u0000${info.sourceFile?.name ?? '?'}`;
//     const set = groups.get(key) ?? new Set();
//     ids.forEach((id) => set.add(id));
//     groups.set(key, set);
//   }
//   return [...groups.entries()].map(([key, set]) => ({
//     label: key.replace('\u0000', '/'),
//     ids: [...set],
//   }));
// }

// /** Non-trashed child count; null if the folder is already gone. */
// async function childCount(drive, id) {
//   try {
//     return (await listChildren(drive, id)).length;
//   } catch (err) {
//     if ((err?.response?.status ?? err?.code) === 404) return null;
//     throw err;
//   }
// }

// async function main() {
//   const drive = google.drive({ version: 'v3', auth: await authorize() });
//   const groups = await readGroups();
//   console.log(`Found ${groups.length} duplicate group(s) in the log.\n`);

//   let trashed = 0;
//   let failed = 0;

//   for (const g of groups) {
//     // Live child counts; drop ids that no longer exist.
//     const twins = [];
//     for (const id of g.ids) {
//       const count = await childCount(drive, id);
//       if (count !== null) twins.push({ id, count });
//     }
//     if (twins.length <= 1) continue; // already resolved

//     // Keep the fullest; trash the rest.
//     twins.sort((a, b) => b.count - a.count);
//     const [keep, ...rest] = twins;

//     for (const t of rest) {
//       try {
//         await driveCall('write', `trash ${t.id}`, () =>
//           drive.files.update({
//             fileId: t.id,
//             requestBody: { trashed: true },
//             supportsAllDrives: true,
//             fields: 'id',
//           }),
//         );
//         trashed += 1;
//         console.log(`trashed ${t.id} (${t.count} items) — kept ${keep.id} — ${g.label}`);
//       } catch (err) {
//         failed += 1;
//         console.warn(`FAILED ${t.id} — ${g.label}: ${err?.message ?? err}`);
//       }
//     }
//   }

//   console.log(`\nDone. Trashed ${trashed}, failed ${failed}.`);
//   console.log('Trashed folders are in Drive Trash (~30 days) if you need to recover one.');
// }

// main().catch((err) => {
//   console.error('Fatal:', err?.message ?? err);
//   process.exit(1);
// });