import test from "node:test";
import assert from "node:assert/strict";
import { createProject, newTrack, newAction, validateProject, enableTimedMap,
  compilePlan, samplePlan, simulate, projectForSave, actionPreview, useTimelineOnly,
  timelineAlignment, addFacingTurns } from "../public/model.js";
import { createSafety, pathProblem, snapPoint, coordinatePoint, collisionWarnings } from "../public/safety.js";
import { regionBounds } from "../public/floor-plan.js";
import { createAutosave } from "../public/autosave.js";
import { compileTimedPlan } from "../public/timed-plan.js";

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
function fixture() {
  const project = createProject({ ordered: true }), map = project.maps[0];
  map.tracks = [];
  map.rooms = [{ id: "room", name: "広場", kind: "room", material: "wood", color: "#123456",
    x: 0, y: 0, width: 1600, height: 900, cells: Array.from({ length: 576 }, (_, i) => i) }];
  map.floorPlan = { doors: [], furniture: [] };
  enableTimedMap(map); project.schema = "robot-scene/v4";
  return { project, map };
}
function track(map, kind = "robot", initial = { x: 125, y: 125 }) {
  const t = newTrack(map, kind);
  if (t.initial) Object.assign(t.initial, initial, { yaw: 0, roomId: "room" });
  map.tracks.push(t); return t;
}
function action(map, track, type = "move", props = {}) {
  const a = Object.assign(newAction(map, track, type), { dwell: 0 }, props);
  track.actions.push(a); return a;
}
const after = a => ({ actionId: a.id, event: "complete", delay: 0 });
const fixedPlan = map => compilePlan(map, { fixedTimeline: true });

test("facing turns insert shared time, keep translation duration and are idempotent after edits", () => {
  const { project, map } = fixture();
  useTimelineOnly(project);
  const robot = track(map), human = track(map, "human", { x: 625, y: 125 });
  const move = action(map, robot, "move", { position: 2, runSeconds: 3, x: 125, y: 425 });
  action(map, human, "move", { position: 2, runSeconds: 3, x: 625, y: 425 });
  const doors = track(map, "room");
  doors.roomId = "room";
  const unlock = action(map, doors, "unlock", { position: 0, runSeconds: 8, roomId: "room" });
  assert.equal(addFacingTurns(map), 1);
  assert.equal(move.position, 3);
  assert.equal(move.runSeconds, 3);
  assert.equal(unlock.runSeconds, 9);
  assert.equal(human.actions.some(a => a.motion === "rotate"), false);
  for (const t of [robot]) {
    const turn = t.actions.find(a => a.motion === "rotate");
    assert.equal(turn.position, 2);
    assert.equal(turn.runSeconds, 1);
    assert.equal(turn.yaw, 90);
  }
  assert.equal(addFacingTurns(map), 0);
  move.x = 425; move.y = 125;
  assert.equal(addFacingTurns(map), 0);
  assert.equal(robot.actions.find(a => a.motion === "rotate").yaw, 0);
  validateProject(project);
  const restored = JSON.parse(JSON.stringify(projectForSave(project)));
  assert.equal(addFacingTurns(restored.maps[0]), 0);
});

test("human turn migration removes manual and generated rotations without shifting other bars", () => {
  const { project, map } = fixture();
  useTimelineOnly(project);
  const human = track(map, "human");
  const move = action(map, human, "move", { position: 4, runSeconds: 3, x: 325, y: 125 });
  action(map, human, "move", { motion: "rotate", position: 0, runSeconds: 1,
    rotationSeconds: 1, angularSpeed: 90, yaw: 90, facingFor: move.id });
  action(map, human, "move", { motion: "rotate", position: 2, runSeconds: 1,
    rotationSeconds: 1, angularSpeed: 90, yaw: 180 });
  const robot = track(map);
  const robotTurn = action(map, robot, "move", { motion: "rotate", position: 1,
    runSeconds: 1, rotationSeconds: 1, angularSpeed: 90, yaw: 90 });
  const before = structuredClone(move);
  useTimelineOnly(project);
  assert.deepEqual(human.actions, [before]);
  assert.deepEqual(robot.actions, [robotTurn]);
  assert.equal(addFacingTurns(map), 0);
  useTimelineOnly(project);
  assert.deepEqual(human.actions, [before]);
});

