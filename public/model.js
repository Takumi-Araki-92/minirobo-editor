import { validateFloorPlan, roomContainsPoint, buildNavigation, ROBOT_SIDE } from "./floor-plan.js";
import { compileTimedPlan } from "./timed-plan.js";
import { positionAt, snapPoint, createSafety, pathProblem } from "./safety.js";
import { prepareDoorPlan, sampleDoorPlan } from "./automatic-doors.js";
import { validatePresentation } from "./scenario-presentation.js";

export function projectForSave(project) {
  validateProject(project);
  const saved = structuredClone(project);
  for (const map of saved.maps) map.navigation = buildNavigation(map);
  if (saved.maps.some(map => map.floorPlan?.walls?.length ||
    map.floorPlan?.doors.some(door => Object.hasOwn(door, "wallId") ||
      Object.hasOwn(door, "openingId")) ||
    map.rooms.some(room => Object.hasOwn(room, "entranceEdge")) ||
    map.doorMode === "story" || map.presentation ||
    map.tracks.some(track => track.actions.some(action =>
      action.type === "unlock" && Object.hasOwn(action, "doorId"))))) {
    saved.schema = "robot-scene/v5";
  }
  return saved;
}

export function orderedActions(track) {
  return [...track.actions].sort((a, b) => a.position - b.position);
}

export function addFacingTurns(map) {
  if (map.executionMode !== "timed" || !map.timelineOnly) return 0;
  const angle = value => ((value + 180) % 360 + 360) % 360 - 180;
  for (const track of map.tracks.filter(track => track.kind === "robot" && track.initial)) {
    const movements = orderedActions(track).filter(action => action.type === "move");
    const stale = new Set(movements.filter((action, index) => action.facingFor &&
      movements[index + 1]?.id !== action.facingFor).map(action => action.id));
    track.actions = track.actions.filter(action => !stale.has(action.id));
  }
  let added = 0;
  while (true) {
    const needed = [];
    for (const track of map.tracks.filter(track => track.kind === "robot" && track.initial)) {
      let from = { ...track.initial };
      const actions = orderedActions(track);
      for (let i = 0; i < actions.length; i++) {
        const action = actions[i];
        if (action.type !== "move") continue;
        if (action.motion === "rotate") {
          const target = actions.slice(i + 1).find(item => item.type === "move");
          if (action.facingFor && action.facingFor === target?.id && target.motion !== "rotate") {
            const dx = target.x - from.x, dy = target.y - from.y;
            if (Math.hypot(dx, dy) > 1e-7) {
              const yaw = Math.atan2(dy, dx) * 180 / Math.PI;
              action.yaw = yaw;
              action.angularSpeed = Math.max(.01, Math.abs(angle(yaw - from.yaw)) / action.runSeconds);
            }
            Object.assign(action, { x: from.x, y: from.y, roomId: from.roomId ?? "" });
          }
          from.yaw = action.yaw;
          continue;
        }
        const dx = action.x - from.x, dy = action.y - from.y;
        const yaw = Math.atan2(dy, dx) * 180 / Math.PI;
        const delta = Math.abs(angle(yaw - from.yaw));
        if (Math.hypot(dx, dy) > 1e-7 && delta > 1e-6) {
          needed.push({ track, action, from: { ...from }, yaw, delta });
          break;
        }
        from = { ...action, yaw: from.yaw };
      }
    }
    if (!needed.length) return added;
    const at = Math.min(...needed.map(item => item.action.position));
    const batch = needed.filter(item => Math.abs(item.action.position - at) < 1e-7);
    const duration = Math.max(...batch.map(item => Math.ceil(item.delta / 90 * 10) / 10));
    // 全行に同じ時間を挿入し、人物・イベント・解錠の連携時刻を保つ。
    for (const track of map.tracks) for (const action of track.actions) {
      if (action.position >= at - 1e-7) action.position += duration;
      else if (action.position + action.runSeconds > at + 1e-7) {
        action.runSeconds += duration;
        if (action.motion === "rotate") action.rotationSeconds = action.runSeconds;
      }
    }
    for (const { track, action, from, yaw, delta } of batch) {
      const turn = newAction(map, track, "move");
      Object.assign(turn, {
        name: `進行方向へ旋回 · ${action.name}`.slice(0, 120), position: at,
        runSeconds: duration, motion: "rotate", rotationSeconds: duration,
        x: from.x, y: from.y, yaw, roomId: from.roomId ?? "",
        angularSpeed: Math.max(.01, delta / duration), dwell: 0, facingFor: action.id,
      });
      if (from.coordinateMode === "free") turn.coordinateMode = "free";
      track.actions.push(turn);
      added++;
    }
  }
}

function previousActions(map) {
  const previous = new Map();
  if (["ordered", "timed"].includes(map.executionMode)) for (const track of map.tracks) {
    const actions = orderedActions(track);
    actions.forEach((action, index) => {
      if (index) previous.set(action.id, actions[index - 1].id);
    });
  }
  return previous;
}

