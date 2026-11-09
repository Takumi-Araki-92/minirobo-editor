import test from "node:test";
import assert from "node:assert/strict";
import {
  createCoordinationDemoMap, createFleetDemoMap, createOfficeDemoMap, refreshDemoScenarios,
} from "../public/demo-map.js";
import { validateProject, compilePlan, samplePlan } from "../public/model.js";
import { ROBOT_SIDE, buildNavigation } from "../public/floor-plan.js";
import { createSafety, pathProblem } from "../public/safety.js";

function assertRobotFacing(plan) {
  const normalize = value => ((value + 180) % 360 + 360) % 360 - 180;
  for (const entry of plan.entries.filter(item => item.track.kind === "robot" &&
    item.action.type === "move" && item.action.motion !== "rotate")) {
    const bearing = Math.atan2(entry.to.y - entry.from.y, entry.to.x - entry.from.x) * 180 / Math.PI;
    assert.ok(Math.abs(normalize(entry.from.yaw - bearing)) < 1e-6, entry.action.name);
  }
}

test("fleet demo map is a valid, warning-free timed project", () => {
  const project = createFleetDemoMap();
  validateProject(project);
  const [map] = project.maps;
  const plan = compilePlan(map, { fixedTimeline: true });

  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.warnings, []);
  assert.ok(plan.entries.length > 0);
  for (const entry of plan.entries) {
    assert.equal(entry.outcome, "success", entry.reason);
    assert.equal(entry.start, entry.action.position);
    assert.ok(Math.abs(entry.end - (entry.start + entry.action.runSeconds)) < 1e-8);
  }
});

test("demo layout contains the requested rooms and decorative charging spaces", () => {
  const { maps: [map] } = createFleetDemoMap();
  const names = map.rooms.map(room => room.name);
  assert.ok(names.includes("Entrance Hall"));
  assert.equal(names.filter(name => name.startsWith("Meeting Room")).length, 2);
  assert.ok(names.includes("WC"));
  assert.ok(names.includes("EV"));
  assert.equal(map.floorPlan.chargingZones.length, 2);
  const cells = map.rooms.flatMap(room => room.cells);
  assert.equal(new Set(cells).size, 32 * 18);
  assert.equal(cells.length, 32 * 18);
  const hall = map.rooms.find(room => room.name === "Entrance Hall");
  assert.equal(hall.height, 900);
  assert.equal(hall.y, 0);
  assert.ok(hall.width <= 450);
  assert.equal(hall.appearance, "continuing-hall");
  assert.ok(map.rooms.find(room => room.name === "Security Waiting Bay").width >= 400);
  assert.ok(map.floorPlan.furniture.length >= 9);
  assert.equal(new Set(map.rooms.map(room => room.material)).size, 4);
  assert.equal(map.rooms.find(room => room.name === "EV").appearance, "elevator");
  assert.ok(map.floorPlan.chargingZones.every(zone =>
    Number.isFinite(zone.x) && Number.isFinite(zone.y) && zone.width > 0 && zone.height > 0));
});

test("Z-corridor route uses two explicit, orthogonal bends in each direction", () => {
  const { maps: [map] } = createFleetDemoMap();
  const cleaner = map.tracks.find(track => track.robotRole === "cleaning");
  const security = map.tracks.find(track => track.robotRole === "security");
  const movement = cleaner.actions.filter(action => action.type === "move" && action.motion !== "rotate");
  const directions = movement.map((action, index) => {
    const from = index ? movement[index - 1] : cleaner.initial;
    return action.x > from.x ? "east" : action.x < from.x ? "west" :
      action.y > from.y ? "north" : "south";
  });

  assert.deepEqual(directions, ["east", "north", "west", "east", "south", "west"]);
  assert.ok(cleaner.actions.filter(action => action.motion === "rotate").length >= 4);
  assert.equal(security.actions[1].motion, "rotate");
  assert.ok(movement.every((action, index) => {
    const from = index ? movement[index - 1] : cleaner.initial;
    return action.x === from.x || action.y === from.y;
  }));
});

