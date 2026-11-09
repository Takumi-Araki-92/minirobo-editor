import test from "node:test";
import assert from "node:assert/strict";
import {
  uid, clone, clamp, formatTime, COLORS, KINDS,
  createProject, validateProject, newTrack, newAction, simulate, projectForSave,
  actionPreview, ARRIVAL_DEFAULTS,
} from "../public/model.js";
import { regionBounds, roomAnchor, roomContainsPoint } from "../public/floor-plan.js";

const close = (actual, expected, delta = 1e-7) =>
  assert.ok(Math.abs(actual - expected) < delta, `${actual} != ${expected}`);
function fixture() {
  const project = createProject();
  const map = project.maps[0];
  map.tracks = [];
  return { project, map };
}
function track(map, kind = "robot", initial = {}) {
  const value = newTrack(map, kind);
  if (value.initial) Object.assign(value.initial, { x: 0, y: 0, yaw: 0, roomId: "" }, initial);
  map.tracks.push(value);
  return value;
}
function action(map, owner, type, properties = {}, sources = null, mode = "all") {
  const value = Object.assign(newAction(map, owner, type), { dwell: 0 }, properties);
  if (sources) value.trigger = { mode, sources };
  owner.actions.push(value);
  return value;
}
const start = delay => ({ actionId: "$start", event: "start", delay: delay ?? 0 });
const after = (value, delay = 0, event = "complete") => ({ actionId: value.id, event, delay });
const actor = (map, time, index = 0) => simulate(map, time).actors[index];

function orderedFixture() {
  const project = createProject({ ordered: true }), map = project.maps[0];
  map.tracks = [];
  return { project, map };
}

test("ordered v3 roundtrips and new actions need no explicit trigger", () => {
  const { project, map } = orderedFixture(), owner = track(map);
  const first = action(map, owner, "move", { x: 100, y: 0, position: 0, dwell: .3 });
  const second = action(map, owner, "move", { x: 200, y: 0, position: 50 });
  assert.deepEqual(first.trigger.sources, []);
  assert.deepEqual(second.trigger.sources, []);
  close(simulate(map, 0).actionStates[second.id].start, 1.3);
  const saved = JSON.parse(JSON.stringify(projectForSave(project)));
  assert.equal(saved.schema, "robot-scene/v3");
  assert.equal(validateProject(saved).maps[0].executionMode, "ordered");
  assert.deepEqual(simulate(saved.maps[0], 1.8), simulate(map, 1.8));
  assert.equal(validateProject(createProject({ ordered: true })).schema, "robot-scene/v3");
  const old = clone(project); old.schema = "robot-scene/v2";
  assert.throws(() => validateProject(old), /v3/);
  const invalid = clone(project); invalid.maps[0].executionMode = "clock";
  assert.throws(() => validateProject(invalid), /ordered/);
});

test("ordered left-to-right placement changes actual order and preview without mutating input", () => {
  const { project, map } = orderedFixture(), owner = track(map);
  const first = action(map, owner, "move", { x: 100, y: 0, position: 0 });
  const second = action(map, owner, "move", { x: 200, y: 0, position: 8 });
  first.position = 16;
  validateProject(project);
  const before = clone(map), state = simulate(map, 0);
  close(state.actionStates[second.id].start, 0);
  close(state.actionStates[first.id].start, 2);
  close(actionPreview(map, owner.id, first).from.x, 200);
  assert.deepEqual(map, before);
  const third = newAction(map, owner, "move");
  assert.equal(third.position, first.position + 8);
});

test("ordered tracks run independently and implicit completion cannot be bypassed by OR", () => {
  for (const mode of ["all", "any"]) {
    const { project, map } = orderedFixture(), one = track(map), two = track(map);
    const a = action(map, one, "move", { x: 500, y: 0, position: 0 });
    const b = action(map, two, "move", { x: 100, y: 0, position: 0 });
    const c = action(map, one, "move", { x: 600, y: 0, position: 8 }, [after(b)], mode);
    validateProject(project);
    const state = simulate(map, 0);
    close(state.actionStates[a.id].start, 0);
    close(state.actionStates[b.id].start, 0);
    close(state.actionStates[c.id].start, 5);
    assert.deepEqual(state.errors, []);
    c.trigger.sources = []; c.trigger.mode = mode;
    close(simulate(map, 0).actionStates[c.id].start, 5);
  }
});

test("ordered additional waits can delay a row and preserve delays and legacy start conditions", () => {
  const { project, map } = orderedFixture(), one = track(map), two = track(map);
  const first = action(map, one, "move", { x: 100, y: 0, position: 0 });
  const external = action(map, two, "move", { x: 400, y: 0 }, [start(2)]);
  const next = action(map, one, "show", { position: 8 },
    [after(external, 1), after(first, .5, "start")]);
  validateProject(project);
  close(simulate(map, 0).actionStates[next.id].start, 7);
  next.trigger.mode = "any";
  close(simulate(map, 0).actionStates[next.id].start, 1);
  two.muted = true; next.trigger.mode = "all";
  const blocked = action(map, one, "move", { position: 16 });
  validateProject(project);
  assert.equal(simulate(map, 10).actionStates[next.id].status, "blocked");
  assert.equal(simulate(map, 10).actionStates[blocked.id].status, "blocked");
});

