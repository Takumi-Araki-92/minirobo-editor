import test from "node:test";
import assert from "node:assert/strict";
import {
  regionBounds, roomContainsPoint, roomAnchor, validateFloorPlan, renderFloorPlan,
  rectangleCells, boundaryEdge, cellNeighbor, removeRegion, nearestDoorWall, buildNavigation,
  mergedDoors,
  GRID_COLUMNS, GRID_ROWS, CELL_SIZE, CELL_COUNT,
  furnitureCells, rotateFurniture, SCREEN_WIDTH_MM, SCREEN_HEIGHT_MM, GRID_CELL_MM,
} from "../public/floor-plan.js";
import {
  createProject, newAction, validateProject, copyMapLayout, projectForSave, useTimelineOnly,
} from "../public/model.js";
import { createSafety, pathProblem } from "../public/safety.js";

const region = (id, cells, extras = {}) => ({
  id, name: id, color: "#739a81", kind: "room", material: "concrete",
  cells: [...cells], ...regionBounds(cells), ...extras,
});
const map = (...rooms) => ({
  id: "map", name: "Plan", background: null, rooms, tracks: [],
  floorPlan: { doors: [], furniture: [] },
});

test("50-inch physical dimensions describe display area, not ratio coordinate units", () => {
  assert.ok(Math.abs(Math.hypot(SCREEN_WIDTH_MM, SCREEN_HEIGHT_MM) - 1270) < 1e-9);
  assert.ok(Math.abs(SCREEN_WIDTH_MM / SCREEN_HEIGHT_MM - 16 / 9) < 1e-12);
  assert.ok(Math.abs(GRID_CELL_MM - SCREEN_HEIGHT_MM / GRID_ROWS) < 1e-12);
  assert.equal(GRID_CELL_MM.toFixed(1), "34.6");
  assert.equal(SCREEN_WIDTH_MM.toFixed(1), "1106.9");
  assert.equal(SCREEN_HEIGHT_MM.toFixed(1), "622.6");
});

test("multi-cell furniture roundtrips and blocks every occupied navigation cell", () => {
  const p = map(region("room", [0, 1, 2, 32, 33, 34, 64, 65, 66]));
  for (const type of ["desk", "chair", "plant"]) {
    p.floorPlan.furniture = [{
      id: "item", roomId: "room", cell: 0, cells: [0, 1, 32, 33], type, rotation: 0,
    }];
    const before = structuredClone(p);
    assert.deepEqual(validateFloorPlan(JSON.parse(JSON.stringify(p))), before);
    const n = buildNavigation(p);
    assert.deepEqual(n.obstacles[0], { id: "item", roomId: "room", cell: 0, type,
      x: 0, y: 800, width: 100, height: 100, rotation: 0 });
    for (const cell of [0, 1, 32, 33]) assert.equal(n.cells[cell].traversable, false);
    assert.equal(n.cells[2].traversable, true);
    assert.deepEqual(p, before);
    const overlapping = structuredClone(p);
    overlapping.floorPlan.furniture.push({
      id: "other", roomId: "room", cell: 33, type: "plant", rotation: 0,
    });
    assert.throws(() => validateFloorPlan(overlapping), /1セル/);
    for (const cells of [[], null, [0, 0], [0, 33], [0, 1, 32], [0, 576], [1, 2]]) {
      const trial = structuredClone(p);
      trial.floorPlan.furniture[0].cells = cells;
      assert.throws(() => validateFloorPlan(trial));
    }
  }
  p.floorPlan.furniture[0].cells = [2, 3];
  p.floorPlan.furniture[0].cell = 2;
  assert.throws(() => validateFloorPlan(p), /同じ領域/);
});

test("furniture cannot cross a room boundary or a hole", () => {
  const p = map(region("a", [0, 32]), region("b", [1, 33]));
  p.floorPlan.furniture = [{
    id: "item", roomId: "a", cell: 0, cells: [0, 1], type: "desk", rotation: 0,
  }];
  assert.throws(() => validateFloorPlan(p), /同じ領域/);
  const hole = map(region("a", [0, 1, 32]));
  hole.floorPlan = p.floorPlan;
  hole.floorPlan.furniture[0].cells = [0, 1, 32, 33];
  assert.throws(() => validateFloorPlan(hole), /同じ領域/);
});