test("timeline alignment uses an eight-screen-pixel radius for either edge at every zoom", () => {
  const { map } = fixture(), t = track(map, "display"), other = track(map, "display");
  const moving = action(map, t, "wait", { position: 2, runSeconds: 2.1 });
  const anchor = action(map, other, "wait", { position: 8.3, runSeconds: 4.4 });
  for (const zoom of [12, 26, 60, 100]) for (const target of [8.3, 12.7]) {
    for (const edge of [0, moving.runSeconds]) {
      const desired = target - edge;
      const match = timelineAlignment(map, moving.id, desired + 6 / zoom, moving.runSeconds, zoom);
      close(match.value, desired); close(match.time, target);
      assert.match(match.name, new RegExp(anchor.name));
    }
    const duration = target - moving.position;
    const match = timelineAlignment(map, moving.id, duration + 6 / zoom, moving.position, zoom,
      { resize: true, min: .5, max: 3600 });
    close(match.value, duration); close(match.time, target);
  }
  assert.equal(timelineAlignment(map, moving.id, 8.3 + 9 / 100, moving.runSeconds, 100), null);
  assert.equal(timelineAlignment(map, moving.id, -10, moving.runSeconds, 26), null);
  other.actions = [];
  assert.equal(timelineAlignment(map, moving.id, moving.position, moving.runSeconds, 26), null);
});

test("timeline-only migration preserves bars and layout while removing joins and cyclic conditions", () => {
  const { project, map } = fixture(), t = track(map), other = track(map, "display");
  const a = action(map, t, "move", { position: 2, runSeconds: 4, x: 325, y: 125 });
  const b = action(map, other, "wait", { position: 1, runSeconds: 3 });
  a.trigger.sources = [after(b)]; b.trigger.sources = [after(a)];
  action(map, other, "join");
  const expected = structuredClone(project);
  expected.maps[0].timelineOnly = true;
  expected.maps[0].doorMode = "story";
  for (const row of expected.maps[0].tracks) {
    row.actions = row.actions.filter(a => a.type !== "join");
    for (const item of row.actions) delete item.trigger;
  }
  assert.deepEqual(useTimelineOnly(project), expected);
  assert.deepEqual(useTimelineOnly(project), expected);
  validateProject(project);
  const state = samplePlan(compilePlan(map), 3);
  close(state.actionStates[a.id].start, 2); close(state.actionStates[a.id].end, 6);
  close(state.actionStates[b.id].start, 1); close(state.actionStates[b.id].end, 4);
  close(state.actors[0].x, 175);
  assert.deepEqual(projectForSave(project).maps[0].tracks, expected.maps[0].tracks);
});

test("timeline-only new actions omit conditions, reject joins and retain timed waits", () => {
  const { project, map } = fixture(), t = track(map, "display");
  useTimelineOnly(project);
  const wait = action(map, t, "wait", { position: 3, runSeconds: 2 });
  assert.equal(Object.hasOwn(wait, "trigger"), false);
  assert.throws(() => newAction(map, t, "join"), /合流/);
  validateProject(project);
  const state = samplePlan(compilePlan(map), 4);
  close(state.actionStates[wait.id].start, 3); close(state.actionStates[wait.id].end, 5);
  wait.trigger = { mode: "all", sources: [] };
  assert.throws(() => validateProject(project), /トリガー/);
});

test("timeline-only still stops overlapping rows without blocking independent former dependencies", () => {
  const { project, map } = fixture(), t = track(map, "display"), other = track(map, "display");
  action(map, t, "wait", { position: 0, runSeconds: 4 });
  const overlap = action(map, t, "wait", { position: 2, runSeconds: 4 });
  const independent = action(map, other, "wait", { position: 3, runSeconds: 1,
    trigger: { mode: "all", sources: [after(overlap)] } });
  useTimelineOnly(project);
  const state = samplePlan(compilePlan(map), 10);
  assert.match(state.actionStates[overlap.id].reason, /重な/);
  close(state.actionStates[independent.id].start, 3);
  close(state.actionStates[independent.id].end, 4);
});

test("timeline-only migration rejects unsupported schemas and retains validation of bad coordinates", () => {
  assert.throws(() => useTimelineOnly({ schema: "robot-scene/v99", maps: [] }), /形式/);
  const { project, map } = fixture(), t = track(map);
  action(map, t, "move", { x: Infinity, y: 125, coordinateMode: "free" });
  useTimelineOnly(project);
  assert.throws(() => validateProject(project), /有限数/);
});

