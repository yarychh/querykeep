export interface ProviderLimits {
  readonly concurrency?: number;
  readonly minIntervalMs?: number;
}

export type AdmissionBlock = 'ready' | 'wait' | 'blocked';

export class AdmissionOverflowError extends Error {
  constructor() {
    super('Admission queue full');
    this.name = 'AdmissionOverflowError';
  }
}

export class AdmissionTimeoutError extends Error {
  constructor() {
    super('Admission timed out');
    this.name = 'AdmissionTimeoutError';
  }
}

export class AdmissionClosedError extends Error {
  constructor() {
    super('Admission closed');
    this.name = 'AdmissionClosedError';
  }
}

export function isAdmissionError(error: unknown): boolean {
  return (
    error instanceof AdmissionOverflowError ||
    error instanceof AdmissionTimeoutError ||
    error instanceof AdmissionClosedError
  );
}

/** A held key or a full provider waits without blocking other providers. Pacing returns `wait`. */
export function eligibility(input: {
  readonly held: boolean;
  readonly provider: string | undefined;
  readonly providerActive: number;
  readonly providerConcurrency: number | undefined;
  readonly elapsed: number;
  readonly notBefore: number;
  readonly active: number;
  readonly concurrency: number;
}): AdmissionBlock {
  if (input.held) return 'blocked';

  if (input.provider !== undefined) {
    if (input.providerConcurrency != null && input.providerActive >= input.providerConcurrency) {
      return 'blocked';
    }

    if (input.elapsed < input.notBefore) return 'wait';
  }

  if (input.active >= input.concurrency) return 'blocked';

  return 'ready';
}
