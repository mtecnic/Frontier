import { migrate } from '../migrate.ts';
import { pool } from '../db.ts';

migrate()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