test("rotation swaps the footprint and rejects blocked or out-of-map results", () => {
  const item = { id: "item", roomId: "room", cell: 0, cells: [0, 1, 2],
    type: "desk", rotation: 0 };
  const before = structuredClone(item);
  const rotated = rotateFurniture(item, 90);
  assert.deepEqual(rotated.cells, [0, 32, 64]);
  assert.deepEqual(rotateFurniture(rotated, 0), item);
  assert.deepEqual(item, before);
  const p = map(region("room", [0, 1, 2, 32, 64]));
  p.floorPlan.furniture = [rotated];
  assert.equal(validateFloorPlan(p), p);
  p.floorPlan.furniture.push({ id: "other", roomId: "room", cell: 32, type: "plant", rotation: 0 });
  assert.throws(() => validateFloorPlan(p), /1セル/);
  assert.throws(() => rotateFurniture({ ...item, cell: 544, cells: [544, 545, 546] }, 90), /外/);
  assert.deepEqual(furnitureCells({ cell: 10 }), [10]);
});

test("adjacent doors merge into a continuous opening without a central wall", () => {
  const p = map(region("room", [0, 1, 2, 32, 64]));
  p.floorPlan.doors = [
    { id: "b", roomId: "room", cell: 1, edge: "top" },
    { id: "a", roomId: "room", cell: 0, edge: "top" },
  ];
  const before = structuredClone(p);
  assert.deepEqual(mergedDoors(p)[0].memberIds, ["a", "b"]);
  const nav = buildNavigation(p);
  assert.equal(nav.doors.length, 1);
  assert.deepEqual(nav.doors[0].opening, { x1: 6, y1: 900, x2: 94, y2: 900 });
  assert.equal(nav.walls.some(w => w.y1 === 900 && w.y2 === 900 &&
    w.x1 < 94 && w.x2 > 6), false);
  assert.deepEqual(p, before);
  p.floorPlan.doors.push({ id: "c", roomId: "room", cell: 2, edge: "top" });
  assert.equal(mergedDoors(p)[0].memberIds.length, 3);
  p.floorPlan.doors = [
    { id: "a", roomId: "room", cell: 0, edge: "left" },
    { id: "b", roomId: "room", cell: 32, edge: "left" },
    { id: "c", roomId: "room", cell: 2, edge: "top" },
  ];
  assert.equal(mergedDoors(p).length, 2);
  assert.deepEqual(buildNavigation(p).doors.find(d => d.memberIds.length === 2).opening,
    { x1: 0, y1: 894, x2: 0, y2: 806 });
  p.floorPlan.doors = [
    { id: "a", roomId: "room", cell: 0, edge: "top" },
    { id: "b", roomId: "room", cell: 2, edge: "top" },
  ];
  assert.equal(mergedDoors(p).length, 2);
});

test("navigation exports bottom-left walls, door gaps and conservative obstacle cells", () => {
  const p = map(region("room", [0, 1, 32]));
  p.floorPlan.doors.push({ id: "door", roomId: "room", cell: 0, edge: "top" });
  p.floorPlan.furniture.push({ id: "desk", roomId: "room", cell: 1, type: "desk", rotation: 90 });
  const before = structuredClone(p), n = buildNavigation(p);
  assert.deepEqual(p, before);
  assert.equal(n.schema, "floor-navigation/v1");
  assert.equal(n.cells.length, 576);
  assert.equal(n.cells[0].traversable, true);
  assert.equal(n.cells[1].reason, "furniture");
  assert.equal(n.cells[33].reason, "unassigned");
  assert.deepEqual(n.doors[0].opening, { x1: 6, y1: 900, x2: 44, y2: 900 });
  assert.equal(n.walls.some(w => w.y1 === 900 && w.x1 === 0 && w.x2 === 6), true);
  assert.deepEqual(n.obstacles[0], {
    id: "desk", type: "desk", roomId: "room", cell: 1,
    x: 50, y: 850, width: 50, height: 50, rotation: 90,
  });
  const shared = map(region("a", [0]), region("b", [1]));
  shared.floorPlan.doors.push({ id: "between", roomId: "a", cell: 0, edge: "right" });
  assert.equal(buildNavigation(shared).doors[0].adjacentRoomId, "b");
  const legacy = { ...p }; delete legacy.floorPlan;
  assert.equal(buildNavigation(legacy).status, "unavailable");
});