test("main corridor doors clear the 100 mm robot footprint", () => {
  const { maps: [map] } = createFleetDemoMap();
  const side = ROBOT_SIDE;
  const circleDiameter = Math.SQRT2 * side;
  assert.ok(Math.abs(side - 144.54) < 0.02);
  assert.ok(circleDiameter < 250 - 12);

  const rooms = map.rooms.filter(r => ["Z Corridor", "Meeting Room 1", "Security Waiting Bay"].includes(r.name));
  const openings = buildNavigation(map).doors.filter(door => rooms.some(room => room.id === door.roomId));
  assert.equal(openings.length, 4);
  assert.ok(openings.every(door => Math.hypot(door.opening.x2 - door.opening.x1,
    door.opening.y2 - door.opening.y1) > circleDiameter));
});

test("default scenario visibly brings people to a meeting, releases them and then cleans", () => {
  const { maps: [map] } = createFleetDemoMap(), plan = compilePlan(map, { fixedTimeline: true });
  const person = map.tracks.find(track => track.kind === "human");
  assert.equal(person.count, 5);
  assert.equal(samplePlan(plan, 0).actors.find(a => a.id === person.id).aggregated, false);
  const meeting = samplePlan(plan, 4);
  assert.equal(meeting.events.length, 1);
  assert.equal(meeting.actors.find(a => a.id === person.id).aggregated, true);
  const finished = samplePlan(plan, 9);
  assert.equal(finished.events.length, 0);
  assert.equal(finished.actors.find(a => a.id === person.id).aggregated, false);
  assert.equal(finished.actors.find(a => a.id === person.id).x, 175);
  const unusedRooms = map.rooms.filter(r => ["EV", "Meeting Room 2", "WC"].includes(r.name));
  for (const door of plan.doorPlan.filter(d => unusedRooms.some(r => r.id === d.roomId))) {
    assert.deepEqual(door.windows, []);
  }
});

test("short exhibition uses a two-second meeting and gives priority to robot coordination", () => {
  const { maps: [map] } = createFleetDemoMap();
  const plan = compilePlan(map);
  const meeting = plan.entries.find(entry => entry.action.type === "event-start");
  assert.equal(meeting.end - meeting.start, 2);
  const cleaner = map.tracks.find(track => track.robotRole === "cleaning");
  const security = map.tracks.find(track => track.robotRole === "security");
  assert.equal(cleaner.actions[0].position, 15);
  assert.ok(Math.max(...security.actions.map(a => a.position + a.runSeconds)) <= 15);
  assert.equal(Math.max(...plan.entries.map(entry => entry.end)), 54);
});

test("charging centers accept initial robot placement without bypassing walls or furniture", () => {
  const { maps: [map] } = createFleetDemoMap();
  const safety = createSafety(map, { robotSide: ROBOT_SIDE });
  for (const zone of map.floorPlan.chargingZones) {
    const center = { x: zone.x + zone.width / 2, y: zone.y + zone.height / 2 };
    assert.equal(pathProblem(safety, center, center), "");
  }
  const furniture = safety.navigation.obstacles[0];
  assert.notEqual(pathProblem(safety, furniture, furniture), "");
  assert.notEqual(pathProblem(safety, { x: 10, y: 10 }, { x: 10, y: 10 }), "");
});

