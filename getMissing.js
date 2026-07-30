import { google } from 'googleapis';
import fs from 'fs/promises';

import dotenv from 'dotenv';
dotenv.config();

const CREDENTIALS_PATH = './credentials.json';
const TOKEN_PATH = './token.json';

// Auth
async function getAuth() {
  const credentials = JSON.parse(await fs.readFile(CREDENTIALS_PATH, 'utf8'));
  const { client_id, client_secret, redirect_uris } =
    credentials.installed || credentials.web;

  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris[0]
  );

  const token = JSON.parse(await fs.readFile(TOKEN_PATH, 'utf8'));
  oAuth2Client.setCredentials(token);

  return oAuth2Client;
}

// Build maps: files (path -> file object) and folders (path -> folderId)
async function mapAll(drive, folderId, prefix = '', files = new Map(), folders = new Map()) {
  const q = `'${folderId}' in parents and trashed=false`;
  let pageToken;

  do {
    const res = await drive.files.list({
      q,
      fields: 'nextPageToken, files(id, name, mimeType)',
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    for (const f of res.data.files || []) {
      const fullPath = prefix ? `${prefix}/${f.name}` : f.name;

      if (f.mimeType === 'application/vnd.google-apps.folder') {
        // If a folder with this path is already recorded, reuse it (avoid duplicates).
        if (!folders.has(fullPath)) {
          folders.set(fullPath, f.id);
        }
        await mapAll(drive, f.id, fullPath, files, folders);
      } else {
        files.set(fullPath, f);
      }
    }

    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return { files, folders };
}

// Ensure folder path exists in target
async function ensureFolder(drive, pathParts, rootId, cache) {
  let parentId = rootId;
  let currentPath = '';

  for (const part of pathParts) {
    currentPath = currentPath ? `${currentPath}/${part}` : part;

    if (cache.has(currentPath)) {
      parentId = cache.get(currentPath);
      continue;
    }

    const res = await drive.files.create({
      requestBody: {
        name: part,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId],
      },
      fields: 'id',
      supportsAllDrives: true,
    });

    parentId = res.data.id;
    cache.set(currentPath, parentId);

    console.log(`📁 Created folder: ${currentPath}`);
  }

  return parentId;
}

// MAIN
async function main() {
  const SOURCE = process.env.SOURCE_FOLDER_ID;
  const TARGET = process.env.TARGET_FOLDER_ID;

  if (!SOURCE || !TARGET) {
    console.error('Set SOURCE_FOLDER_ID and TARGET_FOLDER_ID');
    process.exit(1);
  }

  const auth = await getAuth();
  const drive = google.drive({ version: 'v3', auth });

  console.log('📂 Mapping source...');
  const { files: sourceFiles } = await mapAll(drive, SOURCE);

  console.log('📂 Mapping target...');
  const { files: targetFiles, folders: targetFolders } = await mapAll(drive, TARGET);

  const missing = [...sourceFiles.keys()].filter(k => !targetFiles.has(k));

  console.log(`\n❌ Missing files to copy: ${missing.length}\n`);

  // Pre-seed the folder cache with existing target folders so we reuse them
  // instead of creating duplicates.
  const folderCache = new Map(targetFolders);

  for (const path of missing) {
    const file = sourceFiles.get(path);
    const parts = path.split('/');
    const fileName = parts.pop();

    const parentId = await ensureFolder(drive, parts, TARGET, folderCache);

    console.log(`📄 Copying: ${path}`);

    await drive.files.copy({
      fileId: file.id,
      requestBody: {
        name: fileName,
        parents: [parentId],
      },
      supportsAllDrives: true,
    });
  }

  console.log('\n✅ Missing files copied.');
}

main().catch(err => {
  console.error(err.response?.data || err);
  process.exit(1);
});