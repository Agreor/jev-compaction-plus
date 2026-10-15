import { expect, it } from 'vitest';
import { assertNativeCompaction } from '../src/assessment/claude-native-probe.js';
it('does not mistake successful CLI transport for native compaction', () => {
  expect(() => assertNativeCompaction("/compact isn't available in this environment.", 0, 0)).toThrow('unavailable');
  expect(() => assertNativeCompaction('Request completed', 0, 0)).toThrow('boundary');
  expect(() => assertNativeCompaction('Compacted', 1, 2)).not.toThrow();
});
