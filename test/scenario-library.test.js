import test from "node:test";
import assert from "node:assert/strict";
import { SCENARIO_LIBRARY, createLibraryScenario } from "../public/scenario-library.js";
import { validatePresentation, presentationAt } from "../public/scenario-presentation.js";
import { validateProject, projectForSave, compilePlan, samplePlan, copyMapLayout } from "../public/model.js";

test("the library contains sixteen distinct, independently generated scenarios", () => {
  assert.equal(SCENARIO_LIBRARY.length, 16);
  assert.equal(new Set(SCENARIO_LIBRARY.map(item => item.id)).size, 16);
  assert.throws(() => createLibraryScenario("unknown"), /Unknown library scenario/);
  const first = createLibraryScenario("garbage"), second = createLibraryScenario("garbage");
  assert.notEqual(first.maps[0].id, second.maps[0].id);
  const project = { ...first, maps: [first.maps[0], second.maps[0]] };
  assert.doesNotThrow(() => validateProject(project));
});

for (const spec of SCENARIO_LIBRARY) test(`${spec.id}: schema roundtrip, complete playback, facing and collision safety`, () => {
  const project = createLibraryScenario(spec.id);
  validateProject(project);
  const saved = JSON.parse(JSON.stringify(projectForSave(project)));
  assert.equal(saved.schema, "robot-scene/v5");
  assert.deepEqual(validateProject(structuredClone(saved)), saved);
  const map = project.maps[0], plan = compilePlan(map);
  assert.deepEqual(plan.errors, []);
  assert.ok(plan.duration >= 15 && plan.duration <= 90, String(plan.duration));
  assert.equal(plan.duration, Math.max(...map.tracks.flatMap(t => t.actions.map(a => a.position + a.runSeconds))));
  for (let time = 0; time <= plan.duration; time += .1) {
    const state = samplePlan(plan, time);
    assert.deepEqual(state.warnings, [], `${spec.id} at ${time}: ${JSON.stringify(state.warnings)}`);
    for (const actor of state.actors) {
      assert.ok(Number.isFinite(actor.x) && Number.isFinite(actor.y));
    }
  }
  for (const track of map.tracks.filter(t => t.initial)) {
    let from = track.initial, end = 0;
    for (const action of [...track.actions].sort((a, b) => a.position - b.position)) {
      assert.ok(action.position >= end - 1e-6, "Actions must not overlap");
      end = action.position + action.runSeconds;
      if (action.type !== "move") continue;
      if (track.kind === "human") assert.notEqual(action.motion, "rotate");
      if (track.kind === "robot" && action.motion !== "rotate") {
        const yaw = Math.atan2(action.y - from.y, action.x - from.x) * 180 / Math.PI;
        const delta = Math.abs(((yaw - from.yaw + 540) % 360) - 180);
        assert.ok(delta < .001, `${action.name} must face its destination`);
      }
      from = action;
    }
  }
  const final = samplePlan(plan, plan.duration);
  for (const track of map.tracks.filter(t => t.initial)) {
    const last = track.actions.filter(a => a.type === "move").at(-1) ?? track.initial;
    const actor = final.actors.find(a => a.id === track.id);
    assert.ok(Math.hypot(actor.x - last.x, actor.y - last.y) < .001);
  }
  const presentation = map.presentation;
  assert.ok(presentation.cues.some(cue => cue.label.includes("SIMULATION ONLY")));
  const before = presentationAt(presentation, 6);
  presentationAt(presentation, plan.duration - .1);
  assert.deepEqual(presentationAt(presentation, 6), before);
  assert.equal(copyMapLayout(map, "Layout only").presentation, undefined);
});

