interface Matchers {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toThrow(expected?: unknown): void;
  toBeGreaterThanOrEqual(expected: number): void;
  toBeLessThanOrEqual(expected: number): void;
  toBeUndefined(): void;
  toBeInstanceOf(expected: abstract new (...args: never[]) => unknown): void;
  toMatchObject(expected: object): void;
  readonly not: Matchers;
}

interface TestEach {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- row args are checked by the test callback
  (cases: readonly unknown[]): (name: string, fn: (...args: any[]) => void | Promise<void>) => void;
}

interface TestFunction {
  (name: string, fn: () => void | Promise<void>): void;
  readonly each: TestEach;
}

declare module 'bun:test' {
  export function describe(name: string, fn: () => void): void;
  export function expect(actual: unknown): Matchers;
  export const it: TestFunction;
}