export const COLORS = ["#8d9bff", "#58d8ca", "#ffbd70", "#ec87c7", "#73bafa", "#bd9afa"];
export const KINDS = { robot: "ロボット", human: "人", room: "部屋", display: "画面表示" };
// 約60mm角の車体に対し約10mmの位置余裕を取り、瞬間的な通過は完了にしない。
export const ARRIVAL_DEFAULTS = Object.freeze({ tolerance: 15, dwell: .3, angleTolerance: null });
export const DISPLAY_TEMPLATES = ["label", "card", "sign"];
export const HATCH_STYLES = ["diagonal", "cross", "dots"];
export const uid = () => crypto.randomUUID();
export const clone = value => structuredClone(value);
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
export function formatTime(value) {
  const ticks = Math.round(Math.max(0, Number.isFinite(value) ? value : 0) * 100);
  return `${String(Math.floor(ticks / 6000)).padStart(2, "0")}:${String(Math.floor(ticks / 100) % 60).padStart(2, "0")}.${String(ticks % 100).padStart(2, "0")}`;
}

export function timelineAlignment(map, actionId, value, duration, pixelsPerSecond,
  { resize = false, min = 0, max = 3500 } = {}) {
  let best = null;
  for (const track of map.tracks) for (const action of track.actions) {
    if (action.id === actionId) continue;
    for (const time of [action.position,
      action.position + (action.runSeconds ?? action.plannedDuration ?? 6)]) {
      for (const offset of resize ? [duration] : [0, duration]) {
        const aligned = time - offset, distance = Math.abs(aligned - value) * pixelsPerSecond;
        if (aligned < min || aligned > max || distance > 8) continue;
        if (!best || distance < best.distance)
          best = { value: aligned, time, distance, name: `${track.name} / ${action.name}` };
      }
    }
  }
  return best;
}

const actorKind = kind => kind === "robot" || kind === "human";
const actionTypes = {
  robot: ["move", "show", "hide", "wait", "join"], human: ["move", "show", "hide", "wait", "join"],
  room: ["event-start", "event-end", "unlock", "wait", "join"], display: ["show", "hide", "wait", "join"],
};
const source = (actionId = "$start", event = "start", delay = 0) => ({ actionId, event, delay });
const normalizedYaw = value => ((value + 180) % 360 + 360) % 360 - 180 || 0;
const yaw = value => normalizedYaw(value) === -180 ? 180 : normalizedYaw(value);

export function newTrack(map, kind) {
  if (!Object.hasOwn(KINDS, kind)) throw new Error("未対応のトラック種別です。");
  const peers = map.tracks.filter(track => track.kind === kind);
  const names = new Set(peers.map(track => track.name));
  let ordinal = 1;
  while (names.has(`${KINDS[kind]} ${ordinal}`)) ordinal++;
  const track = {
    id: uid(), kind, name: `${KINDS[kind]} ${ordinal}`,
    color: COLORS[map.tracks.length % COLORS.length], muted: false, locked: false,
    actions: [],
  };
  if (actorKind(kind)) track.initial = { x: 160 + peers.length * 100 % 1400, y: 160, yaw: 0, roomId: "" };
  if (kind === "robot") {
    const used = new Set(peers.map(item => item.robotId));
    track.robotId = 0;
    while (used.has(track.robotId)) track.robotId++;
  }
  if (kind === "human") track.count = 1;
  if (kind === "room") track.roomId = map.rooms[0]?.id ?? "";
  return track;
}

export function newAction(map, track, type = actionTypes[track.kind]?.[0]) {
  requireThat(!map.timelineOnly || type !== "join", "時間軸専用シーケンスでは合流を追加できません。");
  if (!["move", "show", "hide", "event-start", "event-end", "unlock", "wait", "join"].includes(type)) {
    throw new Error("未対応のアクション種別です。");
  }
  const timed = map.executionMode === "timed";
  const sequence = ["ordered", "timed"].includes(map.executionMode) ? orderedActions(track) : track.actions;
  const previous = sequence.at(-1);
  const matchingType = type === "hide" ? "show" : "event-start";
  const localTarget = [...sequence].reverse().find(action => action.type === matchingType);
  const target = localTarget ?? (type === "event-end" ? map.tracks
    .filter(owner => owner.kind === "room" && owner.roomId === track.roomId)
    .flatMap(owner => owner.actions).findLast(action => action.type === matchingType) : null);
  const initial = [...sequence].reverse()
    .find(action => action.type === "move" && action.motion !== "rotate") ?? track.initial;
  const coordinateMode = initial?.coordinateMode ?? "grid";
  const targetPoint = timed && coordinateMode === "grid" ? snapPoint(initial?.x ?? 800, initial?.y ?? 450) :
    { x: initial?.x ?? 800, y: initial?.y ?? 450 };
  return {
    id: uid(), name: type === "unlock" ? `${map.rooms.find(r => r.id === track.roomId)?.name ?? "部屋"}解錠` :
      { move: "移動", show: "表示", hide: "非表示", "event-start": "イベント開始", "event-end": "イベント終了", wait: "待機", join: "合流" }[type],
    type, ...(!map.timelineOnly ? { trigger: { mode: "all", sources: ["ordered", "timed"].includes(map.executionMode) ? [] :
      [previous ? source(previous.id, "complete") : source()] } } : {}),
    position: previous ? previous.position + (timed ?
      previous.runSeconds + (previous.type === "move" ? previous.dwell : 0) : 8) : 0,
    plannedDuration: 6,
    ...(timed ? { runSeconds: type === "wait" ? 3 : type === "move" ? 6 :
      type === "join" ? 0 : ["show", "event-start", "unlock"].includes(type) ? 3 : .5 } : {}),
    ...targetPoint, yaw: initial?.yaw ?? 0,
    ...(coordinateMode === "free" ? { coordinateMode } : {}),
    roomId: track.roomId ?? initial?.roomId ?? "",
    targetId: type === "hide" || type === "event-end" ? target?.targetId ?? uid() : uid(),
    text: "", state: "meeting", speed: 100, ...ARRIVAL_DEFAULTS,
    ...(timed && type !== "move" ? { dwell: 0 } : {}),
  };
}

