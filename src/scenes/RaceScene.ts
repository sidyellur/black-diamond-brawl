import Phaser from 'phaser';
import { CAMERA_HEIGHT, MAX_SPEED, SEGMENT_LENGTH } from '../config';
import { RoadRenderer } from '../render/RoadRenderer';
import { roadElevationAt, Segment } from '../track/segment';
import { buildSamplerTrack } from '../track/testTrack';

const SKY_COLOR = '#8fd0ff';

/**
 * Task 3 scope: render the curved/hilly sampler track and auto-advance the
 * camera down it at a constant speed, looping back to the start. The camera's
 * elevation follows the road under it plus a fixed height so the horizon
 * rises and falls through hills. No player entity or input yet (Task 4).
 */
export class RaceScene extends Phaser.Scene {
  private track: Segment[] = [];
  private roadRenderer!: RoadRenderer;
  private camZ = 0;

  constructor() {
    super({ key: 'RaceScene' });
  }

  create(): void {
    // Static sky/backdrop (design-spec §3.6 step 1): a flat camera
    // background color repaints behind everything each frame for free.
    this.cameras.main.setBackgroundColor(SKY_COLOR);

    this.track = buildSamplerTrack();
    this.roadRenderer = new RoadRenderer(this);
  }

  update(_time: number, delta: number): void {
    const trackLength = this.track.length * SEGMENT_LENGTH;
    const deltaSeconds = delta / 1000;

    this.camZ = (this.camZ + MAX_SPEED * deltaSeconds) % trackLength;

    // Camera elevation follows the road surface under the camera plus a fixed
    // height (§3.4), so the horizon rises and falls as hills are crested.
    const camY = roadElevationAt(this.track, this.camZ) + CAMERA_HEIGHT;

    this.roadRenderer.render(this.track, 0, camY, this.camZ);
  }
}
