// Run the nightly job once (for cron), e.g.  node dist/nightly.mjs [--force]
import { applyConfig } from '../../shared/config.ts';
import { existsSync, readFileSync } from 'node:fs';
import { env } from '../env.ts';
import { pool } from '../db.ts';
import { migrate } from '../migrate.ts';
import { runNightly } from '../nightly.ts';

if (existsSync(env.GAME_CONFIG)) applyConfig(JSON.parse(readFileSync(env.GAME_CONFIG, 'utf8')));
migrate(false)
  .then(() => runNightly({ force: process.argv.includes('--force') }))
  .then((r) => {
    console.log(r ? JSON.stringify(r, null, 2) : 'Already ran today (use --force to run again).');
    return pool.end();
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