test("fixed timeline uses exact bar start/end and ignores physical delay simulation settings", () => {
  const { map } = fixture(), t = track(map);
  const move = action(map, t, "move", { position: 2, runSeconds: 4, x: 325, y: 125,
    dwell: 10, timeoutSeconds: 1, simulationOutcome: "failed" });
  const next = action(map, t, "move", { position: 8, runSeconds: 2, motion: "rotate", yaw: 90 });
  const plan = fixedPlan(map);
  const state = samplePlan(plan, 4);
  close(state.actors[0].x, 225);
  close(state.actionStates[move.id].start, 2); close(state.actionStates[move.id].end, 6);
  close(state.actionStates[next.id].start, 8); close(state.actionStates[next.id].end, 10);
  close(samplePlan(plan, 9).actors[0].yaw, 45);
  assert.equal(samplePlan(plan, 10).actionStates[move.id].result.status, "success");
});

test("fixed timeline rejects overlapping bars and late triggers without silently slipping", () => {
  const { map } = fixture(), t = track(map, "display"), other = track(map, "display");
  const a = action(map, t, "wait", { position: 2, runSeconds: 5 });
  const b = action(map, t, "wait", { position: 4, runSeconds: 2 });
  const c = action(map, other, "wait", { position: 3, runSeconds: 1,
    trigger: { mode: "all", sources: [after(a)] } });
  let state = samplePlan(fixedPlan(map), 20);
  assert.match(state.actionStates[b.id].reason, /重な/);
  assert.match(state.actionStates[c.id].reason, /開始時刻/);
  assert.equal(state.actionStates[c.id].start, null);
  b.position = 7; c.position = 8;
  state = samplePlan(fixedPlan(map), 0);
  close(state.actionStates[b.id].start, 7); close(state.actionStates[c.id].start, 8);
});

test("fixed timeline display and room events end exactly at the right edge of their bars", () => {
  const { map } = fixture(), t = track(map, "display"), room = track(map, "room");
  action(map, t, "show", { position: 2, runSeconds: 3, text: "hello" });
  action(map, room, "event-start", { position: 1, runSeconds: 5, roomId: "room" });
  const plan = fixedPlan(map);
  assert.equal(samplePlan(plan, 4.999).displays.length, 1);
  assert.equal(samplePlan(plan, 5).displays.length, 0);
  assert.equal(samplePlan(plan, 5.999).events.length, 1);
  assert.equal(samplePlan(plan, 6).events.length, 0);
});

test("fixed timeline event completion restores actors hidden by room aggregation", () => {
  const { map } = fixture(), robot = track(map), room = track(map, "room");
  action(map, robot, "move", { position: 2, runSeconds: 4, x: 325, y: 125 });
  action(map, room, "event-start", { position: 2, runSeconds: 4, roomId: "room" });
  const plan = fixedPlan(map);
  assert.equal(samplePlan(plan, 6).actors[0].aggregated, false);
  close(samplePlan(plan, 6).actors[0].x, 325);
});

test("editing geometry is checked independently of muted rows, failed predecessors and invalid initial poses", () => {
  for (const blockedBy of ["muted", "failed", "initial"]) {
    const { map } = fixture(), t = track(map);
    if (blockedBy === "muted") t.muted = true;
    if (blockedBy === "failed") action(map, t, "wait", { simulationOutcome: "failed" });
    if (blockedBy === "initial") t.initial.x = 25;
    const move = action(map, t, "move", { x: 25, y: 125 });
    assert.match(actionPreview(map, t.id, move).geometryProblem, /MAP外/);
    if (blockedBy !== "initial") {
      move.x = 325;
      assert.equal(actionPreview(map, t.id, move).geometryProblem, "");
    }
  }
});

test("v4 timing uses placement, actual width and downstream slip, and seeking is deterministic", () => {
  const { project, map } = fixture(), t = track(map);
  const a = action(map, t, "move", { x: 325, y: 125, position: 2, runSeconds: 4 });
  const b = action(map, t, "wait", { position: 8, runSeconds: 3 });
  const c = action(map, t, "move", { motion: "rotate", angularSpeed: 90, yaw: 90,
    runSeconds: 2, position: 11 });
  validateProject(project);
  let plan = compilePlan(map), state = samplePlan(plan, 4);
  close(state.actors[0].x, 225);
  close(state.actionStates[b.id].start, 8);
  close(samplePlan(plan, 12).actors[0].yaw, 45);
  a.runSeconds = 10;
  plan = compilePlan(map);
  close(samplePlan(plan, 0).actionStates[b.id].start, 12);
  close(samplePlan(plan, 0).actionStates[c.id].start, 15);
  assert.deepEqual(samplePlan(plan, 16), simulate(map, 16));
  assert.deepEqual(samplePlan(plan, 0), samplePlan(plan, 0));
});

