import Phaser from 'phaser';
import { COURSE_LENGTH_SEGMENTS, SCREEN_H, SCREEN_W, SEGMENT_LENGTH } from '../config';
import { bindPlayerInput } from '../entities/input';
import { Player } from '../entities/player';
import { PLAYER_FRAMES, PLAYER_TEXTURE_KEY } from '../entities/playerSprite';
import { RoadRenderer } from '../render/RoadRenderer';
import { FinishBanner } from '../track/finishBanner';
import { generateTrack } from '../track/generator';
import { resolveSeed } from '../track/seed';
import { Segment } from '../track/segment';

const SKY_COLOR = '#8fd0ff';

// Player sprite is drawn at a FIXED screen position (design-spec §3.5) — it
// does NOT go through project(); only its frame/sway/bob react to state.
const PLAYER_SPRITE_SCALE = 2.5; // 32px base art scaled up for screen readability
const PLAYER_SPRITE_BASE_Y = SCREEN_H - 110; // fixed screen position near bottom-center
const PLAYER_LEAN_SWAY_PX = 40; // horizontal sway range across the full lane-offset span
const PLAYER_JUMP_RISE_PX = 60; // sprite bob height at jump apex

// World units behind the finish line the player rests at after crossing —
// keeps the banner in front of the camera (see the `finished` handling in
// update()) instead of sitting exactly at dz=0, where project() culls it.
const FINISH_HOLD_BACK = SEGMENT_LENGTH * 8;

// HUD progress bar (temporary/minimal — Task 9 owns polished UI).
const PROGRESS_BAR_X = 20;
const PROGRESS_BAR_Y = 16;
const PROGRESS_BAR_W = 220;
const PROGRESS_BAR_H = 10;

/**
 * Task 5 scope: the hard-coded sampler track (`testTrack.ts`, still around
 * for reference/manual testing) is replaced with a seeded generator's
 * ~1,500-segment course (design-spec §4.2) with a finish line at the end.
 * The player/camera/renderer wiring from Task 4 is unchanged; what changes
 * is that the track is now a real fixed-length course instead of a looping
 * sampler, so the player's world-Z is no longer wrapped — it runs out at
 * the finish line instead.
 */
export class RaceScene extends Phaser.Scene {
  private track: Segment[] = [];
  private finishSegment: Segment | undefined;
  private roadRenderer!: RoadRenderer;
  private finishBanner!: FinishBanner;
  private player!: Player;
  private playerSprite!: Phaser.GameObjects.Sprite;

  private seed = 0;
  private progressBarBg!: Phaser.GameObjects.Graphics;
  private progressBarFill!: Phaser.GameObjects.Graphics;

  private finished = false;

  constructor() {
    super({ key: 'RaceScene' });
  }

  create(): void {
    // Static sky/backdrop (design-spec §3.6 step 1): a flat camera
    // background color repaints behind everything each frame for free.
    this.cameras.main.setBackgroundColor(SKY_COLOR);

    this.seed = resolveSeed();
    this.track = generateTrack(this.seed);
    this.finishSegment = this.track.find((segment) => segment.isFinish);
    console.log(`[BDB] course seed: ${this.seed} (${this.track.length} segments)`);

    this.roadRenderer = new RoadRenderer(this);
    this.finishBanner = new FinishBanner(this);

    this.player = new Player();
    bindPlayerInput(this, this.player);

    this.playerSprite = this.add.sprite(SCREEN_W / 2, PLAYER_SPRITE_BASE_Y, PLAYER_TEXTURE_KEY, PLAYER_FRAMES.CENTER);
    this.playerSprite.setOrigin(0.5, 1);
    this.playerSprite.setScale(PLAYER_SPRITE_SCALE);

    // Minimal, temporary seed display + progress bar (Task 9 owns real UI).
    this.add.text(PROGRESS_BAR_X, PROGRESS_BAR_Y + PROGRESS_BAR_H + 6, `seed: ${this.seed}`, {
      fontSize: '14px',
      color: '#ffffff'
    });
    this.progressBarBg = this.add.graphics();
    this.progressBarFill = this.add.graphics();
  }

  update(time: number, delta: number): void {
    this.player.update(delta);

    // The course is a fixed, non-looping length (design-spec §4.2) — once
    // the player reaches the finish line their world-Z is held there
    // instead of wrapping, so the camera settles near the banner rather
    // than looping back into the start of the (fixed-size, index-wrapping)
    // track array. Real finish/restart flow is Task 9's job; this is just
    // enough to stop the race cleanly and log the result. Resting position
    // is held a couple of segments BEHIND the finish line rather than
    // exactly on it: project() culls anything at dz <= 0, so parking the
    // camera exactly at the banner's own z would make it invisible right
    // when the player wants to see it.
    if (this.finishSegment) {
      if (!this.finished && this.player.worldZ >= this.finishSegment.z) {
        this.finished = true;
        const elapsedSeconds = time / 1000;
        console.log(`FINISHED in ${elapsedSeconds.toFixed(2)}s (seed ${this.seed})`);
      }
      if (this.finished) {
        this.player.worldZ = Math.max(0, this.finishSegment.z - FINISH_HOLD_BACK);
      }
    }

    // Camera follows the player (§4.1): camZ/camX derive from the player's
    // world-Z and lane offset. Camera height comes from the ROAD's elevation
    // at the player's world-Z (via player.camY), never the jump-arc height,
    // so the camera stays smooth through jumps, including over hills.
    const camZ = this.player.worldZ;
    const camX = this.player.worldX;
    const camY = this.player.camY(this.track);

    this.roadRenderer.render(this.track, camX, camY, camZ);
    this.finishBanner.render(this.finishSegment, camX, camY, camZ);
    this.updatePlayerSprite();
    this.updateProgressBar();
  }

  private updateProgressBar(): void {
    const courseLength = COURSE_LENGTH_SEGMENTS * SEGMENT_LENGTH;
    const progress = courseLength > 0 ? Phaser.Math.Clamp(this.player.worldZ / courseLength, 0, 1) : 0;

    this.progressBarBg.clear();
    this.progressBarBg.fillStyle(0x1a1a1a, 0.6);
    this.progressBarBg.fillRect(PROGRESS_BAR_X, PROGRESS_BAR_Y, PROGRESS_BAR_W, PROGRESS_BAR_H);

    this.progressBarFill.clear();
    this.progressBarFill.fillStyle(0xffcc33, 1);
    this.progressBarFill.fillRect(PROGRESS_BAR_X, PROGRESS_BAR_Y, PROGRESS_BAR_W * progress, PROGRESS_BAR_H);
  }

  private updatePlayerSprite(): void {
    const lean = this.player.leanDirection;
    const frame = this.player.airborne
      ? PLAYER_FRAMES.JUMP
      : lean < 0
        ? PLAYER_FRAMES.LEAN_LEFT
        : lean > 0
          ? PLAYER_FRAMES.LEAN_RIGHT
          : PLAYER_FRAMES.CENTER;
    this.playerSprite.setFrame(frame);

    // Subtle horizontal sway across the lane-offset span (lean effect only —
    // NOT how lane position feeds the camera; that's player.worldX -> camX
    // above) and a vertical bob during the jump arc.
    const swayX = SCREEN_W / 2 + this.player.laneOffsetFraction * PLAYER_LEAN_SWAY_PX;
    const bobY = PLAYER_SPRITE_BASE_Y - this.player.jumpArcHeight * PLAYER_JUMP_RISE_PX;
    this.playerSprite.setPosition(swayX, bobY);
  }
}
