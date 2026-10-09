import Phaser from 'phaser';
import { SCREEN_H, SCREEN_W } from '../config';
import { ScoreBreakdown } from '../entities/scoring';
import { COSMETICS, createQuickRace, CupState, getCourseRecord, getCupRace, RaceOptions, retryRace, RunAwards, RunRecordResult, shareResultText, utcDate } from '../progression';
import { UI } from '../render/palette';
import { randomSeed } from '../track/seed';
import { formatPoints, formatTime, menuButton, menuKeys, menuText, mountainName, MONO } from '../frontend/menu';

export interface ResultSceneData {
  seed: number;
  breakdown: ScoreBreakdown;
  bestScore: number;
  isNewBest: boolean;
  options?: RaceOptions;
  course?: RunRecordResult;
  awards?: RunAwards;
  cup?: CupState | null;
  ghostSaved?: boolean;
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
  private sharePending = false;
  private shareDialog: HTMLDialogElement | null = null;
  private feedback!: Phaser.GameObjects.Text;

  constructor() {
    super({ key: 'ResultScene' });
  }

  create(data: ResultSceneData): void {
    this.resultData = data;
    this.leaving = false;
    this.sharePending = false;
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.shareDialog?.remove(); this.shareDialog = null;
      if (this.input.keyboard) this.input.keyboard.enabled = true;
    });
    this.cameras.main.setBackgroundColor(UI.panel);
    const b = data.breakdown;
    const outcomeColor = b.finished ? UI.accentGood : UI.accentBad;
    // RaceScene commits results exactly once. Visiting/reloading this scorecard
    // must never increase attempts, replay a cup round or award cosmetics again.
    const course = data.course ?? {
      record: getCourseRecord(data.seed) ?? { bestScore: b.total, bestTimeSeconds: b.finished ? b.finishTimeSeconds : null, attempts: 0, lastPlayed: 0 },
      isNewScore: false, isNewTime: false, previousBestTime: null
    };
    const mode = data.options?.mode ?? 'quick';
    const daily = !!data.options?.dailyDate;
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
    menuText(this, 913, 35, mode === 'cup' ? `CUP ROUND ${(data.options?.roundIndex ?? 0) + 1} / 3` : daily ? `${mode === 'practice' ? 'PRACTICE' : 'DAILY'} ${data.options?.dailyDate ?? ''} UTC` : mountainName(data.seed), 13, UI.inkMid, true).setOrigin(1, 0);
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
    const recordNote = mode === 'practice' ? 'Practice runs leave your records and rewards unchanged.' : b.finished && course.previousBestTime !== null
      ? `${Math.abs(b.finishTimeSeconds - course.previousBestTime).toFixed(1)}s ${course.isNewTime ? 'faster than your previous record' : 'off your mountain record'}`
      : b.finished ? 'Your first finish on this mountain. Beat it.' : 'Survive the descent to claim a course record.';
    menuText(this, 49, 387, recordNote, 11, UI.inkLow);

    this.addBreakdown(b);
    const advice = !b.finished ? 'Trees end your run, even in the air. Jump rocks; carve around trees.'
      : b.combatHitCount === 0 ? 'Find the amber target and press F or K. Deliberate hits score 250 points.'
      : b.trickJumpCount === 0 ? 'Jump at a mogul or ride a crest at speed to launch a scoring trick.'
      : 'Same mountain. A faster line. A bigger score. Your record is waiting.';
    const unlockNames = (data.awards?.newUnlocks ?? []).map(id => COSMETICS.find(item => item.id === id)?.name ?? id);
    const news = [data.cup?.status === 'complete' ? data.cup.medal ? `${data.cup.medal.toUpperCase()} CUP MEDAL` : 'CUP COMPLETE' : '', data.ghostSaved ? 'NEW FASTEST GHOST SAVED' : '', unlockNames.length ? `UNLOCKED: ${unlockNames.join(' + ')}` : ''].filter(Boolean).join('  ·  ');
    this.feedback = menuText(this, SCREEN_W / 2, 430, news || advice, news.length > 95 ? 11 : 13, news ? UI.accentWarn : UI.inkMid, !!news).setOrigin(0.5);

    if (mode === 'cup') {
      const complete = data.cup?.status === 'complete';
      menuButton(this, 48, 454, 322, complete ? 'VIEW PODIUM' : 'NEXT RACE', 'ENTER', () => this.cupNext(), true);
      menuButton(this, 385, 454, 292, 'STANDINGS', 'C', () => this.showCup());
    } else {
      menuButton(this, 48, 454, 322, 'RUN IT BACK', 'R / ENTER', () => this.restart(data.seed), true);
      menuButton(this, 385, 454, 292, daily ? 'SHARE RESULT' : 'NEW MOUNTAIN', daily ? 'S' : 'N',
        () => daily ? void this.shareResult() : this.newMountain());
    }
    menuButton(this, 692, 454, 220, 'BASE CAMP', 'ESC', () => this.returnToTitle());
    menuText(this, 48, SCREEN_H - 16, mode === 'practice' ? 'PRACTICE · NO RECORDS OR REWARDS' : `ATTEMPT ${course.record.attempts} ON THIS MOUNTAIN`, 10, UI.inkLow).setOrigin(0, 0.5).setFontFamily(MONO);
    menuText(this, 912, SCREEN_H - 16, daily ? 'LOCAL RESULT · SAME UTC DATE, SAME COURSE' : mode === 'cup' ? 'SERIES PROGRESS SAVED ON THIS DEVICE' : 'SAME SEED. SAME SLOPE. A NEW SHOT.', 10, UI.inkLow).setOrigin(1, 0.5).setFontFamily(MONO);

    menuKeys(this, (code) => {
      if (this.shareDialog) return;
      if (code === 'Enter' || code === 'KeyR') mode === 'cup' ? this.cupNext() : this.restart(data.seed);
      if (code === 'KeyN' && mode === 'quick') this.newMountain();
      if (code === 'KeyS' && daily) void this.shareResult();
      if (code === 'KeyC' && mode === 'cup') this.showCup();
      if (code === 'Escape') this.returnToTitle();
    });
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) this.cameras.main.fadeIn(220, 12, 20, 30);
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
    this.startOptions(createQuickRace(seed));
  }

  private restart(seed: number): void {
    const options = this.resultData.options ? retryRace(this.resultData.options) : createQuickRace(seed);
    if (options.mode === 'daily' && options.dailyDate !== utcDate()) options.mode = 'practice';
    this.startOptions(options);
  }

  private startOptions(options: RaceOptions): void {
    if (this.leaving || this.shareDialog) return;
    this.leaving = true;
    this.scene.start('RaceScene', options);
  }

  private cupNext(): void {
    if (this.leaving) return;
    const options = getCupRace();
    if (this.resultData.cup?.status === 'complete' || !options) this.showCup();
    else this.startOptions(options);
  }

  private showCup(): void {
    if (this.leaving) return;
    this.leaving = true;
    this.scene.start('CupScene', { seed: this.resultData.seed });
  }

  private async shareResult(): Promise<void> {
    if (this.leaving || this.sharePending || this.shareDialog) return;
    this.sharePending = true;
    const text = shareResultText(this.resultData.options ?? createQuickRace(this.resultData.seed), this.resultData.breakdown, window.location.href);
    try {
      if (navigator.share) {
        try {
          await navigator.share({ title: 'Black Diamond Brawl', text });
          if (this.scene.isActive()) this.feedback.setText('Result shared. Challenge someone to beat your line.');
          return;
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') return;
        }
      }
      try {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
        await navigator.clipboard.writeText(text);
        if (this.scene.isActive()) this.feedback.setText('RESULT COPIED · Paste it into a message to share your daily run.');
      } catch {
        if (this.scene.isActive()) this.showShareText(text);
      }
    } finally { this.sharePending = false; }
  }

  /** Native sharing is not universal (especially offline in WKWebView).
   * A selectable result always remains available without special permissions. */
  private showShareText(text: string): void {
    const dialog = document.createElement('dialog');
    this.shareDialog = dialog;
    dialog.setAttribute('aria-label', 'Copy daily challenge result');
    dialog.style.cssText = 'box-sizing:border-box;width:min(620px,88vw);max-height:90vh;max-height:90dvh;padding:20px;border:2px solid #ffb44a;border-radius:12px;background:#12202e;color:#f4f7fa;font:15px Arial,sans-serif;';
    const heading = document.createElement('h2'); heading.textContent = 'Your daily run'; heading.style.cssText = 'margin:0 0 8px;font-size:22px;';
    const hint = document.createElement('p'); hint.textContent = 'Select and copy this text, then share it anywhere.'; hint.style.margin = '0 0 12px';
    const textarea = document.createElement('textarea');
    textarea.value = text; textarea.readOnly = true; textarea.setAttribute('aria-label', 'Shareable result text');
    textarea.style.cssText = '-webkit-user-select:text;user-select:text;touch-action:manipulation;box-sizing:border-box;width:100%;height:150px;max-height:42dvh;resize:none;padding:12px;border:1px solid #63798d;border-radius:6px;background:#1b2836;color:#f4f7fa;font:13px monospace;';
    const button = document.createElement('button'); button.textContent = 'Done'; button.style.cssText = 'display:block;width:100%;min-height:44px;margin-top:12px;border:0;border-radius:6px;background:#ffb44a;color:#12202e;font-weight:bold;';
    const close = (): void => {
      dialog.remove(); this.shareDialog = null;
      if (this.input.keyboard) { this.input.keyboard.enabled = true; this.input.keyboard.addCapture('TAB'); }
      this.game.canvas.focus();
    };
    button.addEventListener('click', close);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.append(heading, hint, textarea, button); document.body.append(dialog);
    if (this.input.keyboard) { this.input.keyboard.enabled = false; this.input.keyboard.removeCapture('TAB'); }
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else { dialog.setAttribute('open', ''); dialog.style.position = 'fixed'; dialog.style.zIndex = '10000'; dialog.style.top = '8%'; }
    textarea.focus(); textarea.select();
  }

  private returnToTitle(): void {
    if (this.leaving || this.shareDialog) return;
    this.leaving = true;
    this.scene.start('TitleScene', { seed: this.resultData.seed });
  }
}