test("ordered implicit edges reject cycles after reordering or cross-track connections", () => {
  const { project, map } = orderedFixture(), one = track(map), two = track(map);
  const a = action(map, one, "move", { position: 0 });
  const b = action(map, one, "move", { position: 8 }, [after(a)]);
  validateProject(project);
  a.position = 16;
  assert.throws(() => validateProject(project), /循環/);
  a.position = 0;
  const c = action(map, two, "show", {}, [after(b)]);
  a.trigger.sources = [after(c)];
  assert.throws(() => validateProject(project), /循環/);
});

test("ordered equal positions are stable, and immediate actions finish before the next", () => {
  const { project, map } = orderedFixture(), owner = track(map, "display");
  const show = action(map, owner, "show", { position: 0, text: "hello" });
  const hide = action(map, owner, "hide", { position: 0, targetId: show.targetId });
  validateProject(project);
  const state = simulate(map, 0);
  close(state.actionStates[hide.id].start, 0);
  assert.deepEqual(state.displays, []);
  assert.deepEqual(state.errors, []);
});

test("legacy v2 has no implicit execution edges and remains unchanged until opted in", () => {
  const { project, map } = fixture(), owner = track(map);
  const a = action(map, owner, "move", { position: 16, x: 100, y: 0 }, [start()]);
  const b = action(map, owner, "show", { position: 0 }, [after(a)]);
  const original = clone(project);
  validateProject(project);
  close(simulate(map, 0).actionStates[b.id].start, 1);
  assert.deepEqual(project, original);
  project.schema = "robot-scene/v3"; map.executionMode = "ordered";
  assert.throws(() => validateProject(project), /循環/);
});

test("new movement uses a fixed near-10mm arrival margin and stable wait", () => {
  const { map } = fixture(), owner = track(map);
  const a = newAction(map, owner, "move");
  assert.equal(a.tolerance, 15);
  assert.equal(a.dwell, .3);
  assert.equal(a.angleTolerance, null);
  assert.ok(Object.isFrozen(ARRIVAL_DEFAULTS));
  owner.actions.push(a);
  a.x = 100; a.y = 0; a.speed = 100;
  close(simulate(map, 0).actionStates[a.id].end, 1.3);
});

test("action preview resolves trigger-ordered start position instead of array order", () => {
  const { map } = fixture(), owner = track(map, "robot", { x: 100, y: 200, yaw: 30 });
  const first = action(map, owner, "move", { x: 300, y: 200, yaw: 60 }, [start()]);
  const second = action(map, owner, "move", { x: 300, y: 400 }, [after(first)]);
  owner.actions.reverse();
  const before = clone(map), preview = actionPreview(map, owner.id, second);
  close(preview.from.x, 300); close(preview.from.y, 200); close(preview.from.yaw, 60);
  close(preview.start, 2);
  assert.equal(preview.warning, "");
  assert.deepEqual(map, before);
  owner.muted = true;
  assert.match(actionPreview(map, owner.id, second).warning, /参考/);
});

test("rotation seconds sets actual duration and completion trigger without changing legacy speed", () => {
  const { project, map } = fixture(), owner = track(map, "human", { x: 125, y: 225, yaw: 0 });
  const turn = action(map, owner, "move", { motion: "rotate", angularSpeed: 90,
    rotationSeconds: 3, yaw: 90, dwell: .3 }, [start()]);
  const next = action(map, owner, "show", {}, [after(turn)]);
  validateProject(project);
  close(actor(map, 1.5).yaw, 45);
  close(actor(map, 1.5).x, 125); close(actor(map, 1.5).y, 225);
  close(simulate(map, 0).actionStates[turn.id].end, 3.3);
  close(simulate(map, 0).actionStates[next.id].start, 3.3);
  for (const bad of [0, -.1, NaN, Infinity, "3", 86401]) {
    const p = clone(project); p.maps[0].tracks[0].actions[0].rotationSeconds = bad;
    assert.throws(() => validateProject(p));
  }
  delete turn.rotationSeconds;
  close(simulate(map, 0).actionStates[turn.id].end, 1.3);
});

test("display templates and event hatch options persist and reach runtime state", () => {
  const { project, map } = fixture(), display = track(map, "display"), room = track(map, "room");
  const show = action(map, display, "show", { displayTemplate: "card", text: "<b>案内</b>" }, [start()]);
  const event = action(map, room, "event-start", { hatchStyle: "cross", hatchColor: "#12abcd",
    text: "会議中" }, [start()]);
  assert.deepEqual(validateProject(JSON.parse(JSON.stringify(project))), project);
  const state = simulate(map, 0);
  assert.equal(state.displays[0].displayTemplate, "card");
  assert.equal(state.displays[0].text, "<b>案内</b>");
  assert.equal(state.events[0].hatchStyle, "cross");
  assert.equal(state.events[0].hatchColor, "#12abcd");
  for (const change of [{ hatchColor: "red" }, { hatchStyle: "script" }]) {
    const p = clone(project);
    Object.assign(p.maps[0].tracks[1].actions[0], change);
    assert.throws(() => validateProject(p));
  }
  show.displayTemplate = "script";
  assert.throws(() => validateProject(project));
  delete show.displayTemplate; delete event.hatchStyle; delete event.hatchColor;
  assert.equal(validateProject(project), project);
});

