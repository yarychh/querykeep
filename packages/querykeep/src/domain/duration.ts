const MAX_MS = 2_147_483_647;

export function assertDuration(value: number, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_MS) {
    throw new Error(`Invalid ${name}`);
  }

  return value;
}

export function assertPositiveInteger(value: number, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_MS) {
    throw new Error(`Invalid ${name}`);
  }

  return value;
}
