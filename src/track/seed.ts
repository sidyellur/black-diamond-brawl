/**
 * Resolves the active course seed (design-spec §4.2): a `?seed=` URL param
 * if present, otherwise a fresh random seed. Numeric params are used
 * directly; non-numeric params are hashed to a number so `?seed=powder-day`
 * is still a valid, deterministic seed. Always returns an unsigned 32-bit
 * integer, matching what `mulberry32` expects.
 */
export function resolveSeed(search: string = typeof window !== 'undefined' ? window.location.search : ''): number {
  const params = new URLSearchParams(search);
  const raw = params.get('seed');

  if (raw !== null && raw.length > 0) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      return parsed >>> 0;
    }
    return hashString(raw);
  }

  return Math.floor(Math.random() * 0xffffffff) >>> 0;
}

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (Math.imul(31, hash) + value.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}
