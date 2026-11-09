import test from "node:test";
import assert from "node:assert/strict";
import {
  equipmentRectangle, sixCellDoor, rectangularGate, regionBounds, elevatorPlacement,
  validateFloorPlan, mergedDoors, buildNavigation, nearestDoorWall,
} from "../public/floor-plan.js";
import { createProject, projectForSave, validateProject } from "../public/model.js";

const ids = () => {
  let next = 0;
  return () => `equipment-${++next}`;
};
const region = (id, cells, kind = "corridor") => ({
  id, name: id, cells, ...regionBounds(cells), kind, color: "#739a81", material: "concrete",
});
const rectangle = (x, y, width, height) =>
  Array.from({ length: height }, (_, row) =>
    Array.from({ length: width }, (_, column) => (y + row) * 32 + x + column)).flat();
const plan = cells => ({
  rooms: [region("floor", cells)], floorPlan: { walls: [], doors: [], furniture: [] },
});
const addGate = (map, gate) => {
  map.floorPlan.walls.push(...gate.walls); map.floorPlan.doors.push(gate.door);
};

test("new EVs keep entrance width exactly six cells in every orientation and drag direction", () => {
  for (const entrance of ["top", "bottom", "left", "right"]) {
    for (const end of [4 * 32 + 3, 12 * 32 + 20]) {
      const cells = equipmentRectangle(8 * 32 + 10, end, entrance, true);
      const bounds = regionBounds(cells), horizontal = ["top", "bottom"].includes(entrance);
      assert.equal(horizontal ? bounds.width : bounds.height, 300);
      assert.equal(horizontal ? bounds.height : bounds.width,
        horizontal ? (Math.abs(Math.floor(end / 32) - 8) + 1) * 50 :
          (Math.abs(end % 32 - 10) + 1) * 50);
    }
  }
  assert.equal(equipmentRectangle(0, 0, "bottom", true).length, 6);
  assert.throws(() => equipmentRectangle(31, 31, "top", true), /6セル/);
  assert.throws(() => equipmentRectangle(17 * 32, 17 * 32, "left", true), /6セル/);
  assert.throws(() => equipmentRectangle(-1, 0), /不正/);
});

test("new boundary doors atomically add six contiguous cells as one opening", () => {
  for (const edge of ["top", "bottom", "left", "right"]) {
    const map = plan(rectangle(2, 2, 9, 9)), before = structuredClone(map);
    const cell = edge === "bottom" ? 10 * 32 + 2 : edge === "right" ? 2 * 32 + 10 : 2 * 32 + 2;
    const doors = sixCellDoor(map, { roomId: "floor", cell, edge }, ids());
    assert.deepEqual(map, before);
    assert.equal(doors.length, 6);
    map.floorPlan.doors.push(...doors);
    validateFloorPlan(map);
    const groups = mergedDoors(map);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].memberIds.length, 6);
    assert.equal(Math.hypot(groups[0].points[2] - groups[0].points[0],
      groups[0].points[3] - groups[0].points[1]), 300);
    const navigation = buildNavigation(map);
    assert.equal(navigation.doors.length, 1);
    assert.equal(Math.hypot(navigation.doors[0].opening.x2 - navigation.doors[0].opening.x1,
      navigation.doors[0].opening.y2 - navigation.doors[0].opening.y1), 288);
  }
});

test("EV placement cuts only corridor cells, adds the oriented entrance and preserves legacy EVs", () => {
  for (const entrance of ["top", "bottom", "left", "right"]) {
    const map = plan(rectangle(0, 0, 20, 14));
    map.rooms.push({ ...region("new-ev", [0]), cells: [], appearance: "elevator", kind: "room" });
    const before = structuredClone(map);
    const cells = equipmentRectangle(4 * 32 + 4, 8 * 32 + 12, entrance, true);
    const placed = elevatorPlacement(map, "new-ev", cells, entrance, ids());
    assert.deepEqual(map, before);
    validateFloorPlan(placed);
    assert.equal(placed.rooms.reduce((sum, room) => sum + room.cells.length, 0), 280);
    assert.deepEqual(placed.rooms[1].cells, cells);
    assert.equal(placed.floorPlan.doors.length, 6);
    assert.equal(mergedDoors(placed)[0].edge, entrance);
    assert.throws(() => elevatorPlacement(placed, "new-ev", cells, entrance, ids()), /既存EV/);
  }
});

test("EV placement rejects blocked footprints without deleting existing furniture or walls", () => {
  const map = plan(rectangle(0, 0, 20, 14)), cells = rectangle(4, 4, 6, 3);
  map.rooms.push({ ...region("new-ev", [0]), cells: [], appearance: "elevator", kind: "room" });
  map.floorPlan.furniture.push({ id: "desk", roomId: "floor", type: "desk", rotation: 0, cell: cells[0] });
  const before = structuredClone(map);
  assert.throws(() => elevatorPlacement(map, "new-ev", cells, "bottom", ids()), /家具/);
  assert.deepEqual(map, before);
  map.floorPlan.furniture = [];
  map.floorPlan.walls.push({ id: "wall", roomId: "floor", x1: 225, y1: 200, x2: 225, y2: 350 });
  assert.throws(() => elevatorPlacement(map, "new-ev", cells, "bottom", ids()), /独立壁/);
  assert.throws(() => elevatorPlacement(map, "new-ev", rectangle(4, 4, 5, 3), "bottom", ids()), /6セル/);
});

