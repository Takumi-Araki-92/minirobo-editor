import { buildNavigation, CELL_SIZE, GRID_COLUMNS, GRID_ROWS, cellNeighbor, ROBOT_SIDE } from "./floor-plan.js";

// 100mm角の車体を包む円で、回転中の壁への張り出しも安全側に判定する。
export const ROBOT_RADIUS = Math.hypot(ROBOT_SIDE / 2, ROBOT_SIDE / 2);
export const HUMAN_RADIUS = 20;
const EPS = 1e-7;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export function snapPoint(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("座標は有限数で指定してください。");
  return {
    x: (clamp(Math.floor(x / CELL_SIZE), 0, GRID_COLUMNS - 1) + .5) * CELL_SIZE,
    y: (clamp(Math.floor(y / CELL_SIZE), 0, GRID_ROWS - 1) + .5) * CELL_SIZE,
  };
}
export function coordinatePoint(x, y, mode = "grid", origin = null, axisLock = false) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("座標は有限数で指定してください。");
  if (!["grid", "free"].includes(mode)) throw new Error("座標指定モードが不正です。");
  if (mode === "grid") return snapPoint(x, y);
  x = clamp(x, 0, 1600); y = clamp(y, 0, 900);
  if (axisLock && origin) {
    if (Math.abs(x - origin.x) >= Math.abs(y - origin.y)) y = origin.y;
    else x = origin.x;
  }
  return { x, y };
}
const cellAt = p => (GRID_ROWS - 1 - Math.floor(p.y / CELL_SIZE)) * GRID_COLUMNS +
  Math.floor(p.x / CELL_SIZE);
const cross = (a, b, p) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
function pointDistance(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, d = dx * dx + dy * dy;
  const t = d ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / d, 0, 1) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}
function segmentDistance(a, b, c, d) {
  const separated = Math.max(a.x, b.x) < Math.min(c.x, d.x) - EPS ||
    Math.max(c.x, d.x) < Math.min(a.x, b.x) - EPS ||
    Math.max(a.y, b.y) < Math.min(c.y, d.y) - EPS ||
    Math.max(c.y, d.y) < Math.min(a.y, b.y) - EPS;
  if (!separated && cross(a, b, c) * cross(a, b, d) <= 0 &&
      cross(c, d, a) * cross(c, d, b) <= 0) return 0;
  return Math.min(pointDistance(a, c, d), pointDistance(b, c, d),
    pointDistance(c, a, b), pointDistance(d, a, b));
}
function rectangleDistance(a, b, r) {
  const inside = p => p.x >= r.x && p.x <= r.x + r.width &&
    p.y >= r.y && p.y <= r.y + r.height;
  if (inside(a) || inside(b)) return 0;
  const corners = [{ x: r.x, y: r.y }, { x: r.x + r.width, y: r.y },
    { x: r.x + r.width, y: r.y + r.height }, { x: r.x, y: r.y + r.height }];
  return Math.min(...corners.map((p, i) => segmentDistance(a, b, p, corners[(i + 1) % 4])));
}

export function createSafety(map, { robotSide = 86 } = {}) {
  const navigation = buildNavigation(map), zones = new Map(), cellZones = new Map();
  const robotRadius = Math.hypot(robotSide / 2, robotSide / 2);
  if (navigation.status !== "available") return { navigation, zones, cellZones, robotRadius };
  const available = new Set(navigation.cells.filter(c => c.traversable).map(c => c.cell));
  for (const room of map.rooms.filter(r => r.kind === "corridor")) {
    const cells = new Set(room.cells.filter(c => available.has(c))), narrow = new Set();
    const run = (cell, one, two) => {
      let n = 1;
      for (const edge of [one, two]) {
        let next = cellNeighbor(cell, edge);
        while (cells.has(next)) { n++; next = cellNeighbor(next, edge); }
      }
      return n;
    };
    for (const cell of cells) if (Math.min(run(cell, "left", "right"),
      run(cell, "top", "bottom")) <= 3) narrow.add(cell);
    while (narrow.size) {
      const start = narrow.values().next().value, queue = [start];
      narrow.delete(start);
      for (let i = 0; i < queue.length; i++) for (const edge of ["left", "right", "top", "bottom"]) {
        const next = cellNeighbor(queue[i], edge);
        if (narrow.delete(next)) queue.push(next);
      }
      const id = `${room.id}:${start}`;
      zones.set(id, { id, name: room.name, cells: new Set(queue) });
      queue.forEach(cell => cellZones.set(cell, id));
    }
  }
  return { navigation, zones, cellZones, robotRadius };
}