test("wait holds display until hide; join waits for both successful completions", () => {
  const { project, map } = fixture(), t = track(map, "display");
  const show = action(map, t, "show", { text: "hello", runSeconds: 0, position: 0 });
  action(map, t, "wait", { runSeconds: 3, position: 0 });
  action(map, t, "hide", { targetId: show.targetId, runSeconds: 0, position: 3 });
  assert.equal(simulate(map, 2).displays.length, 1);
  assert.equal(simulate(map, 3).displays.length, 0);
  const other = track(map, "display"), a = action(map, other, "wait", { runSeconds: 5 });
  const third = track(map, "display");
  const join = action(map, third, "join", { trigger: { mode: "all", sources: [after(show), after(a)] } });
  validateProject(project);
  close(simulate(map, 0).actionStates[join.id].start, 0);
  close(simulate(map, 0).actionStates[join.id].end, 5);
  assert.equal(simulate(map, 2).actionStates[join.id].result.status, "running");
  assert.equal(simulate(map, 5).actionStates[join.id].result.status, "success");
  join.trigger.mode = "any"; assert.throws(() => validateProject(project), /合流/);
});

test("failed and timed out actions never release implicit successors or joins", () => {
  for (const props of [{ simulationOutcome: "failed" }, { timeoutSeconds: 1 }]) {
    const { project, map } = fixture(), t = track(map);
    const move = action(map, t, "move", { x: 325, y: 125, runSeconds: 4, ...props });
    const next = action(map, t, "wait");
    const other = track(map, "display"), w = action(map, other, "wait");
    const join = action(map, other, "join", { trigger: { mode: "all", sources: [after(move), after(w)] } });
    validateProject(project);
    const s = simulate(map, 20);
    assert.equal(s.actionStates[move.id].result.status, props.timeoutSeconds ? "timeout" : "failed");
    assert.equal(s.actionStates[next.id].status, "blocked");
    assert.equal(s.actionStates[join.id].status, "blocked");
    assert.equal(s.actionStates[move.id].result.measuredPosition, null);
    assert.equal(s.actionStates[move.id].result.source, "simulation");
    assert.match(s.actionStates[next.id].reason, /成功/);
    if (props.timeoutSeconds) close(s.actors[0].x, 175);
  }
});

test("joining timeout includes time waiting for dependencies", () => {
  const { map } = fixture(), a = track(map, "display"), b = track(map, "display"), c = track(map, "display");
  const x = action(map, a, "wait", { runSeconds: 5 }), y = action(map, b, "wait", { runSeconds: 8 });
  const j = action(map, c, "join", { timeoutSeconds: 2, trigger: { mode: "all", sources: [after(x), after(y)] } });
  const next = action(map, c, "wait");
  const s = simulate(map, 3);
  close(s.actionStates[j.id].end, 2);
  assert.equal(s.actionStates[j.id].result.status, "timeout");
  assert.equal(s.actionStates[next.id].status, "blocked");
});

test("timed-out rotation stops at its partial angle and never drifts after the deadline", () => {
  const { map } = fixture(), t = track(map);
  const turn = action(map, t, "move", { motion: "rotate", angularSpeed: 90,
    yaw: 90, runSeconds: 4, timeoutSeconds: 1 });
  const plan = compilePlan(map);
  close(samplePlan(plan, .5).actors[0].yaw, 11.25);
  for (const at of [1, 2, 20]) {
    const state = samplePlan(plan, at);
    close(state.actors[0].yaw, 22.5);
    close(state.actionStates[turn.id].result.simulatedPosition.yaw, 22.5);
    assert.equal(state.actors[0].moving, false);
  }
});

test("rotation is motion for room aggregation until the turn has finished", () => {
  const { map } = fixture(), t = track(map);
  action(map, t, "move", { motion: "rotate", angularSpeed: 90, yaw: 90, runSeconds: 4 });
  const r = track(map, "room");
  action(map, r, "event-start", { position: 1, runSeconds: 0, roomId: "room" });
  const during = simulate(map, 2).actors[0];
  assert.equal(during.moving, true);
  assert.equal(during.aggregated, false);
  assert.equal(simulate(map, 4).actors[0].aggregated, true);
});

