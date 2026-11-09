import { compilePlan } from "./model.js";
import { buildNavigation } from "./floor-plan.js";

export function exportScenario(map) {
  const plan = compilePlan(map, { fixedTimeline: true });
  if (plan.errors.length) throw new Error(`実行不可の動作を修正してから出力してください：${plan.errors.join(" / ")}`);
  const position = point => point ? { x: point.x / 16, y: point.y / 9, yaw_deg: point.yaw } : null;
  return {
    schema: "scene-scenario-draft/v1", simulation_only: true, hardware_approved: false,
    map_id: map.id, name: map.name, duration_s: plan.duration,
    coordinates: { unit: "percent", x: "right", y: "up", yaw_zero: "+X",
      yaw_positive: "counterclockwise", yaw_range: "(-180,180]" },
    door_mode: map.doorMode ?? "strict",
    warnings: (plan.warnings ?? []).map(w => w.message),
    robots: map.tracks.filter(t => t.kind === "robot" && !t.muted).map(t => ({
      track_id: t.id, robot_id: t.robotId, name: t.name, role: t.robotRole ?? "cleaning",
      initial: position(t.initial),
    })),
    actions: plan.entries.filter(e => !e.blocked && e.start !== null).map(e => ({
      action_id: e.action.id, track_id: e.track.id, name: e.action.name,
      type: e.action.motion === "rotate" ? "rotate" : e.action.type,
      start_s: e.start, end_s: e.end,
      ...(e.track.kind === "robot" ? { robot_id: e.track.robotId } : {}),
      ...(e.action.type === "move" ? { from: position(e.from), to: position(e.to) } : {}),
      ...(e.action.roomId ? { room_id: e.action.roomId } : {}),
      ...(e.action.doorId ? { door_id: e.action.doorId } : {}),
      ...(e.action.type === "event-start" ? { event: e.action.state } : {}),
      ...(e.action.text ? { text: e.action.text } : {}),
    })),
    navigation: buildNavigation(map),
    integration_required: ["robot-id-mapping", "field-coordinate-transform", "execution-ownership",
      "completion-and-delay-policy", "stop-resume-policy", "hardware-safety-approval"],
  };
}
