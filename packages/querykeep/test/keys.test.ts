import { describe, expect, it } from 'bun:test';

import { keyId } from '../src/index.js';

describe('key identity', () => {
  it.each([
    ['NaN', [Number.NaN], 'JSON'],
    ['Infinity', [Number.POSITIVE_INFINITY], 'JSON'],
    ['undefined', [undefined], 'JSON'],
    ['bigint', [1n], 'JSON'],
    ['function', [() => 1], 'JSON'],
    ['symbol', [Symbol('k')], 'JSON'],
    ['date', [new Date(0)], 'plain'],
    [
      'class instance',
      [
        new (class Box {
          readonly n = 1;
        })(),
      ],
      'plain',
    ],
    [
      'cyclic object',
      (() => {
        const box: { self?: object } = {};

        box.self = box;

        return [box];
      })(),
      'Cyclic',
    ],
    [
      'cyclic array',
      (() => {
        const cycle: unknown[] = [];

        cycle.push(cycle);

        return cycle;
      })(),
      'Cyclic',
    ],
  ])('rejects %s', (_name, key, fragment) => {
    expect(() => keyId(key as never)).toThrow(fragment);
  });

  it('preserves array order and sorts plain object keys', () => {
    expect(keyId([1, 2])).not.toBe(keyId([2, 1]));
    expect(keyId([{ b: 1, a: { d: true, c: null } }])).toBe(
      keyId([{ a: { c: null, d: true }, b: 1 }]),
    );
    expect(keyId(['a', 1, true, null])).toBe('["a",1,true,null]');
  });
});
