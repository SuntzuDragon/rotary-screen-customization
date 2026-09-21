import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

// Wrangler loads worker/.dev.vars into tests if it exists. vitest.config.ts
// overrides every secret in it; this is the tripwire if that ever stops
// holding. Only booleans are compared, so a failure never prints a real value.
describe('test environment', () => {
  it('uses the fixed test key, not a developer or production ENC_KEY', () => {
    expect(env.ENC_KEY === 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=').toBe(true);
  });

  it('has no GitHub credential, so no test can reach GitHub', () => {
    expect(Boolean(env.GH_TOKEN)).toBe(false);
    expect(Boolean(env.GITHUB_CLIENT_SECRET)).toBe(false);
  });
});