test("door snapping finds walls from either side, outer border and shared walls", () => {
  const p = map(region("left", [33, 65]), region("right", [34, 66]));
  assert.deepEqual(nearestDoorWall(p, 98, 75), { roomId: "left", cell: 33, edge: "right" });
  assert.deepEqual(nearestDoorWall(p, 102, 75, { roomId: "left" }),
    { roomId: "left", cell: 33, edge: "right" });
  assert.deepEqual(nearestDoorWall(p, 48, 75), { roomId: "left", cell: 33, edge: "left" });
  assert.equal(nearestDoorWall(p, 500, 500), null);
  assert.equal(nearestDoorWall(p, 98, 100, { edge: "bottom", maxDistance: 10 }), null);
  assert.deepEqual(nearestDoorWall(map(region("border", [0])), 0, 25),
    { roomId: "border", cell: 0, edge: "left" });
  assert.throws(() => nearestDoorWall(p, NaN, 0));
});

test("named partition walls and corridor doors persist and export navigation geometry", () => {
  const p = map(region("hall", [0, 1, 2, 32, 33, 34], { kind: "corridor" }));
  p.floorPlan.walls = [{
    id: "partition", roomId: "hall", name: "Reception partition",
    x1: 25, y1: 25, x2: 225, y2: 25,
  }];
  p.floorPlan.doors = [{
    id: "gate", roomId: "hall", wallId: "partition", name: "North entrance",
    kind: "flapper", x1: 75, y1: 25, x2: 125, y2: 25,
  }];
  const before = structuredClone(p);
  assert.deepEqual(validateFloorPlan(JSON.parse(JSON.stringify(p))), before);
  const navigation = buildNavigation(p);
  assert.deepEqual(navigation.doors[0], {
    id: "gate", roomId: "hall", cell: undefined, edge: undefined,
    name: "North entrance", kind: "flapper", memberIds: ["gate"], adjacentRoomId: null,
    opening: { x1: 81, y1: 875, x2: 119, y2: 875 }, state: "unspecified",
  });

  assert.ok(navigation.walls.some(wall =>
    wall.y1 === 875 && wall.x1 === 25 && wall.x2 === 81));
  assert.ok(navigation.walls.some(wall =>
    wall.y1 === 875 && wall.x1 === 119 && wall.x2 === 225));
  assert.deepEqual(p, before);
  assert.deepEqual(validateFloorPlan(JSON.parse(JSON.stringify(p))).floorPlan, p.floorPlan);
  assert.throws(() => validateFloorPlan({
    ...p, floorPlan: { ...p.floorPlan, doors: [{ ...p.floorPlan.doors[0], wallId: "missing" }] },
  }), /壁が見つかりません/);
  assert.throws(() => validateFloorPlan({
    ...p, floorPlan: { ...p.floorPlan, walls: [{ ...p.floorPlan.walls[0], y2: 50 }] },
  }), /水平・垂直/);
  assert.throws(() => validateFloorPlan({
    ...p, floorPlan: { ...p.floorPlan, doors: [
      p.floorPlan.doors[0], { ...p.floorPlan.doors[0], id: "overlap", x1: 100, x2: 150 },
    ] },
  }), /重ねられません/);
});

test("independent corridor barriers stop unsafe paths and wide door openings permit passage", () => {
  const p = map(region("hall", Array.from({ length: CELL_COUNT }, (_, cell) => cell),
    { kind: "corridor" }));
  p.floorPlan.walls = [{
    id: "partition", roomId: "hall", name: "Corridor divider",
    x1: 25, y1: 425, x2: 525, y2: 425,
  }];
  const from = { x: 275, y: 400 }, to = { x: 275, y: 550 };
  assert.match(pathProblem(createSafety(p), from, to), /壁/);
  const candidate = nearestDoorWall(p, 275, 425, { maxDistance: 1 });
  assert.deepEqual([candidate.x1, candidate.y1, candidate.x2, candidate.y2],
    [125, 425, 375, 425]);
  p.floorPlan.doors.push({
    id: "entrance", roomId: "hall", wallId: "partition", name: "Entrance",
    kind: "automatic", x1: candidate.x1, y1: candidate.y1, x2: candidate.x2, y2: candidate.y2,
  });
  assert.equal(pathProblem(createSafety(p), from, to), "");
});