test("short, wrapping, interrupted and already occupied boundaries reject without partial writes", () => {
  for (const cells of [rectangle(0, 0, 5, 2), rectangle(29, 0, 3, 2), [0, 1, 2, 4, 5, 6]]) {
    const map = plan(cells), before = structuredClone(map);
    assert.throws(() => sixCellDoor(map, { roomId: "floor", cell: cells[0], edge: "top" }, ids()), /6セル/);
    assert.deepEqual(map, before);
  }
  const map = plan(rectangle(0, 0, 10, 4));
  map.floorPlan.doors.push({ id: "legacy", roomId: "floor", cell: 3, edge: "top", kind: "automatic" });
  const before = structuredClone(map);
  assert.throws(() => sixCellDoor(map, { roomId: "floor", cell: 0, edge: "top" }, ids()), /複数/);
  assert.deepEqual(map, before);
});

test("six-cell door cannot cross different adjacent regions", () => {
  const map = plan(rectangle(0, 1, 8, 2));
  map.rooms.push(region("neighbor-a", rectangle(0, 0, 3, 1)),
    region("neighbor-b", rectangle(3, 0, 5, 1)));
  assert.throws(() => sixCellDoor(map, { roomId: "floor", cell: 32, edge: "top" }, ids()), /隣接領域/);
  assert.equal(map.floorPlan.doors.length, 0);
});

test("independent automatic doors are six cells, never clipped to a short wall", () => {
  const map = plan(rectangle(0, 0, 20, 12));
  map.floorPlan.walls.push({ id: "wall", roomId: "floor", x1: 100, y1: 100, x2: 800, y2: 100 });
  const candidate = nearestDoorWall(map, 450, 100);
  const [door] = sixCellDoor(map, candidate, ids());
  assert.equal(door.x2 - door.x1, 300);
  assert.equal(map.floorPlan.doors.length, 0);
  map.floorPlan.walls[0].x2 = 350;
  assert.throws(() => sixCellDoor(map, candidate, ids()), /6セル/);
});

test("rectangular gate overlays reuse walls and flapper door without carving the floor", () => {
  for (const entrance of ["top", "bottom", "left", "right"]) {
    const map = plan(rectangle(0, 0, 20, 14)), before = structuredClone(map.rooms);
    const cells = equipmentRectangle(3 * 32 + 4, 7 * 32 + 11, entrance);
    const gate = rectangularGate(map, cells, entrance, ids());
    assert.equal(gate.walls.length, 3);
    assert.equal(gate.door.kind, "flapper");
    assert.equal(gate.door.y1 === gate.door.y2, ["top", "bottom"].includes(entrance));
    addGate(map, gate); validateFloorPlan(map);
    assert.deepEqual(map.rooms, before);
    const navigation = buildNavigation(map);
    assert.equal(navigation.cells.filter(cell => cell.traversable).length, 280);
    assert.equal(navigation.doors.length, 1);
    assert.equal(navigation.doors[0].kind, "flapper");
    assert.equal(navigation.walls.some(wall =>
      wall.x1 === gate.door.x1 && wall.x2 === gate.door.x2 &&
      wall.y1 === 900 - gate.door.y1 && wall.y2 === 900 - gate.door.y2), false);
  }
});

test("invalid gate overlays reject blank cells, multiple rooms, furniture, walls and non-rectangles atomically", () => {
  const map = plan(rectangle(0, 0, 10, 10)), cells = rectangle(2, 2, 4, 3);
  assert.throws(() => rectangularGate(map, rectangle(9, 9, 2, 2)), /同じ部屋/);
  assert.throws(() => rectangularGate(map, [0, 1, 32]), /長方形/);
  map.floorPlan.furniture.push({ id: "plant", type: "plant", roomId: "floor", cell: cells[0], rotation: 0 });
  const before = structuredClone(map);
  assert.throws(() => rectangularGate(map, cells), /家具/);
  assert.deepEqual(map, before);
  map.floorPlan.furniture = [];
  map.floorPlan.walls.push({ id: "wall", roomId: "floor", x1: 100, y1: 125, x2: 300, y2: 125 });
  assert.throws(() => rectangularGate(map, cells), /独立壁/);
});

test("save and validation preserve old equipment sizes and new opening groups", () => {
  const project = createProject(), map = project.maps[0];
  Object.assign(map, plan(rectangle(0, 0, 20, 14)));
  map.tracks = [];
  map.rooms.push(region("old-ev", rectangle(22, 2, 3, 4), "room"));
  map.rooms[1].appearance = "elevator";
  map.floorPlan.doors.push({ id: "old-door", roomId: "floor", cell: 10, edge: "top" });
  const legacyRoom = structuredClone(map.rooms[1]), legacyDoor = structuredClone(map.floorPlan.doors[0]);
  map.floorPlan.doors.push(...sixCellDoor(map, { roomId: "floor", cell: 0, edge: "top" }, ids()));
  addGate(map, rectangularGate(map, rectangle(3, 3, 4, 3), "left",
    (() => { const next = ids(); return () => `gate-${next()}`; })()));
  const saved = JSON.parse(JSON.stringify(projectForSave(project)));
  validateProject(saved);
  assert.deepEqual(saved.maps[0].rooms[1], legacyRoom);
  assert.deepEqual(saved.maps[0].floorPlan.doors[0], legacyDoor);
  assert.equal(mergedDoors(saved.maps[0]).length, 3);
  const opening = saved.maps[0].floorPlan.doors.filter(door => door.openingId);
  for (const door of opening) { door.name = "Entrance"; door.kind = "automatic"; }
  assert.equal(mergedDoors(saved.maps[0]).find(door => door.openingId).memberIds.length, 6);
});
