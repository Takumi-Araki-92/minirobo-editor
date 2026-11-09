import test from "node:test";
import assert from "node:assert/strict";
import { createProject, newTrack, newAction, compilePlan, samplePlan, validateProject, copyMapLayout,
  useTimelineOnly, projectForSave } from "../public/model.js";

function fixture(end = 10, kind = "human") {
  const project = createProject({ ordered: true }), map = project.maps[0];
  project.schema = "robot-scene/v4"; map.executionMode = "timed";
  map.rooms = [
    { id: "left", name: "Left", kind: "room", material: "tile", color: "#123456", x: 0, y: 0, width: 800, height: 900,
      cells: Array.from({ length: 576 }, (_, i) => i).filter(i => i % 32 < 16) },
    { id: "right", name: "Right", kind: "room", material: "carpet", color: "#123456", x: 800, y: 0, width: 800, height: 900,
      cells: Array.from({ length: 576 }, (_, i) => i).filter(i => i % 32 >= 16) },
  ];
  map.floorPlan = { furniture: [], doors: Array.from({ length: 6 }, (_, index) => ({
    id: `door-${index}`, roomId: "right", cell: (6 + index) * 32 + 16, edge: "left",
  })) };
  map.tracks = [];
  const human = newTrack(map, kind);
  human.initial = { x: 125, y: 425, yaw: 0, roomId: "left" }; map.tracks.push(human);
  const move = newAction(map, human, "move");
  Object.assign(move, { x: 1475, y: 425, position: 0, runSeconds: 10, roomId: "right" });
  human.actions.push(move);
  const doors = newTrack(map, "room"); doors.roomId = "right"; map.tracks.push(doors);
  const unlock = newAction(map, doors, "unlock");
  Object.assign(unlock, { roomId: "right", position: 0, runSeconds: end }); doors.actions.push(unlock);
  return { project, map, human, move, doors, unlock };
}
test("unlock bars have exact duration and use only their owning room", () => {
  const { project, map, unlock } = fixture(8);
  validateProject(project);
  const plan = compilePlan(map, { fixedTimeline: true });
  assert.deepEqual(plan.errors, []);
  assert.equal(samplePlan(plan, 7.999).doors[0].unlocked, true);
  assert.equal(samplePlan(plan, 8).doors[0].unlocked, false);
  assert.equal(samplePlan(plan, 8).doors[0].held, false);
  unlock.roomId = "left";
  const locked = compilePlan(map, { fixedTimeline: true });
  assert.match(locked.errors.join(" "), /施錠/);
  assert.equal(locked.entries[0].blocked, true);
  assert.equal(samplePlan(locked, 10).actors[0].x, 125);
  assert.equal(samplePlan(locked, 10).actionStates[locked.entries[0].action.id].result.simulatedPosition, null);
});
test("expiry during passage holds safely until clear and is deterministic when seeking", () => {
  const { map } = fixture(5);
  const plan = compilePlan(map, { fixedTimeline: true });
  assert.deepEqual(plan.errors, []);
  assert.equal(samplePlan(plan, 5).doors[0].unlocked, false);
  assert.equal(samplePlan(plan, 5).doors[0].held, true);
  assert.equal(samplePlan(plan, 6).doors[0].held, false);
  assert.equal(samplePlan(plan, 5).doors[0].held, true);
  assert.equal(samplePlan(plan, 0).doors[0].unlocked, true);
});

test("unlocked doors advertise only actors whose current path crosses that doorway", () => {
  const { map, human, move } = fixture(10);
  let plan = compilePlan(map, { fixedTimeline: true });
  assert.deepEqual(samplePlan(plan, 3).doors[0].actorIds, [human.id]);
  assert.deepEqual(samplePlan(plan, 10).doors[0].actorIds, []);
  // 近くを並行に歩くだけなら、解錠中でもドアの利用者にしない。
  human.initial = { x: 625, y: 325, yaw: 90, roomId: "left" };
  Object.assign(move, { x: 625, y: 625, roomId: "left" });
  plan = compilePlan(map, { fixedTimeline: true });
  assert.deepEqual(plan.errors, []);
  assert.equal(samplePlan(plan, 3).doors[0].unlocked, true);
  assert.deepEqual(samplePlan(plan, 3).doors[0].actorIds, []);
  assert.deepEqual(samplePlan(plan, 3).doors, samplePlan(plan, 3).doors);
  assert.equal(samplePlan(plan, 3).doors[0].openness, 0);
});