export function createProject({ ordered = false } = {}) {
  const map = {
    id: uid(), name: "マップ 1", background: null,
    ...(ordered ? { executionMode: "ordered" } : {}),
    rooms: [{ id: uid(), name: "会議室", x: 900, y: 450, width: 500, height: 350, color: COLORS[4] }],
    tracks: [],
  };
  for (let i = 0; i < 4; i++) {
    const robot = newTrack(map, "robot");
    robot.initial = { x: 200 + 180 * i, y: 180, yaw: 0, roomId: "" };
    map.tracks.push(robot);
    const move = newAction(map, robot, "move");
    Object.assign(move, { x: 300 + 180 * i, y: 350, yaw: 90, name: "巡回" });
    if (!ordered) move.trigger.sources[0].delay = i;
    robot.actions.push(move);
  }
  const human = newTrack(map, "human");
  human.count = 5;
  human.initial = { x: 700, y: 600, yaw: 0, roomId: "" };
  map.tracks.push(human);
  const arrival = newAction(map, human, "move");
  Object.assign(arrival, { name: "5人が入室", x: 1100, y: 600, roomId: map.rooms[0].id });
  human.actions.push(arrival);
  const room = newTrack(map, "room");
  map.tracks.push(room);
  const meeting = newAction(map, room, "event-start");
  meeting.text = "会議中";
  meeting.trigger.sources = [source(arrival.id, "complete")];
  room.actions.push(meeting);
  const end = newAction(map, room, "event-end");
  end.trigger.sources = [source(meeting.id, "complete", 8)];
  room.actions.push(end);
  const exit = newAction(map, human, "move");
  Object.assign(exit, { name: "会議終了後に退室", x: 700, y: 600, roomId: "" });
  exit.trigger.sources = [source(end.id, "complete", 1)];
  human.actions.push(exit);
  const display = newTrack(map, "display");
  map.tracks.push(display);
  const show = newAction(map, display, "show");
  Object.assign(show, { text: "WELCOME", x: 800, y: 850 });
  display.actions.push(show);
  const hide = newAction(map, display, "hide");
  hide.trigger.sources = [source(exit.id, "complete")];
  display.actions.push(hide);
  return { schema: ordered ? "robot-scene/v3" : "robot-scene/v2", name: "Robot scene", maps: [map] };
}

export function copyMapLayout(source, name) {
  const map = clone(source), ids = new Map(map.rooms.map(room => [room.id, uid()]));
  map.id = uid(); map.name = name; map.executionMode = "timed"; map.tracks = [];
  delete map.navigation;
  delete map.presentation;
  for (const room of map.rooms) room.id = ids.get(room.id);
  if (map.floorPlan) for (const key of ["doors", "furniture", "chargingZones", "walls"]) {
    for (const item of map.floorPlan[key] ?? []) {
      item.id = uid();
      if (item.roomId) item.roomId = ids.get(item.roomId);
    }
  }
  if (map.floorPlan) {
    const wallIds = new Map((source.floorPlan?.walls ?? []).map((wall, index) =>
      [wall.id, map.floorPlan.walls[index].id]));
    for (const door of map.floorPlan.doors ?? []) if (door.wallId) {
      door.wallId = wallIds.get(door.wallId);
    }
  }
  for (const room of map.rooms) {
    const track = newTrack(map, "room");
    track.name = room.name; track.roomId = room.id; track.color = room.color;
    map.tracks.push(track);
  }
  return map;
}

export function useTimelineOnly(project) {
  requireThat(project && ["robot-scene/v2", "robot-scene/v3", "robot-scene/v4", "robot-scene/v5"]
    .includes(project.schema) && Array.isArray(project.maps),
  "対応するシーケンス形式ではありません。");
  for (const map of project.maps ?? []) {
    requireThat(map && [undefined, "ordered", "timed"].includes(map.executionMode) &&
      Array.isArray(map.tracks) && map.tracks.every(track => track && Array.isArray(track.actions)),
    "マップの実行形式または行が不正です。");
    if (map.executionMode !== "timed") enableTimedMap(map);
    map.timelineOnly = true;
    // 扉の演出時刻は後で調整するため、明示された停止設定だけを維持する。
    map.doorMode ??= "story";
    for (const track of map.tracks ?? []) {
      track.actions = track.actions.filter(action => action.type !== "join" &&
        !(track.kind === "human" && action.type === "move" && action.motion === "rotate"));
      for (const action of track.actions) delete action.trigger;
    }
  }
  project.schema = "robot-scene/v4";
  return project;
}

