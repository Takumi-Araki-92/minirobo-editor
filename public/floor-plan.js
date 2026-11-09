export const GRID_COLUMNS = 32;
export const GRID_ROWS = 18;
export const CELL_SIZE = 50;
export const CELL_COUNT = GRID_COLUMNS * GRID_ROWS;
export const MATERIALS = ["wood", "tile", "carpet", "concrete"];
export const EDGES = ["top", "bottom", "left", "right"];
export const FURNITURE_TYPES = ["desk", "chair", "plant", "reception-monitor"];
const SCREEN_DIAGONAL_MM = 50 * 25.4;
export const SCREEN_WIDTH_MM = SCREEN_DIAGONAL_MM * 16 / Math.hypot(16, 9);
export const SCREEN_HEIGHT_MM = SCREEN_DIAGONAL_MM * 9 / Math.hypot(16, 9);
export const GRID_CELL_MM = SCREEN_WIDTH_MM / GRID_COLUMNS;
export const ROBOT_SIDE_MM = 100;
export const ROBOT_SIDE = ROBOT_SIDE_MM * 1600 / SCREEN_WIDTH_MM;
export const EQUIPMENT_ENTRANCE_CELLS = 6;

const requireThat = (condition, message) => {
  if (!condition) throw new Error(message);
};
const finite = (value, min, max) =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const validCell = cell => Number.isInteger(cell) && cell >= 0 && cell < CELL_COUNT;
const validId = id => typeof id === "string" && id.length > 0 && id.length <= 100 &&
  !["__proto__", "prototype", "constructor", "$start"].includes(id);
const own = (value, key) => Object.hasOwn(value, key);

// 新規配置だけを制約し、読込・保存時には既存設備をリサイズしない。
export function equipmentRectangle(start, end, entrance = "bottom", elevator = false) {
  requireThat(validCell(start) && validCell(end) && EDGES.includes(entrance),
    "設備の範囲・入口方向が不正です。");
  let x1 = start % GRID_COLUMNS, x2 = end % GRID_COLUMNS;
  let y1 = Math.floor(start / GRID_COLUMNS), y2 = Math.floor(end / GRID_COLUMNS);
  if (elevator) {
    if (["top", "bottom"].includes(entrance)) x2 = x1 + (x2 < x1 ? -5 : 5);
    else y2 = y1 + (y2 < y1 ? -5 : 5);
  }
  requireThat(x2 >= 0 && x2 < GRID_COLUMNS && y2 >= 0 && y2 < GRID_ROWS,
    "入口幅6セルを確保できません。マップ内からドラッグしてください。");
  const cells = [];
  for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++)
    for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) cells.push(y * GRID_COLUMNS + x);
  return cells;
}

export function sixCellDoor(map, candidate, makeId = () => crypto.randomUUID()) {
  requireThat(candidate, "壁の近くをクリックしてください。");
  if (candidate.independent) {
    const wall = map.floorPlan.walls.find(item => item.id === candidate.wallId);
    requireThat(wall, "独立ドアの壁が見つかりません。");
    const horizontal = wall.y1 === wall.y2, length = EQUIPMENT_ENTRANCE_CELLS * CELL_SIZE;
    const low = horizontal ? wall.x1 : wall.y1, high = horizontal ? wall.x2 : wall.y2;
    requireThat(high - low >= length, "自動ドアには連続した6セル幅の壁が必要です。");
    const center = horizontal ? (candidate.x1 + candidate.x2) / 2 : (candidate.y1 + candidate.y2) / 2;
    const from = Math.max(low, Math.min(high - length,
      low + Math.floor((center - low - length / 2) / CELL_SIZE) * CELL_SIZE));
    const door = {
      id: makeId(), roomId: wall.roomId, wallId: wall.id, kind: "automatic",
      x1: horizontal ? from : wall.x1, y1: horizontal ? wall.y1 : from,
      x2: horizontal ? from + length : wall.x1, y2: horizontal ? wall.y1 : from + length,
    };
    const trial = structuredClone(map);
    trial.floorPlan.doors.push(door); validateFloorPlan(trial);
    return [door];
  }
  const room = map.rooms.find(item => item.id === candidate.roomId);
  requireThat(room, "ドアの領域が見つかりません。");
  const horizontal = ["top", "bottom"].includes(candidate.edge);
  const step = horizontal ? 1 : GRID_COLUMNS, doors = [], openingId = makeId();
  const adjacentOwner = cell => map.rooms.find(item =>
    item.cells?.includes(cellNeighbor(cell, candidate.edge)))?.id ?? null;
  const adjacent = adjacentOwner(candidate.cell);
  for (let i = 0; i < EQUIPMENT_ENTRANCE_CELLS; i++) {
    const cell = candidate.cell + i * step;
    requireThat(validCell(cell) && (!horizontal ||
      Math.floor(cell / GRID_COLUMNS) === Math.floor(candidate.cell / GRID_COLUMNS)) &&
      boundaryEdge(room, cell, candidate.edge), "自動ドアには連続した6セルの同じ外周辺が必要です。");
    requireThat(adjacentOwner(cell) === adjacent,
      "自動ドアの6セルは同じ隣接領域に面する必要があります。");
    doors.push({ id: makeId(), openingId, roomId: room.id, cell, edge: candidate.edge });
  }
  const trial = structuredClone(map);
  trial.floorPlan.doors.push(...doors); validateFloorPlan(trial);
  return doors;
}

export function elevatorPlacement(map, roomId, cells, entrance, makeId = () => crypto.randomUUID()) {
  const trial = structuredClone(map), room = trial.rooms.find(item => item.id === roomId);
  requireThat(room?.appearance === "elevator" && room.cells?.length === 0,
    "新規EVの空の領域だけを配置できます。既存EVはリサイズしません。");
  requireThat(EDGES.includes(entrance), "EVの入口方向が不正です。");
  const bounds = regionBounds(cells), horizontal = ["top", "bottom"].includes(entrance);
  requireThat((horizontal ? bounds.width : bounds.height) === EQUIPMENT_ENTRANCE_CELLS * CELL_SIZE &&
    bounds.width * bounds.height / CELL_SIZE ** 2 === new Set(cells).size,
  "新規EVは入口6セル幅の長方形にしてください。");
  const occupied = new Set(cells);
  const overlaps = trial.rooms.filter(item => item !== room && item.cells.some(cell => occupied.has(cell)));
  requireThat(!overlaps.some(item => item.kind !== "corridor" ||
    item.cells.every(cell => occupied.has(cell))),
  "EVは空白または廊下の一部に配置してください。別の部屋や廊下全体とは重ねられません。");
  const y = 900 - bounds.y - bounds.height;
  requireThat(!(trial.floorPlan.walls ?? []).some(wall =>
    wall.x1 < bounds.x + bounds.width && wall.x2 > bounds.x &&
      wall.y1 <= y + bounds.height && wall.y2 >= y ||
    wall.y1 < y + bounds.height && wall.y2 > y &&
      wall.x1 <= bounds.x + bounds.width && wall.x2 >= bounds.x),
  "EVを既存の独立壁・ゲートと重ねられません。");
  for (const corridor of overlaps) {
    corridor.cells = corridor.cells.filter(cell => !occupied.has(cell));
    Object.assign(corridor, regionBounds(corridor.cells));
  }
  room.cells = [...cells]; Object.assign(room, bounds); room.entranceEdge = entrance;
  const boundary = room.cells.filter(cell => boundaryEdge(room, cell, entrance));
  trial.floorPlan.doors.push(...sixCellDoor(trial, {
    roomId: room.id, cell: Math.min(...boundary), edge: entrance,
  }, makeId));
  validateFloorPlan(trial);
  return trial;
}