test("rendering can hide labels while preserving names, elevator appearance and reception monitor", () => {
  const prior = globalThis.document;
  globalThis.document = { createElementNS: (_namespace, tag) => new SvgElement(tag) };
  try {
    const p = map(region("lift", [0, 1, 32, 33], { appearance: "elevator", name: "Lift" }));
    p.floorPlan.furniture.push({
      id: "monitor", roomId: "lift", cell: 0, type: "reception-monitor", rotation: 0,
    });
    const shown = descendants(renderFloorPlan(p));
    assert.ok(shown.some(node => node.attributes["data-elevator"] === "lift"));
    assert.equal(shown.find(node => node.attributes["data-furniture"] === "monitor")
      .attributes["data-variant"], "reception-monitor");
    assert.ok(shown.some(node => node.tag === "text" && node.textContent === "Lift"));
    p.floorPlan.showRoomLabels = false;
    const hidden = descendants(renderFloorPlan(p));
    assert.ok(!hidden.some(node => node.tag === "text" && node.textContent === "Lift"));
    assert.deepEqual(p.rooms[0].name, "Lift");
    assert.equal(validateFloorPlan(p), p);
    p.floorPlan.showRoomLabels = "false";
    assert.throws(() => validateFloorPlan(p), /真偽値/);
  } finally {
    if (prior === undefined) delete globalThis.document;
    else globalThis.document = prior;
  }
});

test("door mode and door-specific unlock references validate and remap with copied layouts", () => {
  const legacy = createProject({ ordered: true });
  assert.equal(validateProject(legacy), legacy);
  assert.equal(Object.hasOwn(legacy.maps[0], "doorMode"), false);
  const project = createProject({ ordered: true }), mapValue = project.maps[0];
  project.schema = "robot-scene/v4";
  mapValue.executionMode = "timed";
  mapValue.doorMode = "story";
  const roomId = mapValue.rooms[0].id;
  mapValue.rooms.push({
    id: "other-room", name: "Other", x: 0, y: 0, width: 100, height: 100, color: "#123456",
  });
  mapValue.floorPlan = {
    doors: [{
      id: "door", roomId, wallId: "wall", name: "Lobby entrance", kind: "automatic",
      x1: 100, y1: 100, x2: 150, y2: 100,
    }],
    furniture: [],
    walls: [{ id: "wall", roomId, x1: 50, y1: 100, x2: 200, y2: 100 }],
  };
  for (const track of mapValue.tracks) {
    if (track.initial) Object.assign(track.initial, { x: 325, y: 325 });
    for (const action of track.actions) {
      action.runSeconds = 1;
      if (["move", "show"].includes(action.type)) Object.assign(action, { x: 325, y: 325 });
    }
  }
  const roomTrack = mapValue.tracks.find(track => track.kind === "room");
  const unlock = newAction(mapValue, roomTrack, "unlock");
  Object.assign(unlock, { roomId, position: 0, runSeconds: 1, doorId: "door" });
  roomTrack.actions.push(unlock);
  assert.equal(validateProject(project), project);
  const badMode = structuredClone(project);
  badMode.maps[0].doorMode = "loose";
  assert.throws(() => validateProject(badMode), /strictまたはstory/);
  const badRoom = structuredClone(project);
  badRoom.maps[0].tracks.find(track => track.kind === "room").actions.at(-1).roomId = "other-room";
  assert.throws(() => validateProject(badRoom), /指定ドア/);
  const badDoor = structuredClone(project);
  badDoor.maps[0].tracks.find(track => track.kind === "room").actions.at(-1).doorId = "missing";
  assert.throws(() => validateProject(badDoor), /指定ドア/);
  const badType = structuredClone(project);
  badType.maps[0].tracks.find(track => track.kind === "room").actions.at(-1).type = "wait";
  assert.throws(() => validateProject(badType), /解錠アクション/);
  const copied = copyMapLayout(mapValue, "Copy");
  assert.equal(copied.doorMode, "story");
  assert.notEqual(copied.floorPlan.walls[0].id, mapValue.floorPlan.walls[0].id);
  assert.notEqual(copied.floorPlan.doors[0].id, mapValue.floorPlan.doors[0].id);
  assert.equal(copied.floorPlan.doors[0].wallId, copied.floorPlan.walls[0].id);
  assert.equal(copied.floorPlan.doors[0].roomId, copied.rooms[0].id);
});

test("grid bounds use top-row indices and bottom-left world coordinates", () => {
  assert.deepEqual([GRID_COLUMNS, GRID_ROWS, CELL_SIZE, CELL_COUNT], [32, 18, 50, 576]);
  assert.deepEqual(regionBounds([0]), { x: 0, y: 850, width: 50, height: 50 });
  assert.deepEqual(regionBounds([575]), { x: 1550, y: 0, width: 50, height: 50 });
  assert.deepEqual(regionBounds([0, 1, 32, 64]), { x: 0, y: 750, width: 100, height: 150 });
  assert.deepEqual(regionBounds([0, 575]), { x: 0, y: 0, width: 1600, height: 900 });
  for (const cells of [[], [576], [-1], [1.5], ["1"], [NaN], [Infinity], null]) {
    assert.throws(() => regionBounds(cells));
  }
});