test("failure or timeout during arrival dwell preserves the reached position and angle", () => {
  for (const props of [{ simulationOutcome: "failed" }, { timeoutSeconds: 4.1 }]) {
    const { map } = fixture(), t = track(map);
    const rotate = action(map, t, "move", { motion: "rotate", angularSpeed: 90, yaw: 90,
      runSeconds: 4, dwell: .3, ...props });
    const plan = compilePlan(map);
    close(samplePlan(plan, 2).actors[0].yaw, 45);
    const state = samplePlan(plan, 10);
    close(state.actors[0].yaw, 90);
    close(state.actionStates[rotate.id].result.simulatedPosition.yaw, 90);
    const move = Object.assign(rotate, { motion: "linear", x: 325 });
    delete move.rotationSeconds;
    const after = simulate(map, 10);
    close(after.actors[0].x, 325);
    close(after.actionStates[move.id].result.simulatedPosition.x, 325);
  }
});

test("new timed actions add dwell only after movement, not display or wait", () => {
  for (const type of ["move", "show", "wait"]) {
    const { map } = fixture(), t = track(map);
    const a = action(map, t, type, { position: 2, runSeconds: 3, dwell: .3 });
    const next = newAction(map, t, "wait");
    close(next.position, 5 + (type === "move" ? .3 : 0));
    close(simulate(map, 0).actionStates[a.id].start, 2);
  }
});

test("grid snap uses cell centers at all edges", () => {
  assert.deepEqual(snapPoint(0, 0), { x: 25, y: 25 });
  assert.deepEqual(snapPoint(1600, 900), { x: 1575, y: 875 });
  assert.deepEqual(snapPoint(51, 101), { x: 75, y: 125 });
  assert.throws(() => snapPoint(NaN, 0));
});

test("free coordinates preserve decimals, constrain axes from the origin, and validate explicitly", () => {
  const origin = { x: 125, y: 175 };
  assert.deepEqual(coordinatePoint(331.25, 201.5, "free"), { x: 331.25, y: 201.5 });
  assert.deepEqual(coordinatePoint(331.25, 201.5, "grid"), { x: 325, y: 225 });
  assert.deepEqual(coordinatePoint(331.25, 201.5, "free", origin, true), { x: 331.25, y: 175 });
  assert.deepEqual(coordinatePoint(131, 501.5, "free", origin, true), { x: 125, y: 501.5 });
  assert.deepEqual(coordinatePoint(-10, 901, "free"), { x: 0, y: 900 });
  assert.throws(() => coordinatePoint(NaN, 1, "free"));
  const { project, map } = fixture(), t = track(map);
  Object.assign(t.initial, { coordinateMode: "free", x: 126.25, y: 176.5 });
  const move = action(map, t, "move", { coordinateMode: "free", x: 331.25, y: 201.5 });
  validateProject(project);
  assert.deepEqual(projectForSave(project).maps[0].tracks[0].initial, t.initial);
  close(simulate(map, 10).actors[0].x, 331.25);
  close(newAction(map, t, "move").x, 331.25);
  assert.equal(newAction(map, t, "move").coordinateMode, "free");
  move.coordinateMode = "grid";
  assert.throws(() => validateProject(project), /グリッド中央/);
  move.coordinateMode = "invalid";
  assert.throws(() => validateProject(project), /モード/);
  delete move.coordinateMode;
  assert.throws(() => validateProject(project), /グリッド中央/);
});

test("walls, furniture, unassigned cells and swept body clearance block paths", () => {
  const { map } = fixture();
  const left = Array.from({ length: 18 }, (_, r) => Array.from({ length: 10 }, (_, c) => r * 32 + c)).flat();
  map.rooms[0].cells = left; Object.assign(map.rooms[0], regionBounds(left));
  let s = createSafety(map);
  assert.match(pathProblem(s, { x: 125, y: 125 }, { x: 625, y: 125 }), /壁|通行/);
  assert.match(pathProblem(s, { x: 25, y: 125 }, { x: 125, y: 125 }), /MAP外/);
  assert.match(pathProblem(s, { x: 75, y: 25 }, { x: 75, y: 125 }), /MAP外/);
  assert.equal(pathProblem(s, { x: 125, y: 125 }, { x: 325, y: 125 }), "");
  assert.match(pathProblem(s, { x: 55, y: 125 }, { x: 55, y: 325 }), /MAP外/);
  map.floorPlan.furniture.push({ id: "desk", roomId: "room", type: "desk", cell: 16 * 32 + 4, rotation: 0 });
  s = createSafety(map);
  assert.match(pathProblem(s, { x: 125, y: 75 }, { x: 325, y: 75 }), /家具/);
  const { map: unavailable } = fixture(); delete unavailable.floorPlan;
  assert.match(pathProblem(createSafety(unavailable), { x: 125, y: 125 }, { x: 325, y: 125 }), /判定できません/);
});