export function rectangularGate(map, cells, entrance = "bottom", makeId = () => crypto.randomUUID()) {
  requireThat(EDGES.includes(entrance), "ゲートの向きが不正です。");
  const bounds = regionBounds(cells);
  requireThat(bounds.width * bounds.height / CELL_SIZE ** 2 === new Set(cells).size,
    "ゲートは長方形でドラッグしてください。");
  const room = map.rooms.find(item => cells.every(cell => item.cells?.includes(cell)));
  requireThat(room, "ゲート全体を同じ部屋・廊下内に配置してください。");
  requireThat(!map.floorPlan.furniture.some(item => furnitureCells(item).some(cell => cells.includes(cell))),
    "ゲートを家具と重ねられません。");
  const x = bounds.x, y = 900 - bounds.y - bounds.height;
  const right = x + bounds.width, bottom = y + bounds.height;
  requireThat(!(map.floorPlan.walls ?? []).some(wall =>
    wall.x1 < right && wall.x2 > x && wall.y1 <= bottom && wall.y2 >= y ||
    wall.y1 < bottom && wall.y2 > y && wall.x1 <= right && wall.x2 >= x),
  "ゲートを既存の独立壁・ゲートと重ねられません。");
  const horizontal = ["top", "bottom"].includes(entrance), equipmentId = makeId();
  const segments = horizontal ? [
    [x, y, x, bottom], [right, y, right, bottom], [x, (y + bottom) / 2, right, (y + bottom) / 2],
  ] : [
    [x, y, right, y], [x, bottom, right, bottom], [(x + right) / 2, y, (x + right) / 2, bottom],
  ];
  const walls = segments.map(([x1, y1, x2, y2]) => ({
    id: makeId(), equipmentId, roomId: room.id, name: "Flapper gate", x1, y1, x2, y2,
  }));
  const door = { ...walls[2], id: makeId(), wallId: walls[2].id, kind: "flapper" };
  const trial = structuredClone(map);
  trial.floorPlan.walls ??= [];
  trial.floorPlan.walls.push(...walls); trial.floorPlan.doors.push(door);
  validateFloorPlan(trial);
  return { walls, door };
}

export function regionBounds(cells) {
  requireThat(Array.isArray(cells) && cells.length > 0 && cells.length <= CELL_COUNT &&
    cells.every(validCell), "領域のセルは0〜575の整数で1個以上指定してください。");
  let left = GRID_COLUMNS, right = 0, top = GRID_ROWS, bottom = 0;
  for (const cell of cells) {
    const column = cell % GRID_COLUMNS, row = Math.floor(cell / GRID_COLUMNS);
    left = Math.min(left, column); right = Math.max(right, column);
    top = Math.min(top, row); bottom = Math.max(bottom, row);
  }
  return {
    x: left * CELL_SIZE, y: (GRID_ROWS - bottom - 1) * CELL_SIZE,
    width: (right - left + 1) * CELL_SIZE, height: (bottom - top + 1) * CELL_SIZE,
  };
}

// 既存の単セル家具は書き換えず、新旧どちらも同じ占有判定を使う。
export function furnitureCells(item) {
  return own(item, "cells") ? item.cells : [item.cell];
}

export function rotateFurniture(item, rotation) {
  const cells = furnitureCells(item), bounds = regionBounds(cells);
  const left = bounds.x / CELL_SIZE;
  const top = GRID_ROWS - (bounds.y + bounds.height) / CELL_SIZE;
  const width = bounds.width / CELL_SIZE, height = bounds.height / CELL_SIZE;
  const turns = ((rotation - item.rotation + 360) % 360) / 90;
  requireThat(Number.isInteger(turns), "家具の回転は90°単位です。");
  const rotated = cells.map(cell => {
    const x = cell % GRID_COLUMNS - left, y = Math.floor(cell / GRID_COLUMNS) - top;
    const [dx, dy] = turns === 1 ? [y, width - 1 - x] :
      turns === 2 ? [width - 1 - x, height - 1 - y] :
        turns === 3 ? [height - 1 - y, x] : [x, y];
    requireThat(left + dx < GRID_COLUMNS && top + dy < GRID_ROWS,
      "回転後の家具がマップの外にはみ出します。");
    return (top + dy) * GRID_COLUMNS + left + dx;
  }).sort((a, b) => a - b);
  return { ...item, cell: rotated[0], ...(item.cells ? { cells: rotated } : {}), rotation };
}

export function roomContainsPoint(room, x, y) {
  if (!room || !finite(x, 0, 1600) || !finite(y, 0, 900)) return false;
  if (!Array.isArray(room.cells)) {
    return x >= room.x && x <= room.x + room.width &&
      y >= room.y && y <= room.y + room.height;
  }
  // 境界は隣接する両領域に属せるが、空白セルの内部は含めない。
  return room.cells.some(cell => validCell(cell) &&
    x >= cell % GRID_COLUMNS * CELL_SIZE && x <= (cell % GRID_COLUMNS + 1) * CELL_SIZE &&
    y >= (GRID_ROWS - Math.floor(cell / GRID_COLUMNS) - 1) * CELL_SIZE &&
    y <= (GRID_ROWS - Math.floor(cell / GRID_COLUMNS)) * CELL_SIZE);
}

export function roomAnchor(room) {
  const bounds = Array.isArray(room.cells) && room.cells.length ? regionBounds(room.cells) : room;
  const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  if (!Array.isArray(room.cells) || !room.cells.length) return center;
  let nearest = null, distance = Infinity;
  for (const cell of room.cells) {
    const point = {
      x: (cell % GRID_COLUMNS + .5) * CELL_SIZE,
      y: (GRID_ROWS - Math.floor(cell / GRID_COLUMNS) - .5) * CELL_SIZE,
    };
    const candidate = (point.x - center.x) ** 2 + (point.y - center.y) ** 2;
    if (candidate < distance) { nearest = point; distance = candidate; }
  }
  return nearest;
}