export function enableTimedMap(map) {
  map.executionMode = "timed";
  for (const track of map.tracks) {
    if (track.initial && track.initial.coordinateMode !== "free")
      Object.assign(track.initial, snapPoint(track.initial.x, track.initial.y));
    for (const action of track.actions) {
      action.runSeconds = action.type === "move" ? action.plannedDuration ?? 6 :
        action.type === "wait" ? 3 : 0;
      if (action.motion === "rotate") action.runSeconds = action.rotationSeconds ?? action.runSeconds;
      if (["move", "show"].includes(action.type) && action.coordinateMode !== "free")
        Object.assign(action, snapPoint(action.x, action.y));
    }
  }
}

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}
function number(value, min, max, label) {
  requireThat(typeof value === "number" && Number.isFinite(value) && value >= min && value <= max,
    `${label}は${min}〜${max}の有限数で指定してください。`);
}
function text(value, label, max = 120) {
  requireThat(typeof value === "string" && value.length <= max, `${label}の形式または文字数が不正です。`);
}
function color(value) {
  requireThat(typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value), "色は#RRGGBBで指定してください。");
}
function point(value) {
  requireThat(value && typeof value === "object", "位置がありません。");
  number(value.x, 0, 1600, "X");
  number(value.y, 0, 900, "Y");
  number(value.yaw, -180, 180, "yaw");
}
function gridPoint(value) {
  requireThat(value.coordinateMode === undefined || ["grid", "free"].includes(value.coordinateMode),
    "座標指定モードはgridまたはfreeで指定してください。");
  requireThat(value.coordinateMode === "free" || value.x % 50 === 25 && value.y % 50 === 25,
    "v4の位置は1グリッド中央（25 + 50の整数倍）で指定してください。");
}
function roomRef(value, rooms) {
  requireThat(value === "" || typeof value === "string" && rooms.has(value), "部屋参照が不正です。");
}
function safeId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 100 &&
    !["$start", "__proto__", "constructor", "prototype"].includes(value);
}