test("imported invalid initial poses are explicitly blocked even without any movement action", () => {
  const { project, map } = fixture(), t = track(map, "robot", { x: 25, y: 125 });
  const wait = action(map, t, "wait");
  validateProject(project);
  const state = simulate(map, 20);
  assert.ok(state.errors.some(e => e.includes("初期位置") && e.includes("MAP外")));
  assert.equal(state.actionStates[wait.id].result.status, "blocked");
  assert.match(state.actionStates[wait.id].reason, /初期位置/);
  t.muted = true;
  assert.equal(simulate(map, 20).errors.length, 0);
});

test("continuous closest approach detects human/robot crossings and stationary actors", () => {
  const move = (from, to, start = 0, end = 1) => [{ from, to, start, end }];
  const a = { id: "a", name: "R", kind: "robot", segments: move({ x: 0, y: 50 }, { x: 100, y: 50 }) };
  const b = { id: "b", name: "H", kind: "human", segments: move({ x: 50, y: 0 }, { x: 50, y: 100 }) };
  assert.equal(collisionWarnings([a, b]).length, 1);
  b.segments = move({ x: 50, y: 50 }, { x: 50, y: 50 });
  assert.equal(collisionWarnings([a, b]).length, 1);
  b.segments = move({ x: 50, y: 500 }, { x: 50, y: 600 });
  assert.equal(collisionWarnings([a, b]).length, 0);
});

function corridorFixture(width = 3) {
  const { project, map } = fixture();
  const top = 7, bottom = top + width - 1;
  const cells = (left, right, first = 0, last = 17) =>
    Array.from({ length: last - first + 1 }, (_, r) =>
      Array.from({ length: right - left + 1 }, (_, c) => (r + first) * 32 + c + left)).flat();
  map.rooms = [
    { id: "left", cells: cells(0, 5), kind: "room" },
    { id: "hall", cells: cells(6, 23, top, bottom), kind: "corridor" },
    { id: "right", cells: cells(24, 31), kind: "room" },
  ].map(r => ({ ...r, ...regionBounds(r.cells), name: r.id, material: "tile", color: "#123456" }));
  for (let r = top; r <= bottom; r++) {
    map.floorPlan.doors.push({ id: `left-${r}`, roomId: "left", cell: r * 32 + 5, edge: "right" });
    map.floorPlan.doors.push({ id: `right-${r}`, roomId: "right", cell: r * 32 + 24, edge: "left" });
  }
  return { project, map };
}

test("fixed timeline reports corridor conflicts instead of adding invisible waiting time", () => {
  const { map } = corridorFixture();
  const a = track(map, "robot", { x: 225, y: 475 }), b = track(map, "robot", { x: 1375, y: 475 });
  a.initial.roomId = "left"; b.initial.roomId = "right";
  action(map, a, "move", { x: 1375, y: 475, roomId: "right", runSeconds: 10 });
  action(map, b, "move", { x: 225, y: 475, roomId: "left", runSeconds: 10 });
  const plan = fixedPlan(map);
  assert.ok(plan.errors.some(message => /廊下|壁|ドア/.test(message)));
  assert.ok(plan.entries.every(e => !e.waits.length));
  assert.ok(plan.entries.every(e => e.end === null || e.end <= e.action.position + e.action.runSeconds));
});