test("actual L-shaped occupancy excludes the missing bbox corner", () => {
  const room = region("L", [0, 32, 64, 65, 66]);
  assert.equal(roomContainsPoint(room, 25, 875), true);
  assert.equal(roomContainsPoint(room, 125, 775), true);
  assert.equal(roomContainsPoint(room, 125, 875), false);
  assert.equal(roomContainsPoint(room, 75, 825), false);
  assert.equal(roomContainsPoint(room, -1, 875), false);
  assert.equal(roomContainsPoint(room, Infinity, 0), false);
  assert.equal(roomContainsPoint(room, 0, NaN), false);
  assert.equal(roomContainsPoint(room, "25", 875), false);
  const anchor = roomAnchor(room);
  assert.equal(roomContainsPoint(room, anchor.x, anchor.y), true);
  assert.deepEqual(anchor, { x: 25, y: 825 });
});

test("anchor selects a cell interior even for a ring with a hole", () => {
  const room = region("ring", [0, 1, 2, 32, 34, 64, 65, 66]);
  assert.equal(roomContainsPoint(room, 75, 825), false);
  const anchor = roomAnchor(room);
  assert.equal(roomContainsPoint(room, anchor.x, anchor.y), true);
  assert.ok(room.cells.some(cell => anchor.x === (cell % 32 + .5) * 50 &&
    anchor.y === (18 - Math.floor(cell / 32) - .5) * 50));
  const center = { x: 75, y: 825 };
  assert.equal((anchor.x - center.x) ** 2 + (anchor.y - center.y) ** 2, 2500);
});

test("legacy rectangles remain unmodified, optional floor plan is supported", () => {
  const room = { id: "legacy", name: "Old", x: 100, y: 200, width: 200, height: 100, color: "#aaccee" };
  const value = { rooms: [room] }, before = structuredClone(value);
  assert.equal(validateFloorPlan(value), value);
  assert.equal(roomContainsPoint(room, 120, 220), true);
  assert.equal(roomContainsPoint(room, 301, 220), false);
  assert.deepEqual(roomAnchor(room), { x: 200, y: 250 });
  const cells = rectangleCells(room);
  assert.equal(cells.length, 8);
  assert.deepEqual(regionBounds(cells), { x: 100, y: 200, width: 200, height: 100 });
  assert.deepEqual(value, before);
});

test("ownership validates polygons instead of overlapping bounding boxes", () => {
  const a = region("a", [0, 32, 64, 65, 66]);
  const b = region("b", [1, 2, 33, 34]);
  assert.equal(validateFloorPlan(map(a, b)).rooms.length, 2);
  assert.throws(() => validateFloorPlan(map(a, region("b", [32, 33]))), /重な/);
  assert.throws(() => validateFloorPlan(map(region("a", [0, 0]))), /重複/);
  assert.throws(() => validateFloorPlan(map({ ...a, width: 50 })), /外接矩形/);
  assert.throws(() => validateFloorPlan(map({ ...a, cells: [] })), /セル/);
  assert.throws(() => validateFloorPlan(map({ ...a, cells: [576] })), /セル/);
  assert.throws(() => validateFloorPlan(map(a, {
    id: "legacy", name: "Legacy", x: 0, y: 850, width: 50, height: 50, color: "#aabbcc",
  })), /重な/);
});

test("doors belong to occupied cell boundaries and shared-wall doors are unique", () => {
  const room = region("a", [0, 1, 32]);
  assert.equal(boundaryEdge(room, 0, "top"), true);
  assert.equal(boundaryEdge(room, 0, "right"), false);
  assert.equal(boundaryEdge(room, 0, "bottom"), false);
  assert.equal(boundaryEdge(room, 1, "bottom"), true);
  assert.equal(boundaryEdge(room, 33, "top"), false);
  assert.equal(cellNeighbor(31, "right"), -1);
  assert.equal(cellNeighbor(32, "left"), -1);
  assert.equal(cellNeighbor(0, "top"), -1);
  assert.equal(cellNeighbor(575, "bottom"), -1);
  const value = map(room, region("b", [2]));
  value.floorPlan.doors.push({ id: "door", roomId: "a", cell: 1, edge: "right" });
  assert.equal(validateFloorPlan(value), value);
  value.floorPlan.doors.push({ id: "other", roomId: "b", cell: 2, edge: "left" });
  assert.throws(() => validateFloorPlan(value), /同じ壁/);
  for (const change of [
    { edge: "inside" }, { edge: "left", cell: 1 }, { cell: 33 }, { cell: .5 },
    { roomId: "missing" }, { cell: "1" },
  ]) {
    const trial = map(room);
    trial.floorPlan.doors = [{ id: "door", roomId: "a", cell: 1, edge: "top", ...change }];
    assert.throws(() => validateFloorPlan(trial));
  }
});

