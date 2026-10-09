/** Bump both identities whenever simulation or generation changes. V1 PBs remain
 * readable by their original code, but can never enter this competitive pool. */
export const RULES_VERSION = 'fixed60-v2';
export const COURSE_VERSION = 'mountain-v2';
export const FIXED_STEP_MS = 1000 / 60;

/** FNV-1a over UTF-16 code units; deliberately independent of locale/time zone. */
export function hashIdentity(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function courseKey(seed: number): string {
  return `${RULES_VERSION}/${COURSE_VERSION}/${seed >>> 0}`;
}

/** Reset the runtime stream BEFORE constructing rivals/combat, for every mode. */
export function rivalSeed(seed: number): number {
  return hashIdentity(`${courseKey(seed)}/rivals`);
}