test("short robot passages open during the preceding turn and close gradually after arrival", () => {
  const { map, human: robot, move, unlock } = fixture(9, "robot");
  robot.initial.x = 325;
  const approach = Object.assign(newAction(map, robot, "move"), {
    position: 8, runSeconds: 3, x: 675, y: 425, yaw: 0, roomId: "left",
  });
  const turn = Object.assign(newAction(map, robot, "move"), {
    position: 11, runSeconds: 1, motion: "rotate", rotationSeconds: 1,
    x: 675, y: 425, yaw: 0, angularSpeed: 90, roomId: "left",
  });
  Object.assign(move, { position: 12, runSeconds: 2.5, x: 925 });
  robot.actions = [approach, turn, move]; unlock.position = 7;
  const plan = compilePlan(map, { fixedTimeline: true });
  assert.deepEqual(plan.errors, []);
  const at = time => samplePlan(plan, time).doors[0].openness;
  assert.equal(at(11.39), 0);
  assert.ok(at(11.55) > 0 && at(11.55) < at(11.7));
  assert.ok(at(11.7) < at(11.85) && at(11.85) < 1);
  assert.equal(at(12), 1);
  assert.equal(at(14.5), 1);
  assert.ok(at(14.65) > at(14.8) && at(14.8) > at(14.95));
  assert.equal(at(15.11), 0);
  for (let t = 10; t <= 16; t += .01) {
    assert.ok(Math.abs(at(t) - at(t - .01)) < .025, `開度が急変: ${t}`);
  }
  for (const t of [14.8, 11.7, 12, 14.8]) {
    assert.deepEqual(samplePlan(plan, t).doors, samplePlan(compilePlan(map, { fixedTimeline: true }), t).doors);
  }
  assert.equal(plan.entries.find(e => e.action.id === move.id).start, 12);
  assert.equal(plan.entries.find(e => e.action.id === move.id).end, 14.5);
});

test("meeting room doors remain continuous at arrival, waiting and departure boundaries", () => {
  const { map, human, move } = fixture(12);
  human.initial.x = 575;
  Object.assign(move, { runSeconds: 3, x: 925 });
  human.actions.push(Object.assign(newAction(map, human, "move"), {
    position: 5, runSeconds: 3, x: 575, y: 425, roomId: "left",
  }));
  const plan = compilePlan(map, { fixedTimeline: true });
  assert.deepEqual(plan.errors, []);
  const at = t => samplePlan(plan, t).doors[0].openness;
  assert.equal(at(0), 0);
  assert.ok(at(3) > .9);
  assert.ok(at(3.2) > 0 && at(3.2) < at(3));
  assert.equal(at(4), 0);
  assert.ok(at(4.6) > 0 && at(4.6) < at(4.8));
  assert.ok(at(5) > .9);
  for (let t = .01; t <= 10; t += .01) {
    assert.ok(Math.abs(at(t) - at(t - .01)) < .025, `開度が急変: ${t}`);
  }
});

test("story-only mode warns for locked passages without stopping motion or opening doors", () => {
  const { map, human } = fixture(0);
  map.doorMode = "story";
  const plan = compilePlan(map, { fixedTimeline: true });
  assert.deepEqual(plan.errors, []);
  assert.ok(plan.warnings.some(w => w.code === "door-preview" && w.message.includes("実機通行の許可ではありません")));
  const end = samplePlan(plan, 10);
  assert.equal(end.actors.find(a => a.id === human.id).x, 1475);
  assert.equal(end.doors[0].unlocked, false);
  delete map.doorMode;
  assert.ok(compilePlan(map, { fixedTimeline: true }).errors.some(e => e.includes("施錠")));
});

test("editor migration keeps robot timing through locked doors and preserves explicit strict mode", () => {
  for (const unlockStart of [0, 7]) {
    const { project, map, human: robot, move, unlock, doors } = fixture(1, "robot");
    if (!unlockStart) doors.actions = [];
    unlock.position = unlockStart;
    const next = Object.assign(newAction(map, robot, "wait"), { position: 10, runSeconds: 2 });
    robot.actions.push(next);
    const before = structuredClone(robot.actions.map(a => [a.id, a.position, a.runSeconds]));
    useTimelineOnly(project);
    assert.equal(map.doorMode, "story");
    const plan = compilePlan(map, { fixedTimeline: true });
    assert.deepEqual(plan.errors, []);
    assert.ok(plan.warnings.some(w => w.code === "door-preview"));
    assert.deepEqual(robot.actions.map(a => [a.id, a.position, a.runSeconds]), before);
    assert.equal(plan.entries.find(e => e.action.id === move.id).start, 0);
    assert.equal(plan.entries.find(e => e.action.id === move.id).end, 10);
    assert.equal(plan.entries.find(e => e.action.id === next.id).start, 10);
    for (const time of [5, 10, 5]) {
      const state = samplePlan(plan, time);
      assert.equal(state.actors.find(a => a.id === robot.id).x, 125 + 135 * time);
      assert.equal(state.doors[0].unlocked, false);
    }
    const restored = useTimelineOnly(JSON.parse(JSON.stringify(projectForSave(project))));
    assert.equal(restored.schema, "robot-scene/v4");
    assert.equal(projectForSave(restored).schema, "robot-scene/v5");
    assert.equal(restored.maps[0].doorMode, "story");
    map.doorMode = "strict";
    useTimelineOnly(project);
    assert.equal(map.doorMode, "strict");
    const strict = compilePlan(map, { fixedTimeline: true });
    assert.ok(strict.entries.find(e => e.action.id === move.id).blocked);
    assert.ok(strict.entries.find(e => e.action.id === next.id).blocked);
  }
});

