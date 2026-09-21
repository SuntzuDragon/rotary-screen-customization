import { env } from 'cloudflare:workers';

/**
 * Empty every table, keeping the schema.
 *
 * @cloudflare/vitest-pool-workers documents isolated per-test storage, but
 * writes made through `SELF.fetch` persist from one test to the next within a
 * file (checked: an id registered in one test is still claimed in the next).
 * Without this, tests silently depend on each other's leftovers -- which is
 * exactly how a cross-device check once "failed" against a device an earlier
 * test had registered with the same secret.
 */
export async function resetDatabase() {
  const { results } = await env.DB.prepare(
    `SELECT name FROM sqlite_master
     WHERE type = 'table'
       AND name NOT LIKE 'sqlite_%'
       AND name NOT LIKE '_cf_%'
       AND name <> 'd1_migrations'`,
  ).all<{ name: string }>();
  await env.DB.batch(results.map(({ name }) => env.DB.prepare(`DELETE FROM "${name}"`)));
}