test("saved demos upgrade once while preserving custom timings, IDs and other maps", () => {
  const untouched = createFleetDemoMap({ legacy: true });
  assert.equal(refreshDemoScenarios(untouched), true);
  assert.equal(untouched.maps[0].tracks.flatMap(t => t.actions)
    .find(a => a.type === "event-start").runSeconds, 2);
  const project = createFleetDemoMap({ legacy: true });
  const [map] = project.maps, id = map.id;
  const customized = map.tracks.find(track => track.kind === "human").actions[0];
  customized.runSeconds = 4;
  project.maps.push({ id: "untouched" });
  assert.equal(refreshDemoScenarios(project), true);
  assert.equal(map.id, id);
  assert.equal(customized.runSeconds, 4);
  assert.deepEqual(project.maps[1], { id: "untouched" });
  assert.equal(map.tracks.flatMap(t => t.actions).find(a => a.type === "event-start").runSeconds, 19);
  assert.equal(refreshDemoScenarios(project), false);
});

test("office demo covers the field with a straight corridor, reception, offices and EV", () => {
  const project = createOfficeDemoMap();
  validateProject(project);
  const map = project.maps[0], cells = map.rooms.flatMap(room => room.cells);
  assert.equal(cells.length, 576);
  assert.equal(new Set(cells).size, 576);
  const corridor = map.rooms.find(room => room.name === "Central Corridor");
  assert.deepEqual([corridor.x, corridor.y, corridor.width, corridor.height], [400, 300, 1200, 300]);
  assert.ok(map.rooms.some(room => room.appearance === "elevator"));
  const nav = buildNavigation(map);
  assert.equal(nav.doors.length, 6);
  assert.ok(nav.doors.every(door =>
    Math.hypot(door.opening.x2 - door.opening.x1, door.opening.y2 - door.opening.y1) <= 288));
  assert.deepEqual(map.tracks.filter(track => track.kind === "human").map(track => track.count), [1, 3]);
});

test("office scenario has no collision, blocked door or timing warnings and returns to charging", () => {
  const { maps: [map] } = createOfficeDemoMap(), plan = compilePlan(map);
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.warnings, []);
  for (const entry of plan.entries) {
    assert.equal(entry.outcome, "success", `${entry.action.name}: ${entry.reason}`);
    assert.equal(entry.start, entry.action.position);
    assert.equal(entry.end, entry.action.position + entry.action.runSeconds);
  }
  const cleaner = map.tracks.find(track => track.robotRole === "cleaning");
  const security = map.tracks.find(track => track.robotRole === "security");
  assert.ok(security.actions.at(-1).position + security.actions.at(-1).runSeconds <=
    cleaner.actions[0].position);
  assert.equal(map.tracks.flatMap(track => track.actions)
    .find(action => action.type === "event-start").runSeconds, 2);
  const end = Math.max(...plan.entries.map(entry => entry.end));
  assert.equal(samplePlan(plan, end).actors.find(actor => actor.id === cleaner.id).x, cleaner.initial.x);
  assert.equal(samplePlan(plan, end).actors.find(actor => actor.id === cleaner.id).y, cleaner.initial.y);
  const safety = createSafety(map, { robotSide: ROBOT_SIDE });
  assert.equal(pathProblem(safety, cleaner.initial, cleaner.initial), "");
  const original = JSON.stringify(map);
  assert.equal(refreshDemoScenarios({ maps: [map] }), false);
  assert.equal(JSON.stringify(map), original);
});

test("office actors finish rotating at rest before every translation", () => {
  const { maps: [map] } = createOfficeDemoMap(), plan = compilePlan(map);
  const meeting = plan.entries.find(entry => entry.action.type === "event-start");
  const humans = samplePlan(plan, meeting.start + 1).actors.filter(actor => actor.kind === "human");
  assert.deepEqual(humans.map(actor => actor.count), [1, 3]);
  assert.ok(humans.every(actor => actor.aggregated));
  const normalize = value => ((value + 180) % 360 + 360) % 360 - 180;
  assert.ok(map.tracks.filter(track => track.kind === "human")
    .every(track => track.actions.every(action => action.motion !== "rotate")));
  for (const entry of plan.entries.filter(entry => entry.track.kind === "robot" &&
    entry.action.type === "move")) {
    const midpoint = samplePlan(plan, (entry.start + entry.end) / 2)
      .actors.find(actor => actor.id === entry.track.id);
    if (entry.action.motion === "rotate") {
      assert.equal(midpoint.x, entry.from.x);
      assert.equal(midpoint.y, entry.from.y);
    } else {
      const bearing = Math.atan2(entry.to.y - entry.from.y, entry.to.x - entry.from.x) * 180 / Math.PI;
      assert.ok(Math.abs(normalize(midpoint.yaw - bearing)) < 1e-6);
      assert.ok(Math.abs(midpoint.yaw - entry.from.yaw) < 1e-6);
    }
  }
});