export function cellNeighbor(cell, edge) {
  const column = cell % GRID_COLUMNS, row = Math.floor(cell / GRID_COLUMNS);
  if (edge === "top") return row > 0 ? cell - GRID_COLUMNS : -1;
  if (edge === "bottom") return row < GRID_ROWS - 1 ? cell + GRID_COLUMNS : -1;
  if (edge === "left") return column > 0 ? cell - 1 : -1;
  if (edge === "right") return column < GRID_COLUMNS - 1 ? cell + 1 : -1;
  return -1;
}

export function boundaryEdge(room, cell, edge) {
  return EDGES.includes(edge) && Array.isArray(room.cells) && room.cells.includes(cell) &&
    !room.cells.includes(cellNeighbor(cell, edge));
}

export function nearestDoorWall(map, x, y, { roomId = "", edge = "auto", maxDistance = 35 } = {}) {
  requireThat(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(maxDistance) &&
    maxDistance >= 0 && (edge === "auto" || EDGES.includes(edge)), "ドア位置の指定が不正です。");
  let nearest = null, distance = maxDistance ** 2;
  const rooms = [...map.rooms].sort((a, b) => Number(b.id === roomId) - Number(a.id === roomId));
  for (const room of rooms) for (const cell of room.cells ?? []) for (const side of EDGES) {
    if (edge !== "auto" && side !== edge || !boundaryEdge(room, cell, side)) continue;
    const [x1, y1, x2, y2] = edgePoints(cell, side);
    const px = Math.max(x1, Math.min(x2, x)), py = Math.max(y1, Math.min(y2, y));
    const candidate = (x - px) ** 2 + (y - py) ** 2;
    if (candidate <= distance && (!nearest || candidate < distance)) {
      distance = candidate; nearest = { roomId: room.id, cell, edge: side };
    }
  }
  for (const wall of map.floorPlan?.walls ?? []) {
    const horizontal = wall.y1 === wall.y2;
    const low = horizontal ? wall.x1 : wall.y1, high = horizontal ? wall.x2 : wall.y2;
    const span = Math.min(CELL_SIZE * 5, high - low);
    const coordinate = Math.max(low, Math.min(high, horizontal ? x : y));
    const px = horizontal ? coordinate : wall.x1, py = horizontal ? wall.y1 : coordinate;
    const candidate = (x - px) ** 2 + (y - py) ** 2;
    if (candidate > distance) continue;
    const start = Math.max(low, Math.min(high - span,
      low + Math.floor((coordinate - low - span / 2) / CELL_SIZE) * CELL_SIZE));
    distance = candidate;
    nearest = {
      roomId: wall.roomId, wallId: wall.id, independent: true,
      x1: horizontal ? start : wall.x1, y1: horizontal ? wall.y1 : start,
      x2: horizontal ? start + span : wall.x1,
      y2: horizontal ? wall.y1 : start + span,
    };
  }
  return nearest;
}

export function rectangleCells(room) {
  const cells = [];
  for (let cell = 0; cell < CELL_COUNT; cell++) {
    const x = (cell % GRID_COLUMNS + .5) * CELL_SIZE;
    const y = (GRID_ROWS - Math.floor(cell / GRID_COLUMNS) - .5) * CELL_SIZE;
    if (x >= room.x && x <= room.x + room.width && y >= room.y && y <= room.y + room.height) {
      cells.push(cell);
    }
  }
  return cells;
}

export function removeRegion(map, roomId) {
  requireThat(map && Array.isArray(map.rooms), "マップの領域が不正です。");
  requireThat(map.rooms.some(room => room.id === roomId), "削除する領域が見つかりません。");
  const referenced = (map.tracks ?? []).some(track => track.roomId === roomId ||
    track.initial?.roomId === roomId ||
    (track.actions ?? []).some(action => action.roomId === roomId));
  requireThat(!referenced, "この領域はトラック・初期位置・アクションから参照されているため削除できません。");
  const result = structuredClone(map);
  result.rooms = result.rooms.filter(room => room.id !== roomId);
  if (result.floorPlan) {
    const walls = result.floorPlan.walls ?? [];
    const removedWalls = new Set(walls.filter(wall => wall.roomId === roomId).map(wall => wall.id));
    result.floorPlan.doors = result.floorPlan.doors.filter(item =>
      item.roomId !== roomId && !removedWalls.has(item.wallId));
    result.floorPlan.furniture = result.floorPlan.furniture.filter(item => item.roomId !== roomId);
    result.floorPlan.walls = walls.filter(wall => wall.roomId !== roomId);
  }
  return result;
}

