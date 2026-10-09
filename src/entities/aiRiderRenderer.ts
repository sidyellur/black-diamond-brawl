import Phaser from 'phaser';
import { HIT_FLASH_MS, HIT_REACTION_MS, MAX_ENTITY_SCREEN_FRACTION, SCREEN_W, RIDER_WIDTH_FRACTION, RIDER_JUMP_HEIGHT_WORLD } from '../config';
import { entityDepth } from '../render/depth';
import { UI } from '../render/palette';
import { ShadowRenderer } from '../render/ShadowRenderer';
import { Camera, projectEntity, softClampWidth } from '../render/projectEntity';
import { DrawnSegment } from '../render/RoadRenderer';
import { Segment } from '../track/segment';
import { AIRider } from './aiRider';
import { PERSONALITIES } from './personality';
import { EVADE_TIMING_MS } from './skillCombat';
import { AI_RIDER_TEXTURE_KEYS, PLAYER_FRAME_SIZE, PLAYER_FRAMES } from './playerSprite';

// On-screen width of a rider as a fraction of the projected road half-width
// at its depth. Shared verbatim with the player (see RaceScene's
// PLAYER_WIDTH_FRACTION) — the player and its rivals are the same kind of
// object, so any divergence here shows up immediately as rivals that dwarf
// or shrink against the rider you control.
const WIDTH_FRACTION = RIDER_WIDTH_FRACTION;


/**
 * Draws all 4 AI riders each frame (design-spec §3.5/§3.6/§4.5), reusing the
 * SAME entity-projection helper `ObstacleRenderer` uses — riders slide
 * through curves and vanish behind crests exactly like every other entity.
 * Each rider gets a dedicated pooled sprite (stable per rider index, unlike
 * `ObstacleRenderer`'s anonymous draw-order pool — there are only ever 4
 * riders and each keeps its own palette-swapped texture for its lifetime).
 * A rider whose projection is `null` (behind camera, beyond draw distance,
 * or crest-clipped) is simply hidden this frame — its world-Z keeps
 * advancing in `AIRider.update()` regardless, so it reappears at the right
 * spot instead of teleporting.
 */
export class AIRiderRenderer {
  private readonly pool: Phaser.GameObjects.Sprite[] = [];
  private readonly labels: Phaser.GameObjects.Text[] = [];
  private readonly tells: Phaser.GameObjects.Graphics[] = [];
  /** Tells use shape, text and fill rather than flashing or motion. */
  reducedMotion = false;
  private readonly scene: Phaser.Scene;
  /** Called for every sprite the pool creates. The pool grows lazily
   *  mid-race, so a UI camera must be told to ignore each new sprite as it
   *  appears or it renders twice — once in the world, once over the HUD. */
  private readonly onCreate?: (obj: Phaser.GameObjects.GameObject) => void;

  constructor(scene: Phaser.Scene, onCreate?: (obj: Phaser.GameObjects.GameObject) => void) {
    this.scene = scene;
    this.onCreate = onCreate;
  }

  render(
    riders: AIRider[],
    track: Segment[],
    drawnSegments: Map<number, DrawnSegment>,
    camera: Camera,
    shadows?: ShadowRenderer
  ): void {
    riders.forEach((rider, index) => {
      const sprite = this.acquire(index, rider.params.paletteIndex);
      // Always projected, even for a wiped-out rider: a treed rival stays
      // visible, frozen in a crashed pose at its crash spot, exactly like the
      // player's own wipeout — it isn't despawned, just out of the race (see
      // RaceScene's standings log for "out of the race" bookkeeping).
      const projected = projectEntity(rider.laneOffsetFraction, rider.worldZ, track, drawnSegments, camera,
        rider.jumpArcHeight * RIDER_JUMP_HEIGHT_WORLD, rider.airborne);
      const label = this.labels[index];
      const tell = this.tells[index];
      tell.clear();
      if (!projected) {
        sprite.setVisible(false); // behind camera, beyond draw distance, or crest-clipped
        label.setVisible(false);
        return;
      }

      // Frame priority: a crash outranks a recoil, which outranks steering.
      // The recoil tier is what makes a landed hit legible at all — without
      // it a struck rival showed the same lean pose as one voluntarily
      // changing lanes, so hitting someone and watching them dodge looked
      // identical.
      const lean = rider.leanDirection;
      const frame =
        rider.wipedOut || rider.tumbling
          ? PLAYER_FRAMES.TUMBLE
          : rider.hitReacting
            ? PLAYER_FRAMES.HIT
            : rider.attackPhase === 'strike'
              ? PLAYER_FRAMES.SWING
              : rider.airborne
                ? PLAYER_FRAMES.JUMP
                : rider.attackPhase === 'windup'
                  ? (rider.attackTargetFraction < rider.laneOffsetFraction ? PLAYER_FRAMES.LEAN_LEFT : PLAYER_FRAMES.LEAN_RIGHT)
            : lean < 0
              ? PLAYER_FRAMES.LEAN_LEFT
              : lean > 0
                ? PLAYER_FRAMES.LEAN_RIGHT
                : PLAYER_FRAMES.CENTER;

      sprite.setFrame(frame);

      // A brief white-out on the frames right after impact. Safe to tint:
      // rival palettes are baked into separate textures, so nothing else
      // relies on the sprite's tint.
      if (rider.hitReactionMsRemaining > HIT_REACTION_MS - HIT_FLASH_MS) {
        sprite.setTintFill(0xffffff);
      } else {
        sprite.clearTint();
      }
      const widthPx = softClampWidth(
        projected.screenW * WIDTH_FRACTION,
        SCREEN_W * MAX_ENTITY_SCREEN_FRACTION
      );
      sprite.setScale(widthPx / PLAYER_FRAME_SIZE);
      const angle = this.reducedMotion ? 0 : rider.tumbling ? Math.sin(this.scene.time.now / 90) * 28
        : rider.hitReacting ? -10 : lean * 7;
      sprite.setAngle(Phaser.Math.Linear(sprite.angle, angle, 0.28));
      sprite.setPosition(projected.screenX, projected.screenY);
      // Nearer (smaller world-Z) -> higher depth -> drawn on top, same
      // far-to-near convention `ObstacleRenderer` uses.
      sprite.setDepth(entityDepth(rider.worldZ));
      sprite.setVisible(true);
      const ground = projectEntity(rider.laneOffsetFraction, rider.worldZ, track, drawnSegments, camera);
      if (ground) shadows?.draw(ground.screenX, ground.screenY, widthPx, rider.jumpArcHeight);
      this.drawTell(rider, index, projected.screenX, projected.screenY, widthPx);
    });
    // Practice can replace a field with fewer opponents inside one scene.
    for (let index = riders.length; index < this.pool.length; index++) {
      this.pool[index].setVisible(false);
      this.labels[index].setVisible(false);
      this.tells[index].clear();
    }
  }

