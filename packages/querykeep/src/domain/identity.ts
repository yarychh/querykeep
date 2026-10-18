export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type QueryKey = readonly JsonValue[];

/** Canonical identity. Finite JSON values only; array order is preserved; plain-object keys are sorted. */
export function keyId(key: QueryKey): string {
  const visiting = new Set<object>();

  function normalize(value: JsonValue): JsonValue {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;

    if (typeof value === 'number' && Number.isFinite(value)) return value;

    if (typeof value !== 'object' || value === null)
      throw new Error('Key must contain JSON values');

    if (visiting.has(value)) throw new Error('Cyclic query key');

    visiting.add(value);
    let result: JsonValue;

    if (Array.isArray(value)) result = value.map(normalize);
    else {
      if (Object.getPrototypeOf(value) !== Object.prototype)
        throw new Error('Key objects must be plain');

      result = Object.fromEntries(
        Object.keys(value)
          .toSorted()
          .map((entry) => [entry, normalize((value as Record<string, JsonValue>)[entry]!)]),
      );
    }

    visiting.delete(value);

    return result;
  }

  return JSON.stringify(normalize(key));
}