test("rotation stays in place, uses shortest yaw and angular speed, then triggers a straight move", () => {
  for (const kind of ["robot", "human"]) {
    const { project, map } = fixture();
    const owner = track(map, kind, { x: 100, y: 200, yaw: 170, roomId: map.rooms[0].id });
    const turn = action(map, owner, "move", {
      motion: "rotate", angularSpeed: 10, yaw: -170, x: 999, y: 888, roomId: "",
    }, [start()]);
    const move = action(map, owner, "move", { x: 200, y: 200, yaw: -170, speed: 100 },
      [after(turn)]);
    validateProject(project);
    assert.deepEqual(validateProject(JSON.parse(JSON.stringify(project))), project);
    const half = actor(map, 1);
    close(half.x, 100); close(half.y, 200); close(half.yaw, 180);
    assert.equal(half.roomId, owner.initial.roomId);
    const state = simulate(map, 2);
    close(state.actionStates[turn.id].end, 2);
    close(state.actionStates[move.id].start, 2);
    close(actor(map, 2.5).x, 150);
    close(actor(map, 2.5).y, 200);
    close(actor(map, 3).x, 200);
    assert.deepEqual(state.errors, []);
  }
});

test("rotation uses the preceding arrival, preserves room, and rejects overlapping movement", () => {
  const { project, map } = fixture(), owner = track(map);
  const first = action(map, owner, "move", { x: 100, y: 0, yaw: 90,
    speed: 100, roomId: map.rooms[0].id }, [start()]);
  const turn = action(map, owner, "move", { motion: "rotate", angularSpeed: 45,
    yaw: 180, dwell: .5, roomId: "" }, [after(first)]);
  const conflict = action(map, owner, "move", { motion: "rotate", angularSpeed: 90, yaw: 0 },
    [after(turn, .5, "start")]);
  validateProject(project);
  const mid = actor(map, 2);
  close(mid.x, 100); close(mid.y, 0); close(mid.yaw, 135);
  assert.equal(mid.roomId, map.rooms[0].id);
  const result = simulate(map, 4);
  close(result.actionStates[turn.id].end, 3.5);
  assert.equal(result.actionStates[conflict.id].status, "blocked");
  assert.ok(result.errors.some(e => e.includes("重複")));
  for (const change of [
    { angularSpeed: 0 }, { angularSpeed: NaN }, { angularSpeed: 3601 },
    { angularSpeed: "90" }, { motion: "curve" },
  ]) {
    const p = clone(project);
    Object.assign(p.maps[0].tracks[0].actions[1], change);
    assert.throws(() => validateProject(p));
  }
  const p = clone(project);
  delete p.maps[0].tracks[0].actions[1].angularSpeed;
  assert.throws(() => validateProject(p));
});

test("two consecutive moves form straight segments and initial pose persists without an action", () => {
  const { project, map } = fixture(), owner = track(map, "robot", { x: 100, y: 100, yaw: 45 });
  const first = action(map, owner, "move", { x: 200, y: 100, speed: 100 }, [start(1)]);
  action(map, owner, "move", { x: 200, y: 200, speed: 100 }, [after(first)]);
  const saved = validateProject(JSON.parse(JSON.stringify(projectForSave(project))));
  assert.deepEqual(saved.maps[0].tracks[0].initial, owner.initial);
  close(actor(map, 0).x, 100); close(actor(map, 0).yaw, 45);
  close(actor(map, 1.5).x, 150); close(actor(map, 1.5).y, 100);
  close(actor(map, 2.5).x, 200); close(actor(map, 2.5).y, 150);
});

test("exports, helpers, v2 sample, JSON roundtrip, and distinct project IDs", () => {
  const p = createProject();
  assert.equal(p.schema, "robot-scene/v2");
  assert.equal(validateProject(p), p);
  assert.deepEqual(validateProject(JSON.parse(JSON.stringify(p))), p);
  assert.deepEqual(Object.keys(KINDS), ["robot", "human", "room", "display"]);
  assert.equal(COLORS.length, 6);
  assert.notEqual(uid(), uid());
  assert.notEqual(p.maps[0].id, createProject().maps[0].id);
  assert.equal(clamp(10, 0, 5), 5);
  assert.equal(clamp(-1, 0, 5), 0);
  assert.deepEqual(clone(p), p);
  assert.equal(simulate(p.maps[0], 0).actors.filter(value => value.kind === "robot").length, 4);
  assert.equal(simulate(p.maps[0], 0).actors.find(value => value.kind === "human").count, 5);
  const human = p.maps[0].tracks.find(value => value.kind === "human");
  const end = p.maps[0].tracks.find(value => value.kind === "room").actions[1];
  assert.equal(human.actions[1].trigger.sources[0].actionId, end.id);
  const result = simulate(p.maps[0], 1000);
  assert.deepEqual(result.errors, []);
  assert.equal(result.events.length, 0);
  assert.equal(result.displays.length, 0);
  assert.equal(result.actors.find(value => value.kind === "human").roomId, "");
});

