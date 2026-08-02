/**
 * Run migration then link rewrite, in order:
 *
 *   1. node index.js --continue-with-re-copy
 *   2. node updateAllLinks.js   (only if step 1 exits 0)
 *
 * Extra CLI flags are forwarded to updateAllLinks only
 * (e.g. --dry-run, --only=docs, --skip=docx,xlsx).
 *
 * USAGE
 *   node migrateAndUpdateLinks.js
 *   node migrateAndUpdateLinks.js --dry-run
 *   npm run sync
 *   npm run sync -- --dry-run
 *
 * PM2
 *   pm2 start npm --name drive-sync -- run sync
 *   pm2 start ecosystem.config.cjs --only drive-sync
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './driveUtils.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;

function runStep(label, script, args) {
  console.log(`\n========== ${label} ==========`);
  console.log(`$ node ${script}${args.length ? ` ${args.join(' ')}` : ''}\n`);

  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [path.join(ROOT, script), ...args], {
      cwd: ROOT,
      stdio: 'inherit',
      env: process.env,
    });

    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (signal) {
        reject(new Error(`${script} killed by signal ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

async function main() {
  const extraArgs = process.argv.slice(2);

  const migrateCode = await runStep(
    'STEP 1/2 — migrate (re-copy)',
    'index.js',
    ['--continue-with-re-copy'],
  );

  if (migrateCode !== 0) {
    console.error(
      `\n[abort] Migration exited with code ${migrateCode}. ` +
        'Skipping updateAllLinks.js so links are not rewritten against a partial tree.',
    );
    process.exit(migrateCode);
  }

  const linksCode = await runStep(
    'STEP 2/2 — update links',
    'updateAllLinks.js',
    extraArgs,
  );

  if (linksCode !== 0) {
    console.error(`\n[done] Link update exited with code ${linksCode}.`);
    process.exit(linksCode);
  }

  console.log('\n[done] Migration + link update finished successfully.');
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
