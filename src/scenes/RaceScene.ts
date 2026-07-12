import Phaser from 'phaser';
import { SCREEN_H, SCREEN_W, SEGMENT_LENGTH } from '../config';
import { bindPlayerInput } from '../entities/input';
import { Player } from '../entities/player';
import { PLAYER_FRAMES, PLAYER_TEXTURE_KEY } from '../entities/playerSprite';
import { RoadRenderer } from '../render/RoadRenderer';
import { Segment } from '../track/segment';
import { buildSamplerTrack } from '../track/testTrack';

const SKY_COLOR = '#8fd0ff';

// Player sprite is drawn at a FIXED screen position (design-spec §3.5) — it
// does NOT go through project(); only its frame/sway/bob react to state.
const PLAYER_SPRITE_SCALE = 2.5; // 32px base art scaled up for screen readability
const PLAYER_SPRITE_BASE_Y = SCREEN_H - 110; // fixed screen position near bottom-center
const PLAYER_LEAN_SWAY_PX = 40; // horizontal sway range across the full lane-offset span
const PLAYER_JUMP_RISE_PX = 60; // sprite bob height at jump apex

/**
 * Task 4 scope: a player entity with world-Z/speed, lane-shift + jump
 * controls, and a camera that follows the player instead of free-running on
 * its own (Tasks 2-3's `camZ` auto-scroll is now `player.worldZ`). The
 * player sprite renders at a fixed screen position (§3.5) — it's the one
 * entity that skips the world-to-screen projection Task 6 will formalize for
 * obstacles/AI riders.
 */
export class RaceScene extends Phaser.Scene {
  private track: Segment[] = [];
  private roadRenderer!: RoadRenderer;
  private player!: Player;
  private playerSprite!: Phaser.GameObjects.Sprite;

  constructor() {
    super({ key: 'RaceScene' });
  }

  create(): void {
    // Static sky/backdrop (design-spec §3.6 step 1): a flat camera
    // background color repaints behind everything each frame for free.
    this.cameras.main.setBackgroundColor(SKY_COLOR);

    this.track = buildSamplerTrack();
    this.roadRenderer = new RoadRenderer(this);

    this.player = new Player();
    bindPlayerInput(this, this.player);

    this.playerSprite = this.add.sprite(SCREEN_W / 2, PLAYER_SPRITE_BASE_Y, PLAYER_TEXTURE_KEY, PLAYER_FRAMES.CENTER);
    this.playerSprite.setOrigin(0.5, 1);
    this.playerSprite.setScale(PLAYER_SPRITE_SCALE);
  }

  update(_time: number, delta: number): void {
    this.player.update(delta);

    // The sampler track loops; wrap the player's world-Z the same way the
    // old auto-scroll `camZ` did, so it stays numerically small over a long
    // session instead of growing unbounded (Task 5 replaces this with a
    // real fixed-length, non-looping course).
    const trackLength = this.track.length * SEGMENT_LENGTH;
    if (trackLength > 0) {
      this.player.worldZ = ((this.player.worldZ % trackLength) + trackLength) % trackLength;
    }

    // Camera follows the player (§4.1): camZ/camX derive from the player's
    // world-Z and lane offset. Camera height comes from the ROAD's elevation
    // at the player's world-Z (via player.camY), never the jump-arc height,
    // so the camera stays smooth through jumps, including over hills.
    const camZ = this.player.worldZ;
    const camX = this.player.worldX;
    const camY = this.player.camY(this.track);

    this.roadRenderer.render(this.track, camX, camY, camZ);
    this.updatePlayerSprite();
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