test("grid rooms aggregate only occupied cells, retain IDs and select an interior arrival point", () => {
  const { project, map } = fixture();
  const room = map.rooms[0];
  room.cells = [2 * 32 + 2, 2 * 32 + 3, 3 * 32 + 2];
  Object.assign(room, regionBounds(room.cells), { kind: "room", material: "wood" });
  map.floorPlan = { doors: [], furniture: [] };
  const outside = track(map, "human", { x: 175, y: 725, roomId: room.id });
  const inside = track(map, "robot", { x: 125, y: 725, roomId: room.id });
  const owner = track(map, "room");
  action(map, owner, "event-start");
  validateProject(project);
  const state = simulate(map, 0);
  assert.equal(state.actors.find(a => a.id === outside.id).aggregated, false);
  assert.equal(state.actors.find(a => a.id === inside.id).aggregated, true);
  const anchor = roomAnchor(room);
  assert.equal(roomContainsPoint(room, anchor.x, anchor.y), true);
  assert.deepEqual(validateProject(JSON.parse(JSON.stringify(project))), project);
  map.floorPlan.furniture.push({
    id: outside.id, roomId: room.id, cell: room.cells[0], type: "chair", rotation: 0,
  });

  assert.throws(() => validateProject(project), /ID/);
});

test("planned duration roundtrips but never changes execution and supports legacy omissions", () => {
  const project = createProject(), m = project.maps[0], a = m.tracks[0].actions[0];
  const before = simulate(m, 100);
  a.plannedDuration = 90;
  validateProject(project);
  assert.deepEqual(simulate(m, 100), before);
  assert.equal(validateProject(JSON.parse(JSON.stringify(project))).maps[0].tracks[0].actions[0].plannedDuration, 90);
  for (const invalid of [0, -.5, 3601, "5", NaN, Infinity, null]) {
    a.plannedDuration = invalid;
    assert.throws(() => validateProject(project), /目安/);
  }
  delete a.plannedDuration;
  validateProject(project);
  assert.deepEqual(simulate(m, 100), before);
});

test("save snapshot refreshes derived navigation without changing editable data", () => {
  const project = createProject(), before = clone(project);
  const saved = projectForSave(project);
  assert.deepEqual(project, before);
  assert.equal(saved.maps[0].navigation.status, "unavailable");
  saved.maps[0].navigation = { stale: true };
  const refreshed = projectForSave(saved);
  assert.equal(refreshed.maps[0].navigation.schema, "floor-navigation/v1");
  assert.equal(validateProject(JSON.parse(JSON.stringify(refreshed))).schema, "robot-scene/v2");
  const m = project.maps[0], room = m.rooms[0];
  room.cells = [0, 1]; Object.assign(room, regionBounds(room.cells), { kind: "room", material: "tile" });
  m.floorPlan = { doors: [], furniture: [] };
  const first = projectForSave(project);
  assert.equal(first.maps[0].navigation.cells[0].traversable, true);
  m.floorPlan.furniture.push({ id: uid(), roomId: room.id, cell: 0, type: "plant", rotation: 0 });
  const second = projectForSave(project);
  assert.equal(second.maps[0].navigation.cells[0].traversable, false);
  assert.equal(first.maps[0].navigation.cells[0].traversable, true);
  assert.equal(validateProject(JSON.parse(JSON.stringify(second))).maps[0].navigation.obstacles.length, 1);
  m.floorPlan.furniture[0].cells = [0, 1];
  const wide = projectForSave(project), reloaded = validateProject(JSON.parse(JSON.stringify(wide)));
  assert.deepEqual(reloaded.maps[0].floorPlan.furniture[0].cells, [0, 1]);
  assert.equal(reloaded.maps[0].navigation.cells[1].traversable, false);
  assert.equal(reloaded.maps[0].navigation.obstacles[0].width, 100);
  assert.equal(second.maps[0].navigation.cells[1].traversable, true);
});

test("all new kinds and actions validate; defaults are unique, chain locally, and never mutate input", () => {
  const { project, map } = fixture();
  for (const kind of Object.keys(KINDS)) {
    const owner = track(map, kind);
    const before = clone(owner);
    const type = { robot: "move", human: "move", room: "event-start", display: "show" }[kind];
    const first = newAction(map, owner, type);
    assert.deepEqual(owner, before);
    owner.actions.push(first);
    const nextType = { robot: "move", human: "move", room: "event-end", display: "hide" }[kind];
    const second = newAction(map, owner, nextType);
    owner.actions.push(second);
    assert.notEqual(first.id, second.id);
    assert.equal(second.trigger.sources[0].actionId, first.id);
    assert.equal(second.position, first.position + 8);
    if (kind === "room" || kind === "display") assert.equal(second.targetId, first.targetId);
  }
  assert.equal(validateProject(project), project);
  const secondRobot = track(map);
  assert.equal(secondRobot.robotId, 1);
  assert.notEqual(secondRobot.name, map.tracks[0].name);
  assert.throws(() => newTrack(map, "manual"));
  assert.equal(newAction(map, secondRobot, "show").type, "show");
  assert.throws(() => newAction(map, secondRobot, "unsupported"));
  assert.equal(newAction(map, map.tracks[3], "move").type, "move");
  map.rooms = [];
  map.tracks = [];
  const room = track(map, "room");
  assert.equal(room.roomId, "");
  action(map, room, "event-start");
  validateProject(project);
});

test("multiple maps are independent and trigger references never cross map boundaries", () => {
  const { project, map } = fixture();
  const robot = track(map);
  const move = action(map, robot, "move", { x: 100, y: 0, speed: 10 });
  const second = createProject().maps[0];
  second.tracks = [];
  project.maps.push(second);
  const other = track(second);
  const otherMove = action(second, other, "move", { x: 200, y: 0, speed: 10 });
  validateProject(project);
  close(actor(map, 5).x, 50);
  close(actor(second, 5).x, 50);
  assert.equal(simulate(map, 0).duration, 10);
  assert.equal(simulate(second, 0).duration, 20);
  otherMove.trigger.sources = [after(move)];
  assert.throws(() => validateProject(project), /同じマップ/);
});

