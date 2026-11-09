import { projectForSave, compilePlan, orderedActions } from "./model.js";
import { exportScenario } from "./scenario-export.js";

export function createFleetBundle(project) {
  const saved = projectForSave(project);
  return {
    schema: "scene-fleet-bundle/v1",
    bundle_id: crypto.randomUUID(),
    simulation_only: true,
    hardware_approved: false,
    project_name: saved.name,
    index_base: 1,
    coordinates: {
      map: "1600x900; origin=bottom-left; x=right; y=up",
      robot_initial_and_sequence: "1600x900; yaw_degrees=counterclockwise; zero=+X",
      scenario_draft_positions: "percent; x=right; y=up",
      navigation: "1600x900; x=right; y=up; cell-index=top-left",
      source_independent_wall_segments: "1600x900; origin=top-left; y=down",
    },
    scenarios: saved.maps.map((map, offset) => {
      if (map.executionMode !== "timed" || !map.timelineOnly) {
        throw new Error(`index ${offset + 1}「${map.name}」を時間軸方式へ変換してください。`);
      }
      const plan = compilePlan(map, { fixedTimeline: true });
      const errors = [...plan.errors, ...plan.entries.filter(entry => entry.blocked)
        .map(entry => `${entry.track.name} / ${entry.action.name}: ${entry.reason}`)];
      const draft = errors.length ? null : exportScenario(map);
      const position = point => ({ x: point.x, y: point.y, yaw_deg: point.yaw });
      return {
        index: offset + 1, map_id: map.id, name: map.name,
        duration_s: Math.max(0, ...map.tracks.filter(track => !track.muted)
          .flatMap(track => track.actions.map(action => action.position + action.runSeconds))),
        executable: !errors.length,
        validation: { errors, warnings: (plan.warnings ?? []).map(warning => warning.message) },
        map,
        navigation: map.navigation,
        robots: map.tracks.filter(track => track.kind === "robot" && !track.muted).map(track => ({
          track_id: track.id, robot_id: track.robotId, name: track.name,
          role: track.robotRole ?? "cleaning", initial: structuredClone(track.initial),
          sequence: orderedActions(track).map(action => {
            const entry = plan.entries.find(entry => entry.action.id === action.id);
            return {
              action_id: action.id, track_id: track.id, robot_id: track.robotId, name: action.name,
              type: action.motion === "rotate" ? "rotate" : action.type,
              start_s: action.position, end_s: action.position + action.runSeconds,
              executable: !!entry && !entry.blocked && !errors.length,
              ...(entry?.reason ? { reason: entry.reason } : {}),
              ...(action.type === "move" && entry?.from ? { from: position(entry.from) } : {}),
              ...(action.type === "move" ? { to: position(action) } : {}),
              ...(action.roomId ? { room_id: action.roomId } : {}),
              ...(action.doorId ? { door_id: action.doorId } : {}),
              ...(action.type === "event-start" ? { event: action.state } : {}),
              ...(action.text ? { text: action.text } : {}),
              raw_action: structuredClone(action),
            };
          }),
        })),
        scenario_draft: draft,
      };
    }),
  };
}