test("furniture validates occupancy, kind, cardinal rotation and unique cell", () => {
  const value = map(region("a", [0, 32, 64, 65, 66]));
  for (const [index, type] of ["desk", "chair", "plant"].entries()) {
    value.floorPlan.furniture.push({ id: `item-${index}`, roomId: "a", cell: index * 32, type, rotation: index * 90 });
  }
  assert.equal(validateFloorPlan(value), value);
  for (const change of [
    { cell: 1 }, { cell: -1 }, { cell: Infinity }, { cell: "0" },
    { type: "script" }, { rotation: 45 }, { rotation: 360 }, { rotation: "90" },
    { roomId: "__proto__" }, { id: "a" },
  ]) {
    const trial = structuredClone(value);
    Object.assign(trial.floorPlan.furniture[0], change);
    assert.throws(() => validateFloorPlan(trial));
  }
  value.floorPlan.furniture.push({ id: "duplicate", roomId: "a", cell: 0, type: "desk", rotation: 0 });
  assert.throws(() => validateFloorPlan(value), /1セル/);
});

test("strict values, ID safety and count limits reject malformed plans", () => {
  for (const change of [
    { x: NaN }, { y: Infinity }, { width: -1 }, { height: 0 }, { x: "0" },
    { id: "" }, { id: "__proto__" }, { id: "constructor" }, { id: "$start" },
    { id: "x".repeat(101) }, { name: 1 }, { name: "x".repeat(121) },
    { color: "red" }, { color: "#123456;fill:red" }, { kind: "hall" },
    { material: "marble" }, { cells: null }, { cells: [true] },
  ]) {
    assert.throws(() => validateFloorPlan(map({ ...region("a", [0]), ...change })));
  }
  for (const plan of [
    null, [], {}, { doors: [], furniture: null }, { doors: "x", furniture: [] },
    { doors: Array(2305).fill({}), furniture: [] },
    { doors: [], furniture: Array(577).fill({}) },
  ]) {
    const value = map(region("a", [0])); value.floorPlan = plan;
    assert.throws(() => validateFloorPlan(value));
  }
  assert.throws(() => validateFloorPlan({ rooms: Array(101).fill(region("a", [0])) }));
  assert.throws(() => validateFloorPlan(map(region("a", [0]), region("a", [1]))));
  assert.throws(() => validateFloorPlan(null));
});

test("JSON roundtrip preserves IDs, references, polygons and fixtures", () => {
  const value = map(region("a", [0, 32, 64, 65, 66], { material: "wood" }));
  value.tracks.push({ id: "track", roomId: "a", initial: { roomId: "a" }, actions: [{ roomId: "a" }] });
  value.floorPlan.doors.push({ id: "door", roomId: "a", cell: 0, edge: "left" });
  value.floorPlan.furniture.push({ id: "plant", roomId: "a", cell: 64, type: "plant", rotation: 270 });
  const before = structuredClone(value);
  assert.deepEqual(validateFloorPlan(JSON.parse(JSON.stringify(value))), before);
  assert.deepEqual(value, before);
});

test("unreferenced region deletion removes fixtures without mutating the input", () => {
  const value = map(region("a", [0]), region("b", [1]));
  value.floorPlan.doors.push({ id: "door", roomId: "a", cell: 0, edge: "top" });
  value.floorPlan.furniture.push(
    { id: "plant", roomId: "a", cell: 0, type: "plant", rotation: 0 },
    { id: "desk", roomId: "b", cell: 1, type: "desk", rotation: 0 },
  );
  const before = structuredClone(value);
  const result = removeRegion(value, "a");
  assert.deepEqual(result.rooms.map(room => room.id), ["b"]);
  assert.deepEqual(result.floorPlan.doors, []);
  assert.deepEqual(result.floorPlan.furniture.map(item => item.id), ["desk"]);
  assert.equal(validateFloorPlan(result), result);
  assert.deepEqual(value, before);
  const blank = { id: "blank", name: "Blank", cells: [] };
  assert.deepEqual(removeRegion({ rooms: [blank], tracks: [] }, "blank").rooms, []);
  assert.throws(() => removeRegion(value, "missing"), /見つかりません/);
});