test("actual start/complete timestamps drive all/any, delays, gaps, and forward references", () => {
  const { project, map } = fixture();
  const owner = track(map);
  const first = action(map, owner, "move", { x: 100, y: 0, speed: 10, dwell: 2 }, [start(3)]);
  const second = action(map, owner, "move", { x: 200, y: 0, speed: 20 }, [after(first, 4)]);
  const display = track(map, "display");
  const all = action(map, display, "show", { text: "ALL" }, [after(first, 1, "start"), after(second, 2)]);
  const any = action(map, display, "show", { text: "ANY" }, [after(second), after(first, 2, "start")], "any");
  // 前方参照でも配列順は時刻を意味しない。
  owner.actions.reverse();
  validateProject(project);
  const result = simulate(map, 0);
  assert.deepEqual(result.actionStates[first.id], { status: "waiting", start: 3, end: 15 });
  assert.equal(result.actionStates[second.id].start, 19);
  assert.equal(result.actionStates[second.id].end, 24);
  assert.equal(result.actionStates[all.id].start, 26);
  assert.equal(result.actionStates[any.id].start, 5);
  assert.equal(result.duration, 26);
  close(actor(map, 2).x, 0);
  close(actor(map, 8).x, 50);
  assert.equal(actor(map, 13).moving, false);
  assert.equal(simulate(map, 14).actionStates[first.id].status, "running");
  close(actor(map, 17).x, 100);
  close(actor(map, 20).x, 120);
  assert.equal(simulate(map, 24).actionStates[second.id].status, "complete");
});

test("any trigger picks earliest actual source, not first source or first array entry", () => {
  const { project, map } = fixture();
  const display = track(map, "display");
  const late = action(map, display, "show", {}, [start(100)]);
  const early = action(map, display, "show", {}, [start(2)]);
  const result = action(map, display, "show", {}, [after(late), after(early, 1)], "any");
  validateProject(project);
  assert.equal(simulate(map, 5).actionStates[result.id].start, 3);
});

test("move duration is distance/speed plus dwell; yaw follows shortest arc; tolerances are reference-only", () => {
  const { project, map } = fixture();
  const owner = track(map, "robot", { yaw: 170 });
  const move = action(map, owner, "move", {
    x: 300, y: 400, yaw: -170, speed: 100, dwell: 3, tolerance: 1000, angleTolerance: 180,
  });
  validateProject(project);
  close(actor(map, 2.5).x, 150);
  close(actor(map, 2.5).y, 200);
  close(actor(map, 2.5).yaw, 180);
  close(actor(map, 5).yaw, -170);
  assert.equal(actor(map, 5).moving, false);
  assert.equal(simulate(map, 7.99).actionStates[move.id].status, "running");
  assert.equal(simulate(map, 8).actionStates[move.id].status, "complete");
  close(actor(map, 100).x, 300);
  owner.initial.yaw = -170;
  move.yaw = 170;
  close(actor(map, 2.5).yaw, 180);
});

test("zero-distance movement applies yaw and dwell without invented rotation duration", () => {
  const { project, map } = fixture();
  const owner = track(map);
  const value = action(map, owner, "move", { x: 0, y: 0, yaw: 90, dwell: 2 });
  validateProject(project);
  close(actor(map, 0).yaw, 90);
  assert.equal(actor(map, 0).moving, false);
  assert.equal(simulate(map, 0).actionStates[value.id].end, 2);
});

test("planned editor position is not simulation time, and seeking is pure and deterministic", () => {
  const { map } = fixture();
  const owner = track(map);
  action(map, owner, "move", { x: 100, y: 0, position: 999999, speed: 10 });
  const before = clone(map);
  const results = new Map([0, 3, 10, 50].map(time => [time, simulate(map, time)]));
  for (const time of [50, 3, 0, 10, 3]) assert.deepEqual(simulate(map, time), results.get(time));
  assert.deepEqual(map, before);
  close(actor(map, 3).x, 30);
});

test("muted sources block all dependents, any may use live source, and locks do not mute", () => {
  const { project, map } = fixture();
  const owner = track(map);
  owner.muted = true;
  const muted = action(map, owner, "move", { x: 100, y: 0 });
  const live = track(map, "display");
  live.locked = true;
  const independent = action(map, live, "show", {}, [start(2)]);
  const blocked = action(map, live, "show", {}, [after(muted), after(independent)]);
  const transitive = action(map, live, "hide", {}, [after(blocked)]);
  const either = action(map, live, "show", {}, [after(muted), after(independent, 1)], "any");
  const onlyMuted = action(map, live, "hide", {}, [after(muted)], "any");
  live.actions.reverse();
  validateProject(project);
  const result = simulate(map, 3);
  assert.equal(result.actors.length, 0);
  for (const value of [muted, blocked, transitive, onlyMuted]) {
    assert.deepEqual(result.actionStates[value.id], { status: "blocked", start: null, end: null });
  }
  assert.equal(result.actionStates[independent.id].status, "complete");
  assert.equal(result.actionStates[either.id].start, 3);
  assert.deepEqual(result.errors, []);
});