export function validateProject(project) {
  requireThat(["robot-scene/v2", "robot-scene/v3", "robot-scene/v4", "robot-scene/v5"]
    .includes(project?.schema), "未対応のプロジェクト形式です。v2〜v5を使用してください。");
  text(project.name, "プロジェクト名");
  if (Object.hasOwn(project, "facingTurns"))
    requireThat(typeof project.facingTurns === "boolean", "旋回バー自動配置の設定が不正です。");
  requireThat(!Object.hasOwn(project, "duration"), "絶対時間のシーケンス長は使用できません。");
  requireThat(Array.isArray(project.maps) && project.maps.length >= 1 && project.maps.length <= 8,
    "マップは1〜8件で指定してください。");
  const ids = new Set();
  let total = 0;
  let backgroundBytes = 0;
  const identifier = id => {
    requireThat(safeId(id) && !ids.has(id), "IDの重複または不正があります。");
    ids.add(id);
  };
  for (const map of project.maps) {
    requireThat(map && typeof map === "object", "マップが不正です。");
    identifier(map.id); text(map.name, "マップ名");
    if (Object.hasOwn(map, "presentation")) validatePresentation(map.presentation);
    if (Object.hasOwn(map, "facingTurns"))
      requireThat(typeof map.facingTurns === "boolean", "旋回バー自動配置の設定が不正です。");
    if (Object.hasOwn(map, "doorMode")) requireThat(["strict", "story"].includes(map.doorMode),
      "ドア通行モードはstrictまたはstoryで指定してください。");
    if (Object.hasOwn(map, "executionMode")) requireThat(
      ["robot-scene/v3", "robot-scene/v4", "robot-scene/v5"].includes(project.schema) &&
      (map.executionMode === "ordered" || ["robot-scene/v4", "robot-scene/v5"].includes(project.schema) &&
        map.executionMode === "timed"),
      "順序実行にはv3以上・ordered、時間軸実行にはv4以上・timedが必要です。executionModeを確認してください。");
    if (Object.hasOwn(map, "timelineOnly")) requireThat(typeof map.timelineOnly === "boolean" &&
      (!map.timelineOnly || map.executionMode === "timed"),
    "時間軸専用モードはtimedのマップにのみ指定できます。");
    requireThat(!Object.hasOwn(map, "duration"), "絶対時間のシーケンス長は使用できません。");
    requireThat(Array.isArray(map.rooms) && map.rooms.length <= 100, "部屋は最大100件です。");
    requireThat(Array.isArray(map.tracks) && map.tracks.length <= 128, "トラックは最大128本です。");
    const rooms = new Set(map.rooms.map(room => room?.id));
    for (const room of map.rooms) {
      requireThat(room && typeof room === "object", "部屋が不正です。");
      identifier(room.id); text(room.name, "部屋名"); color(room.color);
      number(room.x, 0, 1600, "部屋X"); number(room.y, 0, 900, "部屋Y");
      number(room.width, 1, 1600 - room.x, "部屋幅");
      number(room.height, 1, 900 - room.y, "部屋高さ");
      if (Object.hasOwn(room, "appearance")) requireThat(
        ["standard", "elevator", "continuing-hall"].includes(room.appearance), "空間の見た目が不正です。");
    }
    validateFloorPlan(map);
    if (map.floorPlan) {
      for (const item of [...map.floorPlan.doors, ...map.floorPlan.furniture,
        ...(map.floorPlan.chargingZones ?? []), ...(map.floorPlan.walls ?? [])]) identifier(item.id);
    }
    if (map.background !== null) {
      const image = map.background;
      requireThat(image && typeof image.data === "string" && image.data.length <= 22_000_000,
        "背景は約20MB以下の画像データにしてください。");
      backgroundBytes += image.data.length;
      requireThat(backgroundBytes <= 70 * 1024 * 1024,
        "背景画像データの合計は70MiB以下にしてください。");
      const header = /^data:image\/(?:png|jpeg|webp);base64,/.exec(image.data);
      const payload = header ? image.data.slice(header[0].length) : "";
      requireThat(payload.length > 0 && payload.length % 4 === 0 &&
        /^[a-zA-Z0-9+/]*={0,2}$/.test(payload),
      "背景にはPNG・JPEG・WebPのdata URLのみ使用できます。");
      text(image.name, "背景名", 255); number(image.opacity, 0, 1, "背景の不透明度");
    }
    const actions = new Map();
    const robotIds = new Set();
    for (const track of map.tracks) {
      requireThat(track && typeof track === "object", "トラックが不正です。");
      identifier(track.id); text(track.name, "トラック名"); color(track.color);
      requireThat(Object.hasOwn(KINDS, track.kind), "トラック種別が不正です。");
      requireThat(typeof track.muted === "boolean" && typeof track.locked === "boolean", "トラック状態が不正です。");
      if (actorKind(track.kind)) {
        point(track.initial); roomRef(track.initial.roomId, rooms);
        if (map.executionMode === "timed") gridPoint(track.initial);
      }
      if (track.kind === "robot") {
        if (Object.hasOwn(track, "robotRole")) requireThat(
          ["cleaning", "security", "delivery"].includes(track.robotRole), "ロボット種別が不正です。");
        number(track.robotId, 0, 9999, "ロボットID");
        requireThat(Number.isInteger(track.robotId) && !robotIds.has(track.robotId), "ロボットIDが重複または不正です。");
        robotIds.add(track.robotId);
      }
      if (track.kind === "human") {
        number(track.count, 1, 10000, "人数");
        requireThat(Number.isInteger(track.count), "人数は整数で指定してください。");
      }
      if (track.kind === "room") roomRef(track.roomId, rooms);
      requireThat(Array.isArray(track.actions), "アクション一覧が不正です。");
      total += track.actions.length;
      requireThat(total <= 2000, "アクションは全体で最大2000個です。");
      for (const action of track.actions) {
        requireThat(action && typeof action === "object", "アクションが不正です。");
        identifier(action.id); text(action.name, "アクション名");
        requireThat(actionTypes[track.kind].includes(action.type), "アクション種別が不正です。");
        if (map.timelineOnly) requireThat(action.type !== "join" && !Object.hasOwn(action, "trigger"),
          "時間軸専用シーケンスには合流・トリガーを保存できません。");
        if (["wait", "join", "unlock"].includes(action.type)) requireThat(map.executionMode === "timed",
          "待機・合流・解錠にはv4の時間軸実行が必要です。");
        if (action.type === "unlock") requireThat(rooms.has(action.roomId),
          "解錠する部屋を選択してください。");
        if (Object.hasOwn(action, "doorId")) {
          requireThat(action.type === "unlock" && safeId(action.doorId),
            "ドア指定は対象ドアを持つ解錠アクションに限ります。");
          const door = map.floorPlan?.doors.find(item => item.id === action.doorId);
          requireThat(door && door.roomId === action.roomId,
            "指定ドアは解錠する部屋に属していません。");
        }
        if (map.executionMode === "timed") {
          number(action.runSeconds, ["move", "wait", "unlock"].includes(action.type) ? .1 : 0, 86400, "実行秒数");
          if (action.type === "join") requireThat(action.runSeconds === 0, "合流の幅は0秒です。成立までの時間を自動計算します。");
          if (["move", "show"].includes(action.type)) gridPoint(action);
          if (Object.hasOwn(action, "timeoutSeconds")) number(action.timeoutSeconds, .1, 86400, "タイムアウト秒");
          if (Object.hasOwn(action, "simulationOutcome")) requireThat(
            ["success", "failed"].includes(action.simulationOutcome), "模擬結果が不正です。");
          if (Object.hasOwn(action, "failureReason")) text(action.failureReason, "失敗理由", 500);
        }
        requireThat(!Object.hasOwn(action, "duration") && !Object.hasOwn(action, "start"),
          "絶対時間や継続時間ではなくトリガーを使用してください。");
        point(action); roomRef(action.roomId, rooms);
        requireThat(safeId(action.targetId), "対象IDが不正です。");
        text(action.text, "表示内容", 4000);
        requireThat(["meeting", "fire", "outage"].includes(action.state), "部屋状態が不正です。");
        number(action.position, 0, 1_000_000, "編集位置");
        if (Object.hasOwn(action, "plannedDuration"))
          number(action.plannedDuration, .5, 3600, "目安の実行時間");
        number(action.speed, 0.01, 10000, "移動速度");
        if (Object.hasOwn(action, "motion")) {
          requireThat(action.type === "move" && ["linear", "rotate"].includes(action.motion),
            "移動方法が不正です。");
        }
        if (action.motion === "rotate") number(action.angularSpeed, .01, 3600, "回転速度");
        if (Object.hasOwn(action, "facingFor")) requireThat(action.type === "move" &&
          action.motion === "rotate" && safeId(action.facingFor), "自動旋回の対象が不正です。");
        if (Object.hasOwn(action, "rotationSeconds")) {
          requireThat(action.type === "move" && action.motion === "rotate", "回転時間の対象が不正です。");
          number(action.rotationSeconds, .1, 86400, "回転時間");
        }
        if (Object.hasOwn(action, "displayTemplate"))
          requireThat(DISPLAY_TEMPLATES.includes(action.displayTemplate), "表示テンプレートが不正です。");
        if (Object.hasOwn(action, "hatchStyle"))
          requireThat(HATCH_STYLES.includes(action.hatchStyle), "ハッチングスタイルが不正です。");
        if (Object.hasOwn(action, "hatchColor")) color(action.hatchColor);
        number(action.tolerance, 0, 2000, "到着許容距離");
        number(action.dwell, 0, 86400, "到着待機秒");
        if (action.angleTolerance !== null) number(action.angleTolerance, 0, 180, "角度許容値");
        if (!map.timelineOnly) requireThat(action.trigger && ["all", "any"].includes(action.trigger.mode) &&
          Array.isArray(action.trigger.sources) &&
          action.trigger.sources.length >= (["ordered", "timed"].includes(map.executionMode) ? 0 : 1) &&
          action.trigger.sources.length <= 128, "トリガーが不正です。");
        if (action.type === "join") requireThat(action.trigger.mode === "all" &&
          action.trigger.sources.every(s => s.actionId !== "$start" && s.event === "complete"),
        "合流は完了条件をANDで指定してください。");
        for (const item of action.trigger?.sources ?? []) {
          requireThat(item && (item.actionId === "$start" || safeId(item.actionId)) &&
            ["start", "complete"].includes(item.event) &&
            (item.actionId !== "$start" || item.event === "start"), "トリガーの参照が不正です。");
          number(item.delay, 0, 86400, "トリガー遅延");
        }
        actions.set(action.id, action);
      }
    }
    const indegrees = new Map([...actions.keys()].map(id => [id, 0]));
    const children = new Map([...actions.keys()].map(id => [id, []]));
    const previous = previousActions(map);
    for (const action of actions.values()) {
      for (const dependency of new Set([
        ...(action.trigger?.sources ?? []).map(item => item.actionId),
        ...(previous.has(action.id) ? [previous.get(action.id)] : []),
      ])) {
        if (dependency === "$start") continue;
        requireThat(actions.has(dependency), "トリガーは同じマップ内のアクションを参照してください。");
        indegrees.set(action.id, indegrees.get(action.id) + 1);
        children.get(dependency).push(action.id);
      }
    }
    const queue = [...actions.keys()].filter(id => indegrees.get(id) === 0);
    for (let index = 0; index < queue.length; index++) {
      for (const child of children.get(queue[index])) {
        indegrees.set(child, indegrees.get(child) - 1);
        if (indegrees.get(child) === 0) queue.push(child);
      }
    }
    requireThat(queue.length === actions.size, "実行順またはトリガーに循環参照があります。配置順と待ち条件を確認してください。");
  }
  return project;
}

