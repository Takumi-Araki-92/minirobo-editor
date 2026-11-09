import { createSafety, pathProblem, pathSections, collisionWarnings } from "./safety.js";
import { roomContainsPoint, ROBOT_SIDE } from "./floor-plan.js";

const shortAngle = value => ((value + 180) % 360 + 360) % 360 - 180;
const point = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
export function compileTimedPlan(map, stationary = [], iteration = 0, fixedTimeline = false) {
  fixedTimeline ||= map.timelineOnly === true;
  const entries = map.tracks.flatMap(track => track.actions.map(action => ({
    action, track, start: null, end: null, blocked: track.muted,
    reason: track.muted ? `${track.name} はプレビュー対象外です。` : "",
    outcome: null, segments: [], waits: [],
  })));
  const byId = new Map(entries.map(e => [e.action.id, e])), previous = new Map();
  for (const track of map.tracks) {
    const sorted = [...track.actions].sort((a, b) => a.position - b.position);
    sorted.forEach((a, i) => { if (i) previous.set(a.id, sorted[i - 1].id); });
  }
  const safety = createSafety(map, { robotSide: fixedTimeline ? ROBOT_SIDE : 86 });
  const reservations = new Map(), latest = new Map();
  const initialOccupants = map.tracks.filter(t => t.kind === "robot" && !t.muted).map(t => {
    const cell = (17 - Math.floor(t.initial.y / 50)) * 32 + Math.floor(t.initial.x / 50);
    return { trackId: t.id, name: t.name, zone: safety.cellZones.get(cell), released: false };
  }).filter(t => t.zone);
  for (const r of stationary) {
    const list = reservations.get(r.zone) ?? [];
    list.push(r); reservations.set(r.zone, list);
  }
  const log = [], errors = [], warnings = [];
  const blocked = (e, reason) => { e.blocked = true; e.reason = reason; };
  for (const track of map.tracks.filter(t => t.initial && !t.muted)) {
    const problem = pathProblem(safety, track.initial, track.initial, track.kind);
    if (!problem) continue;
    const reason = `${track.name} の初期位置: ${problem}`;
    errors.push(reason);
    for (const entry of entries.filter(e => e.track.id === track.id)) blocked(entry, reason);
  }
  const waitDeadline = e => {
    if (!e.action.timeoutSeconds) return null;
    e.timedOutWaiting = true;
    return e.ready + e.action.timeoutSeconds;
  };
  const successStamp = (other, event) => {
    if (!other) return "blocked";
    if (other.blocked || other.outcome && other.outcome !== "success") return "blocked";
    return event === "start" ? other.start : other.end;
  };
  const candidate = e => {
    if (e.blocked || e.start !== null) return null;
    if (e.action.type === "join" && new Set(e.action.trigger.sources.map(s => s.actionId)).size < 2) {
      blocked(e, "合流には異なる2項目以上の完了条件を接続してください。"); return null;
    }
    e.timedOutWaiting = false;
    const pred = byId.get(previous.get(e.action.id));
    if (pred && successStamp(pred, "complete") === "blocked") {
      blocked(e, `${pred.track.name} / ${pred.action.name} が成功していないため停止しています。`); return null;
    }
    if (pred && pred.end === null) return null;
    if (fixedTimeline) {
      e.ready = e.action.position;
      if (pred && pred.end > e.ready + 1e-7) {
        blocked(e, `同じ行のバーが重なっています。${pred.action.name} の終了以降へ配置してください。`);
        return null;
      }
      if (map.timelineOnly) return e.ready;
      const stamps = e.action.trigger.sources.map(s => {
        if (s.actionId === "$start") return s.delay;
        const stamp = successStamp(byId.get(s.actionId), s.event);
        return typeof stamp === "number" ? stamp + s.delay : stamp;
      });
      const satisfied = stamp => typeof stamp === "number" && stamp <= e.ready + 1e-7;
      if (stamps.includes(null) && !(e.action.trigger.mode === "any" && stamps.some(satisfied))) return null;
      if (stamps.length && !(e.action.trigger.mode === "any" ?
        stamps.some(satisfied) : stamps.every(satisfied))) {
        blocked(e, "バーの開始時刻にトリガーが成立しません（未完了・失敗・除外を含む）。開始位置または接続条件を修正してください。");
        return null;
      }
      return e.ready;
    }
    const predecessor = pred ? pred.action : null;
    // 後続の空白も保持し、実行遅延だけを行全体へ伝える。
    const ready = pred ? pred.end + Math.max(0, e.action.position -
      predecessor.position - (predecessor.runSeconds ?? predecessor.plannedDuration ?? 6) -
        (predecessor.type === "move" ? predecessor.dwell : 0)) : e.action.position;
    e.ready = ready;
    const values = e.action.trigger.sources.map(s => s.actionId === "$start" ? s.delay :
      successStamp(byId.get(s.actionId), s.event));
    e.action.trigger.sources.forEach((s, i) => {
      if (s.actionId !== "$start" && typeof values[i] === "number") values[i] += s.delay;
    });
    const failed = values.includes("blocked"), unresolved = values.includes(null);
    if ((e.action.type === "join" || e.action.trigger.mode === "all") && failed ||
      values.length && values.every(v => v === "blocked")) {
      blocked(e, "待ち条件の参照先が失敗・タイムアウト・除外されています。"); return null;
    }
    if (e.action.type === "join" || e.action.trigger.mode === "all") {
      if (unresolved) return waitDeadline(e);
      return resourceReady(e, Math.max(ready, ...values));
    }
    if (!values.length) return resourceReady(e, ready);
    const available = values.filter(v => typeof v === "number");
    return available.length ? resourceReady(e, Math.max(ready, Math.min(...available))) : waitDeadline(e);
  };
  const resourceReady = (e, at) => {
    if (e.action.type !== "move" || e.track.kind !== "robot" || e.action.motion === "rotate") return at;
    const from = latest.get(e.track.id)?.to ?? e.track.initial;
    const zones = new Set(pathSections(safety, from, e.action).map(s => s.zone));
    const occupant = initialOccupants.find(t => t.trackId !== e.track.id && !t.released && zones.has(t.zone));
    if (!occupant) return at;
    e.resourceReason = `${occupant.name} が ${safety.zones.get(occupant.zone).name} 内にいます。退出予定が確定しないため通行を停止します。`;
    return waitDeadline(e);
  };
  const reserve = e => {
    const duration = e.action.runSeconds;
    const distance = Math.hypot(e.to.x - e.from.x, e.to.y - e.from.y);
    const margin = distance ? safety.robotRadius / distance : 0;
    const intervals = pathSections(safety, e.from, e.to).filter(s => s.zone).map(s =>
      ({ ...s, from: Math.max(0, s.from - margin), to: Math.min(1, s.to + margin) }));
    const cuts = [...new Set([0, 1, ...intervals.flatMap(s => [s.from, s.to])])].sort((a, b) => a - b);
    const sections = cuts.slice(1).map((to, i) => ({ from: cuts[i], to,
      zones: intervals.filter(s => s.from < (cuts[i] + to) / 2 &&
        s.to > (cuts[i] + to) / 2).map(s => s.zone) }));
    let cursor = e.start;
    for (const s of sections) {
      const from = point(e.from, e.to, s.from), to = point(e.from, e.to, s.to);
      const travel = duration * (s.to - s.from);
      const others = s.zones.flatMap(zone => reservations.get(zone) ?? []);
      let enter = cursor, cause = null;
      if (s.zones.length && e.track.kind === "robot") {
        let changed;
        do {
          changed = false;
          for (const other of others) if (other.trackId !== e.track.id &&
            enter < other.end - 1e-7 && enter + travel > other.start + 1e-7) {
            enter = other.end; cause = other; changed = true;
          }
        } while (changed);
      }
      if (!Number.isFinite(enter)) {
        if (!fixedTimeline && e.action.timeoutSeconds) {
          e.segments.push({ start: cursor, end: Infinity, from, to: from });
          return Infinity;
        }
        e.trafficFailure = true;
        e.reason = `${cause.name} が狭い廊下内に停止し、退出予定がないため通行できません。退出する動作を追加してください。`;
        return null;
      }
      if (enter > cursor) {
        if (fixedTimeline) {
          e.trafficFailure = true;
          e.reason = `${cause.name} と狭い廊下の通行時刻が重なっています。バーの配置時刻を調整してください。`;
          return null;
        }
        e.segments.push({ start: cursor, end: enter, from, to: from });
        const seconds = enter - cursor;
        const zone = s.zones[0];
        const wait = { code: "corridor-wait", actionId: e.action.id, corridorId: zone,
          trackIds: [e.track.id, cause.trackId], at: cursor, seconds, point: from,
          message: `${e.track.name} は ${safety.zones.get(zone).name} の入口で ${seconds.toFixed(2)}秒待機します。${cause.name} の通行予定（${cause.start.toFixed(2)}〜${cause.end.toFixed(2)}秒）と重なるためです。` };
        e.waits.push(wait); warnings.push(wait);
      }
      e.segments.push({ start: enter, end: enter + travel, from, to });
      for (const zone of s.zones) if (e.track.kind === "robot") {
        const list = reservations.get(zone) ?? [];
        list.push({ trackId: e.track.id, actionId: e.action.id, name: e.track.name, start: enter, end: enter + travel });
        reservations.set(zone, list);
      }
      cursor = enter + travel;
    }
    return cursor;
  };
  let processed = 0;
  while (processed < entries.length) {
    let next = null, at = Infinity;
    for (const e of entries) {
      const value = candidate(e);
      if (value !== null && value < at) { next = e; at = value; }
    }
    if (!next) break;
    const e = next, { action: a, track } = e;
    processed++;
    e.start = at;
    e.outcome = fixedTimeline ? "success" : a.simulationOutcome ?? "success";
    const prior = latest.get(track.id);
    if (track.initial) e.from = prior?.to ?? track.initial;
    if (e.timedOutWaiting) {
      e.outcome = "timeout"; e.end = at; e.travel = 0;
      e.to = e.from; e.roomId = prior?.roomId ?? track.initial?.roomId ?? "";
      e.reason = `開始予定・前の完了から${a.timeoutSeconds}秒以内に待ち条件・廊下の空きが成立しません。`;
      if (a.type === "join") e.start = e.ready;
    } else if (a.type === "move") {
      e.to = a.motion === "rotate" ? { ...e.from, yaw: a.yaw } : { ...a, yaw: e.from.yaw };
      e.roomId = a.motion === "rotate" ? prior?.roomId ?? track.initial.roomId : a.roomId;
      const problem = pathProblem(safety, e.from, e.to, track.kind);
      if (problem) {
        e.geometryFailure = true;
        e.outcome = "failed"; e.reason = problem; e.to = e.from; e.end = e.start; e.travel = 0;
      } else {
        e.travel = a.runSeconds;
        const arrival = a.motion === "rotate" || track.kind !== "robot" ?
          e.start + a.runSeconds : reserve(e);
        if (arrival === null) {
          e.outcome = "failed"; e.to = e.from; e.end = e.start; e.travel = 0; e.segments = [];
        } else {
          e.travel = arrival - e.start;
          e.end = arrival + (fixedTimeline ? 0 : a.dwell);
          if (!e.segments.length) e.segments = [{ start: e.start, end: arrival, from: e.from, to: e.to }];
        }
      }
    } else if (a.type === "join" && !fixedTimeline) {
      e.end = at; e.start = e.ready;
    } else e.end = e.start + a.runSeconds;
    const deadline = !fixedTimeline && a.timeoutSeconds ? e.ready + a.timeoutSeconds : Infinity;
    if (e.end > deadline) {
      e.outcome = "timeout"; e.reason = `開始予定・前の完了から${a.timeoutSeconds}秒以内に完了できません。`;
      e.start = Math.min(e.start, deadline); e.end = deadline;
    }
    if (e.outcome !== "success") {
      e.reason ||= a.failureReason || "模擬実行で失敗を指定しています。";
      if (a.type === "move") {
        // 失敗・期限切れ後の架空の到着を作らず、最終位置は停止時刻から求める。
        const stop = e.segments.find(s => e.end <= s.end) ?? e.segments.at(-1);
        if (stop) {
          const t = Math.max(0, Math.min(1, (e.end - stop.start) / (stop.end - stop.start || 1)));
          e.to = { ...point(stop.from, stop.to, t),
            yaw: e.from.yaw + shortAngle(e.to.yaw - e.from.yaw) *
              Math.max(0, Math.min(1, (e.end - e.start) / (a.runSeconds || 1))) };
          e.segments = e.segments.filter(s => s.start < e.end).map(s =>
            s.end > e.end ? { ...s, end: e.end, to: e.to } : s);
        } else e.to = e.from;
        e.travel = Math.min(e.travel ?? 0, Math.max(0, e.end - e.start));
        e.roomId = map.rooms.find(room => roomContainsPoint(room, e.to.x, e.to.y))?.id ?? "";
      }
      errors.push(`${track.name} / ${a.name}: ${e.reason}`);
      for (const [zone, list] of reservations) reservations.set(zone, list.filter(r =>
        r.actionId !== a.id || r.start < e.end).map(r =>
        r.actionId === a.id ? { ...r, end: Math.min(r.end, e.end) } : r));
    }
    if (a.type === "move") {
      if (e.outcome === "success") for (const occupant of initialOccupants.filter(t =>
        t.trackId === track.id && !t.released)) {
        const cell = (17 - Math.floor(e.to.y / 50)) * 32 + Math.floor(e.to.x / 50);
        if (safety.cellZones.get(cell) !== occupant.zone) occupant.released = true;
      }
      latest.set(track.id, e);
      log.push({ at: e.end - (!fixedTimeline && e.outcome === "success" ? a.dwell : 0), kind: "arrival", entry: e });
    }
    log.push({ at: e.start, kind: "start", entry: e });
    if (e.outcome === "success") log.push({ at: e.end, kind: "complete", entry: e });
  }
  for (const e of entries) if (e.start === null) {
    e.blocked = true;
    e.reason ||= e.resourceReason || "待ち条件が成立しません。参照先と行の除外設定を確認してください。";
    warnings.push({ code: "blocked", actionId: e.action.id, trackIds: [e.track.id],
      message: `${e.track.name} / ${e.action.name}: ${e.reason}` });
  }
  for (const e of entries) {
    const references = [...(e.action.trigger?.sources ?? [])];
    if (previous.has(e.action.id)) references.push({ actionId: previous.get(e.action.id), event: "complete", delay: 0 });
    e.waitConditions = references.filter(r => r.actionId !== "$start").map(r => {
      const other = byId.get(r.actionId);
      return { name: `${other?.track.name ?? "不明な行"} / ${other?.action.name ?? "不明な項目"}`,
        at: other ? (r.event === "start" ? other.start : other.end) === null ? null :
          (r.event === "start" ? other.start : other.end) + r.delay : null };
    });
  }
  const priority = { start: 0, arrival: 1, complete: 2 };
  const index = new Map();
  for (const event of log) if (!index.has(event.entry)) index.set(event.entry, index.size);
  log.sort((a, b) => a.at - b.at || index.get(a.entry) - index.get(b.entry) ||
    priority[a.kind] - priority[b.kind]);
  const duration = Math.max(0, ...entries.map(e => e.end ?? 0));
  const trajectories = map.tracks.filter(t => t.initial && !t.muted).map(t => {
    let from = t.initial, cursor = 0;
    const segments = [];
    for (const e of entries.filter(e => e.track.id === t.id && e.action.type === "move" &&
      e.start !== null).sort((a, b) => a.start - b.start)) {
      if (e.start > cursor) segments.push({ start: cursor, end: e.start, from, to: from });
      segments.push(...e.segments);
      const travelEnd = e.segments.at(-1)?.end ?? e.end;
      if (e.end > travelEnd) segments.push({ start: travelEnd, end: e.end, from: e.to, to: e.to });
      cursor = e.end; from = e.to;
    }
    segments.push({ start: cursor, end: Math.max(cursor, duration) + .001, from, to: from });
    return { id: t.id, name: t.name, kind: t.kind,
      ...(t.kind === "robot" ? { radius: safety.robotRadius } : {}), segments };
  });
  const stopped = [];
  for (const t of trajectories.filter(t => t.kind === "robot")) for (const s of t.segments) {
    if (s.from.x !== s.to.x || s.from.y !== s.to.y) continue;
    const cell = (17 - Math.floor(s.from.y / 50)) * 32 + Math.floor(s.from.x / 50);
    const zone = safety.cellZones.get(cell);
    if (zone) stopped.push({ zone, trackId: t.id, name: t.name, start: s.start,
      end: s.end >= duration ? Infinity : s.end });
  }
  const signature = list => JSON.stringify(list.map(r => [r.zone, r.trackId,
    Math.round(r.start * 1e6), Number.isFinite(r.end) ? Math.round(r.end * 1e6) : "forever"]));
  if (signature(stopped) !== signature(stationary)) {
    if (iteration < Math.min(32, entries.length + 2)) return compileTimedPlan(map, stopped, iteration + 1, fixedTimeline);
    errors.push("廊下の待機計画が収束しません。相互待ちを解消するため開始時刻・退出先を調整してください。");
    // 成立しなかった計画の完了時刻で、表示や後続だけが実行されることも防ぐ。
    for (const e of entries) {
      e.blocked = true; e.reason = "廊下の相互待ちが収束しないためマップ全体の実行を停止しました。";
      e.start = null; e.end = null; e.outcome = null; e.segments = []; e.waits = [];
    }
    return { map, entries, log: [], errors, warnings: [], duration: 0, fixedTimeline };
  }
  warnings.push(...collisionWarnings(trajectories));
  return { map, entries, log, errors, warnings, duration, fixedTimeline };
}
