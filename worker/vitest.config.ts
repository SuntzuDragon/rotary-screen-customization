import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Tests run inside workerd, the same runtime the Worker deploys to, against a
// local D1 and KV built from wrangler.toml. Storage is isolated per test, so
// every test starts from an empty database with the migrations applied.
export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.toml' },
        // Defaults to true. Nothing in wrangler.toml is marked remote today,
        // but a test suite should never be one config flag away from the
        // production D1 and KV, so it is off explicitly.
        remoteBindings: false,
        miniflare: {
          // wrangler.toml asks for 2026-09-01, but the runtime bundled with
          // @cloudflare/vitest-pool-workers 0.22.0 (the latest release) only
          // supports dates up to 2026-08-22 and refuses to start. Tests run ten
          // days behind production's compatibility flags until the pool ships
          // a newer runtime -- delete this line then.
          compatibilityDate: '2026-08-22',
          // Wrangler reads worker/.dev.vars into the test runtime whenever it
          // exists, and there is no switch to stop it. These override it, so a
          // test sees the same environment on a laptop as in CI -- and no
          // developer's real GH_TOKEN can turn a test into a call to GitHub.
          // test/env.test.ts fails if that ever stops being true.
          bindings: {
            TEST_MIGRATIONS: migrations,
            // A fixed, meaningless 32-byte key (every byte 0x01). Not a secret.
            ENC_KEY: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
            GH_TOKEN: '',
            GITHUB_CLIENT_SECRET: '',
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
    },
  };
});
