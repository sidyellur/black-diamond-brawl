import Phaser from 'phaser';
import { SCREEN_H, SCREEN_W } from '../config';
import { ScoreBreakdown } from '../entities/scoring';
import { recordCourse } from '../entities/session';
import { UI } from '../render/palette';
import { randomSeed } from '../track/seed';
import { formatPoints, formatTime, menuButton, menuKeys, menuText, mountainName, MONO } from '../frontend/menu';

export interface ResultSceneData {
  seed: number;
  breakdown: ScoreBreakdown;
  bestScore: number;
  isNewBest: boolean;
}

interface Row {
  label: string;
  count: string;
  points: number;
  color: number;
}

const ORDINALS: Record<number, string> = { 1: '1ST', 2: '2ND', 3: '3RD', 4: '4TH', 5: '5TH' };

export class ResultScene extends Phaser.Scene {
  private resultData!: ResultSceneData;
  private leaving = false;

  constructor() {
    super({ key: 'ResultScene' });
  }

  create(data: ResultSceneData): void {
    this.resultData = data;
    this.leaving = false;
    this.cameras.main.setBackgroundColor(UI.panel);
    const b = data.breakdown;
    const outcomeColor = b.finished ? UI.accentGood : UI.accentBad;
    const course = recordCourse(data.seed, b.total, b.finished ? b.finishTimeSeconds : null);
    const art = this.add.graphics();
    // Quiet mountain geometry gives the scorecard a sense of place.
    art.fillStyle(0x182737);
    art.fillTriangle(0, 400, 205, 78, 473, 400);
    art.fillStyle(0x1c3040);
    art.fillTriangle(131, 400, 329, 169, 560, 400);
    art.fillStyle(outcomeColor, 0.08);
    art.fillRect(0, 0, SCREEN_W, 82);
    art.fillStyle(outcomeColor);
    art.fillRect(48, 36, 4, 29);
    art.fillStyle(UI.panelEdge);
    art.fillRect(48, 82, SCREEN_W - 96, 1);
    art.fillStyle(0x172330, 0.96);
    art.fillRoundedRect(414, 103, 498, 304, 8);

    menuText(this, 66, 37, b.finished ? (b.position === 1 ? 'MOUNTAIN CONQUERED' : 'FINISH LINE CROSSED') : 'ONE MORE RUN?', 25, outcomeColor, true);
    menuText(this, 913, 35, mountainName(data.seed), 13, UI.inkMid, true).setOrigin(1, 0);
    menuText(this, 913, 56, `MOUNTAIN #${data.seed}`, 11, UI.inkLow).setOrigin(1, 0).setFontFamily(MONO);

    menuText(this, 50, 107, b.finished ? `${ORDINALS[b.position] ?? `${b.position}TH`} PLACE  /  5 RIDERS` : 'WIPED OUT  /  POINTS KEPT', 15, outcomeColor, true);
    menuText(this, 48, 140, 'TOTAL SCORE', 12, UI.inkMid, true);
    const total = menuText(this, 44, 159, formatPoints(b.total), 70, UI.inkHigh, true).setLetterSpacing(-2);
    if (total.width > 338) total.setFontSize(56);
    menuText(this, 49, 244, data.isNewBest ? 'NEW PERSONAL BEST' : 'PERSONAL BEST', 11, data.isNewBest ? UI.accentWarn : UI.inkLow, true);
    menuText(this, 49, 263, formatPoints(data.bestScore), 23, data.isNewBest ? UI.accentWarn : UI.inkHigh, true);
    menuText(this, 225, 244, b.finished ? 'FINISH TIME' : 'TIME ON SLOPE', 11, UI.inkLow, true);
    menuText(this, 225, 263, formatTime(b.finishTimeSeconds), 23, UI.inkHigh, true);

    art.fillStyle(UI.panelEdge);
    art.fillRect(49, 304, 333, 1);
    menuText(this, 49, 321, course.isNewScore ? 'NEW MOUNTAIN BEST' : 'MOUNTAIN BEST', 11, course.isNewScore ? UI.accentWarn : UI.inkLow, true);
    menuText(this, 382, 318, formatPoints(course.record.bestScore), 19, UI.inkHigh, true).setOrigin(1, 0);
    menuText(this, 49, 358, course.isNewTime ? 'NEW COURSE RECORD' : 'FASTEST FINISH', 11, course.isNewTime ? UI.accentGood : UI.inkLow, true);
    menuText(this, 382, 355, course.record.bestTimeSeconds !== null ? formatTime(course.record.bestTimeSeconds) : 'UNCLAIMED', 19, course.isNewTime ? UI.accentGood : UI.inkMid, true).setOrigin(1, 0);
    const recordNote = b.finished && course.previousBestTime !== null
      ? `${Math.abs(b.finishTimeSeconds - course.previousBestTime).toFixed(1)}s ${course.isNewTime ? 'faster than your previous record' : 'off your mountain record'}`
      : b.finished ? 'Your first finish on this mountain. Beat it.' : 'Survive the descent to claim a course record.';
    menuText(this, 49, 387, recordNote, 11, UI.inkLow);

    this.addBreakdown(b);
    const advice = !b.finished ? 'Trees end your run, even in the air. Jump rocks; carve around trees.'
      : b.combatHitCount === 0 ? 'Find the amber target and press F or K. Deliberate hits score 250 points.'
      : b.trickJumpCount === 0 ? 'Jump at a mogul or ride a crest at speed to launch a scoring trick.'
      : 'Same mountain. A faster line. A bigger score. Your record is waiting.';
    menuText(this, SCREEN_W / 2, 430, advice, 13, UI.inkMid).setOrigin(0.5);

    menuButton(this, 48, 454, 322, 'RUN IT BACK', 'R / ENTER', () => this.restart(data.seed), true);
    menuButton(this, 385, 454, 292, 'NEW MOUNTAIN', 'N', () => this.newMountain());
    menuButton(this, 692, 454, 220, 'BASE CAMP', 'ESC', () => this.returnToTitle());
    menuText(this, 48, SCREEN_H - 16, `ATTEMPT ${course.record.attempts} ON THIS MOUNTAIN`, 10, UI.inkLow).setOrigin(0, 0.5).setFontFamily(MONO);
    menuText(this, 912, SCREEN_H - 16, 'SAME SEED. SAME SLOPE. A NEW SHOT.', 10, UI.inkLow).setOrigin(1, 0.5).setFontFamily(MONO);

    menuKeys(this, (code) => {
      if (code === 'KeyR' || code === 'Enter') this.restart(data.seed);
      if (code === 'KeyN') this.newMountain();
      if (code === 'Escape') this.returnToTitle();
    });
    this.cameras.main.fadeIn(220, 12, 20, 30);
  }