test("overlapping moves block deterministically instead of secretly serializing or introducing a gate", () => {
  const { project, map } = fixture();
  const owner = track(map);
  const first = action(map, owner, "move", { x: 100, y: 0, speed: 10 });
  const overlap = action(map, owner, "move", { x: 200, y: 0 }, [after(first, 1, "start")]);
  const dependent = action(map, owner, "move", {}, [after(overlap)]);
  validateProject(project);
  const result = simulate(map, 5);
  assert.equal(result.actionStates[overlap.id].status, "blocked");
  assert.equal(result.actionStates[dependent.id].status, "blocked");
  assert.equal(result.errors.length, 1);
  close(result.actors[0].x, 50);
  assert.equal(result.duration, 10);
});

test("display targets update in place, hide removes only its target, and effects apply at exact completion", () => {
  const { project, map } = fixture();
  const owner = track(map, "display");
  const show = action(map, owner, "show", { text: "FIRST" }, [start(2)]);
  const update = action(map, owner, "show", { text: "UPDATED", targetId: show.targetId }, [after(show, 1)]);
  const other = action(map, owner, "show", { text: "OTHER" }, [after(update)]);
  action(map, owner, "hide", { targetId: show.targetId }, [after(other, 2)]);
  validateProject(project);
  assert.equal(simulate(map, 1.99).displays.length, 0);
  assert.equal(simulate(map, 2).displays[0].text, "FIRST");
  assert.equal(simulate(map, 2).displays[0].actionId, show.id);
  assert.deepEqual(simulate(map, 3).displays.map(value => value.text), ["UPDATED", "OTHER"]);
  assert.deepEqual(simulate(map, 3).displays.map(value => value.actionId), [update.id, other.id]);
  assert.deepEqual(simulate(map, 5).displays.map(value => value.text), ["OTHER"]);
});

test("actor-attached show/hide coexist with motion and identify their owner by track ID", () => {
  const { project, map } = fixture();
  for (const kind of ["robot", "human"]) {
    const owner = track(map, kind);
    const move = action(map, owner, "move", { x: 100, y: 0, speed: 10 });
    const show = action(map, owner, "show", { text: kind }, [after(move, 1, "start")]);
    action(map, owner, "hide", {}, [after(show, 3)]);
  }
  validateProject(project);
  const result = simulate(map, 2);
  assert.deepEqual(result.displays.map(value => value.actorId), map.tracks.map(value => value.id));
  assert.deepEqual(result.actors.map(value => value.id), map.tracks.map(value => value.id));
  assert.deepEqual(result.actors.map(value => value.x), [20, 20]);
  assert.equal(simulate(map, 4).displays.length, 0);
});

test("event-end defaults match last known local target and selected room, including other room tracks", () => {
  const { project, map } = fixture();
  const owner = track(map, "room");
  const startEvent = action(map, owner, "event-start");
  const end = newAction(map, owner, "event-end");
  assert.equal(end.targetId, startEvent.targetId);
  assert.equal(end.roomId, owner.roomId);
  const other = track(map, "room");
  const otherEnd = action(map, other, "event-end");
  assert.equal(otherEnd.targetId, startEvent.targetId);
  assert.equal(otherEnd.roomId, other.roomId);
  validateProject(project);
});

test("same-timestamp effects have deterministic map/track/action order with dependency precedence", () => {
  const { project, map } = fixture();
  const owner = track(map, "display");
  const show = action(map, owner, "show", { text: "FIRST" });
  const hide = action(map, owner, "hide", { targetId: show.targetId }, [after(show)]);
  owner.actions.reverse();
  validateProject(project);
  assert.equal(simulate(map, 0).displays.length, 0);
  assert.equal(simulate(map, 0).actionStates[hide.id].status, "complete");
  const next = track(map, "display");
  action(map, next, "show", { targetId: show.targetId, text: "LAST" }, [start()]);
  assert.equal(simulate(map, 0).displays[0].text, "LAST");
});

test("room events update stable targets, unrelated end does not clear other room states", () => {
  const { project, map } = fixture();
  const owner = track(map, "room");
  const meeting = action(map, owner, "event-start", { text: "MEETING" });
  const fire = action(map, owner, "event-start", { targetId: meeting.targetId, state: "fire", text: "FIRE" },
    [after(meeting, 1)]);
  const outage = action(map, owner, "event-start", { state: "outage" }, [after(fire)]);
  action(map, owner, "event-end", { targetId: meeting.targetId }, [after(outage, 1)]);
  validateProject(project);
  assert.equal(simulate(map, 0).events[0].roomId, map.rooms[0].id);
  assert.equal(simulate(map, 0).events[0].actionId, meeting.id);
  assert.deepEqual(simulate(map, 1).events.map(value => value.state), ["fire", "outage"]);
  assert.deepEqual(simulate(map, 1).events.map(value => value.actionId), [fire.id, outage.id]);
  assert.deepEqual(simulate(map, 2).events.map(value => value.state), ["outage"]);
});