export function pathProblem(safety, from, to, kind = "robot") {
  if (safety.navigation.status !== "available") return "グリッド式MAPがないため通行判定できません。先にMAPを作成してください。";
  const radius = kind === "robot" ? safety.robotRadius : HUMAN_RADIUS;
  for (const p of [from, to]) if (p.x < radius || p.x > 1600 - radius ||
    p.y < radius || p.y > 900 - radius) return "車体・人物の占有範囲がMAP外にはみ出します。";
  for (const wall of safety.navigation.walls) if (segmentDistance(from, to,
    { x: wall.x1, y: wall.y1 }, { x: wall.x2, y: wall.y2 }) < radius - EPS) {
    return "移動経路が壁または狭すぎるドアに接触します。経路または開口幅を修正してください。";
  }
  for (const obstacle of safety.navigation.obstacles) if (
    rectangleDistance(from, to, obstacle) < radius - EPS) return "移動経路が家具の占有範囲に接触します。";
  const count = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 10));
  for (let i = 0; i <= count; i++) {
    const p = { x: from.x + (to.x - from.x) * i / count, y: from.y + (to.y - from.y) * i / count };
    if (!safety.navigation.cells[cellAt(p)]?.traversable) return "移動経路に通行不可・未定義のグリッドがあります。";
  }
  return "";
}

// セル境界で分割するため、短時間の横断もサンプリング間隔に依存して見落とさない。
export function pathSections(safety, from, to) {
  const cuts = new Set([0, 1]);
  for (const [axis, max] of [["x", 1600], ["y", 900]]) if (to[axis] !== from[axis]) {
    for (let v = CELL_SIZE; v < max; v += CELL_SIZE) {
      const t = (v - from[axis]) / (to[axis] - from[axis]);
      if (t > EPS && t < 1 - EPS) cuts.add(t);
    }
  }
  const values = [...cuts].sort((a, b) => a - b), sections = [];
  for (let i = 1; i < values.length; i++) {
    const a = values[i - 1], b = values[i], mid = (a + b) / 2;
    const zone = safety.cellZones.get(cellAt({
      x: from.x + (to.x - from.x) * mid, y: from.y + (to.y - from.y) * mid,
    })) ?? null;
    const previous = sections.at(-1);
    if (previous?.zone === zone) previous.to = b;
    else sections.push({ from: a, to: b, zone });
  }
  return sections;
}

export function positionAt(segments, at) {
  const s = segments.find(s => at < s.end) ?? segments.at(-1);
  if (!s) throw new Error("軌跡がありません。");
  const t = s.end === s.start ? 1 : clamp((at - s.start) / (s.end - s.start), 0, 1);
  return { x: s.from.x + (s.to.x - s.from.x) * t, y: s.from.y + (s.to.y - s.from.y) * t };
}

export function collisionWarnings(trajectories) {
  const warnings = [];
  for (let i = 0; i < trajectories.length; i++) for (let j = i + 1; j < trajectories.length; j++) {
    const a = trajectories[i], b = trajectories[j];
    if (a.kind === "human" && b.kind === "human") continue;
    const clearance = (a.radius ?? (a.kind === "robot" ? ROBOT_RADIUS : HUMAN_RADIUS)) +
      (b.radius ?? (b.kind === "robot" ? ROBOT_RADIUS : HUMAN_RADIUS));
    let hit = null, ai = 0, bi = 0;
    while (ai < a.segments.length && bi < b.segments.length) {
      const sa = a.segments[ai], sb = b.segments[bi];
      const begin = Math.max(sa.start, sb.start), end = Math.min(sa.end, sb.end);
      if (end >= begin) {
        const p = positionAt([sa], begin), q = positionAt([sb], begin);
        const velocity = s => ({ x: (s.to.x - s.from.x) / (s.end - s.start || 1),
          y: (s.to.y - s.from.y) / (s.end - s.start || 1) });
        const va = velocity(sa), vb = velocity(sb), dx = p.x - q.x, dy = p.y - q.y;
        const vx = va.x - vb.x, vy = va.y - vb.y, v2 = vx * vx + vy * vy;
        const dt = v2 ? clamp(-(dx * vx + dy * vy) / v2, 0, end - begin) : 0;
        if (Math.hypot(dx + vx * dt, dy + vy * dt) < clearance - EPS) { hit = begin + dt; break; }
      }
      if (sa.end <= sb.end) ai++; else bi++;
    }
    if (hit !== null) warnings.push({ code: "collision", trackIds: [a.id, b.id], at: hit,
      message: `${a.name} と ${b.name} が ${hit.toFixed(2)}秒付近で接触する予測です。開始時刻・待機・経路を調整してください。` });
  }
  return warnings;
}