  private addBreakdown(b: ScoreBreakdown): void {
    menuText(this, 437, 118, 'HOW YOU SCORED', 12, UI.inkMid, true);
    menuText(this, 746, 118, 'COUNT', 10, UI.inkLow, true).setOrigin(1, 0);
    menuText(this, 887, 118, 'POINTS', 10, UI.inkLow, true).setOrigin(1, 0);
    const rows: Row[] = [
      { label: 'Combat hits', count: String(b.combatHitCount), points: b.combatHitPoints, color: UI.accentBad },
      { label: 'Knockouts', count: String(b.knockoutCount), points: b.knockoutPoints, color: UI.accentBad },
      { label: 'Body checks', count: String(b.brushCount), points: b.brushPoints, color: UI.inkMid },
      { label: 'Near misses', count: String(b.nearMissCount), points: b.nearMissPoints, color: UI.accentInfo },
      { label: 'Trick jumps', count: String(b.trickJumpCount), points: b.trickJumpPoints, color: UI.accentWarn },
      { label: 'Flow chain', count: `${b.maxChain ?? 0} BEST`, points: b.chainBonusPoints ?? 0, color: UI.accentWarn },
      { label: 'Crossing the finish', count: b.finished ? 'DONE' : 'DNF', points: b.completionBonus, color: UI.accentGood },
      { label: 'Under-par time', count: b.finished ? formatTime(b.finishTimeSeconds) : '—', points: b.timeBonus, color: UI.accentGood },
      { label: 'Race position', count: b.finished ? ORDINALS[b.position] ?? `${b.position}TH` : 'DNF', points: b.positionBonus, color: UI.accentGood }
    ];
    const details = this.add.graphics();
    rows.forEach((row, index) => {
      const y = 155 + index * 27;
      if (index === 6) {
        details.lineStyle(1, UI.panelEdge);
        details.lineBetween(437, y - 13, 888, y - 13);
      }
      details.fillStyle(row.points > 0 ? row.color : UI.panelEdge);
      details.fillCircle(441, y + 3, 3);
      menuText(this, 454, y + 3, row.label, 14, row.points > 0 ? UI.inkHigh : UI.inkLow).setOrigin(0, 0.5);
      menuText(this, 746, y + 3, row.count, 12, UI.inkLow).setOrigin(1, 0.5).setFontFamily(MONO);
      menuText(this, 887, y + 3, `+${formatPoints(row.points)}`, 16, row.points > 0 ? row.color : UI.inkLow, true).setOrigin(1, 0.5);
    });
  }

  private newMountain(): void {
    let seed = randomSeed();
    if (seed === this.resultData.seed) seed = (seed + 1) >>> 0;
    this.restart(seed);
  }

  private restart(seed: number): void {
    if (this.leaving) return;
    this.leaving = true;
    this.scene.start('RaceScene', { seed });
  }

  private returnToTitle(): void {
    if (this.leaving) return;
    this.leaving = true;
    this.scene.start('TitleScene', { seed: this.resultData.seed });
  }
}
