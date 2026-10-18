import { describe, expect, it } from 'bun:test';

import { exponentialBackoff } from '../src/index.js';

describe('exponentialBackoff', () => {
  it.each([
    ['none', 1, 100],
    ['none', 2, 200],
    ['none', 3, 400],
    ['none', 4, 800],
    ['none', 5, 1_000],
    ['full', 1, 25],
    ['full', 2, 50],
    ['full', 3, 100],
    ['full', 5, 250],
  ] as const)('jitter %s retry %i', (jitter, retryNumber, expected) => {
    const delay = exponentialBackoff({
      baseMs: 100,
      capMs: 1_000,
      jitter,
      random: () => 0.25,
    });

    expect(delay({ retryNumber })).toBe(expected);
  });

  it('uses Math.random when no generator is injected', () => {
    const delay = exponentialBackoff({ baseMs: 8, capMs: 8, jitter: 'full' });
    const value = delay({ retryNumber: 1 });

    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(8);
  });
});