function interpolate(from, to, progress) {
  const fraction = clamp(progress, 0, 1);
  return {
    x: from.x + (to.x - from.x) * fraction,
    y: from.y + (to.y - from.y) * fraction,
    yaw: yaw(from.yaw + normalizedYaw(to.yaw - from.yaw) * fraction),
  };
}
function movementPosition(entry, time) {
  time = Math.min(time, entry.end ?? time);
  if (entry.segments?.length) {
    const p = positionAt(entry.segments, time);
    const progress = clamp((time - entry.start) / (entry.travel || 1), 0, 1);
    return { ...p, yaw: yaw(entry.from.yaw + normalizedYaw(entry.to.yaw - entry.from.yaw) * progress) };
  }
  return interpolate(entry.from, entry.to,
    !entry.travel ? 1 : (time - entry.start) / entry.travel);
}

function compileLegacyPlan(map) {
  const entries = map.tracks.flatMap(track => track.actions.map(action => ({
    action, track, start: null, end: null, blocked: track.muted,
  })));
  const byId = new Map(entries.map(entry => [entry.action.id, entry]));
  const previous = previousActions(map);
  const latest = new Map();
  const pendingEvents = [];
  const log = [];
  const errors = [];
  const addEvent = (at, kind, entry) => pendingEvents.push({ at, kind, entry, order: entries.indexOf(entry) });
  const candidate = entry => {
    if (entry.blocked || entry.start !== null) return null;
    const predecessor = byId.get(previous.get(entry.action.id));
    if (predecessor?.blocked) { entry.blocked = true; return null; }
    if (predecessor && predecessor.end === null) return null;
    const ready = predecessor?.end ?? 0;
    const values = entry.action.trigger.sources.map(item => {
      if (item.actionId === "$start") return item.delay;
      const other = byId.get(item.actionId);
      if (!other || other.blocked) return "blocked";
      const stamp = item.event === "start" ? other.start : other.end;
      return stamp === null ? null : stamp + item.delay;
    });
    if (entry.action.trigger.mode === "all") {
      if (values.includes("blocked")) { entry.blocked = true; return null; }
      return values.includes(null) ? null : Math.max(ready, ...values);
    }
    if (!values.length) return ready;
    if (values.every(value => value === "blocked")) { entry.blocked = true; return null; }
    const available = values.filter(value => typeof value === "number");
    return available.length ? Math.max(ready, Math.min(...available)) : null;
  };
  let now = 0;
  while (true) {
    let nextEntry = null;
    let nextStart = Infinity;
    // ブロックは参照順によらず末端まで伝播させる。
    let previousBlocked;
    do {
      previousBlocked = entries.filter(entry => entry.blocked).length;
      for (const entry of entries) candidate(entry);
    } while (entries.filter(entry => entry.blocked).length !== previousBlocked);
    for (const entry of entries) {
      const at = candidate(entry);
      if (at !== null && at < nextStart) { nextEntry = entry; nextStart = at; }
    }
    pendingEvents.sort((a, b) => a.at - b.at ||
      (a.kind === "arrival" ? 0 : 1) - (b.kind === "arrival" ? 0 : 1) || a.order - b.order);
    const event = pendingEvents[0];
    if (event && event.at <= nextStart) {
      pendingEvents.shift();
      now = event.at;
      log.push(event);
      continue;
    }
    if (!nextEntry) break;
    const entry = nextEntry;
    now = Math.max(now, nextStart);
    const { action, track } = entry;
    if (action.type === "move") {
      const previous = latest.get(track.id);
      if (previous && previous.end > now) {
        entry.blocked = true;
        errors.push(`移動が重複しています: ${action.id}`);
        continue;
      }
      entry.from = previous ? movementPosition(previous, now) : track.initial;
      const rotate = action.motion === "rotate";
      entry.to = rotate ? { ...entry.from, yaw: action.yaw } : action;
      entry.travel = rotate ? action.rotationSeconds ??
        Math.abs(normalizedYaw(action.yaw - entry.from.yaw)) / action.angularSpeed :
        Math.hypot(action.x - entry.from.x, action.y - entry.from.y) / action.speed;
      entry.roomId = rotate ? previous?.roomId ?? track.initial.roomId : action.roomId;
      entry.start = now;
      entry.end = now + entry.travel + action.dwell;
      latest.set(track.id, entry);
      addEvent(now + entry.travel, "arrival", entry);
    } else {
      entry.start = now;
      entry.end = now;
    }
    log.push({ at: now, kind: "start", entry });
    addEvent(entry.end, "complete", entry);
  }
  for (const entry of entries) {
    if (entry.start === null) entry.blocked = true;
  }
  return { map, entries, log, errors, duration: Math.max(0, ...entries.map(entry => entry.end ?? 0)) };
}

