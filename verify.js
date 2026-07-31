/**
 * Read-only comparison of the source tree against the target tree, matched by
 * full path (not by name), reporting what is missing and what is extra.
 *
 * Nothing here writes: no copy, no create, no delete. Only files.list is called,
 * so only the read quota bucket is ever charged.
 *
 * Concurrency model (same architecture as index.js)
 *   - One folder queue drained by WALK_CONCURRENCY workers, seeded with *both*
 *     roots, so the source and target walks overlap in a single pool instead of
 *     running one after the other.
 *   - Every request goes through the shared adaptive governor, so a 403/429 on
 *     either tree slows the whole fleet at once and recovers gradually.
 *   - A folder that cannot be listed is logged to logs/issues.log and the run
 *     continues; the exit code is non-zero so partial results are not mistaken
 *     for a clean comparison.
 */

import { google } from 'googleapis';
import fs from 'fs/promises';

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

/**
 * Set difference both ways, by full path.
 *
 * Sorted rather than left in traversal order: a concurrent walk has no stable
 * order between runs, and sorting groups each folder's files in the report.
 */
function comparePaths(sourceFiles, targetFiles) {
    const sourceSet = new Set(sourceFiles);
    const targetSet = new Set(targetFiles);

    return {
        missing: sourceFiles.filter(f => !targetSet.has(f)).sort(),
        extra: targetFiles.filter(f => !sourceSet.has(f)).sort(),
    };
}

/** Two-line status block: [progress] counts per tree, [scan] queue + API health. */
function createStatusLogger(ctx) {
    const startedAt = Date.now();

    return createStatusPrinter(() => {
        const { source, target } = ctx.scan;
        const elapsedMs = Date.now() - startedAt;

        const progress = [
            `[progress] source ${source.files} files / ${source.folders} folders`,
            `target ${target.files} files / ${target.folders} folders`,
        ];
        if (ctx.stats.errors) progress.push(`${ctx.stats.errors} errors`);
        progress.push(`elapsed ${formatDuration(elapsedMs)}`);

        const scan = [
            ctx.done
                ? '[scan] listing complete'
                : '[scan] listing…',
            `queue: ${ctx.queues.folders.size} folders`,
            `api ${governors.read.rate.toFixed(1)}/s read`,
        ];
        if (apiStats.retries) scan.push(`${apiStats.retries} retries`);
        scan.push(`in: ${truncateName(ctx.runtime.currentFolder || '/', 40)}`);

        return [progress.join(' | '), scan.join(' | ')];
    });
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

    const sourceFiles = [];
    const targetFiles = [];

    const ctx = createWalkContext({
        onFile(side, fullPath) {
            (side === 'source' ? sourceFiles : targetFiles).push(fullPath);
        },
    });

    // Both walks share one worker pool and start together.
    console.log('📂 Listing source...');
    console.log('📂 Listing target...');
    console.log(
        `   ${WALK_CONCURRENCY} walkers | rate: ${READ_RATE}→${READ_RATE_MAX}/s read (adaptive)`,
    );

    let interrupted = false;
    const onInterrupt = () => {
        if (interrupted) process.exit(130);
        interrupted = true;
        ctx.aborted = true;
        console.log('\n[abort] Finishing in-flight requests… (Ctrl+C again to force quit)');
    };
    process.on('SIGINT', onInterrupt);

    const status = createStatusLogger(ctx);
    status.start();
    try {
        await walkTrees(
            drive,
            [
                { side: 'source', id: SOURCE },
                { side: 'target', id: TARGET },
            ],
            ctx,
        );
        ctx.done = !ctx.aborted;
    } finally {
        status.stop();
        process.off('SIGINT', onInterrupt);
        await flushIssues();
    }

    const { missing, extra } = comparePaths(sourceFiles, targetFiles);

    console.log('\n===== ✅ RESULT =====\n');

    console.log(`Total Source Files: ${sourceFiles.length}`);
    console.log(`Total Target Files: ${targetFiles.length}`);

    console.log(`\n❌ Missing in Target: ${missing.length}`);
    missing.forEach(f => console.log('  ', f));

    console.log(`\n⚠️ Extra in Target: ${extra.length}`);
    extra.forEach(f => console.log('  ', f));

    console.log(
        `\nAPI calls: ${apiStats.calls}${apiStats.retries ? ` (${apiStats.retries} retried)` : ''} | ` +
        `final read rate ${governors.read.rate.toFixed(1)}/s`,
    );
    if (ctx.stats.shortcuts) {
        console.log(
            `Shortcuts counted as files: ${ctx.stats.shortcuts} (index.js does not copy shortcuts, so source shortcuts show up as missing)`,
        );
    }

    if (ctx.stats.errors) {
        // A folder we could not list means its files were never seen, so the
        // lists above understate the source and overstate what is missing.
        console.log(`\n⚠️ ${ctx.stats.errors} folders could not be listed — results are INCOMPLETE (see ${ISSUE_LOG})`);
        for (const line of ctx.failures.slice(0, 10)) console.log(`    - ${line}`);
        if (ctx.failures.length > 10) console.log(`    …and more in ${ISSUE_LOG}`);
        process.exitCode = 1;
    }
    if (ctx.aborted) {
        console.log('\n⚠️ Interrupted — results are INCOMPLETE.');
        process.exitCode = 130;
    }

    console.log('\n🎉 Done.');
}

// Guarded so tests can import the comparison without running a full listing.
if (isMainModule(import.meta.url)) {
    main().catch(err => {
        console.error('❌ Error:', err.response?.data || err.message || err);
        process.exit(1);
    });
}

export { comparePaths, main };