  private drawTell(rider: AIRider, index: number, x: number, y: number, width: number): void {
    const label = this.labels[index];
    const tell = this.tells[index];
    if (rider.wipedOut || width < 22) { label.setVisible(false); return; }
    const definition = PERSONALITIES[rider.personality];
    const winding = rider.attackPhase === 'windup';
    const late = winding && definition.windupMs - rider.attackElapsedMs <= EVADE_TIMING_MS;
    const phase = winding ? (late ? 'EVADE NOW' : 'WIND-UP') : rider.attackPhase === 'strike' ? 'STRIKE' :
      rider.attackPhase === 'recovery' ? 'OPEN' : rider.airborne ? 'AIR' : '';
    const name = width >= 55 ? (rider.params.name ?? definition.name) : definition.glyph;
    const subtitle = phase || (rider.params.name && width >= 55 ? definition.name : '');
    label.setText(subtitle ? `${definition.glyph} ${name}\n${subtitle}` : `${definition.glyph} ${name}`);
    label.setFontSize(Math.min(13, Math.max(10, width * 0.12)));
    label.setPosition(x, Math.max(48, y - width * 0.92 - 8));
    label.setColor(late ? '#ffffff' : phase === 'OPEN' ? '#46d38a' : '#f5a623');
    label.setDepth(entityDepth(rider.worldZ) + 0.5).setVisible(true);
    tell.setDepth(entityDepth(rider.worldZ) + 0.4);
    if (winding) {
      const barWidth = Math.max(42, Math.min(85, width * 0.85));
      const barY = label.y + 3;
      tell.fillStyle(UI.panel, 0.95).fillRect(x - barWidth / 2 - 2, barY - 2, barWidth + 4, 8);
      tell.fillStyle(late ? UI.inkHigh : UI.accentWarn).fillRect(x - barWidth / 2, barY, barWidth * rider.attackProgress, 4);
      // A static bracket around the rider remains readable in grayscale and
      // reduced-motion mode. Its width does not pulse with wall-clock time.
      tell.lineStyle(2, late ? UI.inkHigh : UI.accentWarn, 1);
      tell.strokeRect(x - width * 0.33, y - width * 0.7, width * 0.66, width * 0.65);
    }
  }

  private acquire(index: number, paletteIndex: number): Phaser.GameObjects.Sprite {
    let sprite = this.pool[index];
    if (!sprite) {
      sprite = this.scene.add.sprite(0, 0, AI_RIDER_TEXTURE_KEYS[paletteIndex], PLAYER_FRAMES.CENTER);
      sprite.setOrigin(0.5, 1);
      this.pool[index] = sprite;
      const label = this.scene.add.text(0, 0, '', {
        fontFamily: 'Arial, sans-serif', fontSize: '12px', fontStyle: 'bold',
        color: '#f5a623', backgroundColor: '#121a24', align: 'center', padding: { x: 4, y: 2 }
      }).setOrigin(0.5, 1);
      const tell = this.scene.add.graphics();
      this.labels[index] = label;
      this.tells[index] = tell;
      this.onCreate?.(sprite);
      this.onCreate?.(label);
      this.onCreate?.(tell);
    }
    return sprite;
  }
}