export function compilePlan(map, { fixedTimeline = false } = {}) {
  fixedTimeline ||= map.timelineOnly === true;
  const plan = map.executionMode === "timed" ? compileTimedPlan(map, [], 0, fixedTimeline) : compileLegacyPlan(map);
  if (fixedTimeline) prepareDoorPlan(plan);
  return plan;
}

export function samplePlan(plan, time, includeMotionContext = false) {
  number(time, 0, Number.MAX_SAFE_INTEGER, "再生時刻");
  const { map, entries, log, errors } = plan;
  const actors = map.tracks.filter(track => actorKind(track.kind) && !track.muted).map(track => ({
    id: track.id, kind: track.kind, name: track.name, color: track.color,
    count: track.kind === "human" ? track.count : 1,
    ...(track.kind === "robot" ? { robotRole: track.robotRole ?? "cleaning" } : {}),
    robotId: track.kind === "robot" ? track.robotId : null,
    ...clone(track.initial), aggregated: false, moving: false,
  }));
  const actorById = new Map(actors.map(actor => [actor.id, actor]));
  const movements = new Map();
  const displays = new Map();
  const events = new Map();
  const rooms = new Map(map.rooms.map(room => [room.id, room]));
  const inside = (actor, roomId) => {
    const room = rooms.get(roomId);
    return actor.roomId === roomId && room && roomContainsPoint(room, actor.x, actor.y);
  };
  const aggregate = actor => {
    if (!actor.moving && [...events.values()].some(event => inside(actor, event.roomId))) actor.aggregated = true;
  };
  const advance = at => {
    for (const [id, movement] of movements) {
      const actor = actorById.get(id);
      Object.assign(actor, movementPosition(movement, at));
      const segment = movement.segments?.find(s => at >= s.start && at < s.end);
      actor.moving = movement.segments ? !!segment &&
        (movement.action.motion === "rotate" ||
          segment.from.x !== segment.to.x || segment.from.y !== segment.to.y) :
        at < movement.start + movement.travel;
    }
  };
  for (const event of log) {
    if (event.at > time) break;
    advance(event.at);
    const { action, track } = event.entry;
    const actor = actorById.get(track.id);
    if (plan.fixedTimeline && event.kind === "complete") {
      if (action.type === "show" && displays.get(action.targetId)?.actionId === action.id) displays.delete(action.targetId);
      if (action.type === "event-start" && events.get(action.targetId)?.actionId === action.id) events.delete(action.targetId);
    }
    if (event.kind === "start" && action.type === "move") {
      if (actor.roomId !== event.entry.roomId) actor.aggregated = false;
      movements.set(track.id, event.entry);
      actor.moving = event.entry.travel > 0;
    } else if (event.kind === "arrival") {
      Object.assign(actor, movementPosition(event.entry, event.at), { roomId: event.entry.roomId, moving: false });
      aggregate(actor);
    } else if (event.kind === "complete" && map.executionMode !== "timed" ||
      map.executionMode === "timed" && event.kind === "start" &&
        event.entry.outcome === "success") {
      if (action.type === "show") displays.set(action.targetId, {
        actionId: action.id,
        targetId: action.targetId, text: action.text, x: action.x, y: action.y, color: track.color,
        ...(action.displayTemplate ? { displayTemplate: action.displayTemplate } : {}),
        ...(actorKind(track.kind) ? { actorId: track.id } : {}),
      });
      if (action.type === "hide") displays.delete(action.targetId);
      if (action.type === "event-start") {
        events.set(action.targetId, {
          actionId: action.id,
          targetId: action.targetId, roomId: action.roomId || track.roomId,
          state: action.state, text: action.text, color: track.color,
          ...(action.hatchColor ? { hatchColor: action.hatchColor } : {}),
          ...(action.hatchStyle ? { hatchStyle: action.hatchStyle } : {}),
        });
        for (const item of actors) aggregate(item);
      }
      if (action.type === "event-end") events.delete(action.targetId);
    }
  }
  advance(time);
  if (plan.fixedTimeline) for (const actor of actors) {
    if (![...events.values()].some(event => inside(actor, event.roomId))) actor.aggregated = false;
  }
  const actionStates = {};
  for (const entry of entries) {
    const status = entry.blocked ? "blocked" : time < entry.start ? "waiting" :
      time < entry.end ? "running" : "complete";
    actionStates[entry.action.id] = { status, start: entry.start, end: entry.end };
    if (map.executionMode === "timed") {
      const failed = entry.outcome && entry.outcome !== "success" && time >= entry.end;
      if (failed) actionStates[entry.action.id].status = entry.outcome;
      const waiting = !entry.blocked && time < entry.start;
      const awaiting = entry.waitConditions?.filter(c => c.at === null || time < c.at).map(c => c.name);
      const reason = entry.reason || ((waiting || entry.action.type === "join" && time < entry.end) ?
        awaiting?.length ? `${awaiting.join("、")} の成功完了待ち` :
          `配置・条件の開始時刻待ち（${entry.start.toFixed(2)}秒）` : "");
      Object.assign(actionStates[entry.action.id], { reason, waits: entry.waits,
        result: { schema: "scene-action-result/v1", actionId: entry.action.id,
          trackId: entry.track.id, robotId: entry.track.robotId ?? null,
          source: "simulation", status: entry.blocked ? "blocked" :
          time < entry.start ? "pending" : time < entry.end ? "running" : entry.outcome,
          elapsedSeconds: entry.start === null ? 0 : Math.max(0, Math.min(time, entry.end) - entry.start),
          waitingSeconds: entry.start === null ? 0 : Math.max(0, entry.start - entry.ready),
          startedAtSeconds: entry.start, endedAtSeconds: entry.end,
          simulatedPosition: entry.track.initial && entry.start !== null && time >= entry.start ?
            movementPosition({ ...entry, from: entry.from, to: entry.to ?? entry.from,
              travel: entry.travel ?? 0 }, Math.min(time, entry.end)) : null,
          measuredPosition: null, reason } });
    }
    if (includeMotionContext && entry.from) actionStates[entry.action.id].from = clone(entry.from);
  }

  const travelling = new Set(entries.filter(entry => !entry.blocked &&
    entry.action.type === "move" && entry.start !== null && time >= entry.start && time < entry.end &&
    (entry.action.motion === "rotate" || entry.from?.x !== entry.to?.x ||
      entry.from?.y !== entry.to?.y)).map(entry => entry.track.id));
  const roomActivities = map.rooms.filter(room => room.kind === "room").flatMap(room => {
    const robots = actors.filter(actor => actor.kind === "robot" &&
      !actor.moving && !travelling.has(actor.id) &&
      roomContainsPoint(room, actor.x, actor.y) &&
      !(map.floorPlan?.chargingZones ?? []).some(zone =>
        actor.x >= zone.x && actor.x <= zone.x + zone.width &&
        actor.y >= zone.y && actor.y <= zone.y + zone.height));
    if (!robots.length) return [];
    const labels = [...new Set(robots.map(robot =>
      ({ cleaning: "掃除中", security: "監視中", delivery: "配送中" })[robot.robotRole]))];
    return [{ roomId: room.id, text: labels.join(" / "), actorIds: robots.map(robot => robot.id) }];
  });
  return {
    actors, displays: [...displays.values()], events: [...events.values()], actionStates,
    roomActivities,
    doors: sampleDoorPlan(plan, time),
    duration: plan.duration, errors, ...(plan.warnings ? { warnings: plan.warnings } : {}),
  };
}