test("arrival during event aggregates, latch survives end, same-room move retains and exit releases at start", () => {
  const { project, map } = fixture();
  const roomId = map.rooms[0].id;
  const human = track(map, "human", { x: 800, y: 600 });
  human.count = 5;
  const enter = action(map, human, "move", { x: 1000, y: 600, roomId, speed: 100, dwell: 2 });
  const room = track(map, "room");
  const event = action(map, room, "event-start", {}, [start()]);
  const end = action(map, room, "event-end", { targetId: event.targetId }, [start(5)]);
  const within = action(map, human, "move", { x: 1200, y: 600, roomId, speed: 100 }, [after(end, 1)]);
  action(map, human, "move", { x: 800, y: 600, roomId: "", speed: 100 }, [after(within, 2)]);
  validateProject(project);
  assert.equal(actor(map, 1).aggregated, false);
  assert.equal(actor(map, 2).aggregated, true);
  assert.equal(actor(map, 2).moving, false);
  assert.equal(simulate(map, 2).actionStates[enter.id].status, "running");
  assert.equal(actor(map, 5).aggregated, true);
  assert.equal(simulate(map, 5).events.length, 0);
  assert.equal(actor(map, 7).aggregated, true);
  assert.equal(actor(map, 7).moving, true);
  assert.equal(actor(map, 9).aggregated, true);
  assert.equal(actor(map, 10).aggregated, false);
  assert.equal(actor(map, 10).moving, true);
  assert.equal(actor(map, 10).count, 5);
});

test("starting event aggregates stationary actors inside room, not moving or geometrically outside actors", () => {
  const { project, map } = fixture();
  const roomId = map.rooms[0].id;
  track(map, "human", { x: 1000, y: 600, roomId });
  const moving = track(map, "robot", { x: 1100, y: 600, roomId });
  action(map, moving, "move", { x: 1300, y: 600, roomId, speed: 50 });
  track(map, "human", { x: 100, y: 100, roomId });
  const room = track(map, "room");
  action(map, room, "event-start", {}, [start(1)]);
  validateProject(project);
  const result = simulate(map, 1);
  assert.deepEqual(result.actors.map(value => value.aggregated), [true, false, false]);
  assert.equal(simulate(map, 4).actors[1].aggregated, true);
});

test("event during arrival dwell sees stationary actor and aggregation is retained after event end", () => {
  const { project, map } = fixture();
  const roomId = map.rooms[0].id;
  const robot = track(map, "robot", { x: 800, y: 600 });
  action(map, robot, "move", { x: 1000, y: 600, roomId, speed: 100, dwell: 10 });
  const room = track(map, "room");
  const event = action(map, room, "event-start", {}, [start(3)]);
  action(map, room, "event-end", {}, [after(event, 1)]);
  validateProject(project);
  assert.equal(actor(map, 2).aggregated, false);
  assert.equal(actor(map, 3).aggregated, true);
  assert.equal(actor(map, 4).aggregated, true);
});

test("event starting during unaggregated same-room travel does not aggregate until arrival", () => {
  const { project, map } = fixture();
  const roomId = map.rooms[0].id;
  const robot = track(map, "robot", { x: 1000, y: 600, roomId });
  action(map, robot, "move", { x: 1200, y: 600, roomId, speed: 50 });
  const room = track(map, "room");
  const event = action(map, room, "event-start", {}, [start(1)]);
  action(map, room, "event-end", {}, [after(event, 1)]);
  validateProject(project);
  assert.equal(actor(map, 1).aggregated, false);
  assert.equal(actor(map, 5).aggregated, false);
});

test("valid backgrounds include high-quality 15MB encoded images without regex recursion", () => {
  const { project, map } = fixture();
  for (const format of ["png", "jpeg", "webp"]) {
    map.background = { name: "map", opacity: 0.8, data: `data:image/${format};base64,AA==` };
    validateProject(project);
  }
  map.background.data = `data:image/png;base64,${"AAAA".repeat(5_242_880)}`;
  validateProject(project);
});

test("aggregate encoded background size reserves metadata headroom for 80MiB JSON imports", () => {
  const { project } = fixture();
  const header = "data:image/png;base64,";
  const encodedImage = `${header}${"AAAA".repeat(5_000_000)}`;
  for (let index = 0; index < 4; index++) {
    const map = index === 0 ? project.maps[0] : createProject().maps[0];
    if (index > 0) project.maps.push(map);
    map.background = { name: "map", opacity: 1, data: encodedImage };
  }
  assert.throws(() => validateProject(project), /合計.*70MiB/);
  project.maps[3].background = {
    name: "map", opacity: 1,
    data: `${header}${"AAAA".repeat(Math.floor((70 * 1024 * 1024 -
      encodedImage.length * 3 - header.length) / 4))}`,
  };
  validateProject(project);
  project.maps[3].background.data += "AAAA";
  assert.throws(() => validateProject(project), /合計.*70MiB/);
});