test("narrow corridors serialize opposing robots, hold outside entry and delay downstream", () => {
  const { project, map } = corridorFixture();
  const a = track(map, "robot", { x: 225, y: 475 }), b = track(map, "robot", { x: 1375, y: 475 });
  a.initial.roomId = "left"; b.initial.roomId = "right";
  const one = action(map, a, "move", { x: 1375, y: 475, roomId: "right", runSeconds: 10 });
  const two = action(map, b, "move", { x: 225, y: 475, roomId: "left", runSeconds: 10 });
  const next = action(map, b, "wait", { runSeconds: 2 });
  validateProject(project);
  const plan = compilePlan(map), state = samplePlan(plan, 0);
  assert.deepEqual(plan.errors, []);
  const waits = state.warnings.filter(w => w.code === "corridor-wait");
  assert.ok(waits.length >= 1);
  const wait = waits[0];
  assert.ok(wait.seconds > 0); assert.ok(wait.point.x > 1200 + 42);
  assert.deepEqual(new Set(wait.trackIds), new Set([a.id, b.id]));
  const e = plan.entries.find(e => e.action.id === two.id);
  const hold = e.segments.find(s => s.from.x === s.to.x && s.end > s.start);
  close(samplePlan(plan, (hold.start + hold.end) / 2).actors[1].x, wait.point.x);
  assert.ok(state.actionStates[two.id].end > 10);
  close(state.actionStates[next.id].start, state.actionStates[two.id].end);
  close(state.actionStates[one.id].end, 10);
});

test("four-cell corridors are not exclusive and parked robots in narrow corridors block entry", () => {
  let { map } = corridorFixture(4);
  assert.equal(createSafety(map).zones.size, 0);
  ({ map } = corridorFixture());
  const parked = track(map, "robot", { x: 725, y: 475 }); parked.initial.roomId = "hall";
  const moving = track(map, "robot", { x: 225, y: 475 }); moving.initial.roomId = "left";
  const move = action(map, moving, "move", { x: 1375, y: 475, runSeconds: 10, roomId: "right" });
  const s = simulate(map, 20);
  assert.equal(s.actionStates[move.id].result.status, "blocked");
  assert.match(s.actionStates[move.id].reason, /退出予定/);
  close(s.actors[1].x, 225);
});

test("a deadline expires even when the corridor occupant never has an exit plan", () => {
  const { map } = corridorFixture();
  const parked = track(map, "robot", { x: 725, y: 475 }); parked.initial.roomId = "hall";
  const moving = track(map, "robot", { x: 225, y: 475 }); moving.initial.roomId = "left";
  const move = action(map, moving, "move", { x: 1375, y: 475, roomId: "right",
    runSeconds: 10, timeoutSeconds: 2 });
  const next = action(map, moving, "wait");
  const plan = compilePlan(map);
  assert.equal(samplePlan(plan, 1).actionStates[move.id].result.status, "pending");
  const state = samplePlan(plan, 3);
  assert.equal(state.actionStates[move.id].result.status, "timeout");
  assert.equal(state.actionStates[next.id].result.status, "blocked");
  close(state.actors[1].x, 225);
});

test("a deadline covers an unresolved dependency, not just dependencies with known completion times", () => {
  const { map } = corridorFixture();
  const parked = track(map, "robot", { x: 725, y: 475 }); parked.initial.roomId = "hall";
  const moving = track(map, "robot", { x: 225, y: 475 }); moving.initial.roomId = "left";
  const move = action(map, moving, "move", { x: 1375, y: 475, roomId: "right", runSeconds: 10 });
  const display = track(map, "display");
  const wait = action(map, display, "wait", { timeoutSeconds: 2,
    trigger: { mode: "all", sources: [after(move)] } });
  const state = simulate(map, 3);
  assert.equal(state.actionStates[wait.id].result.status, "timeout");
});

test("a robot initially in a narrow corridor has priority to exit before an incoming robot", () => {
  const { project, map } = corridorFixture();
  const incoming = track(map, "robot", { x: 225, y: 475 }); incoming.initial.roomId = "left";
  const resident = track(map, "robot", { x: 725, y: 475 }); resident.initial.roomId = "hall";
  const enter = action(map, incoming, "move", { x: 1375, y: 475, roomId: "right", runSeconds: 10 });
  action(map, resident, "wait", { runSeconds: 5, position: 0 });
  const exit = action(map, resident, "move", { x: 1375, y: 475, roomId: "right", runSeconds: 5, position: 5 });
  validateProject(project);
  const state = simulate(map, 0);
  assert.ok(state.warnings.some(w => w.code === "corridor-wait"));
  assert.equal(state.actionStates[enter.id].result.status, "running");
  close(state.actionStates[exit.id].end, 10);
  assert.ok(state.actionStates[enter.id].end > 10);
});