export function validateFloorPlan(map) {
  requireThat(map && typeof map === "object" && !Array.isArray(map), "マップが不正です。");
  requireThat(Array.isArray(map.rooms) && map.rooms.length <= 100, "領域は100件以下です。");
  const rooms = new Map(), ids = new Set(), owners = new Map();
  const identifier = id => {
    requireThat(validId(id) && !ids.has(id), "領域・家具・ドアのIDが不正または重複しています。");
    ids.add(id);
  };
  for (const room of map.rooms) {
    requireThat(room && typeof room === "object" && !Array.isArray(room), "領域が不正です。");
    identifier(room.id); rooms.set(room.id, room);
    requireThat(typeof room.name === "string" && room.name.length <= 120, "領域名は120文字以下です。");
    requireThat(typeof room.color === "string" && /^#[0-9a-f]{6}$/i.test(room.color), "領域色は#RRGGBBです。");
    requireThat(finite(room.x, 0, 1600) && finite(room.y, 0, 900) &&
      finite(room.width, 1, 1600 - room.x) && finite(room.height, 1, 900 - room.y),
    "領域の矩形はマップ内の有限数で指定してください。");
    if (own(room, "kind")) requireThat(["room", "corridor"].includes(room.kind), "領域種別が不正です。");
    if (own(room, "material")) requireThat(MATERIALS.includes(room.material), "床材が不正です。");
    if (own(room, "appearance")) requireThat(
      ["standard", "elevator", "continuing-hall"].includes(room.appearance),
      "領域の外観が不正です。");
    if (own(room, "entranceEdge")) requireThat(EDGES.includes(room.entranceEdge),
      "入口の辺が不正です。");
    if (own(room, "cells")) {
      const bounds = regionBounds(room.cells);
      requireThat(new Set(room.cells).size === room.cells.length, "領域内のセルが重複しています。");
      requireThat(["room", "corridor"].includes(room.kind) && MATERIALS.includes(room.material),
        "セル領域には種別と床材が必要です。");
      requireThat(["x", "y", "width", "height"].every(key => room[key] === bounds[key]),
        "領域の外接矩形とセルが一致しません。");
      for (const cell of room.cells) {
        requireThat(!owners.has(cell), "領域のセルが重なっています。");
        owners.set(cell, room.id);
      }
    }
  }
  // 旧矩形のままのマップは読み込めるが、セル領域との重複は許さない。
  const all = [...rooms.values()];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i], b = all[j];
      if (Array.isArray(a.cells) && Array.isArray(b.cells)) continue;
      const rectangles = room => Array.isArray(room.cells)
        ? room.cells.map(cell => ({
          x: cell % GRID_COLUMNS * CELL_SIZE,
          y: (GRID_ROWS - Math.floor(cell / GRID_COLUMNS) - 1) * CELL_SIZE,
          width: CELL_SIZE, height: CELL_SIZE,
        })) : [room];
      requireThat(!rectangles(a).some(x => rectangles(b).some(y =>
        x.x < y.x + y.width && x.x + x.width > y.x &&
        x.y < y.y + y.height && x.y + x.height > y.y)), "領域が重なっています。");
    }
  }
  if (!own(map, "floorPlan")) return map;
  const plan = map.floorPlan;
  requireThat(plan && typeof plan === "object" && !Array.isArray(plan) &&
    Array.isArray(plan.doors) && plan.doors.length <= CELL_COUNT * 4 &&
    Array.isArray(plan.furniture) && plan.furniture.length <= CELL_COUNT,
  "床プランのドア・家具の配列または件数が不正です。");
  if (own(plan, "showRoomLabels")) requireThat(typeof plan.showRoomLabels === "boolean",
    "部屋名表示は真偽値で指定してください。");
  if (own(plan, "walls")) requireThat(Array.isArray(plan.walls) && plan.walls.length <= CELL_COUNT * 4,
    "独立壁は2304件以下の配列で指定してください。");
  const furnitureCells = new Set(), doorEdges = new Set();
  const wallsById = new Map();
  for (const wall of plan.walls ?? []) {
    requireThat(wall && typeof wall === "object" && !Array.isArray(wall), "独立壁が不正です。");
    identifier(wall.id);
    requireThat(rooms.has(wall.roomId), "独立壁の領域が見つかりません。");
    validateSegment(wall, "独立壁");
    if (own(wall, "name")) requireThat(typeof wall.name === "string" && wall.name.length <= 120,
      "壁の名前は120文字以下です。");
    if (own(wall, "equipmentId")) requireThat(validId(wall.equipmentId), "設備グループが不正です。");
    wallsById.set(wall.id, wall);
  }
  if (own(plan, "chargingZones")) {
    requireThat(Array.isArray(plan.chargingZones) && plan.chargingZones.length <= 64,
      "充電スペースは64件以下の配列で指定してください。");
    for (const zone of plan.chargingZones) {
      requireThat(zone && typeof zone === "object", "充電スペースが不正です。");
      identifier(zone.id);
      requireThat(typeof zone.name === "string" && zone.name.length <= 120 &&
        finite(zone.x, 0, 1599) && finite(zone.y, 0, 899) &&
        finite(zone.width, 1, 1600 - zone.x) && finite(zone.height, 1, 900 - zone.y),
      "充電スペースの名前・矩形をMAP内で指定してください。");
    }
  }
  for (const item of plan.furniture) {
    requireThat(item && typeof item === "object" && !Array.isArray(item), "家具が不正です。");
    identifier(item.id);
    const room = rooms.get(item.roomId);
    requireThat(room && validCell(item.cell) && Array.isArray(room.cells),
      "家具は領域内のセルに配置してください。");
    requireThat(FURNITURE_TYPES.includes(item.type) && [0, 90, 180, 270].includes(item.rotation),
      "家具の種類または回転が不正です。");
    const cells = furnitureCellsForValidation(item);
    requireThat(cells.every(cell => room.cells.includes(cell)),
      "家具全体を同じ領域内に配置してください。");
    for (const cell of cells) {
      requireThat(!furnitureCells.has(cell), "家具は1セルに1個までです。");
      furnitureCells.add(cell);
    }
  }
  for (const door of plan.doors) {
    requireThat(door && typeof door === "object" && !Array.isArray(door), "ドアが不正です。");
    identifier(door.id);
    const room = rooms.get(door.roomId);
    requireThat(room, "ドアの領域が見つかりません。");
    if (own(door, "name")) requireThat(typeof door.name === "string" && door.name.length <= 120,
      "ドア名は120文字以下です。");
    if (own(door, "kind")) requireThat(["automatic", "flapper"].includes(door.kind),
      "ドア種別が不正です。");
    for (const key of ["openingId", "equipmentId"])
      if (own(door, key)) requireThat(validId(door[key]), "ドアのグループが不正です。");
    if (own(door, "x1") || own(door, "y1") || own(door, "x2") || own(door, "y2")) {
      validateSegment(door, "独立ドア");
      requireThat(Math.hypot(door.x2 - door.x1, door.y2 - door.y1) > 12,
        "独立ドアの長さは12を超える必要があります。");
      const wall = wallsById.get(door.wallId);
      requireThat(wall, "独立ドアの壁が見つかりません。");
      requireThat(wall.roomId === door.roomId, "独立ドアと壁の領域が一致しません。");
      requireThat(segmentContains(wall, door), "独立ドアは独立壁の範囲内に配置してください。");
      requireThat(!plan.doors.some(other => other !== door && own(other, "x1") &&
        segmentsOverlap(door, other)), "同じ壁にドアを重ねられません。");
    } else {
      requireThat(validCell(door.cell) && boundaryEdge(room, door.cell, door.edge),
        "ドアは領域セルの外周辺に配置してください。");
      const key = edgeKey(door.cell, door.edge);
      requireThat(!doorEdges.has(key), "同じ壁に複数のドアは配置できません。");
      doorEdges.add(key);
    }
  }

  function validateSegment(item, label) {
    requireThat(finite(item.x1, 0, 1600) && finite(item.x2, 0, 1600) &&
      finite(item.y1, 0, 900) && finite(item.y2, 0, 900) &&
      (item.x1 === item.x2 || item.y1 === item.y2) &&
      (item.x1 !== item.x2 || item.y1 !== item.y2) &&
      (item.x1 < item.x2 || item.y1 < item.y2),
    `${label}はマップ内の有限な水平・垂直線分で指定してください。`);
  }

  function segmentContains(wall, opening) {
    if (wall.x1 === wall.x2 && opening.x1 === opening.x2 && wall.x1 === opening.x1) {
      return Math.min(opening.y1, opening.y2) >= Math.min(wall.y1, wall.y2) &&
        Math.max(opening.y1, opening.y2) <= Math.max(wall.y1, wall.y2);
    }
    if (wall.y1 === wall.y2 && opening.y1 === opening.y2 && wall.y1 === opening.y1) {
      return Math.min(opening.x1, opening.x2) >= Math.min(wall.x1, wall.x2) &&
        Math.max(opening.x1, opening.x2) <= Math.max(wall.x1, wall.x2);
    }
    return false;
  }

  function segmentsOverlap(a, b) {
    if (a.x1 === a.x2 && b.x1 === b.x2 && a.x1 === b.x1) {
      return Math.max(a.y1, b.y1) < Math.min(a.y2, b.y2);
    }
    if (a.y1 === a.y2 && b.y1 === b.y2 && a.y1 === b.y1) {
      return Math.max(a.x1, b.x1) < Math.min(a.x2, b.x2);
    }
    return false;
  }
  return map;
}

