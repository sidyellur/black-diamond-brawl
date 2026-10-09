export type CosmeticSlot = 'board' | 'jacket';
export interface Cosmetic { id: string; slot: CosmeticSlot; name: string; color: number; requirement: string }
/** Colors only. No physics, hitbox, score or speed modifiers exist. */
export const COSMETICS: readonly Cosmetic[] = [
  { id: 'classic-board', slot: 'board', name: 'Glacier', color: 0x38bde8, requirement: 'Always available' },
  { id: 'sunrise-board', slot: 'board', name: 'Sunrise', color: 0xffb44a, requirement: 'Finish a race' },
  { id: 'aurora-board', slot: 'board', name: 'Aurora', color: 0x56ddb0, requirement: 'Land 3 tricks in one finished run' },
  { id: 'champion-board', slot: 'board', name: 'Champion', color: 0xffd36b, requirement: 'Win a gold cup medal' },
  { id: 'classic-jacket', slot: 'jacket', name: 'Ember', color: 0xe85a40, requirement: 'Always available' },
  { id: 'midnight-jacket', slot: 'jacket', name: 'Midnight', color: 0x687bea, requirement: 'Land 5 combat hits in one finished run' },
  { id: 'alpine-jacket', slot: 'jacket', name: 'Alpine', color: 0x268770, requirement: 'Finish all 3 races in a cup' },
  { id: 'summit-jacket', slot: 'jacket', name: 'Summit', color: 0xba73cc, requirement: 'Earn a cup podium medal' }
];
export const CHALLENGES = [
  { id: 'first-finish', name: 'First Descent', description: 'Finish any competitive race', cosmetic: 'sunrise-board' },
  { id: 'trick-trio', name: 'Air Time', description: 'Land 3 tricks in one finished run', cosmetic: 'aurora-board' },
  { id: 'five-hits', name: 'Brawler', description: 'Land 5 combat hits in one finished run', cosmetic: 'midnight-jacket' },
  { id: 'cup-finisher', name: 'Full Descent', description: 'Finish every round in a cup', cosmetic: 'alpine-jacket' },
  { id: 'cup-podium', name: 'Podium Club', description: 'Earn a cup podium medal', cosmetic: 'summit-jacket' },
  { id: 'cup-gold', name: 'Mountain Champion', description: 'Win a gold cup medal', cosmetic: 'champion-board' }
] as const;
export function cosmetic(id: string): Cosmetic | undefined { return COSMETICS.find(item => item.id === id); }
