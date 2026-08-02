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