for (const [name, modify] of [
  ["v1", p => { p.schema = "robot-scene/v1"; }],
  ["absolute project duration", p => { p.duration = 60; }],
  ["empty maps", p => { p.maps = []; }],
  ["map limit", p => { p.maps = Array(9).fill(p.maps[0]); }],
  ["null map", p => { p.maps[0] = null; }],
  ["duplicate global ID", p => { p.maps[0].tracks[0].id = p.maps[0].rooms[0].id; }],
  ["unsafe ID", p => { p.maps[0].tracks[0].actions[0].id = "__proto__"; }],
  ["reserved ID", p => { p.maps[0].tracks[0].id = "$start"; }],
  ["unknown kind", p => { p.maps[0].tracks[0].kind = "manual"; }],
  ["unsafe color", p => { p.maps[0].tracks[0].color = "red;xxx"; }],
  ["nonboolean mute", p => { p.maps[0].tracks[0].muted = 1; }],
  ["duplicate robot", p => { p.maps[0].tracks[1].robotId = 0; }],
  ["fractional robot", p => { p.maps[0].tracks[0].robotId = 0.5; }],
  ["human zero count", p => { p.maps[0].tracks[4].count = 0; }],
  ["human fractional count", p => { p.maps[0].tracks[4].count = 1.5; }],
  ["unknown initial room", p => { p.maps[0].tracks[0].initial.roomId = "missing"; }],
  ["missing initial room", p => { delete p.maps[0].tracks[0].initial.roomId; }],
  ["bad initial coordinates", p => { p.maps[0].tracks[0].initial.x = NaN; }],
  ["room outside bounds", p => { p.maps[0].rooms[0].width = 1600; }],
  ["unknown room track reference", p => { p.maps[0].tracks[5].roomId = "missing"; }],
  ["unknown action room", p => { p.maps[0].tracks[0].actions[0].roomId = "missing"; }],
  ["wrong action kind", p => { p.maps[0].tracks[0].actions[0].type = "event-start"; }],
  ["absolute start", p => { p.maps[0].tracks[0].actions[0].start = 3; }],
  ["duration", p => { p.maps[0].tracks[0].actions[0].duration = 3; }],
  ["nonfinite speed", p => { p.maps[0].tracks[0].actions[0].speed = Infinity; }],
  ["zero speed", p => { p.maps[0].tracks[0].actions[0].speed = 0; }],
  ["numeric string", p => { p.maps[0].tracks[0].actions[0].x = "10"; }],
  ["bad coordinates", p => { p.maps[0].tracks[0].actions[0].y = 901; }],
  ["bad yaw", p => { p.maps[0].tracks[0].actions[0].yaw = 181; }],
  ["nonfinite editor position", p => { p.maps[0].tracks[0].actions[0].position = Infinity; }],
  ["negative tolerance", p => { p.maps[0].tracks[0].actions[0].tolerance = -1; }],
  ["nonfinite dwell", p => { p.maps[0].tracks[0].actions[0].dwell = NaN; }],
  ["bad angle tolerance", p => { p.maps[0].tracks[0].actions[0].angleTolerance = 181; }],
  ["bad target", p => { p.maps[0].tracks[0].actions[0].targetId = ""; }],
  ["bad state", p => { p.maps[0].tracks[0].actions[0].state = "unknown"; }],
  ["bad text", p => { p.maps[0].tracks[0].actions[0].text = {}; }],
  ["long text", p => { p.maps[0].tracks[0].actions[0].text = "x".repeat(4001); }],
  ["null trigger", p => { p.maps[0].tracks[0].actions[0].trigger = null; }],
  ["unknown mode", p => { p.maps[0].tracks[0].actions[0].trigger.mode = "none"; }],
  ["empty sources", p => { p.maps[0].tracks[0].actions[0].trigger.sources = []; }],
  ["null source", p => { p.maps[0].tracks[0].actions[0].trigger.sources = [null]; }],
  ["start complete", p => { p.maps[0].tracks[0].actions[0].trigger.sources[0].event = "complete"; }],
  ["negative delay", p => { p.maps[0].tracks[0].actions[0].trigger.sources[0].delay = -1; }],
  ["nonfinite delay", p => { p.maps[0].tracks[0].actions[0].trigger.sources[0].delay = Infinity; }],
  ["missing action reference", p => { p.maps[0].tracks[0].actions[0].trigger.sources[0].actionId = "missing"; }],
  ["self cycle", p => {
    const a = p.maps[0].tracks[0].actions[0]; a.trigger.sources = [after(a)];
  }],
  ["indirect cycle even in any mode", p => {
    const a = p.maps[0].tracks[0].actions[0], b = p.maps[0].tracks[1].actions[0];
    a.trigger = { mode: "any", sources: [start(), after(b)] }; b.trigger.sources = [after(a)];
  }],
  ["external background", p => {
    p.maps[0].background = { name: "bad", opacity: 1, data: "https://example.invalid/map.png" };
  }],
  ["SVG background", p => {
    p.maps[0].background = { name: "bad", opacity: 1, data: "data:image/svg+xml;base64,AAAA" };
  }],
  ["bad base64", p => {
    p.maps[0].background = { name: "bad", opacity: 1, data: "data:image/png;base64,A==A" };
  }],
  ["empty background", p => {
    p.maps[0].background = { name: "bad", opacity: 1, data: "data:image/png;base64," };
  }],
  ["background size", p => {
    p.maps[0].background = { name: "bad", opacity: 1, data: `data:image/png;base64,${"A".repeat(22_000_000)}` };
  }],
]) test(`validator rejects ${name}`, () => {
  const project = createProject();
  modify(project);
  assert.throws(() => validateProject(project));
});

test("2000 action limit is global across maps, exact limit validates without recursive graph traversal", () => {
  const { project, map } = fixture();
  const owner = track(map, "display");
  for (let i = 0; i < 2000; i++) action(map, owner, "show");
  validateProject(project);
  const second = createProject().maps[0];
  second.tracks = [];
  project.maps.push(second);
  action(second, track(second, "display"), "show");
  assert.throws(() => validateProject(project), /2000/);
});

test("time formatting carries rounded seconds and minutes", () => {
  assert.equal(formatTime(59.999), "01:00.00");
  assert.equal(formatTime(0), "00:00.00");
  assert.equal(formatTime(3600), "60:00.00");
  assert.equal(formatTime(-1), "00:00.00");
});