test("fire coordination demo retreats cleaning before security enters the fire room", () => {
  const project = createCoordinationDemoMap("fire"), map = project.maps[0];
  validateProject(project);
  const plan = compilePlan(map, { fixedTimeline: true });
  const cleaner = map.tracks.find(track => track.robotRole === "cleaning");
  const security = map.tracks.find(track => track.robotRole === "security");
  const retreat = plan.entries.find(entry =>
    entry.action.name === "Continue retreat to reception");
  const response = plan.entries.find(entry => entry.action.name === "Enter the meeting room");

  assert.equal(map.coordinationDemo, "fire");
  assert.equal(map.executionMode, "timed");
  assert.equal(map.timelineOnly, true);
  assert.equal(map.tracks.filter(track => track.kind === "robot").length, 2);
  assert.equal(map.tracks.filter(track => track.kind === "human").length, 0);
  assert.equal(plan.duration, 33);
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.warnings, []);
  assert.ok(retreat.end < response.start);
  assert.ok(plan.entries.every(entry => entry.outcome === "success"));
  assert.ok(plan.entries.every(entry => entry.start === entry.action.position));
  assert.ok(plan.entries.every(entry =>
    Math.abs(entry.end - (entry.action.position + entry.action.runSeconds)) < 1e-8));
  assertRobotFacing(plan);
  assert.equal(samplePlan(plan, 10).actors.find(actor => actor.id === cleaner.id).x, 225);
  assert.equal(samplePlan(plan, 10).actors.find(actor => actor.id === security.id).x, 825);
  assert.ok(samplePlan(plan, 10).events.some(event => event.state === "fire"));
});

test("yield coordination demo waits, retreats from the shared corridor and stays collision-free", () => {
  const project = createCoordinationDemoMap("yield"), map = project.maps[0];
  validateProject(project);
  const plan = compilePlan(map, { fixedTimeline: true });
  const cleaner = map.tracks.find(track => track.robotRole === "cleaning");
  const retreat = plan.entries.find(entry => entry.action.name === "Retreat into the meeting room");
  const cleanerWait = plan.entries.find(entry =>
    entry.action.name === "Wait while security clears the corridor");
  const securityWait = plan.entries.find(entry =>
    entry.action.name === "Wait for cleaning robot to retreat");
  const securityPass = plan.entries.find(entry =>
    entry.action.name === "Pass west through the shared corridor");

  assert.equal(map.coordinationDemo, "yield");
  assert.equal(map.tracks.filter(track => track.kind === "robot").length, 2);
  assert.equal(map.tracks.filter(track => track.kind === "human").length, 0);
  assert.equal(plan.duration, 60);
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.warnings, []);
  assert.ok(retreat.end <= securityPass.start);
  assert.ok(cleanerWait.end >= securityPass.end);
  assert.ok(securityWait.end === securityPass.start);
  assert.ok(plan.entries.every(entry => entry.outcome === "success"));
  assert.ok(plan.entries.every(entry => entry.start === entry.action.position));
  assert.ok(plan.entries.every(entry =>
    Math.abs(entry.end - (entry.action.position + entry.action.runSeconds)) < 1e-8));
  assertRobotFacing(plan);
  const waiting = samplePlan(plan, 4).actors.find(actor => actor.id === cleaner.id);
  assert.deepEqual([waiting.x, waiting.y], [725, 725]);
});

