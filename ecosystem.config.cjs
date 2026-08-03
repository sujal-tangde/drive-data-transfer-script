/** PM2 config for one-shot batch scripts (no autorestart). */
module.exports = {
  apps: [
    {
      name: 'drive-copy',
      script: 'index.js',
      cwd: __dirname,
      autorestart: false,
      max_restarts: 0,
      args: '--continue-with-re-copy',
    },
    {
      // Same as drive-copy, but same-named sibling folders are mirrored
      // one-for-one instead of merged into the first match.
      name: 'drive-copy-handled-duplicates',
      script: 'index.js',
      cwd: __dirname,
      autorestart: false,
      max_restarts: 0,
      args: '--continue-with-re-copy-handled-duplicates',
    },
    {
      // Full pipeline: re-copy, then rewrite links (migrateAndUpdateLinks.js).
      name: 'drive-sync',
      script: 'migrateAndUpdateLinks.js',
      cwd: __dirname,
      autorestart: false,
      max_restarts: 0,
    },
    {
      name: 'drive-verify',
      script: 'verify.js',
      cwd: __dirname,
      autorestart: false,
      max_restarts: 0,
    },
    {
      name: 'drive-get-missing',
      script: 'getMissing.js',
      cwd: __dirname,
      autorestart: false,
      max_restarts: 0,
    },
  ],
};
