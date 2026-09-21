import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

// Runs once per test file, outside the per-test storage isolation, so every
// test in the file starts from the fully migrated schema.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
