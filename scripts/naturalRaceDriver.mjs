/**
 * Accelerated natural-course acceptance driver.
 *
 * Pass this exported function directly to page.evaluate. Its body is completely
 * self-contained and also accepts a scene-shaped local model for parity tests.
 * It issues only the public player steering/jump actions, then calls the real
 * RaceScene.simulate at the production 60 Hz step. No hazard, pickup, crest,
 * rival, physics or clock value is replaced. A paused display is only a test
 * harness hold between batches; this is NOT a claim of real keyboard input or
 * real-time rendering. Use the separate keyboard acceptance for that proof.
 *
 * await page.evaluate(naturalRaceDriver, { stopAtCheckpoint: 0 });
 * await page.screenshot({ path: 'natural-checkpoint.png' });
 * const completed = await page.evaluate(naturalRaceDriver, {});
 */
export function naturalRaceDriver(options = {}) {
  const scene = options.scene ?? globalThis.__game?.scene.getScene('RaceScene');
  if (!scene || typeof scene.simulate !== 'function') throw new Error('An active RaceScene is required');
  if (scene.countdownMs > 0) throw new Error('Wait for the real countdown before driving');
  if (scene.practiceObjective) throw new Error('Natural driver requires a complete race, not practice');
  if (scene.aiRiders.length !== 4 || scene.aiCollisions.length !== 4) throw new Error('All four production rivals/colliders must be present');
  const expectedNames = ['NOVA', 'SLATE', 'FROST', 'EMBER'];
  if (scene.aiRiders.some((rider, i) => rider.params.name !== expectedNames[i])) throw new Error('Universal production roster is required');
  const dt = 1000 / 60;
  const maxSteps = options.maxSteps ?? 18000;
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 36000) throw new Error('Invalid bounded simulation step budget');
  const signature = () => JSON.stringify({
    obstacles: scene.obstacles.map(o => [o.kind, o.lane, o.z]),
    pickups: scene.pickups.map(p => [p.lane, p.z]),
    crests: scene.crestApexZs,
    rivals: scene.aiRiders.map(r => r.params)
  });
  const runId = scene.options?.runId ?? scene.seed;
  let trace = scene.__naturalAcceptance;
  if (!trace || trace.runId !== runId || scene.elapsedRaceMs < trace.lastElapsedMs) {
    trace = scene.__naturalAcceptance = {
      runId, seed: scene.seed, startElapsedMs: scene.elapsedRaceMs,
      startWorldZ: scene.player.worldZ, lastElapsedMs: scene.elapsedRaceMs,
      courseSignature: signature(), obstacleRefs: [...scene.obstacles],
      pickupRefs: [...scene.pickups], rivalRefs: [...scene.aiRiders],
      aiCollisionRefs: [...scene.aiCollisions],
      obstacles: scene.obstacles.length, pickups: scene.pickups.length,
      crests: scene.crestApexZs.length, shifts: 0, jumps: 0,
      fixedSteps: 0, crestCrossings: 0, rockRecoveries: 0,
      rivalHitReactions: 0, checkpoints: [], ghostLoaded: !!scene.ghost
    };
  }
  // A synchronous batch cannot interleave with RAF. Keep normal RAF gameplay
  // held after it returns so a screenshot/next batch does not add stray input.
  scene.paused = true;
  const player = scene.player;
  const drive = () => {
    if (scene.simulationHitStopMs > 0 || player.wipedOut || player.airborne ||
        player.tumbling || player.swinging || player.leanDirection) return;
    const nearest = (lane) => scene.obstacles.filter(o => o.lane === lane && o.z >= player.worldZ - 100)
      .reduce((best, obstacle) => !best || obstacle.z < best.z ? obstacle : best, null);
    const current = nearest(player.laneIndex);
    if (!current || current.z - player.worldZ > 1400) return;
    const candidates = [player.laneIndex - 1, player.laneIndex + 1].filter(lane => lane >= 0 && lane < 5)
      .map(lane => ({ lane, clearance: (nearest(lane)?.z ?? Infinity) - player.worldZ }))
      .sort((a, b) => b.clearance - a.clearance);
    if (candidates[0]?.clearance > 1000) {
      const previousSerial = player.maneuverSerial;
      player.requestLaneShift(candidates[0].lane > player.laneIndex ? 1 : -1);
      if (player.maneuverSerial !== previousSerial) trace.shifts++;
    } else if (current.kind !== 'tree' && current.z - player.worldZ < 420 &&
        !scene.obstacles.some(o => o.kind === 'tree' && o.lane === player.laneIndex &&
          o.z > player.worldZ && o.z < player.worldZ + 4000)) {
      // Same condition as isMogulLaunchAvailable, using the production public
      // lane fraction and constants (100-unit collision / 400-unit launch).
      const extended = scene.obstacles.some(o => o.kind === 'mogul' &&
        Math.abs((-0.8 + o.lane * 0.4) - player.laneOffsetFraction) <= 0.2 &&
        o.z - player.worldZ >= -100 && o.z - player.worldZ <= 400);
      const previousSerial = player.maneuverSerial;
      player.jump(extended);
      if (player.maneuverSerial !== previousSerial) trace.jumps++;
    }
  };
  let batchSteps = 0;
  for (; batchSteps < maxSteps && !scene.raceOver; batchSteps++) {
    drive();
    const previousZ = player.worldZ;
    const previousTumble = player.tumbling;
    const previousHit = player.hitReacting;
    scene.simulate(dt, dt);
    trace.fixedSteps++;
    trace.crestCrossings += scene.crestApexZs.filter(z => previousZ < z && player.worldZ >= z).length;
    if (!previousTumble && player.tumbling) trace.rockRecoveries++;
    if (!previousHit && player.hitReacting) trace.rivalHitReactions++;
    const split = scene.checkpoints.latest;
    if (split && !trace.checkpoints.some(s => s.index === split.index)) trace.checkpoints.push({ ...split });
    if (Number.isInteger(options.stopAtCheckpoint) && split?.index >= options.stopAtCheckpoint) {
      batchSteps++;
      break;
    }
  }
  trace.lastElapsedMs = scene.elapsedRaceMs;
  const unchanged = signature() === trace.courseSignature &&
    scene.obstacles.every((o, i) => o === trace.obstacleRefs[i]) &&
    scene.pickups.every((p, i) => p === trace.pickupRefs[i]) &&
    scene.aiRiders.every((r, i) => r === trace.rivalRefs[i]) &&
    scene.aiCollisions.every((c, i) => c === trace.aiCollisionRefs[i]);
  if (!unchanged) throw new Error('Natural course, roster, or collider identity changed');
  // Rendering at delta zero refreshes the genuine scene/HUD/ghost position
  // without consuming physics time; normal browser rendering paints it later.
  if (!scene.raceOver && options.render !== false && typeof scene.update === 'function') {
    const timeBeforeRender = scene.elapsedRaceMs;
    scene.paused = false;
    scene.update(0, 0);
    scene.paused = true;
    if (scene.elapsedRaceMs !== timeBeforeRender) throw new Error('Zero-delta render advanced gameplay');
  }
  return {
    seed: scene.seed, over: scene.raceOver, finished: scene.raceOver && !player.wipedOut,
    wipedOut: player.wipedOut, elapsedMs: scene.elapsedRaceMs,
    startElapsedMs: trace.startElapsedMs, startWorldZ: trace.startWorldZ,
    worldZ: player.worldZ, finishZ: scene.finishSegment.z,
    fixedSteps: trace.fixedSteps, batchSteps,
    obstacles: trace.obstacles, pickups: trace.pickups, collected: scene.pickups.filter(p => p.collected).length,
    crests: trace.crests, crestCrossings: trace.crestCrossings,
    shifts: trace.shifts, jumps: trace.jumps, rockRecoveries: trace.rockRecoveries,
    rivalHitReactions: trace.rivalHitReactions,
    unchangedCourseAndRoster: unchanged, ghostLoaded: trace.ghostLoaded,
    ghostSamples: scene.ghostRecorder.sampleCount,
    ghostSplit: scene.ghostSplit, checkpoints: trace.checkpoints.map(split => ({ ...split })),
    playerObstacleHits: scene.obstacles.filter(o => scene.collisions.wasHit(o)).map(o => ({ kind: o.kind, z: o.z })),
    rivals: scene.aiRiders.map((r, i) => ({ name: r.params.name, personality: r.personality,
      startZ: r.params.startZOffset, worldZ: r.worldZ, finishTimeMs: r.finishTimeMs,
      wipedOut: r.wipedOut,
      obstacleHits: scene.obstacles.filter(o => scene.aiCollisions[i].wasHit(o)).length }))
  };
}
