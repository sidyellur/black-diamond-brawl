import Phaser from 'phaser';
import { SCREEN_W } from '../config';
import { ScoreBreakdown } from '../entities/scoring';
import { randomSeed } from '../track/seed';

const BACKGROUND_COLOR = '#1a1a1a';
const ORDINALS: Record<number, string> = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th', 5: '5th' };

export interface ResultSceneData {
  seed: number;
  breakdown: ScoreBreakdown;
  bestScore: number;
  isNewBest: boolean;
}

/**
 * Finish or wipeout summary (design-spec §2/§4.7/§4.8): score breakdown by
 * category, finish time + position (finish mode only awards their bonuses —
 * wipeout mode still shows the frozen position for information, per §4.7),
 * session-best, and the restart prompt (same seed / new seed).
 */
export class ResultScene extends Phaser.Scene {
  private resultData!: ResultSceneData;

  constructor() {
    super({ key: 'ResultScene' });
  }

  create(data: ResultSceneData): void {
    this.resultData = data;
    this.cameras.main.setBackgroundColor(BACKGROUND_COLOR);

    const b = data.breakdown;
    const lines: string[] = [];
    lines.push(b.finished ? 'FINISHED!' : 'WIPED OUT');
    lines.push('');
    lines.push(`Combat hits:  ${b.combatHitCount}  (+${b.combatHitPoints})`);
    lines.push(`Knockouts:    ${b.knockoutCount}  (+${b.knockoutPoints})`);
    lines.push(`Near misses:  ${b.nearMissCount}  (+${b.nearMissPoints})`);
    lines.push(`Trick jumps:  ${b.trickJumpCount}  (+${b.trickJumpPoints})`);
    if (b.finished) {
      lines.push(`Completion bonus: +${b.completionBonus}`);
      lines.push(`Time bonus (${b.finishTimeSeconds.toFixed(1)}s): +${Math.round(b.timeBonus)}`);
      lines.push(`Position: ${ORDINALS[b.position] ?? `${b.position}th`}  (+${b.positionBonus})`);
    } else {
      lines.push(`Position at wipeout: ${ORDINALS[b.position] ?? `${b.position}th`}  (no bonus)`);
    }
    lines.push('');
    lines.push(`TOTAL: ${Math.round(b.total)}`);
    lines.push(`Session best: ${Math.round(data.bestScore)}${data.isNewBest ? '  (NEW BEST!)' : ''}`);
    lines.push('');
    lines.push('R / Enter: restart (same seed)');
    lines.push('N: restart (new seed)');

    this.add
      .text(SCREEN_W / 2, 30, lines.join('\n'), {
        fontSize: '16px',
        color: '#ffffff',
        align: 'center',
        lineSpacing: 4
      })
      .setOrigin(0.5, 0);

    const keyboard = this.input.keyboard;
    if (keyboard) {
      keyboard.once('keydown-R', () => this.restart(this.resultData.seed));
      keyboard.once('keydown-ENTER', () => this.restart(this.resultData.seed));
      keyboard.once('keydown-N', () => this.restart(randomSeed()));
    }
  }

  private restart(seed: number): void {
    this.scene.start('RaceScene', { seed });
  }
}
