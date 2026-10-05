import { start } from '../index.ts';

start().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
