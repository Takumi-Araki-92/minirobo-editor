import { automaticDoorOpenness, buildNavigation, ROBOT_SIDE } from "./floor-plan.js";
import { positionAt, collisionWarnings } from "./safety.js";

const DOOR_TRANSITION_SECONDS = .6;
const distanceToOpening = (opening, point) => {
  const dx = opening.x2 - opening.x1, dy = opening.y2 - opening.y1;
  const along = Math.max(0, Math.min(1, ((point.x - opening.x1) * dx +
    (point.y - opening.y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(point.x - opening.x1 - along * dx, point.y - opening.y1 - along * dy);
};
function trajectories(plan) {
  return plan.map.tracks.filter(t => t.initial && !t.muted).map(track => {
    let from = track.initial, cursor = 0;
    const segments = [];
    for (const entry of plan.entries.filter(e => e.track.id === track.id &&
      e.action.type === "move" && !e.blocked && e.start !== null).sort((a, b) => a.start - b.start)) {
      if (entry.start > cursor) segments.push({ start: cursor, end: entry.start, from, to: from });
      segments.push(...entry.segments);
      cursor = entry.end; from = entry.to;
    }
    segments.push({ start: cursor, end: Infinity, from, to: from });
    return { id: track.id, name: track.name, kind: track.kind,
      radius: track.kind === "robot" ? Math.SQRT2 * ROBOT_SIDE / 2 : 20, segments };
  });
}
function clearAt(opening, trajectory, at) {
  const clearance = trajectory.radius + 10;
  if (distanceToOpening(opening, positionAt(trajectory.segments, at)) > clearance) return at;
  for (const segment of trajectory.segments.filter(s => s.end > at)) {
    if (distanceToOpening(opening, segment.to) <= clearance) continue;
    // 開口近傍は凸集合なので、直線区間の退出点を一度だけ求めればよい。
    let low = Math.max(segment.start, at), high = segment.end;
    for (let index = 0; index < 40; index++) {
      const mid = (low + high) / 2;
      if (distanceToOpening(opening, positionAt([segment], mid)) <= clearance) low = mid;
      else high = mid;
    }
    return high;
  }
  return Infinity;
}
function doorWindows(plan, doors, paths) {
  const unlocks = plan.entries.filter(e => e.action.type === "unlock" &&
    !e.blocked && e.outcome === "success" && e.start !== null && e.end > e.start);
  return doors.map(door => ({
    ...door,
    passages: paths.flatMap(path => path.segments.flatMap(segment => {
      if (!Number.isFinite(segment.end)) return [];
      const crossing = crossingTime(door.opening, segment, path.radius);
      if (!crossing) return [];
      return [{ actorId: path.id, start: segment.start, end: segment.end,
        openingStart: Math.max(0, segment.start - DOOR_TRANSITION_SECONDS),
        openBy: segment.start > 0 ? segment.start :
          Math.min(DOOR_TRANSITION_SECONDS, crossing.enter),
      }];
    })),
    windows: unlocks.filter(e => e.action.doorId ?
      (door.memberIds ?? [door.id]).includes(e.action.doorId) :
      e.action.roomId === door.roomId).map(entry => ({
      start: entry.start, end: entry.end,
      heldUntil: Math.max(entry.end, ...paths.map(path => clearAt(door.opening, path, entry.end))),
    })),
  }));
}
function crossingTime(opening, segment, radius) {
  const horizontal = opening.y1 === opening.y2, key = horizontal ? "y" : "x";
  const boundary = horizontal ? opening.y1 : opening.x1;
  const delta = segment.to[key] - segment.from[key];
  if (!delta) return null;
  const t = (boundary - segment.from[key]) / delta;
  if (t < 0 || t > 1) return null;
  const coordinate = horizontal ? segment.from.x + (segment.to.x - segment.from.x) * t :
    segment.from.y + (segment.to.y - segment.from.y) * t;
  const min = Math.min(horizontal ? opening.x1 : opening.y1, horizontal ? opening.x2 : opening.y2);
  const max = Math.max(horizontal ? opening.x1 : opening.y1, horizontal ? opening.x2 : opening.y2);
  if (coordinate < min || coordinate > max) return null;
  const at = segment.start + (segment.end - segment.start) * t;
  const enter = Math.max(segment.start,
    at - (radius + 10) * (segment.end - segment.start) / Math.abs(delta));
  return { enter, at };
}
const allowed = (door, at) => door.windows.some(w => at >= w.start && at < w.heldUntil);

export function prepareDoorPlan(plan) {
  const doors = buildNavigation(plan.map).doors ?? [];
  if (!doors.length) { plan.doorPlan = []; return; }
  const previous = new Map(), byId = new Map(plan.entries.map(e => [e.action.id, e]));
  for (const track of plan.map.tracks) {
    const ordered = plan.entries.filter(e => e.track.id === track.id)
      .sort((a, b) => a.action.position - b.action.position);
    ordered.forEach((entry, index) => { if (index) previous.set(entry.action.id, ordered[index - 1]); });
  }
  let changed;
  do {
    changed = false;
    const paths = trajectories(plan), states = doorWindows(plan, doors, paths);
    for (const entry of plan.entries) {
      if (entry.blocked || entry.start === null) continue;
      let reason = "";
      if (entry.action.type === "move" && entry.action.motion !== "rotate") {
        const closed = states.find(door => entry.segments.some(segment => {
          const crossing = crossingTime(door.opening, segment,
            entry.track.kind === "robot" ? Math.SQRT2 * ROBOT_SIDE / 2 : 20);
          return crossing !== null && (!allowed(door, crossing.enter) || !allowed(door, crossing.at));
        }));
        if (closed) {
          reason = `${closed.name ?? plan.map.rooms.find(r => r.id === closed.roomId)?.name ?? "部屋"}のドアが施錠中です。通過時刻を含む解錠コントロールを追加してください。`;
          if (plan.map.doorMode === "story") {
            plan.warnings ??= [];
            if (!plan.warnings.some(w => w.code === "door-preview" && w.actionId === entry.action.id)) {
              plan.warnings.push({ code: "door-preview", actionId: entry.action.id,
                message: `${entry.track.name} / ${entry.action.name}: ストーリー確認のため移動を継続します。${reason} 実機通行の許可ではありません。` });
            }
            reason = "";
          }
        }
      }
      if (!reason && (previous.get(entry.action.id)?.blocked ||
        !plan.map.timelineOnly && entry.action.trigger.sources.length && (entry.action.trigger.mode === "all" ?
          entry.action.trigger.sources.some(s => byId.get(s.actionId)?.blocked) :
          entry.action.trigger.sources.every(s => byId.get(s.actionId)?.blocked)))) {
        reason = "前の項目または待ち条件が成功していないため停止しています。";
      }
      if (reason) {
        entry.blocked = true; entry.reason = reason; entry.outcome = null;
        entry.start = null; entry.end = null; entry.segments = []; entry.waits = [];
        plan.errors.push(`${entry.track.name} / ${entry.action.name}: ${reason}`); changed = true;
      }
    }
  } while (changed);
  const paths = trajectories(plan);
  plan.doorPaths = paths;
  plan.doorPlan = doorWindows(plan, doors, paths);
  plan.log = plan.log.filter(e => !e.entry.blocked);
  plan.warnings = [...(plan.warnings ?? []).filter(w => w.code !== "collision"), ...collisionWarnings(paths)];
  plan.duration = Math.max(0, ...plan.entries.map(e => e.end ?? 0));
}

export function sampleDoorPlan(plan, time) {
  const actors = new Map((plan.doorPaths ?? []).map(path => [path.id, {
    ...positionAt(path.segments, time), kind: path.kind, radius: path.radius,
  }]));
  return (plan.doorPlan ?? []).map(door => {
    const unlocked = door.windows.some(w => time >= w.start && time < w.end);
    const held = door.windows.some(w => time >= w.end && time < w.heldUntil);
    let openness = 0;
    for (const passage of door.passages) {
      const closeBy = passage.end + DOOR_TRANSITION_SECONDS;
      if (time < passage.openingStart || time >= closeBy) continue;
      const actor = actors.get(passage.actorId);
      const opening = passage.openBy > passage.openingStart ?
        (time - passage.openingStart) / (passage.openBy - passage.openingStart) : 1;
      const closing = time <= passage.end ? 1 :
        1 - (time - passage.end) / DOOR_TRANSITION_SECONDS;
      // バー開始前の旋回と入室後の待機にも接続し、境界で扉を瞬間切替しない。
      openness = Math.max(openness, automaticDoorOpenness(door.opening, [actor]) *
        Math.max(0, Math.min(1, opening, closing)));
    }
    if ([...actors.values()].some(actor =>
      distanceToOpening(door.opening, actor) <= actor.radius + 10)) openness = 1;
    return {
      id: door.id, unlocked, held,
      openness: held ? 1 : unlocked ? openness : 0,
      actorIds: door.passages.filter(passage => time >= passage.start && time < passage.end)
        .map(passage => passage.actorId),
    };
  });
}