test("story default does not allow robots to cross walls outside a doorway", () => {
  const { project, map, human: robot, move } = fixture(0, "robot");
  robot.initial.y = 175; move.y = 175;
  useTimelineOnly(project);
  const plan = compilePlan(map, { fixedTimeline: true });
  assert.ok(plan.errors.length);
  assert.equal(plan.entries.find(e => e.action.id === move.id).geometryFailure, true);
  assert.equal(samplePlan(plan, 10).actors.find(a => a.id === robot.id).x, 125);
});

test("named independent gates unlock individually, not every gate owned by the corridor", () => {
  const { project, map, unlock, human } = fixture(10);
  map.rooms = [{ ...map.rooms[0], width: 1600,
    cells: Array.from({ length: 576 }, (_, i) => i) }];
  human.initial.roomId = "left"; human.actions[0].roomId = "left";
  map.tracks[1].roomId = "left"; unlock.roomId = "left";
  map.floorPlan = { furniture: [], walls: [
    { id: "partition", roomId: "left", x1: 800, y1: 0, x2: 800, y2: 900 },
  ], doors: [
    { id: "entrance", name: "入口", kind: "automatic", roomId: "left", wallId: "partition",
      x1: 800, y1: 350, x2: 800, y2: 650 },
    { id: "other-gate", name: "別ゲート", kind: "flapper", roomId: "left", wallId: "partition",
      x1: 800, y1: 50, x2: 800, y2: 250 },
  ] };
  unlock.doorId = "entrance";
  validateProject(project);
  const plan = compilePlan(map, { fixedTimeline: true });
  assert.deepEqual(plan.errors, []);
  const state = samplePlan(plan, 3);
  assert.equal(state.doors.find(door => door.id === "entrance").unlocked, true);
  assert.equal(state.doors.find(door => door.id === "other-gate").unlocked, false);
  unlock.doorId = "other-gate";
  assert.ok(compilePlan(map, { fixedTimeline: true }).errors.some(error => error.includes("施錠")));
});
test("unlock must be active before the leading footprint reaches the doorway", () => {
  const { map, unlock, move } = fixture(10);
  unlock.position = 4.99;
  const plan = compilePlan(map, { fixedTimeline: true });
  assert.equal(plan.entries.find(e => e.action.id === move.id).blocked, true);
  assert.match(plan.errors.join(" "), /施錠/);
});
test("muted, failed and invalid unlock controls never permit a passage", () => {
  for (const change of [({ doors }) => { doors.muted = true; },
    ({ unlock }) => { unlock.trigger.sources = [{ actionId: "$start", event: "start", delay: 20 }]; }]) {
    const data = fixture(); change(data);
    const plan = compilePlan(data.map, { fixedTimeline: true });
    assert.equal(plan.entries.find(e => e.action.id === data.move.id).blocked, true);
    assert.equal(samplePlan(plan, 5).doors[0].unlocked, false);
  }
  const { project, unlock } = fixture();
  unlock.roomId = "";
  assert.throws(() => validateProject(project), /解錠する部屋/);
});
test("layout reuse preserves the full appearance but creates independent IDs and empty sequences", () => {
  const { project, map } = fixture(), before = structuredClone(map);
  map.rooms[0].appearance = "continuing-hall";
  const copied = copyMapLayout(map, "Alternate");
  assert.notEqual(copied.id, map.id);
  assert.equal(copied.rooms[0].appearance, "continuing-hall");
  assert.equal(copied.floorPlan.doors.length, map.floorPlan.doors.length);
  assert.equal(copied.floorPlan.doors[0].roomId, copied.rooms[1].id);
  assert.ok(copied.tracks.every(t => t.kind === "room" && t.actions.length === 0));
  project.maps.push(copied);
  assert.doesNotThrow(() => validateProject(project));
  copied.rooms[0].name = "Edited";
  assert.equal(map.rooms[0].name, before.rooms[0].name);
});
