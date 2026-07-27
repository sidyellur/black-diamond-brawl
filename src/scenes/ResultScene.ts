import Phaser from 'phaser';
import { SCREEN_H, SCREEN_W } from '../config';
import { ScoreBreakdown } from '../entities/scoring';
import { DEPTH } from '../render/depth';
import { UI } from '../render/palette';
import { randomSeed } from '../track/seed';

const hex = (v: number): string => `#${v.toString(16).padStart(6, '0')}`;
const ORDINALS: Record<number, string> = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th', 5: '5th' };

export interface ResultSceneData {
  seed: number;
  breakdown: ScoreBreakdown;
  bestScore: number;
  isNewBest: boolean;
}

interface Row {
  label: string;
  value: string;
  accent?: number;
}

/**
 * Finish or wipeout summary (design-spec §2/§4.7/§4.8).
 *
 * Laid out as a panel with aligned label/value columns rather than a single
 * centred text blob, so the eye can scan the breakdown. Categories carry the
 * accent colour that matches what they represent — combat is aggressive, near
 * misses informational, tricks rewarding — which is what turns a list of
 * numbers into a readable summary of how the run went.
 */
export class ResultScene extends Phaser.Scene {
  private resultData!: ResultSceneData;

  constructor() {
    super({ key: 'ResultScene' });
  }

  create(data: ResultSceneData): void {
    this.resultData = data;
    this.cameras.main.setBackgroundColor(UI.panel);

    const b = data.breakdown;
    const finished = b.finished;

    // Header band — colour-coded so the outcome registers before any reading.
    const band = this.add.graphics();
    band.fillStyle(finished ? UI.accentGood : UI.accentBad, 0.16);
    band.fillRect(0, 0, SCREEN_W, 74);
    band.fillStyle(finished ? UI.accentGood : UI.accentBad, 1);
    band.fillRect(0, 72, SCREEN_W, 2);

    this.add
      .text(SCREEN_W / 2, 30, finished ? 'FINISHED' : 'WIPED OUT', {
        fontSize: '34px',
        fontStyle: 'bold',
        color: hex(finished ? UI.accentGood : UI.accentBad)
      })
      .setOrigin(0.5, 0.5);

    const rows: Row[] = [
      { label: 'Combat hits', value: `${b.combatHitCount}   +${b.combatHitPoints}`, accent: UI.accentBad },
      { label: 'Knockouts', value: `${b.knockoutCount}   +${b.knockoutPoints}`, accent: UI.accentBad },
      { label: 'Near misses', value: `${b.nearMissCount}   +${b.nearMissPoints}`, accent: UI.accentInfo },
      { label: 'Trick jumps', value: `${b.trickJumpCount}   +${b.trickJumpPoints}`, accent: UI.accentWarn }
    ];

    if (finished) {
      rows.push({ label: 'Completion', value: `+${b.completionBonus}`, accent: UI.accentGood });
      rows.push({
        label: `Time  (${b.finishTimeSeconds.toFixed(1)}s)`,
        value: `+${Math.round(b.timeBonus)}`,
        accent: UI.accentGood
      });
      rows.push({
        label: `Position  ${ORDINALS[b.position] ?? `${b.position}th`}`,
        value: `+${b.positionBonus}`,
        accent: UI.accentGood
      });
    } else {
      rows.push({
        label: `Position at wipeout  ${ORDINALS[b.position] ?? `${b.position}th`}`,
        value: 'no bonus',
        accent: UI.inkLow
      });
    }

    const leftX = SCREEN_W / 2 - 190;
    const rightX = SCREEN_W / 2 + 190;
    let y = 108;

    for (const row of rows) {
      this.add.text(leftX, y, row.label, { fontSize: '15px', color: hex(UI.inkMid) }).setOrigin(0, 0.5);
      this.add
        .text(rightX, y, row.value, {
          fontSize: '15px',
          fontStyle: 'bold',
          color: hex(row.accent ?? UI.inkHigh)
        })
        .setOrigin(1, 0.5);
      y += 27;
    }

    // Total, separated by a rule so it does not read as just another row.
    y += 8;
    const rule = this.add.graphics();
    rule.fillStyle(UI.panelEdge, 1);
    rule.fillRect(leftX, y - 8, rightX - leftX, 1);

    this.add
      .text(leftX, y + 14, 'TOTAL', { fontSize: '20px', fontStyle: 'bold', color: hex(UI.inkHigh) })
      .setOrigin(0, 0.5);
    this.add
      .text(rightX, y + 14, `${Math.round(b.total)}`, {
        fontSize: '26px',
        fontStyle: 'bold',
        color: hex(UI.inkHigh)
      })
      .setOrigin(1, 0.5);

    const bestLabel = data.isNewBest ? 'NEW SESSION BEST' : 'Session best';
    this.add
      .text(SCREEN_W / 2, y + 48, `${bestLabel}   ${Math.round(data.bestScore)}`, {
        fontSize: '14px',
        color: hex(data.isNewBest ? UI.accentWarn : UI.inkLow),
        fontStyle: data.isNewBest ? 'bold' : 'normal'
      })
      .setOrigin(0.5, 0.5);

    this.add
      .text(SCREEN_W / 2, SCREEN_H - 34, 'R / ENTER  restart same seed        N  new seed', {
        fontSize: '14px',
        color: hex(UI.inkMid)
      })
      .setOrigin(0.5, 0.5)
      .setDepth(DEPTH.HUD);

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
