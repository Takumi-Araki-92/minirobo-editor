import test from "node:test";
import assert from "node:assert/strict";
import { createProject, newTrack, newAction, validateProject, projectForSave, compilePlan } from "../public/model.js";
import { ROBOT_SIDE, SCREEN_WIDTH_MM, validateFloorPlan, buildNavigation } from "../public/floor-plan.js";
import { createSafety, pathProblem, ROBOT_RADIUS } from "../public/safety.js";
import { adjustTimeline, checkSequence, reorderSequence } from "../public/timeline-edit.js";
import { exportScenario } from "../public/scenario-export.js";

test("bulk timeline validation preserves long timed durations accepted by the project schema", () => {
  const track = { name: "Long scenario", actions: [
    { name: "Wait", position: 4000.123456, runSeconds: 86400 },
  ] };
  assert.doesNotThrow(() => checkSequence(track));
  assert.throws(() => checkSequence({ ...track,
    actions: [{ name: "Too long", position: 0, runSeconds: 86401 }] }), /秒数が不正/);
  assert.throws(() => checkSequence({ ...track,
    actions: [{ name: "Legacy duration", position: 0, plannedDuration: 3601 }] }), /秒数が不正/);
});

test("batch timeline edits preserve relative starts and reject invalid edits atomically", () => {
  const map = { executionMode: "timed", tracks: [
    { id: "one", name: "One", actions: [{ id: "a", name: "A", position: 2, runSeconds: 2 },
      { id: "b", name: "B", position: 8, runSeconds: 3 }] },
    { id: "two", name: "Two", actions: [{ id: "c", name: "C", position: 4, runSeconds: 2,
      motion: "rotate", rotationSeconds: 2 }] },
  ] };
  const before = structuredClone(map), shifted = adjustTimeline(map, ["a", "c"], 2);
  assert.equal(shifted.tracks[0].actions[0].position, 4);
  assert.equal(shifted.tracks[1].actions[0].position, 6);
  const resized = adjustTimeline(map, ["a", "c"], 0, 1);
  assert.equal(resized.tracks[1].actions[0].rotationSeconds, 3);
  assert.equal(resized.tracks[0].actions[0].runSeconds, 3);
  assert.throws(() => adjustTimeline(map, ["a"], -3), /不正/);
  assert.throws(() => adjustTimeline(map, ["a"], 5), /重な/);
  assert.throws(() => adjustTimeline(map, ["missing"], 1), /見つか/);
  assert.throws(() => adjustTimeline(map, ["a"], 0, -3), /0.1/);
  assert.deepEqual(map, before);
  const locked = structuredClone(map); locked.tracks[1].locked = true;
  assert.throws(() => adjustTimeline(locked, ["a", "c"], 1), /ロック/);
  assert.deepEqual(map, before);
});

test("sequence reordering changes chronological order without changing duration or gaps", () => {
  const track = { name: "One", actions: [
    { id: "a", name: "A", position: 2, runSeconds: 2 },
    { id: "b", name: "B", position: 8, runSeconds: 3 },
  ] };
  reorderSequence(track, "b", -1);
  assert.deepEqual(track.actions.map(a => [a.id, a.position, a.runSeconds]), [["b", 2, 3], ["a", 9, 2]]);
  checkSequence(track);
  reorderSequence(track, "b", 1);
  assert.deepEqual(track.actions.map(a => [a.id, a.position, a.runSeconds]), [["a", 2, 2], ["b", 8, 3]]);
});

test("scenario handoff is explicitly a draft with percent coordinates and exact action times", () => {
  const { map } = fixture();
  map.timelineOnly = true;
  const robot = newTrack(map, "robot");
  robot.initial = { x: 125, y: 125, yaw: 0, roomId: "room" }; map.tracks = [robot];
  robot.actions.push(Object.assign(newAction(map, robot, "move"), { x: 325, y: 125,
    yaw: 0, position: 2, runSeconds: 4 }));
  const result = exportScenario(map);
  assert.equal(result.simulation_only, true);
  assert.equal(result.hardware_approved, false);
  assert.equal(result.coordinates.unit, "percent");
  assert.equal(result.robots[0].initial.x, 125 / 16);
  assert.equal(result.robots[0].initial.y, 125 / 9);
  assert.equal(result.actions[0].start_s, 2);
  assert.equal(result.actions[0].end_s, 6);
  assert.deepEqual(result.actions[0].from, { x: 125 / 16, y: 125 / 9, yaw_deg: 0 });
  assert.deepEqual(result.actions[0].to, { x: 325 / 16, y: 125 / 9, yaw_deg: 0 });
  assert.ok(result.integration_required.includes("hardware-safety-approval"));
  robot.initial.x = 0;
  assert.throws(() => exportScenario(map), /実行不可/);
});