test("region deletion protects direct track, initial and action room references", () => {
  for (const track of [
    { roomId: "a" }, { initial: { roomId: "a" } },
    { actions: [{ roomId: "b" }, { roomId: "a" }] },
  ]) {
    const value = map(region("a", [0]), region("b", [1]));
    value.tracks.push(track);
    const before = structuredClone(value);
    assert.throws(() => removeRegion(value, "a"), /参照.*削除できません/);
    assert.deepEqual(value, before);
  }
});

class SvgElement {
  constructor(tag) { this.tag = tag; this.attributes = {}; this.children = []; this.textContent = ""; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  append(...children) { this.children.push(...children); }
}
function descendants(element) { return [element, ...element.children.flatMap(descendants)]; }

test("renderer stretches furniture to its footprint and switches multi-cell variants", () => {
  const prior = globalThis.document;
  globalThis.document = { createElementNS: (_namespace, tag) => new SvgElement(tag) };
  try {
    const p = map(region("room", [0, 1, 2, 32, 33, 34]));
    for (const [type, variant] of [["desk", "long-desk"], ["chair", "bench"], ["plant", "large-plant"]]) {
      p.floorPlan.furniture = [{ id: "item", roomId: "room", cell: 0,
        cells: [0, 1, 2, 32, 33, 34], type, rotation: 0 }];
      const before = structuredClone(p);
      const nodes = descendants(renderFloorPlan(p));
      const item = nodes.find(node => node.attributes["data-furniture"] === "item");
      assert.equal(item.attributes["data-variant"], variant);
      assert.equal(item.attributes.transform, "translate(75 50) rotate(0)");
      if (type === "desk" || type === "chair") {
        assert.equal(Number(item.children[0].attributes.width), type === "desk" ? 138 : 136);
        assert.equal(Number(item.children[0].attributes.height), type === "desk" ? 88 : 84);
        assert.ok(item.children.length >= 5);
      } else assert.match(item.children[0].attributes.transform, /^scale\(/);
      const title = item.children.find(node => node.tag === "title");
      assert.match(title.textContent, /3 × 2 cells/);
      assert.deepEqual(p, before);
      p.floorPlan.furniture = [rotateFurniture(p.floorPlan.furniture[0], 90)];
      const rotated = descendants(renderFloorPlan(p)).find(node => node.attributes["data-furniture"]);
      assert.equal(rotated.attributes.transform, "translate(50 75) rotate(-90)");
      assert.equal(rotated.attributes["data-variant"], variant);
    }
  } finally {
    if (prior === undefined) delete globalThis.document;
    else globalThis.document = prior;
  }
});

test("renderer is DOM-lazy, has clickable geometry, shared walls, door gap and textured furniture", () => {
  const prior = globalThis.document;
  globalThis.document = { createElementNS: (_namespace, tag) => new SvgElement(tag) };
  try {
    const value = map(region("a", [0, 32]), region("b", [1]));
    value.floorPlan.doors.push({ id: "door", roomId: "a", cell: 0, edge: "right" });
    value.floorPlan.furniture.push({ id: "desk", roomId: "a", cell: 32, type: "desk", rotation: 90 });
    const before = structuredClone(value), rendered = renderFloorPlan(value);
    assert.equal(rendered.tag, "g");
    const nodes = descendants(rendered);
    assert.equal(nodes.filter(node => node.tag === "pattern").length, 4);
    const roomGroup = nodes.find(node => node.tag === "g" && node.attributes["data-room"] === "a");
    assert.equal(roomGroup.children[0].tag, "path");
    assert.match(roomGroup.children[0].attributes.d, /M0 0h50v50h-50ZM0 50/);
    assert.equal(roomGroup.children[0].attributes["shape-rendering"], "crispEdges");
    const walls = nodes.find(node => node.attributes.class === "floor-walls");
    assert.equal(walls.children.length, 10);
    assert.ok(!walls.children.some(node => node.attributes.x1 === "50" && node.attributes.y1 === "0" &&
      node.attributes.x2 === "50" && node.attributes.y2 === "50"));
    const door = nodes.find(node => node.attributes["data-door"] === "door");
    assert.equal(door.attributes["data-state"], "closed");
    assert.equal(door.attributes["data-opening"], "50,894,50,856");
    const panels = door.children.find(node => node.attributes["data-door-panels"] === "");
    assert.equal(panels.tag, "svg");
    assert.equal(panels.attributes.overflow, "hidden");
    assert.equal(panels.attributes.width, "38");
    assert.equal(panels.attributes.viewBox, "0 -7 38 14");
    assert.equal(panels.children.filter(node => node.attributes["data-door-leaf"]).length, 2);
    const frame = door.children.find(node => node.attributes["data-door-frame"] === "");
    assert.ok(frame);
    assert.equal(frame.children.filter(node => node.attributes["data-door-jamb"] === "").length, 2);
    assert.equal(Number(frame.children[0].attributes.width), 38);
    assert.equal(frame.attributes["clip-path"], undefined);
    const furniture = nodes.find(node => node.attributes["data-furniture"] === "desk");
    assert.equal(furniture.attributes["data-room"], "a");
    assert.match(furniture.attributes.transform, /rotate\(-90\)/);
    assert.equal(nodes.filter(node => node.tag === "text" && node.attributes["data-room"]).length, 2);
    const next = descendants(renderFloorPlan(value));
    assert.notEqual(nodes.find(node => node.tag === "pattern").attributes.id,
      next.find(node => node.tag === "pattern").attributes.id);
    assert.deepEqual(value, before);
  } finally {
    if (prior === undefined) delete globalThis.document;
    else globalThis.document = prior;
  }
});

test("editor module is also importable without a top-level document", async () => {
  const { editMap } = await import("../public/map-editor.js");
  assert.equal(typeof editMap, "function");
});

test("extended equipment selectively saves v5 and survives timeline conversion and roundtrip", () => {
  const project = createProject({ ordered: true });
  project.schema = "robot-scene/v4";
  const mapValue = project.maps[0];
  mapValue.executionMode = "timed";
  mapValue.tracks = [];
  mapValue.rooms = [region("hall", Array.from({ length: CELL_COUNT }, (_, cell) => cell),
    { kind: "corridor" })];
  mapValue.floorPlan = { doors: [], furniture: [], walls: [] };
  const wall = { id: "partition", roomId: "hall", x1: 25, y1: 425, x2: 525, y2: 425 };
  const before = structuredClone(project);
  assert.equal(projectForSave(project).schema, "robot-scene/v4");
  assert.deepEqual(project, before);
  mapValue.floorPlan.walls.push(wall);
  const saved = projectForSave(project);
  assert.equal(saved.schema, "robot-scene/v5");
  assert.equal(project.schema, "robot-scene/v4");
  assert.deepEqual(validateProject(JSON.parse(JSON.stringify(saved))), saved);
  const converted = useTimelineOnly(structuredClone(saved));
  assert.deepEqual(converted.maps[0].floorPlan.walls, [wall]);
  assert.equal(projectForSave(converted).schema, "robot-scene/v5");
  assert.equal(converted.maps[0].timelineOnly, true);

  const story = structuredClone(before);
  story.maps[0].doorMode = "story";
  assert.equal(projectForSave(story).schema, "robot-scene/v5");
  story.maps[0].doorMode = "strict";
  assert.equal(projectForSave(story).schema, "robot-scene/v4");
  const targeted = structuredClone(before);
  targeted.maps[0].floorPlan.doors.push({
    id: "boundary-door", roomId: "hall", cell: 0, edge: "top",
  });
  const roomTrack = {
    id: "controls", name: "Controls", kind: "room", roomId: "hall",
    color: "#123456", muted: false, locked: false, actions: [],
  };
  targeted.maps[0].tracks.push(roomTrack);
  const unlock = newAction(targeted.maps[0], roomTrack, "unlock");
  Object.assign(unlock, { doorId: "boundary-door", roomId: "hall", runSeconds: 1 });
  roomTrack.actions.push(unlock);
  assert.equal(projectForSave(targeted).schema, "robot-scene/v5");
  delete unlock.doorId;
  assert.equal(projectForSave(targeted).schema, "robot-scene/v4");
  targeted.maps[0].floorPlan.doors[0].openingId = "wide-opening";
  assert.equal(projectForSave(targeted).schema, "robot-scene/v5");
  delete targeted.maps[0].floorPlan.doors[0].openingId;
  targeted.maps[0].rooms[0].entranceEdge = "bottom";
  const oriented = projectForSave(targeted);
  assert.equal(oriented.schema, "robot-scene/v5");
  const serialized = JSON.parse(JSON.stringify(oriented));
  assert.deepEqual(validateProject(structuredClone(serialized)), serialized);
});