test("daily scenarios share building geometry and show three roles without moving standby robots", () => {
  const maps = ["daily-security", "daily-cleaning", "daily-delivery"].map(id => createLibraryScenario(id).maps[0]);
  const geometry = map => map.rooms.map(({ name, cells, appearance }) => ({ name, cells, appearance }));
  assert.deepEqual(geometry(maps[0]), geometry(maps[1]));
  assert.deepEqual(geometry(maps[0]), geometry(maps[2]));
  for (const [index, role] of ["security", "cleaning", "delivery"].entries()) {
    const tracks = maps[index].tracks.filter(t => t.kind === "robot");
    assert.equal(tracks.length, 3);
    for (const track of tracks) assert.equal(track.actions.some(a => a.type === "move"), track.robotRole === role);
    assert.equal(presentationAt(maps[index].presentation, 0).filter(c => c.kind === "route").length, 3);
  }
  const courier = maps[2].tracks.find(t => t.kind === "robot" && t.robotRole === "delivery");
  assert.ok(courier.actions.some(a => a.name.includes("荷物受取")));
  assert.ok(courier.actions.some(a => a.type === "wait" && a.name.includes("EV")));
  assert.equal(courier.actions.at(-1).roomId, maps[2].rooms.find(r => r.appearance === "elevator").id);
});

test("door priority demonstrates actual intermediate closure before the other robot crosses", () => {
  const map = createLibraryScenario("tutorial-door").maps[0], plan = compilePlan(map);
  const controls = map.tracks.find(t => t.kind === "room");
  assert.equal(controls.actions.length, 3);
  const [unmanaged, a, b] = controls.actions;
  assert.ok(unmanaged.position + unmanaged.runSeconds <= a.position);
  const gap = a.position + a.runSeconds + 1;
  assert.ok(gap < b.position);
  assert.equal(samplePlan(plan, gap).doors[0].openness, 0);
  const aTimes = [], bTimes = [];
  for (let time = 0; time < plan.duration; time += .05) {
    const door = samplePlan(plan, time).doors[0];
    if (time > 10 && door.openness > .1) {
      if (time < gap) aTimes.push(time);
      if (time >= b.position) bTimes.push(time);
    }
  }
  assert.ok(aTimes.length > 10 && bTimes.length > 10);
});

test("dirty regions are partial, visible before cleaning and removed when cleaning completes", () => {
  for (const id of ["garbage", "tutorial-dirt", "occupancy", "daily-cleaning"]) {
    const map = createLibraryScenario(id).maps[0];
    const dirt = map.presentation.cues.filter(c => c.kind === "dirt");
    assert.ok(dirt.length);
    for (const cue of dirt) {
      assert.ok(cue.width * cue.height < 400 * 900);
      assert.ok(presentationAt(map.presentation, cue.start).includes(cue));
      assert.ok(!presentationAt(map.presentation, cue.end).includes(cue));
      const cleaner = map.tracks.find(t => t.robotRole === "cleaning");
      const state = samplePlan(compilePlan(map), cue.end - .01);
      const actor = state.actors.find(a => a.id === cleaner.id);
      assert.ok(actor.x >= cue.x && actor.x <= cue.x + cue.width &&
        actor.y >= cue.y && actor.y <= cue.y + cue.height, `${id}: cleaner must be inside the dirty zone`);
    }
  }
});

test("building-side crowd information precedes clockwise detour and stays outside local sensor view", () => {
  const map = createLibraryScenario("tutorial-crowd").maps[0];
  const cues = map.presentation.cues;
  const crowd = cues.find(c => c.kind === "crowd"), sensor = cues.find(c => c.kind === "scan");
  assert.ok(crowd.x + crowd.width < sensor.x);
  const routes = cues.filter(c => c.kind === "route");
  assert.equal(routes.length, 2);
  assert.ok(routes[0].end <= routes[1].start);
  assert.ok(crowd.start < routes[1].start);
  const delivery = map.tracks.find(t => t.robotRole === "delivery");
  assert.ok(delivery.actions.filter(a => a.type === "move" && a.motion !== "rotate")
    .every(a => a.y <= 450));
});

test("presentation input rejects malformed times, geometry, styling and excessive cue counts", () => {
  const base = createLibraryScenario("garbage").maps[0].presentation;
  for (const change of [
    { start: -1 }, { end: Infinity }, { kind: "script" }, { color: "url(https://invalid)" },
    { label: "<script>".repeat(100) }, { kind: "dirt", x: 1590, y: 0, width: 100, height: 100 },
    { kind: "route", points: [[0, 0], [Infinity, 2]] },
  ]) {
    const value = structuredClone(base);
    Object.assign(value.cues[0], change);
    assert.throws(() => validatePresentation(value));
  }
  assert.throws(() => validatePresentation({ ...base, cues: Array(161).fill(base.cues[0]) }));
});
