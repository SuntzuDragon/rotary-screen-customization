import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.ts';

// Vitest's 5-second default is too tight for shared CI runners. A loaded runner
// has been measured at over ten times slower than a normal one -- the
// flash-plan tests took ~4s each instead of a few milliseconds -- and a test
// that is merely slow should not fail the build.
export default mergeConfig(viteConfig, defineConfig({ test: { testTimeout: 30_000 } }));