function furnitureCellsForValidation(item) {
  const cells = furnitureCells(item), bounds = regionBounds(cells);
  requireThat(new Set(cells).size === cells.length && item.cell === Math.min(...cells),
    "家具セルの重複または基準セルが不正です。");
  requireThat(cells.length === bounds.width * bounds.height / CELL_SIZE ** 2,
    "家具のドラッグ範囲は長方形で指定してください。");
  return cells;
}

function edgePoints(cell, edge) {
  const x = cell % GRID_COLUMNS * CELL_SIZE, y = Math.floor(cell / GRID_COLUMNS) * CELL_SIZE;
  if (edge === "top") return [x, y, x + CELL_SIZE, y];
  if (edge === "bottom") return [x, y + CELL_SIZE, x + CELL_SIZE, y + CELL_SIZE];
  if (edge === "left") return [x, y, x, y + CELL_SIZE];
  return [x + CELL_SIZE, y, x + CELL_SIZE, y + CELL_SIZE];
}
function edgeKey(cell, edge) { return edgePoints(cell, edge).join(","); }

export function mergedDoors(map) {
  const owners = new Map((map.rooms ?? []).flatMap(r => (r.cells ?? []).map(c => [c, r.id])));
  const groups = [];
  const doors = map.floorPlan?.doors ?? [];
  const sorted = doors.filter(door => !own(door, "x1")).map(door => ({
    ...door, points: edgePoints(door.cell, door.edge),
    adjacentRoomId: owners.get(cellNeighbor(door.cell, door.edge)) ?? null,
  })).sort((a, b) => a.points[1] - b.points[1] || a.points[0] - b.points[0]);
  for (const door of sorted) {
    const horizontal = door.points[1] === door.points[3];
    const group = groups.find(g => (door.openingId
      ? g.openingId === door.openingId
      : !g.openingId && !g.name && !g.kind && !door.name && !door.kind) &&
      g.roomId === door.roomId && g.edge === door.edge &&
      g.adjacentRoomId === door.adjacentRoomId &&
      (horizontal ? g.points[1] === door.points[1] && g.points[2] === door.points[0] :
        g.points[0] === door.points[0] && g.points[3] === door.points[1]));
    if (group) {
      group.points[2] = door.points[2]; group.points[3] = door.points[3];
      group.memberIds.push(door.id);
    } else groups.push({ ...door, memberIds: [door.id] });
  }
  for (const door of doors.filter(item => own(item, "x1"))) {
    groups.push({
      ...door, points: [door.x1, door.y1, door.x2, door.y2], adjacentRoomId: null,
      memberIds: [door.id],
    });
  }
  return groups;
}

export function automaticDoorOpenness(opening, actors) {
  const dx = opening.x2 - opening.x1, dy = opening.y2 - opening.y1;
  const lengthSquared = dx * dx + dy * dy;
  let openness = 0;
  for (const actor of actors) {
    if (actor.kind !== "robot" && actor.kind !== "human") continue;
    const along = lengthSquared ? Math.max(0, Math.min(1,
      ((actor.x - opening.x1) * dx + (actor.y - opening.y1) * dy) / lengthSquared)) : 0;
    const distance = Math.hypot(actor.x - opening.x1 - along * dx,
      actor.y - opening.y1 - along * dy);
    const radius = actor.kind === "robot" ? Math.SQRT2 * ROBOT_SIDE / 2 : 20;
    // 再生・シークで同じ位置なら必ず同じ開度になり、車体が到達する前に開き切る。
    openness = Math.max(openness, Math.max(0, Math.min(1,
      (radius + 4 * CELL_SIZE - distance) / (2 * CELL_SIZE))));
  }
  return openness;
}

export function updateAutomaticDoors(root, actors, permissions = []) {
  const byId = new Map(permissions.map(p => [p.id, p]));
  for (const group of root.querySelectorAll("[data-auto-door]")) {
    const [x1, y1, x2, y2] = group.dataset.opening.split(",").map(Number);
    const permission = byId.get(group.dataset.door);
    group.dataset.permission = permission?.held ? "safety-hold" : permission?.unlocked ? "unlocked" : "locked";
    const opening = { x1, y1, x2, y2 };
    const eligible = permission?.actorIds ? actors.filter(actor =>
      permission.actorIds.includes(actor.id) ||
      (actor.kind === "robot" || actor.kind === "human") &&
        automaticDoorOpenness(opening, [actor]) === 1 &&
        Math.abs(y1 === y2 ? actor.y - y1 : actor.x - x1) <=
          (actor.kind === "robot" ? Math.SQRT2 * ROBOT_SIDE / 2 : 20) + 10) : actors;
    const openness = permission?.held ? 1 : permission?.unlocked ?
      permission.openness ?? automaticDoorOpenness(opening, eligible) : 0;
    const value = openness.toFixed(3);
    if (group.dataset.openness === value) continue;
    group.dataset.openness = value;
    group.dataset.state = openness === 0 ? "closed" : openness === 1 ? "open" : "partial";
    const travel = Math.hypot(x2 - x1, y2 - y1) / 2 * openness;
    group.querySelector("[data-door-leaf=left]").setAttribute("transform", `translate(${-travel} 0)`);
    group.querySelector("[data-door-leaf=right]").setAttribute("transform", `translate(${travel} 0)`);
  }
}

function doorWallSegments(map, walls) {
  const keys = new Set((map.floorPlan?.doors ?? []).filter(d => !own(d, "x1"))
    .map(d => edgeKey(d.cell, d.edge)));
  const segments = [...walls].filter(([key]) => !keys.has(key)).map(([, points]) => points);
  for (const door of mergedDoors(map).filter(item => !own(item, "x1"))) {
    const [x1, y1, x2, y2] = door.points;
    const horizontal = y1 === y2;
    segments.push([x1, y1, x1 + (horizontal ? 6 : 0), y1 + (horizontal ? 0 : 6)],
      [x2 - (horizontal ? 6 : 0), y2 - (horizontal ? 0 : 6), x2, y2]);
  }
  return segments;
}

