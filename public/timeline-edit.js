const duration = action => action.runSeconds ?? action.plannedDuration ?? 6;

export function checkSequence(track) {
  const actions = [...track.actions].sort((a, b) => a.position - b.position);
  let end = 0;
  for (const action of actions) {
    if (!Number.isFinite(action.position) || action.position < 0 ||
      !Number.isFinite(duration(action)) || duration(action) < 0 ||
      duration(action) > (action.runSeconds === undefined ? 3600 : 86400)) {
      throw new Error(`${track.name} / ${action.name}: 開始時刻・秒数が不正です。`);
    }
    if (action.position < end - 1e-7) {
      throw new Error(`${track.name} / ${action.name}: 同じ行のバーが重なっています。`);
    }
    end = action.position + duration(action);
  }
}

export function adjustTimeline(map, actionIds, offset, durationOffset = 0) {
  if (!actionIds.length || !Number.isFinite(offset) || !Number.isFinite(durationOffset)) {
    throw new Error("調整するブロックと有限の秒数を指定してください。");
  }
  const result = structuredClone(map), ids = new Set(actionIds), found = new Set();
  for (const track of result.tracks) {
    const actions = track.actions.filter(action => ids.has(action.id));
    if (!actions.length) continue;
    if (track.locked) throw new Error(`${track.name} は編集ロック中です。`);
    for (const action of actions) {
      found.add(action.id);
      action.position = Math.round((action.position + offset) * 1e6) / 1e6;
      if (durationOffset) {
        const seconds = duration(action) + durationOffset;
        if (seconds < .1) throw new Error("調整後の秒数は0.1秒以上にしてください。");
        action[result.executionMode === "timed" ? "runSeconds" : "plannedDuration"] = seconds;
        if (action.motion === "rotate") action.rotationSeconds = seconds;
      }
    }
    checkSequence(track);
  }
  if (found.size !== ids.size) throw new Error("選択したブロックが見つかりません。選び直してください。");
  return result;
}

export function reorderSequence(track, actionId, direction) {
  if (track.locked) throw new Error("この行はロックされています。");
  const actions = [...track.actions].sort((a, b) => a.position - b.position);
  const index = actions.findIndex(action => action.id === actionId), other = index + direction;
  if (index < 0) throw new Error("入れ替えるブロックがありません。");
  if (other < 0 || other >= actions.length) throw new Error("これ以上移動できません。");
  const left = Math.min(index, other), right = Math.max(index, other);
  const start = actions[left].position;
  const gap = Math.max(0, actions[right].position - start - duration(actions[left]));
  [actions[left], actions[right]] = [actions[right], actions[left]];
  actions[left].position = start;
  actions[right].position = start + duration(actions[left]) + gap;
  track.actions = actions;
  checkSequence(track);
}
