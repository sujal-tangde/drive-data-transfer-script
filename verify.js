



import { google } from 'googleapis';
import fs from 'fs/promises';

import dotenv from 'dotenv';
dotenv.config();

// Paths
const CREDENTIALS_PATH = './credentials.json';
const TOKEN_PATH = './token.json';

// ✅ Proper auth (FIXED)
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

// 🔁 Recursively list all files with full path
async function listAll(drive, folderId, prefix = '') {
    const q = `'${folderId}' in parents and trashed=false`;
    let pageToken;
    const items = [];

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
                const sub = await listAll(drive, f.id, fullPath);
                items.push(...sub);
            } else {
                items.push(fullPath);
            }
        }

        pageToken = res.data.nextPageToken;
    } while (pageToken);

    return items;
}

// 🚀 Main
async function main() {
    const SOURCE = process.env.SOURCE_FOLDER_ID;
    const TARGET = process.env.TARGET_FOLDER_ID;

    if (!SOURCE || !TARGET) {
        console.error('❌ Set SOURCE_FOLDER_ID and TARGET_FOLDER_ID');
        process.exit(1);
    }

    const auth = await getAuth();
    const drive = google.drive({ version: 'v3', auth });

    console.log('📂 Listing source...');
    const sourceFiles = await listAll(drive, SOURCE);

    console.log('📂 Listing target...');
    const targetFiles = await listAll(drive, TARGET);

    const sourceSet = new Set(sourceFiles);
    const targetSet = new Set(targetFiles);

    const missing = sourceFiles.filter(f => !targetSet.has(f));
    const extra = targetFiles.filter(f => !sourceSet.has(f));

    console.log('\n===== ✅ RESULT =====\n');

    console.log(`Total Source Files: ${sourceFiles.length}`);
    console.log(`Total Target Files: ${targetFiles.length}`);

    console.log(`\n❌ Missing in Target: ${missing.length}`);
    missing.forEach(f => console.log('  ', f));

    console.log(`\n⚠️ Extra in Target: ${extra.length}`);
    extra.forEach(f => console.log('  ', f));

    console.log('\n🎉 Done.');
}

main().catch(err => {
    console.error('❌ Error:', err.response?.data || err.message || err);
    process.exit(1);
});