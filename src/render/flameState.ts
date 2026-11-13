/**
 * The on/off life of the boost flames, kept free of Phaser so it can be tested on its own.
 *
 * It turns the simulation's `boost.active` (plus whether the rider is in the air) into a smooth
 * `power` for the renderer to scale the flames by, and into one-frame edges for the ignition
 * burst and the flame-out puff. Presentation only: nothing here feeds back into the race.
 *
 * Boost is cut while airborne and restarts on landing if the button is still held, so a jump
 * shows up here as `boosting` going false in the air: the flames sputter out over a little longer
 * than a plain release, and the next ignition after landing is marked as a re-ignite so it can
 * be a smaller burst than a fresh start.
 */
export const FLAME_RISE_MS = 90;
export const FLAME_FALL_MS = 120;
export const FLAME_SPUTTER_MS = 240;
export const FLAME_BURST_MS = 320;
/** An ignition this soon after a sputter (a jump) is a re-ignite. */
export const FLAME_REIGNITE_WINDOW_MS = 2500;

export type FlameEdge = 'none' | 'ignite' | 'reignite' | 'flameout' | 'sputter';

export class FlameState {
  /** 0..1: how much flame there is right now. 0 means nothing at all is drawn or updated. */
  power = 0;
  /** 1 at ignition, decaying to 0: drives the extra-large first flame. */
  burst = 0;
  /** What changed this update; reset on every call. */
  edge: FlameEdge = 'none';
  private was = false;
  private sputtering = false;
  private sinceSputterMs = Infinity;

  update(deltaMs: number, boosting: boolean, airborne: boolean): void {
    const dt = Math.max(0, Number.isFinite(deltaMs) ? deltaMs : 0);
    this.edge = 'none';
    this.sinceSputterMs += dt;
    if (boosting && !this.was) {
      this.edge = this.sinceSputterMs <= FLAME_REIGNITE_WINDOW_MS ? 'reignite' : 'ignite';
      this.burst = this.edge === 'ignite' ? 1 : 0.45;
      this.sputtering = false;
    } else if (!boosting && this.was) {
      this.sputtering = airborne;
      if (airborne) this.sinceSputterMs = 0;
      this.edge = airborne ? 'sputter' : 'flameout';
    }
    this.was = boosting;
    if (boosting) this.power = Math.min(1, this.power + dt / FLAME_RISE_MS);
    else this.power = Math.max(0, this.power - dt / (this.sputtering ? FLAME_SPUTTER_MS : FLAME_FALL_MS));
    this.burst = Math.max(0, this.burst - dt / FLAME_BURST_MS);
  }

  /** True while any flame is on screen (or about to be). */
  get lit(): boolean { return this.power > 0; }
  get isSputtering(): boolean { return this.sputtering && this.power > 0; }

  reset(): void {
    this.power = 0; this.burst = 0; this.edge = 'none';
    this.was = false; this.sputtering = false; this.sinceSputterMs = Infinity;
  }
}