function independentWallSegments(wall, doors = []) {
  const horizontal = wall.y1 === wall.y2;
  const low = horizontal ? wall.x1 : wall.y1, high = horizontal ? wall.x2 : wall.y2;
  const cuts = doors.filter(door => door.wallId === wall.id).map(door => ({
    start: Math.max(low, horizontal ? door.x1 : door.y1) + 6,
    end: Math.min(high, horizontal ? door.x2 : door.y2) - 6,
  })).filter(cut => cut.start < cut.end).sort((a, b) => a.start - b.start);
  const segments = [];
  let cursor = low;
  for (const cut of cuts) {
    if (cut.start > cursor) segments.push(horizontal
      ? [cursor, wall.y1, cut.start, wall.y1] : [wall.x1, cursor, wall.x1, cut.start]);
    cursor = Math.max(cursor, cut.end);
  }
  if (cursor < high) segments.push(horizontal
    ? [cursor, wall.y1, high, wall.y1] : [wall.x1, cursor, wall.x1, high]);
  return segments;
}

export function buildNavigation(map) {
  validateFloorPlan(map);
  if (!map.floorPlan || map.rooms.some(r => !Array.isArray(r.cells))) return {
    schema: "floor-navigation/v1", status: "unavailable",
    reason: "legacy-map-without-grid", coordinateSystem: "x-right-y-up", width: 1600, height: 900,
  };
  const owners = new Map(map.rooms.flatMap(r => r.cells.map(cell => [cell, r.id])));
  const walls = new Map();
  for (const room of map.rooms) for (const cell of room.cells) for (const edge of EDGES) {
    if (boundaryEdge(room, cell, edge)) walls.set(edgeKey(cell, edge), edgePoints(cell, edge));
  }
  const segment = ([x1, y1, x2, y2], from = 0, to = 1) => ({
    x1: x1 + (x2 - x1) * from, y1: 900 - (y1 + (y2 - y1) * from),
    x2: x1 + (x2 - x1) * to, y2: 900 - (y1 + (y2 - y1) * to),
  });
  const furniture = new Set(map.floorPlan.furniture.flatMap(furnitureCells));
  return {
    schema: "floor-navigation/v1", status: "available", coordinateSystem: "x-right-y-up",
    units: "ratio-coordinate", width: 1600, height: 900,
    grid: { columns: GRID_COLUMNS, rows: GRID_ROWS, cellSize: CELL_SIZE, indexOrigin: "top-left" },
    policy: "conservative-full-cell-furniture; doors-are-potential-openings; no-robot-clearance",
    cells: Array.from({ length: CELL_COUNT }, (_, cell) => ({
      cell, roomId: owners.get(cell) ?? null,
      traversable: owners.has(cell) && !furniture.has(cell),
      reason: !owners.has(cell) ? "unassigned" : furniture.has(cell) ? "furniture" : "floor",
    })),
    walls: [
      ...doorWallSegments(map, walls),
      ...(map.floorPlan.walls ?? []).flatMap(wall =>
        independentWallSegments(wall, map.floorPlan.doors)),
    ].map(points => segment(points)),
    doors: mergedDoors(map).map(d => ({
      id: d.id, roomId: d.roomId, cell: d.cell, edge: d.edge, name: d.name, kind: d.kind,
      memberIds: d.memberIds, adjacentRoomId: d.adjacentRoomId,
      opening: segment(d.points, 6 / Math.hypot(
        d.points[2] - d.points[0], d.points[3] - d.points[1]),
      1 - 6 / Math.hypot(d.points[2] - d.points[0], d.points[3] - d.points[1])), state: "unspecified",
    })),
    obstacles: map.floorPlan.furniture.map(f => ({
      id: f.id, type: f.type, roomId: f.roomId, cell: f.cell,
      ...regionBounds(furnitureCells(f)), rotation: f.rotation,
    })),
  };
}