test("nonconvergent traffic plans stop all effects instead of releasing stale downstream completions", () => {
  const { map } = corridorFixture();
  const t = track(map, "robot", { x: 725, y: 475 }); t.initial.roomId = "hall";
  action(map, t, "wait", { runSeconds: 2 });
  action(map, t, "move", { position: 2, x: 1375, y: 475, roomId: "right", runSeconds: 5 });
  const successor = action(map, t, "wait", { position: 7 });
  const display = track(map, "display");
  action(map, display, "show", { text: "must not run",
    trigger: { mode: "all", sources: [after(successor)] } });
  const plan = compileTimedPlan(map, [], 32), state = samplePlan(plan, 100);
  assert.ok(plan.errors.some(e => e.includes("収束")));
  assert.equal(state.displays.length, 0);
  assert.ok(Object.values(state.actionStates).every(a => a.result.status === "blocked"));
  assert.equal(plan.log.length, 0);
  assert.ok(Object.values(state.actionStates).every(a => a.result.simulatedPosition === null));
});

test("v4 validates fields and roundtrips without altering legacy maps", () => {
  const { project, map } = fixture(), t = track(map);
  action(map, t, "wait", { timeoutSeconds: 10 });
  assert.deepEqual(validateProject(JSON.parse(JSON.stringify(projectForSave(project)))).maps[0].tracks, map.tracks);
  for (const seconds of [-1, NaN, Infinity, "3", 86401]) {
    const bad = structuredClone(project); bad.maps[0].tracks[0].actions[0].runSeconds = seconds;
    assert.throws(() => validateProject(bad));
  }
  const old = createProject();
  assert.equal(validateProject(old).schema, "robot-scene/v2");
});

test("autosave serializes writers and stops stale tabs without overwriting", async () => {
  const data = new Map(), storage = { getItem: key => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value) };
  let tail = Promise.resolve();
  const locks = { request: (name, fn) => { const result = tail.then(fn); tail = result.catch(() => {}); return result; } };
  const notices = [], a = createAutosave(storage, "save", x => notices.push(x), locks);
  const b = createAutosave(storage, "save", x => notices.push(x), locks);
  const results = await Promise.allSettled([a.save({ revision: 1 }), b.save({ revision: 2 })]);
  assert.deepEqual(results.map(r => r.status), ["fulfilled", "rejected"]);
  assert.equal(storage.getItem("save"), '{"revision":1}');
  assert.equal(b.stopped, true); assert.equal(notices.length, 1);
  await a.save({ revision: 3 });
  assert.equal(storage.getItem("save"), '{"revision":3}');
  await assert.rejects(b.save({ revision: 4 }), /停止/);
  const unsupported = createAutosave(storage, "save", () => {});
  await assert.rejects(unsupported.save({ revision: 5 }), /対応/);
});

test("storage quota errors do not advance the save baseline and explicit recovery stops preserve raw data", async () => {
  let value = "original", full = true;
  const storage = { getItem: () => value, setItem: (key, next) => {
    if (full) throw new Error("QuotaExceededError"); value = next;
  } };
  const notices = [], locks = { request: async (name, fn) => fn() };
  const save = createAutosave(storage, "save", message => notices.push(message), locks);
  await assert.rejects(save.save({ next: 1 }), /QuotaExceededError/);
  assert.equal(value, "original");
  full = false; await save.save({ next: 2 });
  assert.equal(value, '{"next":2}');
  save.stop("復元失敗のため停止");
  await assert.rejects(save.save({ next: 3 }), /復元失敗/);
  assert.equal(value, '{"next":2}');
  assert.deepEqual(notices, []);
});

test("compiled 2000-action sampling matches fresh evaluation and stays within a frame budget", () => {
  const { project, map } = fixture(), t = track(map, "display");
  for (let i = 0; i < 2000; i++) action(map, t, "wait", { runSeconds: 1, position: i });
  validateProject(project);
  const before = JSON.stringify(map), begin = performance.now(), plan = compilePlan(map);
  const compileMs = performance.now() - begin;
  for (const at of [0, .5, 400, 1999.5, 2100]) assert.deepEqual(samplePlan(plan, at), simulate(map, at));
  const started = performance.now();
  for (let i = 0; i < 40; i++) samplePlan(plan, i * 50);
  const sampleMs = (performance.now() - started) / 40;
  assert.ok(compileMs < 2000, `compile ${compileMs.toFixed(2)}ms`);
  assert.ok(sampleMs < 16, `sample ${sampleMs.toFixed(2)}ms`);
  assert.equal(JSON.stringify(map), before);
});