export function simulate(map, time, includeMotionContext = false) {
  return samplePlan(compilePlan(map), time, includeMotionContext);
}

export function actionPreview(map, trackId, action, options) {
  const copy = clone(map), track = copy.tracks.find(t => t.id === trackId);
  requireThat(track, "プレビュー対象の行が見つかりません。");
  const index = track.actions.findIndex(a => a.id === action.id);
  if (index < 0) track.actions.push(clone(action));
  else track.actions[index] = clone(action);
  const plan = compilePlan(copy, options);
  const state = samplePlan(plan, 0, true), entry = state.actionStates[action.id];
  const at = entry.start ?? 0;
  const before = samplePlan(plan, Math.max(0, at - .000001));
  const sequence = ["ordered", "timed"].includes(copy.executionMode) ? orderedActions(track) : track.actions;
  const precedingMove = sequence.slice(0, sequence.findIndex(a => a.id === action.id))
    .findLast(a => a.type === "move" && a.motion !== "rotate");
  // 除外・未成立の行でも、編集時の通行判定を実行計画の成立有無で省略しない。
  const from = entry.from ?? (precedingMove ? { ...precedingMove } : track.initial) ??
    before.actors.find(a => a.id === trackId) ?? null;
  const safety = action.type === "move" ? createSafety(copy,
    { robotSide: options?.fixedTimeline ? ROBOT_SIDE : 86 }) : null;
  const geometryProblem = safety ?
    pathProblem(safety, track.initial, track.initial, track.kind) ||
      pathProblem(safety, from, action.motion === "rotate" ? from : action, track.kind) : "";
  return {
    from, geometryProblem,
    state: before, start: entry.start, end: entry.end,
    warning: entry.reason || (entry.status === "blocked" ? "開始条件が成立しないため、開始位置は参考表示です。" : ""),
  };
}