let renderSerial = 0;
export function renderFloorPlan(map) {
  const svg = (tag, attributes = {}, children = []) => {
    const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
    element.append(...children);
    return element;
  };
  const text = (value, attributes) => {
    const element = svg("text", attributes); element.textContent = value; return element;
  };
  const prefix = `floor-${++renderSerial}-`;
  const root = svg("g", { class: "floor-plan", "data-floor-plan": "" });
  const definitions = svg("defs");
  const patterns = {
    wood: ["#c2a983", "#94744e", "M0 0H100M0 25H100M25 0V25M0 25V50M4 8H40M12 37H46"],
    tile: ["#dbe3df", "#a0b6ac", "M0 0H50V50H0ZM25 0V50M0 25H50"],
    carpet: ["#718796", "#526773", "M0 0L8 8M12 0L20 8M24 0L32 8M36 0L44 8M0 18L8 26M12 18L20 26M24 18L32 26M36 18L44 26M0 36L8 44M12 36L20 44"],
    concrete: ["#bfc9c8", "#9aa9a6", "M3 3h2M15 17h2M31 9h2M39 37h2"],
  };
  for (const [material, [fill, stroke, d]] of Object.entries(patterns)) {
    definitions.append(svg("pattern", {
      id: prefix + material, patternUnits: "userSpaceOnUse", width: 50, height: 50,
    }, [svg("rect", { width: 50, height: 50, fill }),
      svg("path", { d, fill: "none", stroke, "stroke-width": .9 })]));
  }
  root.append(definitions);
  const walls = new Map();
  for (const room of map.rooms ?? []) {
    const group = svg("g", { "data-room": room.id, class: "floor-region" });
    const material = MATERIALS.includes(room.material) ? room.material : "concrete";
    if (Array.isArray(room.cells)) {
      const cells = new Set(room.cells);
      const d = room.cells.map(cell => {
        const x = cell % GRID_COLUMNS * CELL_SIZE, y = Math.floor(cell / GRID_COLUMNS) * CELL_SIZE;
        return `M${x} ${y}h50v50h-50Z`;
      }).join("");
      group.append(svg("path", { d, fill: `url(#${prefix + material})`,
        stroke: "none", "shape-rendering": "crispEdges", "data-room": room.id }));
      for (const cell of room.cells) {
        for (const edge of EDGES) {
          if (!cells.has(cellNeighbor(cell, edge))) walls.set(edgeKey(cell, edge), edgePoints(cell, edge));
        }
      }
    } else {
      group.append(svg("rect", { x: room.x, y: 900 - room.y - room.height,
        width: room.width, height: room.height, fill: `url(#${prefix + material})`,
        stroke: "#515b55", "stroke-width": 5, "data-room": room.id }));
    }
    root.append(group);
  }
  const wallGroup = svg("g", { class: "floor-walls", stroke: "#505c54",
    "stroke-width": 6, "stroke-linecap": "square", "pointer-events": "none" });
  for (const [x1, y1, x2, y2] of doorWallSegments(map, walls)) {
    wallGroup.append(svg("line", { x1, y1, x2, y2 }));
  }
  root.append(wallGroup);
  for (const wall of map.floorPlan?.walls ?? []) {
    const group = svg("g", { "data-room": wall.roomId, "data-partition-wall": wall.id,
      class: "floor-partition-wall", stroke: "#505c54", "stroke-width": 8,
      "stroke-linecap": "square", "pointer-events": "stroke" });
    for (const [x1, y1, x2, y2] of independentWallSegments(wall, map.floorPlan.doors)) {
      group.append(svg("line", { x1, y1, x2, y2, "data-partition-wall": wall.id }));
    }
    root.append(group);
  }
  for (const room of map.rooms ?? []) {
    if (room.appearance === "continuing-hall") {
      const y = 900 - room.y - room.height;
      const group = svg("g", { "data-hall-continuation": room.id, "pointer-events": "none" });
      group.append(svg("line", { x1: room.x + 2, y1: y + 4, x2: room.x + 2,
        y2: y + room.height - 4, stroke: "#dbe3df", "stroke-width": 9 }));
      for (const offset of [.2, .5, .8]) {
        const cy = y + room.height * offset;
        group.append(svg("path", { d: `M${room.x + 58} ${cy - 22}l-24 22 24 22`,
          fill: "none", stroke: "#648b85", "stroke-width": 5 }));
      }
      group.append(text("HALL CONTINUES", { x: room.x + 35, y: y + room.height / 2,
        transform: `rotate(-90 ${room.x + 35} ${y + room.height / 2})`,
        fill: "#486d65", "font-size": 20, "text-anchor": "middle" }));
      root.append(group);
    }
    if (room.appearance === "elevator") {
      if (room.entranceEdge) {
        const x = room.x + 8, y = 900 - room.y - room.height + 8;
        const w = room.width - 16, h = room.height - 16;
        const cabin = svg("g", { "data-elevator": room.id, "pointer-events": "none",
          "data-entrance-edge": room.entranceEdge });
        cabin.append(svg("rect", { x, y, width: w, height: h, rx: 7,
          fill: "#dce3db", stroke: "#788983", "stroke-width": 3, "data-elevator-floor": "" }),
        text("EV", { x: x + w / 2, y: y + h / 2 + 6, "text-anchor": "middle",
          fill: "#60776c", "font-size": 20, "font-weight": 650 }));
        const entry = {
          top: [x, y, x + w, y], bottom: [x, y + h, x + w, y + h],
          left: [x, y, x, y + h], right: [x + w, y, x + w, y + h],
        }[room.entranceEdge];
        cabin.append(svg("line", { x1: entry[0], y1: entry[1], x2: entry[2], y2: entry[3],
          stroke: "#94e3d3", "stroke-width": 5 }));
        root.append(cabin);
        continue;
      }
      const x = room.x + 22, y = 900 - room.y - room.height + 22;
      const w = room.width - 44, h = room.height - 44;
      const metal = `${prefix}lift-${room.id}`;
      definitions.append(svg("linearGradient", { id: metal, x1: "0", x2: "1", y1: "0", y2: "1" }, [
        svg("stop", { offset: "0", "stop-color": "#ecf1ee" }),
        svg("stop", { offset: ".48", "stop-color": "#a7b5b1" }),
        svg("stop", { offset: "1", "stop-color": "#d9e2dd" }),
      ]));
      const cabin = svg("g", { "data-elevator": room.id, "pointer-events": "none" });
      cabin.append(svg("rect", { x, y, width: w, height: h, rx: 12,
        fill: `url(#${metal})`, stroke: "#788983", "stroke-width": 3 }),
      svg("rect", { x: x + 13, y: y + 13, width: w - 26, height: h - 26, rx: 7,
        fill: "#dce3db", stroke: "#f8fbf6", "stroke-width": 3, "data-elevator-floor": "" }));
      for (const fraction of [.33, .66]) cabin.append(svg("line", {
        x1: x + 16, x2: x + w - 16, y1: y + h * fraction, y2: y + h * fraction,
        stroke: "#c5cfc4", "stroke-width": 1,
      }));
      cabin.append(svg("path", { d: `M${x + 23} ${y + h - 40}V${y + 27}H${x + w - 23}V${y + h - 40}`,
        stroke: "#7d9188", "stroke-width": 4, fill: "none", "stroke-linecap": "round" }),
      text("EV", { x: x + w / 2, y: y + h / 2 + 8, "text-anchor": "middle",
        fill: "#60776c", "font-size": 36, "font-weight": 650, "letter-spacing": 5 }));
      const topEntry = map.floorPlan?.doors.some(door => door.roomId === room.id && door.edge === "top");
      const displayY = topEntry ? y + h - 32 : y + 7;
      cabin.append(svg("rect", { x: x + w / 2 - 51, y: displayY, width: 102, height: 25,
        rx: 6, fill: "#344c43", stroke: "#ecf4e9", "stroke-width": 2 }),
      text("1F  ↑ ↓", { x: x + w / 2, y: displayY + 18, "text-anchor": "middle",
        fill: "#c4eed4", "font-size": 16, "font-weight": 600 }));
      root.append(cabin);
    }
  }
  for (const door of mergedDoors(map)) {
    const [x1, y1, x2, y2] = door.points;
    const horizontal = y1 === y2;
    const length = Math.hypot(x2 - x1, y2 - y1) - 12;
    const hx = x1 + (horizontal ? 6 : 0), hy = y1 + (horizontal ? 0 : 6);
    const group = svg("g", { "data-room": door.roomId, "data-door": door.id,
      "data-door-kind": door.kind ?? "automatic", "data-door-name": door.name ?? "",
      "data-auto-door": "", "data-state": "closed", "data-openness": "0.000",
      "data-opening": [hx, 900 - hy, hx + (horizontal ? length : 0),
        900 - hy - (horizontal ? 0 : length)].join(","),
      transform: `translate(${hx} ${hy})${horizontal ? "" : " rotate(90)"}` });
    const title = svg("title");
    title.textContent = door.name || (door.kind === "flapper" ? "Flapper gate" : "Automatic sliding door");
    group.append(title,
      svg("line", { x1: 0, y1: 0, x2: length, y2: 0,
        stroke: door.kind === "flapper" ? "#b36b37" : "#82968d",
        "stroke-width": 2, "stroke-dasharray": door.kind === "flapper" ? "2 4" : "6 7" }));
    // 扉が開口内へ退避しても、枠とレールで設備の位置を示し続ける。
    const frame = svg("g", { "data-door-frame": "", "pointer-events": "none" });
    frame.append(svg("rect", { x: 0, y: -9, width: length, height: 18, rx: 3,
      fill: "#263d3520", stroke: "#597a6e", "stroke-width": 2 }));
    for (const x of [0, length - 8]) frame.append(svg("rect", {
      x, y: -11, width: 8, height: 22, rx: 2, fill: "#405b50", stroke: "#dce9df",
      "stroke-width": 1.5, "data-door-jamb": "",
    }));
    const panels = svg("svg", { x: 0, y: -7, width: length, height: 14,
      viewBox: `0 -7 ${length} 14`, overflow: "hidden", "data-door-panels": "" });
    for (const [side, x] of [["left", 0], ["right", length / 2]]) {
      panels.append(svg("rect", { "data-door-leaf": side, x, y: -5, width: length / 2,
        height: 10, rx: 2, fill: door.kind === "flapper" ? "#e9a65a" : "#94e3d3",
        "fill-opacity": .7, stroke: door.kind === "flapper" ? "#875126" : "#426f65",
        "stroke-width": 2 }));
    }
    group.append(panels, frame);
    root.append(group);
  }
  for (const item of map.floorPlan?.furniture ?? []) {
    const cells = furnitureCells(item), bounds = regionBounds(cells);
    const x = bounds.x + bounds.width / 2, y = 900 - bounds.y - bounds.height / 2;
    const sideways = item.rotation % 180 !== 0;
    let width = sideways ? bounds.height : bounds.width;
    let height = sideways ? bounds.width : bounds.height;
    const long = cells.length > 1;
    let visualRotation = item.rotation;
    // 縦に描いた長椅子も、背もたれを長辺に沿わせる。
    if (long && item.type !== "plant" && height > width) {
      [width, height] = [height, width]; visualRotation += 90;
    }
    const group = svg("g", { "data-room": item.roomId, "data-furniture": item.id,
      "data-variant": long ? (item.type === "desk" ? "long-desk" :
        item.type === "chair" ? "bench" : item.type === "plant" ? "large-plant" : item.type) : item.type,
      transform: `translate(${x} ${y}) rotate(${-visualRotation})` });
    if (item.type === "desk") {
      const w = width - 12, h = long ? height - 12 : 26;
      group.append(svg("rect", { x: -w / 2, y: -h / 2, width: w, height: h, rx: 3,
        fill: "#d5ad62", stroke: "#9c7638", "stroke-width": 2 }),
      svg("path", { d: `M${-w / 2 + 6} ${-h / 2 + 5}h${w - 12}M${-w / 2 + 6} ${h / 2 - 5}h${w - 12}`,
        stroke: "#edce93", fill: "none" }));
      if (long) for (let offset = CELL_SIZE; offset < width; offset += CELL_SIZE) {
        group.append(svg("path", { d: `M${offset - width / 2} ${-h / 2 + 2}v${h - 4}`,
          stroke: "#bd934e", "stroke-width": 1 }));
      }
    } else if (item.type === "reception-monitor") {
      group.append(svg("rect", { x: -width / 2 + 5, y: -height / 2 + 5,
        width: width - 10, height: height - 14, rx: 5, fill: "#34424b",
        stroke: "#202b32", "stroke-width": 3 }),
      svg("rect", { x: -width / 2 + 10, y: -height / 2 + 10,
        width: width - 20, height: height - 24, rx: 2, fill: "#9bd5c5",
        stroke: "#d5eee4", "stroke-width": 2 }),
      svg("path", { d: `M-7 ${height / 2 - 9}H7M0 ${height / 2 - 9}V${height / 2 - 4}`,
        stroke: "#34424b", "stroke-width": 4 }));
    } else if (item.type === "chair") {
      const w = long ? width - 14 : 24, h = long ? height - 16 : 24;
      group.append(svg("rect", { x: -w / 2, y: -h / 2, width: w, height: h, rx: 6,
        fill: "#89a7a0", stroke: "#516c64", "stroke-width": 2 }),
      svg("path", { d: `M${-w / 2 - 2} ${h / 2 - 4}V${-h / 2 - 1}Q0 ${-h / 2 - 10} ${w / 2 + 2} ${-h / 2 - 1}V${h / 2 - 4}`,
        fill: "none", stroke: "#516c64", "stroke-width": 4 }));
      if (long) for (let offset = CELL_SIZE; offset < width; offset += CELL_SIZE) {
        group.append(svg("path", { d: `M${offset - width / 2} ${-h / 2 + 3}v${h - 6}`,
          stroke: "#516c64", "stroke-width": 2 }));
      }
    } else {
      const foliage = svg("g", { transform: `scale(${(width - 8) / 36} ${(height - 8) / 43})` });
      foliage.append(svg("circle", { r: 12, fill: "#b78d61", stroke: "#8b6a45", "stroke-width": 2 }));
      for (const [cx, cy] of [[-7, -5], [7, -5], [0, 7], [0, -10]]) {
        foliage.append(svg("ellipse", { cx, cy, rx: 9, ry: 12, fill: "#6b9a62", stroke: "#497a45" }));
      }
      group.append(foliage);
    }
    const title = svg("title");
    title.textContent = `${long ? { desk: "長机", chair: "長椅子", plant: "観葉植物" }[item.type] : item.type} · ${bounds.width / CELL_SIZE} × ${bounds.height / CELL_SIZE} cells`;
    group.append(title);
    root.append(group);
  }
  for (const room of map.floorPlan?.showRoomLabels === false ? [] : map.rooms ?? []) {
    const anchor = roomAnchor(room);
    root.append(text(room.name, { x: anchor.x, y: room.appearance === "elevator" ?
      900 - room.y - room.height + 18 : 900 - anchor.y, "data-room": room.id,
      fill: "#394b40", "font-size": 27, "font-weight": 700, "text-anchor": "middle",
      "dominant-baseline": "middle", stroke: "#f2f4ed", "stroke-width": 4,
      "paint-order": "stroke", class: "floor-room-name" }));
  }
  for (const zone of map.floorPlan?.chargingZones ?? []) {
    const group = svg("g", { "data-charging-zone": zone.id, class: "charging-zone" });
    const label = "⚡ " + zone.name;
    group.append(svg("title", {}, [label]));
    group.append(svg("rect", { x: zone.x, y: 900 - zone.y - zone.height,
      width: zone.width, height: zone.height, rx: 12, fill: "#3de0c2",
      "fill-opacity": .16, stroke: "#51dbbd", "stroke-width": 3, "stroke-dasharray": "14 9" }));
    if (zone.width >= 40 && zone.height >= 35) group.append(
    text(label, { x: zone.x + zone.width / 2, y: 900 - zone.y - zone.height + 26,
      fill: "#c5fff1", "font-size": 23, "text-anchor": "middle", "paint-order": "stroke",
      stroke: "#183b38", "stroke-width": 4,
      ...(label.length * 14 > zone.width - 16 ?
        { textLength: zone.width - 16, lengthAdjust: "spacingAndGlyphs" } : {}) }));
    root.append(group);
  }
  return root;
}