test("coordination demo rejects unsupported scenario names", () => {
  assert.throws(() => createCoordinationDemoMap("other"), /Unknown coordination demo/);
});

test("conflict companion is simulation-only and predicts a collision without plan errors", () => {
  const project = createCoordinationDemoMap("conflict"), map = project.maps[0];
  validateProject(project);
  const plan = compilePlan(map, { fixedTimeline: true });

  assert.match(map.name, /競合例.*シミュレーション/);
  assert.equal(map.simulationOnly, true);
  assert.equal(map.tracks.filter(track => track.kind === "robot").length, 2);
  assert.deepEqual(plan.errors, []);
  assert.ok(plan.warnings.some(warning => warning.code === "collision"));
  assert.equal(plan.duration, 60);
  assert.ok(plan.entries.every(entry => entry.outcome === "success"));
});

test("room activity follows physical robot occupancy and excludes charging and muted robots", () => {
  const { maps: [map] } = createOfficeDemoMap(), plan = compilePlan(map);
  const cleaner = map.tracks.find(track => track.robotRole === "cleaning");
  const security = map.tracks.find(track => track.robotRole === "security");
  const cleanEntry = plan.entries.find(entry => entry.action.name === "清掃（3秒）");
  const cleanState = samplePlan(plan, cleanEntry.start + 1);
  const room = map.rooms.find(room => room.name === "Meeting Room");
  assert.ok(cleanState.roomActivities.some(activity => activity.roomId === room.id && activity.text === "掃除中"));
  const end = samplePlan(plan, plan.duration);
  assert.ok(end.roomActivities.some(activity => activity.text === "監視中" && activity.actorIds.includes(security.id)));
  assert.ok(!end.roomActivities.some(activity => activity.actorIds.includes(cleaner.id)));
  cleaner.muted = true; security.muted = true;
  assert.deepEqual(samplePlan(compilePlan(map), cleanEntry.start + 1).roomActivities, []);
  const inside = cleanState.actors.find(actor => actor.id === cleaner.id);
  map.tracks = ["cleaning", "cleaning", "security", "delivery"].map((role, index) => ({
    ...cleaner, id: `activity-${index}`, robotId: index, robotRole: role, muted: false, actions: [],
    initial: { x: inside.x, y: inside.y, yaw: 0, roomId: "stale-room" },
  }));
  const combined = samplePlan(compilePlan(map), 0).roomActivities;
  assert.equal(combined.length, 1);
  assert.equal(combined[0].roomId, room.id);
  assert.equal(combined[0].text, "掃除中 / 監視中 / 配送中");
  assert.equal(combined[0].actorIds.length, 4);
  assert.deepEqual(samplePlan(compilePlan(map), 2).roomActivities, combined);
});

test("transit and turning robots never become room activities while crossing the entrance", () => {
  for (const project of [createFleetDemoMap(), createOfficeDemoMap()]) {
    const map = project.maps[0], plan = compilePlan(map, { fixedTimeline: true });
    const trips = plan.entries.filter(entry => !entry.blocked && entry.action.type === "move" &&
      (entry.action.motion === "rotate" || entry.from.x !== entry.to.x || entry.from.y !== entry.to.y));
    for (const trip of trips) {
      for (const at of [trip.start, trip.start + .01, (trip.start + trip.end) / 2, trip.end - .01]) {
        const state = samplePlan(plan, at);
        assert.ok(!state.roomActivities.some(activity => activity.actorIds.includes(trip.track.id)),
          `${map.name} / ${trip.action.name} at ${at}`);
      }
    }
    const clean = plan.entries.find(entry => /Clean Meeting Room 1|清掃（3秒）/.test(entry.action.name));
    assert.ok(samplePlan(plan, clean.start + .5).roomActivities.some(activity =>
      activity.actorIds.includes(clean.track.id) && activity.text.includes("掃除中")));
  }
});