function fixture() {
  const project = createProject({ ordered: true }), map = project.maps[0];
  map.tracks = [];
  map.rooms = [{ id: "room", name: "Open", kind: "room", material: "wood", color: "#123456",
    x: 0, y: 0, width: 1600, height: 900, cells: Array.from({ length: 576 }, (_, i) => i) }];
  map.floorPlan = { doors: [], furniture: [], chargingZones: [
    { id: "charger", name: "CHARGING", x: 100, y: 100, width: 300, height: 200 },
  ] };
  map.executionMode = "timed"; project.schema = "robot-scene/v4";
  return { project, map };
}

test("100mm rendering dimension and editor safety share the same conservative footprint", () => {
  assert.ok(Math.abs(ROBOT_SIDE * SCREEN_WIDTH_MM / 1600 - 100) < 1e-10);
  assert.ok(Math.abs(ROBOT_RADIUS - Math.hypot(ROBOT_SIDE / 2, ROBOT_SIDE / 2)) < 1e-10);
  const { map } = fixture(), safety = createSafety(map, { robotSide: ROBOT_SIDE });
  assert.equal(safety.robotRadius, ROBOT_RADIUS);
  assert.match(pathProblem(safety, { x: 75, y: 125 }, { x: 75, y: 125 }), /MAP外/);
  assert.equal(pathProblem(safety, { x: 125, y: 125 }, { x: 325, y: 125 }), "");
});

test("charging overlays preserve all navigation cells, walls and obstacles across JSON roundtrip", () => {
  const { project, map } = fixture();
  const without = structuredClone(map); delete without.floorPlan.chargingZones;
  assert.deepEqual(buildNavigation(map), buildNavigation(without));
  assert.deepEqual(JSON.parse(JSON.stringify(projectForSave(project))).maps[0].floorPlan.chargingZones,
    map.floorPlan.chargingZones);
  for (const props of [{ x: -1 }, { width: 2000 }, { height: NaN }, { id: "room" }]) {
    const invalid = structuredClone(map);
    Object.assign(invalid.floorPlan.chargingZones[0], props);
    assert.throws(() => validateFloorPlan(invalid), /充電|ID/);
  }
});

test("robot role accepts all three types, preserves old missing values and rejects unknown roles", () => {
  const { project, map } = fixture(), robot = newTrack(map, "robot");
  robot.initial = { x: 125, y: 125, yaw: 0, roomId: "room" };
  map.tracks.push(robot);
  assert.doesNotThrow(() => validateProject(project));
  for (const role of ["cleaning", "security", "delivery"]) {
    robot.robotRole = role;
    assert.doesNotThrow(() => validateProject(project));
    assert.equal(projectForSave(project).maps[0].tracks[0].robotRole, role);
  }
  robot.robotRole = "other";
  assert.throws(() => validateProject(project), /種別/);
});

test("disconnected join nodes are editable but cannot fire without two sources", () => {
  const { project, map } = fixture(), track = newTrack(map, "display");
  map.tracks.push(track);
  // 接続解除で空になった合流を削除せず、再接続できる状態として保存する。
  track.actions = [{ id: "join", name: "Join", type: "join", runSeconds: 0, position: 0,
    plannedDuration: 0.5, trigger: { mode: "all", sources: [] }, targetId: "join-target",
    roomId: "", x: 25, y: 25, yaw: 0, text: "", state: "meeting",
    speed: 100, tolerance: 15, dwell: 0, angleTolerance: null }];
  validateProject(project);
  const plan = compilePlan(map, { fixedTimeline: true });
  assert.equal(plan.entries[0].blocked, true);
  assert.match(plan.entries[0].reason, /2項目/);
});
