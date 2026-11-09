import { uid, clone, clamp, COLORS, KINDS, createProject, validateProject, newTrack,
  newAction, formatTime, projectForSave, actionPreview as modelActionPreview, ARRIVAL_DEFAULTS,
  DISPLAY_TEMPLATES, HATCH_STYLES, orderedActions, enableTimedMap, compilePlan, samplePlan, copyMapLayout, useTimelineOnly, timelineAlignment, addFacingTurns } from "./model.js";
import { editMap } from "./map-editor.js";
import { renderFloorPlan, roomAnchor, roomContainsPoint, ROBOT_SIDE, updateAutomaticDoors } from "./floor-plan.js";
import { snapPoint, coordinatePoint, createSafety as modelSafety, pathProblem, ROBOT_RADIUS, HUMAN_RADIUS } from "./safety.js";
import { createAutosave } from "./autosave.js";
import { createHistoryClient } from "./history-client.js";
import { adjustTimeline, checkSequence, reorderSequence } from "./timeline-edit.js";
import { exportScenario } from "./scenario-export.js";
import { SCENARIO_LIBRARY, createLibraryScenario } from "./scenario-library.js";
import { renderPresentation } from "./scenario-presentation.js";
import { createFleetDemoMap, createOfficeDemoMap, createCoordinationDemoMap, replaceOldDemoMaps, refreshDemoScenarios } from "./demo-map.js";

const $ = id => document.getElementById(id), NS = "http://www.w3.org/2000/svg";
const TYPES = { move: "移動", show: "表示", hide: "表示を消去", "event-start": "イベント発生", "event-end": "イベント終了", unlock: "ドア解錠", wait: "待機" };
const ICONS = { robot: "↗", human: "♙", room: "▧", display: "T" };
const ROBOT_ROLES = [["cleaning", "清掃"], ["security", "警備"], ["delivery", "配送"]];
const FLEET_DEMO_NAME = "テストマップ";
const STORE = "robot-scene-studio.v4";
function freshProject() {
  const p = createProject({ ordered: true });
  p.maps = createFleetDemoMap().maps;
  p.maps[0].name = FLEET_DEMO_NAME;
  p.facingTurns = true;
  for (const m of p.maps) { m.facingTurns = true; addFacingTurns(m); }
  p.schema = "robot-scene/v4"; return useTimelineOnly(p);
}
let project = freshProject(), mapId = project.maps[0].id, selection = {}, time = 0;
let selectedBlocks = new Set(), placementTrack = null;
let running = false, looping = false, speed = 1, last = 0, px = 26, snapping = true;
let undo = [], redo = [], dirty = true, timer, draft = null, dragging = false;
let bgCache, scale = 1;
let runtimeError = "";
let floorCache;
let focusMap, focusKey = "";
let renderedMap, roomStamp = "", displayStamp = "", pathStamp = "";
let paletteDragType = null, paletteDragKind = null, dropCache = null;
const plans = new WeakMap();
const createSafety = m => modelSafety(m, { robotSide: ROBOT_SIDE });
const actionPreview = (m, trackId, action) =>
  modelActionPreview(m, trackId, action, { fixedTimeline: true });
function planFor(m) {
  if (!plans.has(m)) plans.set(m, compilePlan(m, { fixedTimeline: true }));
  return plans.get(m);
}
function previewState(m, at) { return samplePlan(planFor(m), at); }
const autosave = createAutosave(localStorage, STORE, message => {
  $("storageStatus").textContent = "AUTOSAVE CONFLICT"; notify(message, true);
}, navigator.locks);
const durableHistory = createHistoryClient(localStorage, (message, error) => {
  $("historyStatus").textContent = message;
  if (error) notify(message, true);
});
window.addEventListener("storage", e => {
  if (e.key === STORE || e.key === null) autosave.changed();
});
const map = () => project.maps.find(m => m.id === mapId);
const selectedTrack = () => map().tracks.find(t => t.id === selection.track);
const selectedAction = () => selectedTrack()?.actions.find(a => a.id === selection.action);
const entries = m => m.tracks.flatMap(t => t.actions.map(a => ({ t, a })));
const plannedDuration = a => a.runSeconds ?? a.plannedDuration ?? 6;
const actionWidth = a => plannedDuration(a) === 0 ? 12 : plannedDuration(a) * px;
function node(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  children.forEach(c => n.append(c)); return n;
}
function editInitial(track) {
    if (track.locked) throw new Error("この行はロックされています。");
    pause();
    const initial = clone(track.initial);
    const dialog = node("dialog", { class: "action-dialog", "aria-label": "初期位置を設定" });
    const form = node("form"), content = node("div");
    const close = () => { dialog.close(); dialog.remove(); };
    const error = node("p", { role: "alert" });
    const apply = node("button", { type: "submit", class: "primary", text: "適用" });
    const validateInitial = () => {
      const problem = pathProblem(createSafety(map()), initial, initial, track.kind);
      error.textContent = problem;
      apply.disabled = !!problem;
      return problem;
    };
    const renderInitial = () => {
      content.replaceChildren(
        node("h2", { text: `${track.name} · 初期位置を設定` }),
        node("p", { class: "help", text: "シーケンス開始前の位置・向きです。時間軸のアクションではありません。" }),
        node("p", { text: `X ${initial.x} / Y ${initial.y} · ${map().rooms.find(r => r.id === initial.roomId)?.name ?? "室外"}` }),
        button("MAPで初期位置を指定", () => openCoordinatePicker(initial, renderInitial)),
        field("初期の向き yaw", initial.yaw, v => { initial.yaw = v; }, "number",
          { min: -180, max: 180, step: 1 }),
      );
      validateInitial();
    };
    form.append(content, error, node("div", { class: "dialog-actions" }, [
      button("キャンセル", close), apply,
    ]));
    form.addEventListener("submit", event => {
      event.preventDefault();
      try {
        const problem = validateInitial();
        if (problem) throw new Error(problem);
        commit((p, m) => { m.tracks.find(t => t.id === track.id).initial = clone(initial); },
          "初期位置を設定しました。");
        close();
      } catch (e) { error.textContent = e.message; }
    });
    dialog.addEventListener("cancel", e => { e.preventDefault(); close(); });
    dialog.append(form); document.body.append(dialog); renderInitial(); dialog.showModal();
  }
function shape(tag, attrs = {}, children = []) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) k === "text" ? n.textContent = v : n.setAttribute(k, v);
  children.forEach(c => n.append(c)); return n;
}
function notify(text, error = false) { $("notice").textContent = text; $("notice").className = error ? "error" : ""; }
function resultText(result) {
  const label = { pending: "実行待ち", running: "実行中", success: "成功", failed: "失敗",
    timeout: "タイムアウト", blocked: "停止" }[result.status];
  const point = result.simulatedPosition;
  return `模擬結果：${label}\n経過 ${result.elapsedSeconds.toFixed(2)}秒 / 事前待ち ${result.waitingSeconds.toFixed(2)}秒\n` +
    `模擬位置：${point ? `X ${point.x.toFixed(1)} / Y ${point.y.toFixed(1)} / ${point.yaw.toFixed(1)}°` : "未実行"}\n` +
    `実測位置：未取得（実機未接続）${result.reason ? `\n${result.reason}` : ""}`;
}
const safe = fn => async (...args) => { try { await fn(...args); } catch (e) { notify(e.message, true); } };
function validateEdit(p) {
  validateProject(p);
  const m = p.maps.find(item => item.id === mapId);
  if (m?.executionMode === "timed") {
    const safety = createSafety(m);
    const original = map(), previousPlan = original.executionMode === "timed" ? planFor(original) : null;
    for (const track of m.tracks.filter(t => t.initial)) {
      const problem = pathProblem(safety, track.initial, track.initial, track.kind);
      const before = original.tracks.find(t => t.id === track.id);
      if (problem && (!before || original.executionMode !== "timed" ||
        JSON.stringify(before.initial) !== JSON.stringify(track.initial) ||
        !pathProblem(createSafety(original), before.initial, before.initial, before.kind))) {
        throw new Error(`${track.name} の初期位置: ${problem}`);
      }
    }
    const invalid = planFor(m).entries.find(e => e.geometryFailure && !previousPlan?.entries.some(old =>
      old.geometryFailure && old.action.id === e.action.id && old.reason === e.reason &&
      JSON.stringify([old.from.x, old.from.y, old.action.x, old.action.y]) ===
        JSON.stringify([e.from.x, e.from.y, e.action.x, e.action.y])));
    if (invalid) throw new Error(`${invalid.track.name} / ${invalid.action.name}: ${invalid.reason}`);
    for (const track of m.tracks) for (const action of track.actions.filter(a => a.type === "move")) {
      const before = original.tracks.find(t => t.id === track.id)?.actions.find(a => a.id === action.id);
      if (before && JSON.stringify(before) === JSON.stringify(action)) continue;
      const problem = actionPreview(m, track.id, action).geometryProblem;
      if (problem) throw new Error(`${track.name} / ${action.name}: ${problem}`);
    }
  }
}
function commit(edit, message = "変更しました。") {
  const p = clone(project);
  edit(p, p.maps.find(item => item.id === mapId));
  useTimelineOnly(p);
  for (const m of p.maps) if (p.facingTurns || m.facingTurns) {
    m.facingTurns = true; addFacingTurns(m);
  }
  if (p.maps.some(m => m.executionMode === "timed")) p.schema = "robot-scene/v4";
  else if (p.maps.some(m => m.executionMode === "ordered")) p.schema = "robot-scene/v3";
  validateEdit(p);
  durableHistory.record(projectForSave(p), message);
  undo.push(project); if (undo.length > 40) undo.shift(); redo = [];
  project = p; if (!project.maps.some(m => m.id === mapId)) mapId = project.maps[0].id;
  dirty = true; persistLocal(); render();
  if (runtimeError) notify(`実行できない動作があります：${runtimeError}`, true);
  else notify(message);
}
function persistLocal() {
  clearTimeout(timer); timer = setTimeout(async () => {
    try { await autosave.save(projectForSave(project)); $("storageStatus").textContent = "LOCAL AUTOSAVE · OK"; }
    catch (e) { $("storageStatus").textContent = "AUTOSAVE FAILED"; notify(`自動保存失敗：${e.message}。JSON保存してください。`, true); }
  }, 350);
}
function pause() { running = false; $("play").textContent = "▶"; $("play").setAttribute("aria-label", "再生"); }
function choose(track, action) {
  selection = { track, action }; selectedBlocks = new Set(action ? [action] : []); render();
}
function revealSelection() {
  const scroller = $("timelineScroll");
  const lane = [...$("lanes").children].find(n => n.dataset.track === selection.track);
  if (!lane) return;
  const viewport = scroller.getBoundingClientRect(), bounds = lane.getBoundingClientRect();
  const top = viewport.top + scroller.clientTop + $("ruler").offsetHeight;
  const bottom = viewport.top + scroller.clientTop + scroller.clientHeight;
  if (bounds.top < top) scroller.scrollTop += bounds.top - top;
  else if (bounds.bottom > bottom) scroller.scrollTop += bounds.bottom - bottom;
  const card = [...lane.children].find(n => n.dataset.action === selection.action);
  if (card) {
    const rect = card.getBoundingClientRect(), left = viewport.left + scroller.clientLeft;
    if (rect.left < left + 12) scroller.scrollLeft += rect.left - left - 12;
    else if (rect.right > left + scroller.clientWidth - 12)
      scroller.scrollLeft += rect.right - left - scroller.clientWidth + 12;
  }
  $("trackLabels").scrollTop = scroller.scrollTop;
}
function selectRoom(id) {
  const tracks = map().tracks.filter(t => t.kind === "room" && t.roomId === id);
  const track = tracks.find(t => t.id === selection.track) ?? tracks[0];
  selection = { room: id, track: track?.id }; render(); revealSelection();
  if (!track) notify("この部屋にはまだ行がありません。右側の「部屋の行を追加」で追加できます。");
}
function quantize(v) { return Math.max(0, Math.round(v / (snapping ? .5 : .1)) * (snapping ? .5 : .1)); }
function button(text, fn, cls = "") { return node("button", { type: "button", text, class: cls, onclick: safe(fn) }); }
function field(label, value, update, type = "text", attrs = {}) {
  const input = node(type === "textarea" ? "textarea" : "input", { ...attrs });
  if (type !== "textarea") input.type = type;
  input.value = value ?? "";
  input.addEventListener("change", safe(() => {
    try { update(type === "number" ? (input.value.trim() ? Number(input.value) : NaN) : input.value); }
    catch (e) { input.value = value ?? ""; throw e; }
  }));
  return node("label", { class: "field", text: label }, [input]);
}
function select(label, value, options, update) {
  const s = node("select"); s.append(...options.map(([v, name]) => node("option", { value: v, text: name })));
  s.value = value; s.onchange = safe(() => update(s.value));
  return node("label", { class: "field", text: label }, [s]);
}
const row = (...children) => node("div", { class: "field-row" }, children);
function section(title, ...children) { return node("div", { class: "inspector-section" }, [node("div", { class: "eyebrow", text: title }), ...children]); }
async function confirm(title, message) {
  pause(); $("confirmTitle").textContent = title; $("confirmMessage").textContent = message;
  const d = $("confirmDialog"); d.returnValue = "cancel"; d.showModal();
  return new Promise(resolve => d.addEventListener("close", () => resolve(d.returnValue === "ok"), { once: true }));
}
function render() {
  $("projectName").value = project.name;
  $("saveState").textContent = dirty ? "● 未保存の変更" : "JSON保存操作済み";
  $("saveState").classList.toggle("dirty", dirty); $("undo").disabled = !undo.length; $("redo").disabled = !redo.length;
  const tabs = $("mapTabs"), stamp = JSON.stringify(project.maps.map(m => [m.id, m.name]));
  if (tabs.dataset.stamp !== stamp) {
    tabs.dataset.stamp = stamp;
    tabs.replaceChildren(...project.maps.map(m => {
      const tab = button(m.name, e => {
        if (e.target.closest("input") || mapId === m.id) return;
        pause(); mapId = m.id; selection = {}; time = 0; render();
      }, "map-tab");
      tab.dataset.map = m.id; tab.title = "ダブルクリックで名前を編集";
      tab.ondblclick = e => { if (!e.target.closest("input")) renameMap(m.id); };
      tab.setAttribute("role", "tab"); return tab;
    }));
  }
  [...tabs.children].forEach((n, i) => {
    n.classList.toggle("active", project.maps[i].id === mapId);
    n.setAttribute("aria-selected", project.maps[i].id === mapId);
  });
  $("floorInfo").textContent = map().floorPlan ? `32 × 18 GRID · ${map().rooms.length} エリア` :
    map().background?.name ?? "マップ編集で部屋・廊下を作成してください";
  $("opacity").value = map().background?.opacity ?? .7; $("opacity").disabled = !map().background;
  $("removeFloor").disabled = !map().background;
  $("opacity").closest("label").hidden = !map().background;
  $("removeFloor").hidden = !map().background;
  $("roomList").replaceChildren(...map().rooms.map(r => button(`▧ ${r.name}`, () => selectRoom(r.id), "asset-item")));
  $("objectList").replaceChildren(...map().tracks.filter(t => ["robot", "human"].includes(t.kind))
    .map(t => button(`${ICONS[t.kind]} ${t.name}${t.kind === "human" ? ` · ${t.count}人` : ` · ID${t.robotId}`}`, () => choose(t.id), "asset-item")));
  renderTimeline(); renderInspector(); preview();
}
function renameMap(id) {
  const tab = [...$("mapTabs").children].find(n => n.dataset.map === id);
  const current = project.maps.find(m => m.id === id);
  if (!tab || !current || tab.querySelector("input")) return;
  pause();
  const input = node("input", { class: "map-name-input", maxlength: 120, "aria-label": "タブ名" });
  input.value = current.name;
  let finished = false;
  const finish = cancelled => {
    if (finished) return;
    const name = input.value.trim();
    if (!cancelled && !name) { notify("タブ名を入力してください。", true); input.focus(); return; }
    finished = true;
    $("mapTabs").dataset.stamp = "";
    if (!cancelled && name !== current.name)
      safe(() => commit(p => { p.maps.find(m => m.id === id).name = name; }, "タブ名を変更しました。"))();
    else render();
  };
  input.addEventListener("keydown", e => {
    e.stopPropagation();
    if (e.key === "Enter" || e.key === "Escape") { e.preventDefault(); finish(e.key === "Escape"); }
  });
  input.addEventListener("blur", () => finish(false));
  tab.replaceChildren(input); input.focus(); input.select();
}

function showTimelineAlignment(match) {
  $("timelineAlignment")?.remove();
  if (!match) return;
  $("timelineCanvas").append(node("div", {
    id: "timelineAlignment", class: "timeline-alignment",
    style: `left:${16 + match.time * px}px`, "data-time": match.time,
  }, [node("span", { text: `${match.time.toFixed(2)}s · ${match.name}` })]));
}

function timelinePointerDrag(event, element, update, finish) {
  let x = event.clientX, shifted = event.shiftKey, moved = false, finished = false;
  dragging = true; element.setPointerCapture(event.pointerId);
  const draw = () => update(x, shifted);
  const move = e => {
    if (e.pointerId !== event.pointerId) return;
    x = e.clientX; shifted = e.shiftKey;
    if (!moved && Math.abs(x - event.clientX) < 3) return;
    moved = true; draw();
  };
  const end = cancelled => {
    if (finished) return;
    finished = true;
    element.removeEventListener("pointermove", move);
    element.removeEventListener("pointerup", up);
    element.removeEventListener("pointercancel", cancel);
    element.removeEventListener("lostpointercapture", cancel);
    document.removeEventListener("keydown", key);
    document.removeEventListener("keyup", key);
    window.removeEventListener("blur", cancel);
    if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
    dragging = false; showTimelineAlignment(null); finish(cancelled, moved);
  };
  const up = e => {
    if (e.pointerId !== event.pointerId) return;
    if (moved) { x = e.clientX; shifted = e.shiftKey; draw(); }
    end(false);
  };
  const cancel = () => end(true);
  const key = e => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); end(true); }
    else if (e.key === "Shift") { shifted = e.shiftKey; if (moved) draw(); }
  };
  element.addEventListener("pointermove", move);
  element.addEventListener("pointerup", up);
  element.addEventListener("pointercancel", cancel);
  element.addEventListener("lostpointercapture", cancel);
  document.addEventListener("keydown", key);
  document.addEventListener("keyup", key);
  window.addEventListener("blur", cancel);
}
function horizon() {
  const state = previewState(map(), time);
  return Math.min(7200, Math.max(30,
    ...entries(map()).map(({ a }) => a.position + plannedDuration(a) + 4),
    Math.min(3600, state.duration + 8)));
}
function renderTimeline() {
  const m = map(), width = Math.max(horizon() * px + 160, $("timelineScroll").clientWidth);
  const available = new Set(entries(m).map(({ a }) => a.id));
  selectedBlocks = new Set([...selectedBlocks].filter(id => available.has(id)));
  renderSelectionTools();
  $("doorMode").value = m.doorMode ?? "story";
  $("zoom").value = px;
  $("timelineCanvas").style.width = `${width}px`; $("timelineCanvas").style.setProperty("--grid-width", `${px * 5}px`);
  const timed = m.executionMode === "timed", ordered = timed || m.executionMode === "ordered";
  $("trackCount").textContent = `${m.tracks.length} TRACKS · ${timed ? "秒数で実行" : ordered ? "左→右に順序実行" : "旧トリガー方式"}`;
  $("executionMode").hidden = timed;
  document.querySelector(".timeline-footer").textContent = timed ?
    "左端＝開始 · 右端＝終了 · 幅＝実行時間 · 行内の重複はエラー" : ordered ?
    "左→右に実行 · 前の動作が完了してから次へ · 空白は待機時間ではありません · ✓で追加の待ち条件" :
    "旧方式：横軸は予定位置 · 順序実行へ切替で左→右に実行 · ✓で完了接続";
  const ticks = [], step = px < 30 ? 5 : 2;
  for (let t = 0; t <= width / px; t += step) ticks.push(node("span", { class: "tick", style: `left:${t * px + 16}px`, text: `${t}s` }));
  $("ruler").replaceChildren(...ticks);
  const state = previewState(m, time);
  $("trackLabels").replaceChildren(...m.tracks.map(t => {
    const label = node("div", { class: `track-label${selection.track === t.id ? " selected" : ""}`, style: `--color:${t.color}`,
      onclick: () => choose(t.id),
      ondblclick: safe(e => { if (!e.target.closest("button")) openSequenceEditor(t.id); }),
      draggable: true, "data-track": t.id,
      ondragstart: e => {
        e.dataTransfer.setData("application/x-scene-reorder", t.id);
        e.dataTransfer.effectAllowed = "move";
      },
      ondragover: e => { if ([...e.dataTransfer.types].includes("application/x-scene-reorder")) e.preventDefault(); },
      ondrop: safe(e => {
        const source = e.dataTransfer.getData("application/x-scene-reorder");
        if (!source) return;
        e.preventDefault();
        commit((p, m) => {
          const from = m.tracks.findIndex(track => track.id === source);
          const to = m.tracks.findIndex(track => track.id === t.id);
          if (from < 0 || to < 0) throw new Error("移動元の行がありません。");
          if (m.tracks[from].locked || m.tracks[to].locked) throw new Error("ロック中の行は移動できません。");
          m.tracks.splice(to, 0, m.tracks.splice(from, 1)[0]);
        }, "行の並びを変更しました。実行時刻は変更しません。");
      }) }, [
      node("span", { class: "track-icon", text: ICONS[t.kind] }),
      node("div", { class: "track-description" }, [node("strong", { text: t.name }), node("small", { text: t.kind === "human" ? `${t.count}人 / GROUP` : KINDS[t.kind] })]),
    ]);
    const flags = node("div", { class: "track-flags" });
    for (const [key, name] of [["muted", "除外"], ["locked", "固定"]]) {
      const b = button(name, e => {
        e.stopPropagation(); commit((p, m) => { m.tracks.find(x => x.id === t.id)[key] = !t[key]; });
      }, t[key] ? "active" : "");
      const label = `${t.name} ${key === "muted" ? "プレビュー除外" : "編集ロック"}`;
      b.title = label; b.setAttribute("aria-label", label); b.setAttribute("aria-pressed", t[key]); flags.append(b);
    }
    label.append(flags); return label;
  }));
  $("lanes").replaceChildren(...m.tracks.map(t => {
    const sequence = new Map(orderedActions(t).map((a, index) => [a.id, index + 1]));
    const lane = node("div", { class: `lane${t.muted ? " muted" : ""}${selection.track === t.id ? " selected" : ""}`, "data-track": t.id });
    lane.addEventListener("dragover", e => showDropPreview(e, t, lane));
    lane.addEventListener("dragleave", e => { if (!lane.contains(e.relatedTarget)) clearDropPreview(); });
    lane.addEventListener("drop", safe(e => {
      e.preventDefault();
      const candidate = dropCandidate(e, t, lane);
      clearDropPreview();
      if (!candidate) return;
      if (candidate.reason) throw new Error(candidate.reason);
      openAction(t.id, null, candidate.type, candidate.overrides);
    }));
    lane.addEventListener("dblclick", safe(e => {
      if (e.target === lane) openAction(t.id, null, ["robot", "human"].includes(t.kind) ? "move" : t.kind === "room" ? "event-start" : "show",
        { position: quantize((e.clientX - lane.getBoundingClientRect().left - 16) / px) });
    }));
    for (const a of t.actions) {
      const status = state.actionStates[a.id]?.status ?? "waiting";
      const card = node("div", { class: `action-node ${status}${actionWidth(a) < 2 ? " hairline" : ""}${selectedBlocks.has(a.id) ? " selected" : ""}`,
        "data-action": a.id, tabindex: 0, role: "button", "aria-label": a.name,
        "aria-pressed": String(selectedBlocks.has(a.id)),
        style: `left:${a.position * px + 16}px;width:${actionWidth(a)}px;--color:${t.color}`,
        ondblclick: safe(e => { e.stopPropagation(); if (!e.target.closest(".duration-handle")) openAction(t.id, a.id); }),
        onkeydown: safe(e => { if (e.key === "Enter") openAction(t.id, a.id); }),
        onpointerdown: e => moveNode(e, t, a) }, [
        node("strong", { text: `${ordered ? `${sequence.get(a.id)}. ` : ""}${a.name}` }),
        node("small", { text: `${a.motion === "rotate" ? "向き変更" : TYPES[a.type]} · ${a.position.toFixed(1)}〜${(a.position + plannedDuration(a)).toFixed(1)}秒` }),
        node("span", { class: "duration-label", text: `${timed ? "" : "目安 "}${plannedDuration(a)}s` }),
        node("span", { class: "duration-handle", title: timed ? "ドラッグで実行秒数を変更" : "ドラッグで目安の実行時間を変更（実行条件は不変）",
          role: "slider", tabindex: 0, "aria-label": `${a.name} 目安の実行時間`,
          "aria-valuemin": .5, "aria-valuemax": 3600, "aria-valuenow": plannedDuration(a),
          onpointerdown: e => resizeAction(e, t, a),
          onkeydown: safe(e => {
            if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
            e.preventDefault(); e.stopPropagation();
            if (t.locked) throw new Error("この行はロックされています。");
            commit((p, m) => { m.tracks.find(v => v.id === t.id).actions.find(v => v.id === a.id)[timed ? "runSeconds" : "plannedDuration"] =
              clamp(plannedDuration(a) + (e.key === "ArrowRight" ? .5 : -.5), .5, 3600); });
          }) }),
      ]);
      lane.append(card);
      if (timed) {
        const actual = state.actionStates[a.id];
        card.title = `${a.name} / 予定 ${a.position.toFixed(2)}秒 / 実行 ${actual.start?.toFixed(2) ?? "不可"}〜${actual.end?.toFixed(2) ?? "不可"}秒`;
        if (actual.start !== null && actual.start > a.position + .001) lane.append(node("span", {
          class: "actual-timing", style: `left:${actual.start * px + 16}px;width:${Math.max(3, (actual.end - actual.start) * px)}px`,
          text: `実 ${actual.start.toFixed(1)}s`, title: card.title,
        }));
      }
    }
    return lane;
  }));
  $("playhead").style.height = `${35 + m.tracks.length * 72}px`;
  document.querySelector(".track-sidebar").style.paddingBottom = `${$("timelineScroll").offsetHeight - $("timelineScroll").clientHeight}px`;
  $("trackLabels").scrollTop = $("timelineScroll").scrollTop;
  playhead();
}
function moveNode(e, t, a) {
  if (e.target.closest(".duration-handle")) return;
  if (e.button !== 0) return;
  pause();
  if (e.ctrlKey || e.metaKey) {
    if (selectedBlocks.has(a.id)) selectedBlocks.delete(a.id); else selectedBlocks.add(a.id);
    selection = { track: t.id, action: a.id }; render(); return;
  }
  if (e.shiftKey && selection.track === t.id && selection.action && !selectedBlocks.has(a.id)) {
    const ordered = orderedActions(t), first = ordered.findIndex(item => item.id === selection.action);
    const last = ordered.findIndex(item => item.id === a.id);
    for (const item of ordered.slice(Math.min(first, last), Math.max(first, last) + 1)) selectedBlocks.add(item.id);
    selection = { track: t.id, action: a.id }; render(); return;
  }
  if (!selectedBlocks.has(a.id)) selectedBlocks = new Set([a.id]);
  selection = { track: t.id, action: a.id }; renderSelectionTools(); renderInspector(); preview();
  [...$("lanes").children].forEach(n => n.classList.toggle("selected", n.dataset.track === t.id));
  [...$("trackLabels").children].forEach((n, i) => n.classList.toggle("selected", map().tracks[i].id === t.id));
  document.querySelectorAll(".action-node").forEach(n => n.classList.toggle("selected", selectedBlocks.has(n.dataset.action)));
  if (t.locked) { notify("この行はロックされています。", true); return; }
  const n = e.currentTarget, x = e.clientX, original = a.position;
  const scrollLeft = $("timelineScroll").scrollLeft;
  const group = entries(map()).filter(({ a }) => selectedBlocks.has(a.id));
  if (group.some(({ t }) => t.locked)) { notify("選択に編集ロック中の行が含まれます。", true); return; }
  const first = Math.min(...group.map(({ a }) => a.position));
  const last = Math.max(...group.map(({ a }) => a.position));
  const targets = { ...map(), tracks: map().tracks.map(t => ({ ...t,
    actions: t.actions.filter(item => item.id === a.id || !selectedBlocks.has(item.id)) })) };
  let next = original;
  timelinePointerDrag(e, n, (clientX, shifted) => {
    const raw = original + (clientX - x + $("timelineScroll").scrollLeft - scrollLeft) / px;
    const match = shifted ? timelineAlignment(targets, a.id, raw, plannedDuration(a), px) : null;
    next = original + clamp((match?.value ?? quantize(raw)) - original, -first, 3500 - last);
    for (const { a: item } of group) {
      const card = document.querySelector(`.action-node[data-action="${item.id}"]`);
      card.style.left = `${(item.position + next - original) * px + 16}px`;
    }
    showTimelineAlignment(match);
  }, (cancelled, moved) => {
    if (moved && !cancelled) safe(() => {
      try {
        commit((p, m) => {
          if (selectedBlocks.size > 1) m.tracks = adjustTimeline(m, [...selectedBlocks], next - original).tracks;
          else m.tracks.find(track => track.id === t.id).actions.find(item => item.id === a.id).position = next;
        },
          map().executionMode === "timed" ? "開始予定を変更しました。実行時刻と後続を再計算しました。" :
          map().executionMode === "ordered" ? "配置順を変更しました。実行順も左→右に更新しました。" :
            "予定位置を変更しました。トリガー条件は変更していません。");
      } catch (error) { render(); throw error; }
    })();
    else if (moved) render();
  });
}
function resizeAction(e, t, a) {
  e.stopPropagation();
  if (e.button !== 0) return;
  e.preventDefault(); pause();
  if (t.locked) { notify("この行はロックされています。", true); return; }
  selection = { track: t.id, action: a.id }; renderInspector();
  const handle = e.currentTarget, card = handle.closest(".action-node"), startX = e.clientX;
  const scrollLeft = $("timelineScroll").scrollLeft;
  const original = plannedDuration(a);
  const resizeIds = selectedBlocks.has(a.id) && selectedBlocks.size > 1 ? [...selectedBlocks] : [a.id];
  if (map().tracks.some(track => track.locked && track.actions.some(action => resizeIds.includes(action.id)))) {
    notify("選択に編集ロック中の行が含まれます。", true); return;
  }
  let next = original;
  timelinePointerDrag(e, handle, (clientX, shifted) => {
    const raw = original + (clientX - startX + $("timelineScroll").scrollLeft - scrollLeft) / px;
    const match = shifted ? timelineAlignment(map(), a.id, raw, a.position, px,
      { resize: true, min: .5, max: 3600 }) : null;
    next = match?.value ?? clamp(quantize(raw), .5, 3600);
    for (const { a: item } of entries(map()).filter(({ a }) => resizeIds.includes(a.id))) {
      const target = document.querySelector(`.action-node[data-action="${item.id}"]`);
      const seconds = Math.max(.1, plannedDuration(item) + next - original);
      target.style.width = `${seconds * px}px`;
      target.querySelector(".duration-label").textContent = `${seconds.toFixed(1)}s`;
    }
    showTimelineAlignment(match);
    handle.setAttribute("aria-valuenow", next);
    const scroll = $("timelineScroll");
    const right = scroll.getBoundingClientRect().right;
    if (clientX > right - 25) {
      $("timelineCanvas").style.width = `${Math.max($("timelineCanvas").clientWidth, a.position * px + next * px + 180)}px`;
    }
  }, (cancelled, moved) => {
    if (!cancelled && moved && next !== original) safe(() => {
      try { commit((p, m) => {
        if (resizeIds.length > 1) m.tracks = adjustTimeline(m, resizeIds, 0, next - original).tracks;
        else {
          const item = m.tracks.find(track => track.id === t.id).actions.find(item => item.id === a.id);
          item[m.executionMode === "timed" ? "runSeconds" : "plannedDuration"] = next;
          if (item.motion === "rotate") item.rotationSeconds = next;
        }
      }, map().executionMode === "timed" ? "実行秒数を変更しました。移動・回転速度と後続を再計算しました。" :
        "目安の実行時間を変更しました。実際の移動速度・トリガー条件は変更していません。");
      } catch (error) { render(); throw error; }
    })();
    else render();
  });
}
function availableTypes(track) {
  const types = ["robot", "human"].includes(track.kind) ? ["move", "show", "hide"] :
    track.kind === "room" ? ["event-start", "event-end"] : ["show", "hide"];
  return map().executionMode === "timed" ? [...types, ...(track.kind === "room" ? ["unlock"] : []), "wait"] : types;
}
function renderSelectionTools() {
  const tools = $("selectionTools");
  if (!tools) return;
  const offset = node("input", { type: "number", step: .5, value: 1, "aria-label": "まとめて調整する秒数" });
  const adjust = duration => {
    const seconds = Number(offset.value);
    if (!offset.value.trim() || !Number.isFinite(seconds)) throw new Error("調整する秒数を入力してください。");
    commit((p, m) => { m.tracks = adjustTimeline(m, [...selectedBlocks],
      duration ? 0 : seconds, duration ? seconds : 0).tracks; }, "選択したブロックをまとめて調整しました。");
  };
  tools.replaceChildren(node("span", { text: `${selectedBlocks.size}件選択` }),
    offset, button("開始をずらす", () => adjust(false)), button("長さを調整", () => adjust(true)),
    button("選択を解除", () => { selectedBlocks.clear(); render(); }),
    node("small", { text: "Ctrlで追加選択 / Shiftで行内範囲 / 選択後ドラッグで一括移動" }));
  for (const control of tools.querySelectorAll("button,input")) control.disabled = !selectedBlocks.size;
}
function unlockTarget(action, updated) {
  const doors = map().floorPlan?.doors ?? [];
  return select("解錠する部屋", action.doorId ? `door:${action.doorId}` : action.roomId,
    [["", "部屋・設備を選択"], ...map().rooms.map(room => [room.id, room.name]),
      ...doors.filter(door => door.name).map(door => [`door:${door.id}`, `設備：${door.name}`])],
    value => {
      if (value.startsWith("door:")) {
        const door = doors.find(door => door.id === value.slice(5));
        if (!door) throw new Error("指定した設備がありません。");
        action.doorId = door.id; action.roomId = door.roomId; action.name = `${door.name}解錠`;
      } else {
        delete action.doorId; action.roomId = value;
        action.name = `${map().rooms.find(room => room.id === value)?.name ?? "部屋"}解錠`;
      }
      updated();
    });
}

function openSequenceEditor(trackId, options = {}) {
  pause();
  const original = map().tracks.find(track => track.id === trackId);
  if (!original) throw new Error("編集する行がありません。");
  if (original.locked) throw new Error("この行はロックされています。");
  const track = clone(original);
  let activeId = options.actionId ?? orderedActions(track)[0]?.id;
  const addAction = (type, overrides = {}) => {
    const action = newAction(map(), track, type === "rotate" ? "move" : type);
    action.position = Math.max(0, ...track.actions.map(item => item.position + plannedDuration(item)));
    if (type === "rotate") Object.assign(action, { motion: "rotate", rotationSeconds: 1,
      runSeconds: 1, angularSpeed: 90, yaw: ((action.yaw + 270) % 360) - 180 });
    Object.assign(action, overrides);
    track.actions.push(action); activeId = action.id;
  };
  if (options.type) addAction(options.type, options.overrides);
  const dialog = node("dialog", { class: "sequence-dialog", "aria-label": "シーケンスを一括設定" });
  const form = node("form"), error = node("p", { class: "sequence-error", role: "alert" });
  const content = node("div", { class: "sequence-content" });
  const apply = node("button", { type: "submit", class: "primary", text: "適用" });
  const close = () => {
    placementTrack = null; dialog.close(); dialog.remove(); preview();
  };
  const run = fn => () => { error.textContent = ""; try { fn(); } catch (e) { error.textContent = e.message; } };
  const renderDraft = () => {
    const metadata = node("div", { class: "sequence-metadata" }, [
      field("名称", track.name, value => { track.name = value; }, "text", { maxlength: 120 }),
    ]);
    content.replaceChildren(metadata);
    if (track.kind === "robot") metadata.append(
      select("ロボット種別", track.robotRole ?? "cleaning", ROBOT_ROLES, value => { track.robotRole = value; renderDraft(); }),
      field("ロボットID", track.robotId, value => { track.robotId = value; }, "number", { min: 0, max: 9999, step: 1 }));
    if (track.kind === "human") metadata.append(field("人数", track.count, value => { track.count = value; }, "number", { min: 1, step: 1 }));
    if (track.initial) {
      content.append(node("div", { class: "sequence-initial" }, [
        button("初期位置をMAPで配置", () => openCoordinatePicker(track.initial, renderDraft,
          { kind: track.kind, track, title: "初期位置を配置" })),
        node("small", { text: `初期位置 X ${track.initial.x} / Y ${track.initial.y} / ${track.initial.yaw}° · 車体 100 × 100 mm` }),
      ]));
    }
    if (track.kind === "room") content.append(select("対象の部屋", track.roomId,
      map().rooms.map(room => [room.id, room.name]), value => { track.roomId = value; }));
    const actions = node("div", { class: "sequence-rows", role: "list", "aria-label": "シーケンスの動作" });
    for (const action of orderedActions(track)) {
      const rotating = action.motion === "rotate";
      const controls = node("div", { class: `sequence-row${action.id === activeId ? " active" : ""}`,
        "data-sequence-action": action.id, role: "listitem" }, [
        button(`${rotating ? "回転" : TYPES[action.type]} · ${action.name}`, () => {
          activeId = action.id; renderDraft();
        }, "sequence-action-select"),
        node("small", { text: `${action.position}〜${action.position + plannedDuration(action)}秒` }),
      ]);
      controls.append(button("↑", run(() => { reorderSequence(track, action.id, -1); renderDraft(); })),
        button("↓", run(() => { reorderSequence(track, action.id, 1); renderDraft(); })),
        button("削除", () => {
          track.actions = track.actions.filter(item => item.id !== action.id);
          if (activeId === action.id) activeId = orderedActions(track)[0]?.id;
          renderDraft();
        }, "danger"));
      actions.append(controls);
    }
    const fields = node("div", { class: "sequence-action-fields" });
    const workspace = node("div", { class: "sequence-workspace" }, [actions, fields]);
    content.append(workspace);
    const action = track.actions.find(item => item.id === activeId);
    apply.disabled = false; error.textContent = "";
    if (action) renderActionForm({
      trackId, actionId: action.id, action, track, fields, error, apply,
      following: false, bulk: true,
    });
    else {
      if (track.initial) {
        const svg = shape("svg", { viewBox: "0 0 1600 900",
          class: "sequence-empty-map", "aria-label": "初期配置のプレビュー" });
        svg.append(renderFloorPlan(map()), actorGlyph({ ...track, ...track.initial }));
        fields.append(svg);
      }
      fields.append(node("p", { class: "help", text: "動作を追加し、MAPで位置や経路を確認してください。「適用」まで保存されません。" }));
    }
    const additions = node("div", { class: "sequence-additions" });
    const types = availableTypes(track).flatMap(type => type === "move" && track.kind === "robot" ? ["move", "rotate"] : [type]);
    for (const type of types) additions.append(button(`＋ ${type === "rotate" ? "回転" : TYPES[type]}`, () => {
      addAction(type); renderDraft();
    }));
    content.append(additions);
  };
  form.addEventListener("submit", e => {
    e.preventDefault();
    run(() => {
      checkSequence(track);
      const editingMap = { ...map(), tracks: map().tracks.map(t => t.id === track.id ? track : t) };
      for (const action of orderedActions(track).filter(a => a.type === "move")) {
        const context = actionPreview(editingMap, trackId, action);
        if (context.geometryProblem) throw new Error(`${action.name}: ${context.geometryProblem}`);
        if (action.motion === "rotate") action.rotationSeconds = action.runSeconds;
        else action.yaw = context.from.yaw;
      }
      commit((p, m) => { m.tracks[m.tracks.findIndex(item => item.id === trackId)] = clone(track); },
        "シーケンスを一括適用しました。");
      choose(trackId, activeId);
      close();
    })();
  });
  form.append(node("header", { class: "modal-heading" }, [
    node("h2", { text: "シーケンスを一括設定" }), button("キャンセル", close),
  ]), node("p", { class: "help", text: "作業コピーを編集します。「適用」で全変更をまとめて保存。矢印で実行順を入れ替えます。" }),
  content, error, apply);
  dialog.append(form);
  dialog.addEventListener("cancel", e => { e.preventDefault(); close(); });
  dialog.addEventListener("keydown", e => e.stopPropagation());
  document.body.append(dialog); renderDraft(); dialog.showModal();
}
function clearDropPreview() {
  document.querySelectorAll(".drop-preview").forEach(n => n.remove());
  document.querySelectorAll(".drop-target").forEach(n => n.classList.remove("drop-target", "drop-invalid"));
}
function dropCandidate(event, track, lane = null) {
  const type = paletteDragType ?? event.dataTransfer?.getData("application/x-scene-action");
  if (!Object.hasOwn(TYPES, type)) return null;
  const position = lane ? Math.max(0, (event.clientX - lane.getBoundingClientRect().left - 16) / px) : quantize(time);
  const key = JSON.stringify([type, track?.id, position, lane ? null : stagePoint(event, "free")]);
  if (dropCache?.key === key) return dropCache.value;
  let reason = !track ? "先に配置先の行を選択してください。" :
    track.locked ? "この行はロックされています。" :
    !availableTypes(track).includes(type) ? `${track.name} に「${TYPES[type]}」は配置できません。` : "";
  const overrides = { position };
  if (!reason && !lane) {
    const action = newAction(map(), track, type);
    Object.assign(overrides, stagePoint(event, action.coordinateMode ?? "grid"));
    const room = map().rooms.find(r => roomContainsPoint(r, overrides.x, overrides.y));
    if (type === "move") {
      overrides.roomId = room?.id ?? "";
      const context = actionPreview(map(), track.id, { ...action, ...overrides });
      reason = pathProblem(createSafety(map()), context.from, overrides, track.kind);
    } else if (type === "event-start") {
      if (!room) reason = "イベントは部屋・廊下の内側に配置してください。";
      else overrides.roomId = room.id;
    }
  }
  const action = track && !reason ? { ...newAction(map(), track, type), ...overrides } : null;
  const value = { type, overrides, reason, action };
  dropCache = { key, value }; return value;
}
function showDropPreview(event, track, lane = null) {
  const candidate = dropCandidate(event, track, lane);
  if (!candidate) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = candidate.reason ? "none" : "copy";
  clearDropPreview();
  const { type, overrides, reason, action } = candidate;
  const label = reason || `${TYPES[type]} · ${overrides.position.toFixed(1)}秒` +
    (!lane && ["move", "show"].includes(type) ? ` · X ${overrides.x.toFixed(1)} / Y ${overrides.y.toFixed(1)}` : "");
  if (lane) {
    lane.classList.add("drop-target");
    lane.classList.toggle("drop-invalid", !!reason);
    lane.append(node("div", {
    class: `drop-preview timeline-drop-preview${reason ? " invalid" : ""}`,
    style: `left:${overrides.position * px + 16}px;width:${action ? actionWidth(action) : 150}px`,
    role: "status", title: label, text: label,
    }));
  }
  else {
    const p = overrides.x === undefined ? stagePoint(event) : overrides;
    const room = map().rooms.find(r => r.id === (overrides.roomId ?? action?.roomId));
    const region = type.startsWith("event-") && room;
    const geometry = region ? room.cells ? shape("path", {
      d: room.cells.map(cell => `M${cell % 32 * 50} ${Math.floor(cell / 32) * 50}h50v50h-50Z`).join(""),
      class: "drop-region-shape", "data-room": room.id,
    }) : shape("rect", { x: room.x, y: 900 - room.y - room.height,
      width: room.width, height: room.height, class: "drop-region-shape", "data-room": room.id }) :
      shape("rect", { x: p.x - 25, y: 900 - p.y - 25, width: 50, height: 50, rx: 5 });
    const group = shape("g", { class: `drop-preview stage-drop-preview${reason ? " invalid" : ""}`,
      "pointer-events": "none", role: "status" }, [
      geometry,
      shape("text", { x: clamp(p.x, 100, 1000), y: clamp(900 - p.y - 45, 35, 860), text: label }),
    ]);
    if (type === "move" && action) {
      const from = actionPreview(map(), track.id, action).from;
      group.prepend(shape("line", { x1: from.x, y1: 900 - from.y, x2: p.x, y2: 900 - p.y }));
      group.append(shape("circle", { cx: p.x, cy: 900 - p.y,
        r: track.kind === "robot" ? ROBOT_RADIUS : HUMAN_RADIUS }));
    }
    $("stage").append(group);
  }
}
function openAction(trackId, actionId, type, overrides, initialChosen = false) {
  pause(); const track = map().tracks.find(t => t.id === trackId);
  if (!track) throw new Error("先に対象の行を選択してください。");
  if (track.locked) throw new Error("この行はロックされています。");
  if (track.kind === "robot") {
    openSequenceEditor(trackId, actionId ? { actionId } : { type, overrides }); return;
  }
  if (!actionId && !availableTypes(track).includes(type)) throw new Error("この行には配置できないアクションです。");
  const action = actionId ? clone(track.actions.find(a => a.id === actionId)) : newAction(map(), track, type);
  Object.assign(action, overrides ?? {});
  if (!actionId && map().executionMode === "timed" && !Object.hasOwn(overrides ?? {}, "position")) {
    const previous = orderedActions(track).at(-1);
    if (previous) action.position = previous.position + previous.runSeconds;
  }
  const sequence = ["ordered", "timed"].includes(map().executionMode) ? orderedActions(track) : track.actions;
  const first = sequence[0];
  if (!actionId && track.initial && !initialChosen &&
    (!first || action.position < first.position)) {
    selection = { track: trackId };
    const initial = clone(track.initial);
    openCoordinatePicker(initial, () => openAction(trackId, null, type, overrides, true), {
      title: "初期位置をどこにしますか？", kind: track.kind,
      help: "MAPで何度でも選び直せます。「適用」で初期位置を確定し、アクションの設定へ進みます。",
      onSelect: () => commit((p, m) => {
        m.tracks.find(t => t.id === trackId).initial = clone(initial);
      }, "初期位置を設定しました。"),
    });
    return;
  }
  if (action.type === "move") {
    Object.assign(action, ARRIVAL_DEFAULTS);
    if (action.motion === "rotate") {
      action.angleTolerance = 10;
      if (action.rotationSeconds === undefined) {
        const context = actionPreview(map(), trackId, action);
        const angle = Math.abs(((action.yaw - context.from.yaw + 540) % 360) - 180);
        action.rotationSeconds = Math.max(.1, angle / action.angularSpeed);
      }
    }
  }
  draft = { trackId, actionId, action, following: action.coordinateMode === "free" };
  selection = { track: trackId, action: actionId }; $("actionError").textContent = "";
  renderActionForm(); if (!$("actionDialog").open) $("actionDialog").showModal();
}
function renderActionForm(editor = draft) {
  const a = editor.action, track = editor.track ?? map().tracks.find(t => t.id === editor.trackId);
  const f = editor.fields ?? $("actionFields");
  const render = () => renderActionForm(editor), refresh = () => refreshActionMap(editor);
  const timed = map().executionMode === "timed";
  const rotating = a.type === "move" && a.motion === "rotate";
  if (!editor.bulk) $("actionTitle").textContent = `${rotating ? "回転" : TYPES[a.type]} · ${track.name}`;
  const basic = node("div", { class: "action-basic" }, [
    field("アクション名", a.name, v => { a.name = v; }, "text", { maxlength: 120 }),
  ]);
  if (a.type === "move" && track.kind === "robot") basic.append(node("div", { class: "motion-switch", role: "group", "aria-label": "移動の種類" },
    [["linear", "↗ 移動"], ["rotate", "↻ 回転"]].map(([value, text]) => button(text, () => {
      if ((a.motion ?? "linear") === value) return;
      a.motion = value;
      a.angleTolerance = value === "rotate" ? 10 : null;
      if (value === "rotate") { a.angularSpeed ??= 90; a.rotationSeconds ??= 1; }
      else delete a.rotationSeconds;
      render();
    }, (a.motion ?? "linear") === value ? "active" : ""))));
  const update = callback => value => {
    callback(value);
    refresh();
  };
  if (editor.bulk) basic.append(field("開始（秒）", a.position,
    update(value => { a.position = value; }), "number", { min: 0, max: 1_000_000, step: "any" }));
  if (rotating) basic.append(row(
    field("回転後の角度（°）", a.yaw, update(v => { a.yaw = v; }), "number",
      { min: -180, max: 180, step: "any" }),
    field("回転にかける秒数", timed ? a.runSeconds : a.rotationSeconds, update(v => {
      if (timed) a.runSeconds = v; else a.rotationSeconds = v;
    }),
      "number", { min: .1, max: 86400, step: "any" }),
  ));
  if (timed && !rotating) basic.append(
    field(a.type === "wait" ? "待機する秒数" : "実行にかける秒数", a.runSeconds,
      update(v => { a.runSeconds = v; }), "number",
      { min: ["wait", "move", "unlock"].includes(a.type) ? .1 : 0, max: 86400, step: "any" }));
  if (timed && !planFor(map()).fixedTimeline) {
    const details = node("details", { class: "execution-options" }, [
      node("summary", { text: "タイムアウト・模擬結果の検証" }),
      field("期限秒（空欄は期限なし・待ち時間を含む）", a.timeoutSeconds ?? "", v => {
        if (Number.isNaN(v)) delete a.timeoutSeconds; else a.timeoutSeconds = v;
        refresh();
      }, "number", { min: .1, max: 86400, step: "any" }),
      select("模擬結果（実機ではありません）", a.simulationOutcome ?? "success",
        [["success", "成功"], ["failed", "失敗を模擬する"]], update(v => { a.simulationOutcome = v; })),
    ]);
    basic.append(details);
  }
  if (a.type === "show") basic.append(select("表示テンプレート", a.displayTemplate ?? "label",
    DISPLAY_TEMPLATES.map(value => [value, { label: "テキスト", card: "案内カード", sign: "サイン / ピル" }[value]]),
    update(v => { a.displayTemplate = v; })));
  if (a.type === "unlock") basic.append(
    unlockTarget(a, render),
    node("p", { class: "help", text: "このバーの間だけ、選択室に属するドアが接近に反応します。終了時に通過中なら、離れてから再施錠します。" }));
  if (a.type === "event-start") basic.append(
    node("div", { class: "field-row triple" }, [
      select("イベント", a.state, [["meeting", "会議中"], ["outage", "停電"], ["fire", "火災"]],
        v => { a.state = v; render(); }),
      field("色", a.hatchColor ?? eventColor(a), update(v => { a.hatchColor = v; }), "color"),
      select("模様", a.hatchStyle ?? "diagonal",
        HATCH_STYLES.map(value => [value, { diagonal: "斜線", cross: "クロス", dots: "ドット" }[value]]),
        update(v => { a.hatchStyle = v; })),
    ]),
  );
  if (["show", "event-start"].includes(a.type)) {
    const textField = field("表示する言葉", a.text, v => { a.text = v; }, "textarea", { maxlength: 500 });
    textField.querySelector("textarea").addEventListener("input", e => {
      a.text = e.target.value; refresh();
    });
    basic.append(textField);
  }
  if (["hide", "event-end"].includes(a.type)) {
    const starts = entries(map()).filter(e => e.a.type === (a.type === "hide" ? "show" : "event-start"));
    basic.append(select("終了する項目", a.targetId, [["", "対象を選択"], ...starts.map(e => [e.a.targetId, `${e.t.name} / ${e.a.name}`])],
      v => { a.targetId = v; const start = starts.find(e => e.a.targetId === v); if (start && a.type === "event-end") a.roomId = start.a.roomId; render(); }));
  }
  const mapPanel = node("div", { class: "action-map-panel" });
  if (!editor.bulk) mapPanel.id = "actionMapPanel";
  editor.mapPanel = mapPanel;
  f.replaceChildren(basic, mapPanel);
  refresh();
}
function eventColor(event) {
  return event.hatchColor ?? { meeting: "#9684ed", fire: "#ef7858", outage: "#7f9bb5" }[event.state];
}
let graphicSerial = 0;
function eventGraphic(room, event) {
  const id = `event-pattern-${++graphicSerial}`, color = eventColor(event);
  const pattern = shape("pattern", { id, width: 28, height: 28, patternUnits: "userSpaceOnUse" });
  const style = event.hatchStyle ?? "diagonal";
  pattern.append(style === "dots" ? shape("circle", { cx: 14, cy: 14, r: 4, fill: color }) :
    shape("path", { d: style === "cross" ? "M0 0L28 28M28 0L0 28" : "M-7 7L7 -7M0 28L28 0M21 35L35 21",
      stroke: color, "stroke-width": 4, fill: "none" }));
  pattern.append(shape("animateTransform", { attributeName: "patternTransform", type: "translate",
    from: "0 0", to: "28 0", dur: "4s", repeatCount: "indefinite" }));
  const area = room.cells ? { d: room.cells.map(cell =>
    `M${cell % 32 * 50} ${Math.floor(cell / 32) * 50}h50v50h-50Z`).join("") } :
    { x: room.x, y: 900 - room.y - room.height, width: room.width, height: room.height };
  const anchor = roomAnchor(room);
  return shape("g", { "data-stage-action": event.actionId ?? event.id }, [
    shape("defs", {}, [pattern]),
    shape(room.cells ? "path" : "rect", { ...area, fill: color, opacity: .13 }),
    shape(room.cells ? "path" : "rect", { ...area, fill: `url(#${id})`, opacity: .6, class: "room-hatching" }),
    shape("text", { x: anchor.x, y: 900 - anchor.y + 36, "text-anchor": "middle",
      fill: color, "font-size": 25, "font-weight": 700, stroke: "#131822", "stroke-width": 4,
      "paint-order": "stroke", text: event.text || { meeting: "会議中", fire: "火災", outage: "停電" }[event.state] }),
  ]);
}
function displayGraphic(display, x = display.x, y = display.y) {
  const allLines = (display.text || "").split("\n").flatMap(line => {
    const chars = [...line];
    return chars.length ? Array.from({ length: Math.ceil(chars.length / 22) }, (_, i) =>
      chars.slice(i * 22, (i + 1) * 22).join("")) : [""];
  });
  const lines = allLines.slice(0, 5);
  if (allLines.length > 5) lines[4] += "…";
  const width = Math.min(640,
    Math.max(130, ...lines.map(line => [...line].length * 25 + 36)));
  const template = display.displayTemplate ?? "label", height = lines.length * 32 + 24;
  const g = shape("g", { transform: `translate(${x} ${900 - y})`,
    "data-stage-action": display.actionId ?? display.id, class: `display-graphic template-${template}` });
  if (template !== "label") {
    g.append(shape("rect", { x: -width / 2, y: -height / 2, width, height,
      rx: template === "sign" ? height / 2 : 10, fill: template === "sign" ? display.color : "#18202e",
      stroke: display.color, "stroke-width": 3 }));
  }
  lines.forEach((line, i) => g.append(shape("text", { x: 0,
    y: (i - (lines.length - 1) / 2) * 32, "dominant-baseline": "middle",
    "text-anchor": "middle", "font-size": 26, "font-weight": 650,
    fill: template === "sign" ? "#171b25" : display.color, text: line })));
  return g;
}
function coordinateModeControl(value, changed) {
  return select("座標指定モード", value.coordinateMode ?? "grid",
    [["grid", "グリッド中央"], ["free", "自由座標"]], mode => {
      value.coordinateMode = mode;
      if (mode === "grid") Object.assign(value, snapPoint(value.x, value.y));
      changed(mode);
    });
}
function bindCoordinatePointer(svg, value, origin, state, redraw, fixed) {
  let cursor;
  const update = event => {
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(svg.getScreenCTM().inverse());
    const point = coordinatePoint(p.x, 900 - p.y, value.coordinateMode ?? "grid",
      origin, event.shiftKey);
    Object.assign(value, point);
    const room = map().rooms.find(r => roomContainsPoint(r, point.x, point.y));
    if (!value.type || value.type === "move") value.roomId = room?.id ?? "";
    redraw();
  };
  svg.addEventListener("pointermove", e => {
    cursor = { clientX: e.clientX, clientY: e.clientY };
    if (value.coordinateMode === "free" && state.following) {
      svg.focus({ preventScroll: true }); update(e);
    }
  });
  svg.addEventListener("pointerleave", () => { cursor = null; });
  for (const type of ["keydown", "keyup"]) svg.addEventListener(type, e => {
    if (e.key === "Shift" && cursor && state.following && value.coordinateMode === "free") {
      update({ ...cursor, shiftKey: e.shiftKey });
    }
  });
  svg.addEventListener("click", e => {
    if (value.coordinateMode === "free") {
      if (!state.following) {
        if (e.target.closest("[data-coordinate-target]")) {
          state.following = true; redraw();
        }
        return;
      }
      update(e); state.following = false; redraw(); fixed();
    } else { update(e); fixed(); }
  });
}
function actorGlyph(actor) {
  const g = shape("g", { transform: `translate(${actor.x} ${900 - actor.y})` });
  if (actor.kind === "human") {
    const count = Math.min(actor.count ?? 1, 5);
    for (let i = 0; i < count; i++) g.append(shape("g", {
      transform: `translate(${(i % 3) * 24 - (count > 1 ? 24 : 0)} ${Math.floor(i / 3) * 30})`,
    }, [
      shape("circle", { cx: 0, cy: -10, r: 8, fill: actor.color }),
      shape("path", { d: "M0 0L0 18M-13 7H13M0 18L-9 31M0 18L9 31", fill: "none",
        stroke: actor.color, "stroke-width": 5, "stroke-linecap": "round" }),
    ]));
  } else {
    const half = ROBOT_SIDE / 2, role = actor.robotRole ?? "cleaning";
    const body = shape("g", { transform: `rotate(${-actor.yaw})`, "data-robot-role": role }, [
      shape("rect", { x: -half, y: -half, width: ROBOT_SIDE, height: ROBOT_SIDE,
        rx: 23, fill: "#151e2f", stroke: actor.color, "stroke-width": 3,
        "data-robot-body": "", "data-size-mm": 100 }),
      shape("rect", { x: -half + 10, y: -half + 10, width: ROBOT_SIDE - 20,
        height: ROBOT_SIDE - 20, rx: 17, fill: "#26374b", stroke: "#738fa366", "stroke-width": 2 }),
      shape("path", { d: `M${half - 18} -24L${half - 6} 0L${half - 18} 24`,
        fill: "none", stroke: "#c5fff3", "stroke-width": 4 }),
    ]);
    if (role === "cleaning") body.append(
      shape("circle", { r: 35, fill: "#0f2830", stroke: "#64e8ca", "stroke-width": 4 }),
      shape("path", { d: "M-22 -8Q0 -32 22 -8M-22 8Q0 32 22 8M-10 -20V20M10 -20V20",
        fill: "none", stroke: "#8effd9", "stroke-width": 4 }));
    else if (role === "security") body.append(
      shape("path", { d: "M0 -39L32 -24V6Q26 28 0 42Q-26 28 -32 6V-24Z",
        fill: "#243c70", stroke: "#94bcff", "stroke-width": 4 }),
      shape("circle", { r: 13, fill: "#b9deff" }),
      shape("path", { d: "M-17 0H17M0 -17V17", stroke: "#416dc1", "stroke-width": 4 }));
    else body.append(
      shape("rect", { x: -32, y: -32, width: 64, height: 64, rx: 5,
        fill: "#62492c", stroke: "#ffce86", "stroke-width": 4 }),
      shape("path", { d: "M0 -32V32M-32 -9H32M-12 -32V-12H12V-32",
        fill: "none", stroke: "#ffe2a9", "stroke-width": 4 }));
    g.append(body);
  }
  return g;
}
function refreshActionMap(editor = draft) {
  const panel = editor?.mapPanel;
  if (!panel || !editor) return;
  const error = editor.error ?? $("actionError");
  error.textContent = "";
  const apply = editor.apply ?? $("actionForm").querySelector('button[type="submit"]');
  apply.disabled = false;
  const a = editor.action, track = editor.track ?? map().tracks.find(t => t.id === editor.trackId);
  const editingMap = editor.track ?
    { ...map(), tracks: map().tracks.map(t => t.id === track.id ? track : t) } : map();
  const rotating = a.type === "move" && a.motion === "rotate";
  const safety = a.type === "move" ? createSafety(map()) : null;
  let context, validationError = "";
  try {
    const p = clone(project), m = p.maps.find(m => m.id === mapId), t = m.tracks.find(t => t.id === track.id);
    if (editor.track) m.tracks[m.tracks.indexOf(t)] = clone(track);
    const editingTrack = m.tracks.find(t => t.id === track.id);
    const index = editingTrack.actions.findIndex(item => item.id === a.id);
    if (index < 0) editingTrack.actions.push(clone(a)); else editingTrack.actions[index] = clone(a);
    try { validateProject(p); } catch (problem) {
      validationError = problem.message;
      error.textContent = validationError; apply.disabled = true;
    }
    context = actionPreview(editingMap, track.id, a);
    if (context.geometryProblem) {
      error.textContent = context.geometryProblem; apply.disabled = true;
    }
  } catch (problem) {
    error.textContent = problem.message;
    apply.disabled = true;
    return;
  }
  const svg = shape("svg", { viewBox: "0 0 1600 900", class: "action-spatial-map",
    role: "img", "aria-label": "アクションのMAPプレビュー", tabindex: 0 });
  svg.append(shape("rect", { width: 1600, height: 900, fill: "#161d27" }));
  if (map().background) svg.append(shape("image", { href: map().background.data,
    opacity: map().background.opacity ?? .7, width: 1600, height: 900, preserveAspectRatio: "none" }));
  svg.append(renderFloorPlan(map()));
  for (const event of context.state.events.filter(event => event.targetId !== a.targetId)) {
    const room = map().rooms.find(room => room.id === event.roomId);
    if (room) svg.append(eventGraphic(room, event));
  }
  for (const display of context.state.displays.filter(display => display.targetId !== a.targetId)) {
    const actor = context.state.actors.find(actor => actor.id === display.actorId);
    svg.append(displayGraphic(display, actor ? actor.x : display.x, actor ? actor.y + 75 : display.y));
  }
  for (const actor of context.state.actors.filter(actor => a.type !== "move" || actor.id !== track.id)) {
    const glyph = actorGlyph(actor); glyph.setAttribute("opacity", .4); svg.append(glyph);
  }
  const target = ["hide", "event-end"].includes(a.type) ?
    (a.type === "hide" ? context.state.displays : context.state.events)
      .find(item => item.targetId === a.targetId) ??
      entries(map()).find(e => e.a.targetId === a.targetId &&
        e.a.type === (a.type === "hide" ? "show" : "event-start"))?.a : null;
  const room = map().rooms.find(r => r.id === (target?.roomId ?? a.roomId));
  const editablePoint = a.type === "move" && !rotating || a.type === "show" && !track.initial;
  const free = a.coordinateMode === "free";
  let redrawPoint;
  let message = "";
  if (a.type === "move") {
    const from = context.from;
    const after = { ...track, ...from, x: rotating ? from.x : a.x,
      y: rotating ? from.y : a.y, yaw: rotating ? a.yaw : from.yaw, color: "#93ead1" };
    const before = actorGlyph({ ...track, ...from, color: "#b8b9ce" });
    before.setAttribute("opacity", .45);
    const path = shape("line", { x1: from.x, y1: 900 - from.y, x2: after.x, y2: 900 - after.y,
      stroke: "#93ead1", "stroke-width": 5, "stroke-dasharray": "12 8" });
    const afterGlyph = actorGlyph(after);
    afterGlyph.setAttribute("data-coordinate-target", "");
    svg.append(path, before, afterGlyph);
    const caption = (x, y, text, color) => shape("text", { x, y: 900 - y - 65,
      fill: color, "font-size": 25, "text-anchor": "middle", stroke: "#171b25",
      "paint-order": "stroke", "stroke-width": 5, text });
    if (!rotating) svg.append(caption(from.x, from.y, "移動前", "#d0d0de"));
    const afterCaption = caption(after.x, after.y, rotating ? `回転後 ${a.yaw}°` : "移動後", "#93ead1");
    svg.append(afterCaption);
    redrawPoint = () => {
      afterGlyph.setAttribute("transform", `translate(${a.x} ${900 - a.y})`);
      path.setAttribute("x2", a.x); path.setAttribute("y2", 900 - a.y);
      afterCaption.setAttribute("x", a.x); afterCaption.setAttribute("y", 900 - a.y - 65);
      const problem = pathProblem(safety, track.initial, track.initial, track.kind) ||
        pathProblem(safety, from, a, track.kind);
      error.textContent = problem || validationError;
      apply.disabled = !!(problem || validationError);
      path.setAttribute("stroke", problem ? "#ff817b" : "#93ead1");
      afterGlyph.classList.toggle("invalid-destination", !!problem);
      svg.dataset.invalidDestination = String(!!problem);
    };
    if (rotating) {
      const problem = pathProblem(safety, from, from, track.kind);
      if (problem) error.textContent = problem;
    }
    message = rotating ? `薄い輪郭：回転前 ${Math.round(from.yaw)}° → 回転後 ${a.yaw}° / ${a.runSeconds ?? a.rotationSeconds}秒` :
      "MAPをクリックして移動後の位置を指定。白：移動前 / ミント：移動後";
  } else if (a.type.startsWith("event-") && room) {
    const graphic = eventGraphic(room, target ?? a);
    if (a.type === "event-end") graphic.setAttribute("opacity", .3);
    svg.append(graphic);
    message = a.type === "event-end" ? "薄いハッチング：このイベントを終了して消去します" :
      `${room.name}：MAPの部屋をクリックして変更`;
  } else if (a.type === "show" || a.type === "hide" && target) {
    const item = target ?? a;
    const owner = target ? context.state.actors.find(actor => actor.id === target.actorId) : null;
    const point = owner ?? (track.initial && context.from ? context.from : item);
    const graphic = displayGraphic({ ...item, color: item.color ?? track.color }, point.x,
      point.y + (owner || track.initial ? 75 : 0));
    if (editablePoint) {
      graphic.setAttribute("data-coordinate-target", "");
      graphic.prepend(shape("circle", { r: 28, fill: "transparent", "pointer-events": "all" }));
      redrawPoint = () => graphic.setAttribute("transform", `translate(${a.x} ${900 - a.y})`);
    }
    if (a.type === "hide") graphic.setAttribute("opacity", .3);
    svg.append(graphic);
    message = a.type === "hide" ? "薄い表示：この項目を消去します" :
      track.initial ? "この表示は対象のロボット・人に追従します" : "MAPをクリックして表示位置を指定";
  } else if (a.type === "wait") message = `現在位置で ${a.runSeconds}秒待機します。`;
  else if (a.type === "unlock") {
    if (room) svg.append(shape("rect", { x: room.x, y: 900 - room.y - room.height,
      width: room.width, height: room.height, fill: "#63e2c0", "fill-opacity": .13,
      stroke: "#63e2c0", "stroke-width": 5 }));
    message = room ? `${room.name}：解錠バーの間だけ自動開閉します` : "解錠する部屋をドロップダウンから選択してください";
  }
  else message = a.type === "event-start" ? "MAPの部屋をクリックしてイベントの対象を指定" :
    "左側で終了する項目を選択してください";
  svg.addEventListener("click", e => {
    if (rotating || ["hide", "event-end", "wait", "unlock"].includes(a.type) || a.type === "show" && track.initial) return;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM().inverse());
    if (editablePoint) return;
    const { x, y } = snapPoint(p.x, 900 - p.y);
    const room = map().rooms.find(room => roomContainsPoint(room, x, y));
    if (a.type === "event-start" && !room) {
      error.textContent = "部屋・廊下の内側をクリックしてください。"; return;
    }
    if (a.type === "event-start") a.roomId = room.id;
    else { a.x = x; a.y = y; if (a.type === "move") a.roomId = room?.id ?? ""; }
    refreshActionMap(editor);
  });
  const coordinateStatus = node("p", { class: "spatial-caption", "aria-live": "polite" });
  if (editablePoint) {
    const redraw = () => {
      redrawPoint();
      svg.dataset.following = String(free && editor.following);
      coordinateStatus.textContent = `X ${a.x.toFixed(2)} / Y ${a.y.toFixed(2)} · ` +
        (free ? editor.following ? "カーソル追従中 · クリックで仮固定 · Shiftで水平/垂直" :
          "仮固定中 · 移動後のオブジェクトをクリックして再指定" : "クリックでグリッド中央を指定");
    };
    bindCoordinatePointer(svg, a, { ...(context.from ?? a) }, editor, redraw, () => refreshActionMap(editor));
    redraw();
  }
  panel.replaceChildren(node("div", { class: "spatial-heading", text: "LIVE MAP / 実行イメージ" }),
    ...(editablePoint ? [coordinateModeControl(a, mode => {
      editor.following = mode === "free"; refreshActionMap(editor);
    })] : []),
    svg, ...(!editablePoint || context.warning ?
      [node("p", { class: "spatial-caption", text: context.warning || message })] : []),
    ...(editablePoint ? [coordinateStatus] : []),
    ...(a.type === "move" ? [node("p", { class: "spatial-footnote",
      text: "自由座標のShift制限は移動前の位置が基準。安定0.3秒。通行・接近予測は実機の安全保証ではありません。" })] : []));
}
function openCoordinatePicker(value = draft.action, updated = renderActionForm, options = {}) {
    const a = clone(value), origin = { x: value.x, y: value.y };
    const state = { following: a.coordinateMode === "free" };
    const roomEvent = a.type?.startsWith("event-") ?? false;
    const initialPosition = !a.type;
    const room = map().rooms.find(r => r.id === a.roomId);
    const selectedPoint = roomEvent && room ? roomAnchor(room) : a;
    const dialog = node("dialog", { class: "coordinate-dialog", "aria-label": "MAPで位置を指定" });
    const close = () => { dialog.close(); dialog.remove(); };
    dialog.append(node("div", { class: "modal-heading" }, [
      node("h2", { text: options.title ?? (roomEvent ? "対象の部屋をクリック" : "目標座標をクリック") }),
      button("閉じる", close),
    ]));
    const picker = shape("svg", { viewBox: "0 0 1600 900", class: "action-map-picker",
      role: "img", "aria-label": "マップをクリックして座標を指定" });
    picker.append(shape("rect", { width: 1600, height: 900, fill: "#181c24" }));
    if (map().background) picker.append(shape("image", {
      href: map().background.data, width: 1600, height: 900, preserveAspectRatio: "none",
    }));
    picker.append(renderFloorPlan(map()));
    const marker = shape("g", { "data-coordinate-target": "", transform: `translate(${selectedPoint.x} ${900 - selectedPoint.y})` }, [
      shape("circle", { r: 28, fill: "#bca1ff", stroke: "#252038", "stroke-width": 4 }),
      shape("path", { d: "M-28 0h56M0 -28v56",
        stroke: "#a47aff", "stroke-width": 3 }),
    ]);
    const heading = initialPosition ? shape("path", {
      d: "M-12 -14L24 0L-12 14Z", fill: "#fff", stroke: "#252038", "stroke-width": 2,
      "data-initial-heading": "",
    }) : null;
    if (heading) marker.replaceChildren(
      actorGlyph({ ...(options.track ?? selectedTrack()), kind: options.kind ?? selectedTrack()?.kind ?? "robot",
        color: options.track?.color ?? selectedTrack()?.color ?? "#93ead1", ...a, x: 0, y: 900 }), heading);
    picker.append(marker);
    const coordinate = node("p", { class: "help", text: roomEvent ?
      `対象エリア：${room?.name ?? "未選択"} · マップ上の部屋・廊下をクリック` :
      `選択位置 X ${a.x} / Y ${a.y} · マップをクリックして変更` });
    const safety = !a.type ? createSafety(map()) : null;
    const problemAt = () => initialPosition && (!Number.isFinite(a.yaw) || a.yaw < -180 || a.yaw > 180) ?
      "初期の向きは -180〜180° で指定してください。" :
      safety ? pathProblem(safety, a, a, options.kind ?? selectedTrack()?.kind ?? "robot") : "";
    const accept = () => {
      const problem = problemAt();
      if (problem) { coordinate.textContent = problem; return; }
      Object.assign(value, a);
      try { options.onSelect?.(); }
      catch (error) { coordinate.textContent = error.message; return; }
      close(); updated();
    };
    const redraw = () => {
      marker.setAttribute("transform", `translate(${a.x} ${900 - a.y})`);
      if (heading && Number.isFinite(a.yaw)) heading.setAttribute("transform", `rotate(${-a.yaw})`);
      if (initialPosition && Number.isFinite(a.yaw)) marker.querySelector("[data-robot-role]")?.setAttribute("transform", `rotate(${-a.yaw})`);
      picker.dataset.following = String(a.coordinateMode === "free" && state.following);
      coordinate.textContent = `X ${a.x.toFixed(2)} / Y ${a.y.toFixed(2)} · ` +
        (a.coordinateMode === "free" ? state.following ?
          "カーソル追従中 · クリックで仮固定 · Shiftで水平/垂直" :
          "仮固定中 · マーカーを再クリックして再指定" : "クリックでグリッド中央を指定");
      const problem = problemAt();
      if (problem) coordinate.textContent = problem;
      selectPoint.disabled = !!problem;
      marker.classList.toggle("invalid-destination", !!problem);
    };
    if (!roomEvent) bindCoordinatePointer(picker, a, origin, state, redraw, redraw);
    else picker.addEventListener("click", e => {
      const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(picker.getScreenCTM().inverse());
      const { x, y } = snapPoint(p.x, 900 - p.y);
      const room = map().rooms.find(r => roomContainsPoint(r, x, y));
      if (roomEvent && !room) { coordinate.textContent = "対象の部屋・廊下の内部をクリックしてください。"; return; }
      if (roomEvent) a.roomId = room.id;
      else { a.x = x; a.y = y; if (!a.type || a.type === "move") a.roomId = room?.id ?? ""; }
      marker.setAttribute("transform", `translate(${x} ${900 - y})`);
      coordinate.textContent = `対象エリア：${room.name} · 「適用」で戻ります`;
    });
    const modeControl = coordinateModeControl(a, mode => {
      state.following = mode === "free";
      redraw();
    });
    const selectPoint = button("適用", accept, "primary");
    const yawInput = initialPosition ? node("input", {
      type: "number", min: -180, max: 180, step: 1, value: a.yaw,
    }) : null;
    if (yawInput) yawInput.addEventListener("input", () => {
      a.yaw = yawInput.value.trim() ? Number(yawInput.value) : NaN; redraw();
    });
    dialog.classList.toggle("initial-coordinate-dialog", initialPosition);
    dialog.append(...(roomEvent ? [] : [modeControl]), picker, coordinate,
      node("p", { class: "help",
        text: options.help ?? (initialPosition ?
          "MAPで何度でも選び直し「適用」で戻ります。元の初期位置画面で適用するまで未保存です。" :
          "MAPでは何度でも選び直せます。「適用」で戻り、元の設定画面でも「適用」を押すまで保存しません。") }));
    dialog.append(initialPosition ? node("div", { class: "initial-coordinate-actions" }, [
      node("label", { class: "field", text: "初期の向き（°）" }, [yawInput]),
      selectPoint,
    ]) : selectPoint);
    if (!roomEvent) redraw();
    dialog.addEventListener("cancel", e => { e.preventDefault(); close(); });
    dialog.addEventListener("keydown", e => {
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); close(); }
    });
    document.body.append(dialog); dialog.showModal();
}
$("actionForm").onsubmit = e => {
  e.preventDefault();
  try {
    const d = draft;
    if (d.action.type === "move") {
      const context = actionPreview(map(), d.trackId, d.action);
      if (context.geometryProblem) throw new Error(context.geometryProblem);
      Object.assign(d.action, ARRIVAL_DEFAULTS);
      if (d.action.motion === "rotate") d.action.angleTolerance = 10;
      else d.action.yaw = context.from.yaw;
    }
    commit((p, m) => {
      const t = m.tracks.find(t => t.id === d.trackId);
      if (d.actionId) t.actions[t.actions.findIndex(a => a.id === d.actionId)] = clone(d.action);
      else t.actions.push(clone(d.action));
    }, "アクションとトリガーを適用しました。");
    selection = { track: d.trackId, action: d.action.id }; draft = null; $("actionDialog").close(); render();
  } catch (error) { $("actionError").textContent = error.message; }
};
function closeAction() { draft = null; $("actionDialog").close(); }
$("cancelAction").onclick = closeAction; $("closeAction").onclick = closeAction;
$("actionDialog").addEventListener("cancel", () => { draft = null; });
function renderInspector() {
  const c = $("inspectorContent"), t = selectedTrack(), a = selectedAction(), room = map().rooms.find(r => r.id === selection.room);
  $("selectionBadge").textContent = a ? "ACTION" : room ? "ROOM" : t ? "TRACK" : "MAP";
  c.replaceChildren();
  if (room) {
    const edit = (k, v) => commit((p, m) => { m.rooms.find(r => r.id === room.id)[k] = v; });
    c.append(field("部屋名", room.name, v => edit("name", v)));
    if (room.cells) c.append(button("部屋の形・床材・家具を編集", () => editCurrentMap(), "wide"));
    else c.append(
      row(field("左下 X", room.x, v => edit("x", v), "number"), field("左下 Y", room.y, v => edit("y", v), "number")),
      row(field("幅", room.width, v => edit("width", v), "number"), field("高さ", room.height, v => edit("height", v), "number")));
    c.append(
      select("空間の見た目", room.appearance ?? "standard",
        [["standard", "標準"], ["elevator", "エレベーター"], ["continuing-hall", "画面外へ続くホール"]],
        v => edit("appearance", v)),
      field("カラー", room.color, v => edit("color", v), "color"),
      button("部屋の行を追加", () => addTrack("room", room.id), "wide"),
      button("部屋を削除", async () => {
        if (entries(map()).some(e => e.a.roomId === room.id) || map().tracks.some(t => t.roomId === room.id || t.initial?.roomId === room.id))
          throw new Error("この部屋は行・移動先・初期位置で使用中です。先に関連付けを変更してください。");
        if (await confirm("部屋を削除", room.name)) {
          commit((p, m) => {
            m.rooms = m.rooms.filter(r => r.id !== room.id);
            if (m.floorPlan) for (const key of ["doors", "furniture"])
              m.floorPlan[key] = m.floorPlan[key].filter(item => item.roomId !== room.id);
          }); selection = {}; render();
        }
      }, "wide danger")); return;
  }
  if (a) {
    const state = previewState(map(), time).actionStates[a.id];
    c.append(node("h3", { text: a.name }), node("div", { class: "summary-card", text: `${TYPES[a.type]} · ${state?.status ?? "waiting"}` }),
      button(t.kind === "robot" ? "シーケンスを一括設定" : "アクションを編集",
        () => openAction(t.id, a.id), "wide primary"),
      ...(t.initial ? [button("初期位置を設定", () => editInitial(t), "wide")] : []),
      section("実行順", node("p", { class: "help", text: ["ordered", "timed"].includes(map().executionMode) ?
        `行内の ${orderedActions(t).indexOf(a) + 1} 番目。バーの開始時刻と長さどおりに実行します。` : "時間軸実行" }),
        node("p", { class: "help", text: state?.start === null ? "実行不可：通行・行内の重複・行の除外を確認してください。" :
          `模擬開始 ${formatTime(state.start)} / 完了 ${formatTime(state.end)}` })),
      ...(state.result ? [section("実行結果（模擬）",
        node("p", { id: "actionResult", class: "help", text: resultText(state.result) }))] : []),
      button("複製", duplicateAction, "wide"), button("削除", deleteSelection, "wide danger"),
      button("行の設定", () => choose(t.id), "wide quiet")); return;
  }
  if (!t) {
    c.append(node("h3", { text: "順番に、空間をつなぐ。" }),
      node("p", { class: "quick-help", text: "行を追加し、移動やイベントを時間軸へドラッグ。左端が開始、右端が終了です。接続条件はありません。" }),
      node("p", { class: "help", text: map().executionMode === "timed" ?
        "バーの開始・終了・幅どおりに実行します。同じ行で時間が重なる場合はエラーです。" : map().executionMode === "ordered" ?
        "同じ行は左→右に、前の項目の完了を待って実行します。別の行は独立して進みます。空白の間隔は待機時間ではありません。" :
        "旧方式では横軸は予定位置です。「時間軸実行へ切替」で位置と幅を実行へ反映できます。" })); return;
  }
  const edit = (k, v) => {
    if (t.locked) throw new Error("この行はロックされています。");
    commit((p, m) => { m.tracks.find(x => x.id === t.id)[k] = v; });
  };
  c.append(field("行名 / クラス名", t.name, v => edit("name", v)), field("カラー", t.color, v => edit("color", v), "color"));
  c.prepend(button("シーケンスを一括設定", () => openSequenceEditor(t.id), "wide primary"));
  if (t.kind === "human") c.append(field("人数（全員で移動）", t.count, v => edit("count", v), "number", { min: 1, max: 1000, step: 1 }));
  if (t.kind === "robot") c.append(
    select("ロボット種別", t.robotRole ?? "cleaning", ROBOT_ROLES, v => edit("robotRole", v)),
    field("ロボットID", t.robotId, v => edit("robotId", v), "number", { min: 0, max: 99, step: 1 }),
    node("p", { class: "help", text: "車体：100 × 100 mm（50インチ・16:9換算）" }));
  if (t.initial) {
    c.append(button("初期位置を設定", () => editInitial(t), "wide primary"));
    c.append(section("初期姿勢", node("p", { class: "help",
      text: `MAPで指定 · X ${t.initial.x.toFixed(2)} / Y ${t.initial.y.toFixed(2)} / 向き ${t.initial.yaw}°` })));
  }
  if (t.kind === "room") c.append(select("部屋", t.roomId, [["", "選択してください"], ...map().rooms.map(r => [r.id, r.name])], v => edit("roomId", v)));
  c.append(section("アクション追加", ...availableTypes(t).map(type => button(`＋ ${TYPES[type]}`, () => openAction(t.id, null, type), "wide"))),
    row(button("↑ 上へ", () => reorder(-1)), button("↓ 下へ", () => reorder(1))),
    button("行を削除", deleteSelection, "wide danger"));
}
function reorder(direction) {
  if (selectedTrack()?.locked) throw new Error("この行はロックされています。");
  commit((p, m) => {
    const i = m.tracks.findIndex(t => t.id === selection.track), j = i + direction;
    if (j < 0 || j >= m.tracks.length) throw new Error("これ以上移動できません。");
    [m.tracks[i], m.tracks[j]] = [m.tracks[j], m.tracks[i]];
  });
}
function trackForPlacement(m, kind, roomId) {
  if (m.tracks.length >= 128) throw new Error("トラックは最大128本です。");
  if (kind === "room" && m.floorPlan && !m.rooms.length)
    throw new Error("先にマップ編集で部屋・廊下を作成してください。");
  if (kind === "room" && !m.rooms.length) m.rooms.push({
      id: uid(), name: "部屋 1", x: 450, y: 300, width: 450, height: 300, color: COLORS[0],
    });
    const t = newTrack(m, kind); if (roomId) t.roomId = roomId;
    if (t.initial && m.executionMode === "timed") {
      const safety = createSafety(m);
      let location;
      for (const cell of safety.navigation.cells ?? []) {
        const point = { x: (cell.cell % 32 + .5) * 50, y: (17.5 - Math.floor(cell.cell / 32)) * 50 };
        if (cell.traversable && !pathProblem(safety, point, point, t.kind) &&
          m.tracks.filter(t => t.initial).every(t => Math.hypot(
            t.initial.x - point.x, t.initial.y - point.y) >=
              (t.kind === "robot" ? ROBOT_RADIUS : HUMAN_RADIUS) +
              (kind === "robot" ? ROBOT_RADIUS : HUMAN_RADIUS) + 5)) {
          location = { ...point, roomId: cell.roomId }; break;
        }
      }
      if (!location) throw new Error("初期位置を配置できる空きがありません。先にグリッドMAPの部屋・廊下を広げてください。");
      Object.assign(t.initial, location);
    }
  return t;
}
function addTrack(kind, roomId, index = map().tracks.length) {
  let id;
  commit((p, m) => {
    const t = trackForPlacement(m, kind, roomId);
    m.tracks.splice(index, 0, t); id = t.id;
  }, "行を追加しました。");
  choose(id); revealSelection();
  if (kind === "robot") {
    placementTrack = id; time = 0; preview(); openSequenceEditor(id);
  }
}
function duplicateAction() {
  const t = selectedTrack(), a = selectedAction();
  if (!a || t.locked) throw new Error("編集可能なアクションを選択してください。");
  let id;
  commit((p, m) => {
    const copy = clone(a); copy.id = uid(); id = copy.id; copy.position += 6;
    copy.name = `${copy.name.slice(0, 110)} copy`;
    if (["show", "event-start"].includes(copy.type)) copy.targetId = uid();
    m.tracks.find(x => x.id === t.id).actions.push(copy);
  }); choose(t.id, id);
}
async function deleteSelection() {
  const t = selectedTrack(), a = selectedAction();
  if (!t || t.locked) throw new Error("編集可能な行・アクションを選択してください。");
  const ids = a && selectedBlocks.size ? new Set(selectedBlocks) : new Set(a ? [a.id] : []);
  if (map().tracks.some(track => track.locked && track.actions.some(action => ids.has(action.id)))) {
    throw new Error("選択に編集ロック中の行が含まれます。");
  }
  if (!await confirm("削除の確認", `${ids.size > 1 ? `${ids.size}件のブロック` : a?.name ?? t.name}を削除します。元に戻せます。`)) return;
  commit((p, m) => {
    if (a) for (const track of m.tracks) track.actions = track.actions.filter(action => !ids.has(action.id));
    else m.tracks = m.tracks.filter(x => x.id !== t.id);
  }); selection = {}; selectedBlocks.clear(); render();
}
function preview(options = {}) {
  const m = map(), state = previewState(m, time);
  renderPresentation($("scenarioLayer"), m.presentation, time);
  const roomActivityActors = new Set(state.roomActivities.flatMap(activity => activity.actorIds)
    .filter(id => id !== placementTrack));
  if (renderedMap !== m) {
    renderedMap = m; roomStamp = ""; displayStamp = ""; pathStamp = "";
  }
  const warningKey = JSON.stringify([state.errors, state.warnings]);
  if ($("safetyWarnings").dataset.key !== warningKey) {
    $("safetyWarnings").dataset.key = warningKey;
    $("safetyWarnings").replaceChildren(...[
      ...state.errors, ...(state.warnings ?? []).map(w => w.message),
    ].map(message => node("p", { text: message })));
    $("safetyWarnings").hidden = !state.errors.length && !state.warnings?.length;
  }
  const result = selectedAction() && state.actionStates[selectedAction().id]?.result;
  if ($("actionResult") && result) $("actionResult").textContent = resultText(result);
  $("stage").classList.toggle("has-floor-plan", !!m.floorPlan);
  if (floorCache !== m) {
    floorCache = m;
    $("floorLayer").replaceChildren(...(m.floorPlan ? [renderFloorPlan(m)] : []));
    // 部屋のハッチやイベントで扉を覆わず、車体は引き続き扉より手前に描く。
    $("doorLayer").replaceChildren(...$("floorLayer").querySelectorAll("[data-auto-door]"));
  }
  updateAutomaticDoors($("doorLayer"), state.actors, state.doors);
  const error = state.errors.join(" / ");
  if (error !== runtimeError) {
    const hadError = !!runtimeError;
    runtimeError = error;
    if (error) notify(`実行できない動作があります：${error}`, true);
    else if (hadError) notify("現在のマップの実行競合が解消されました。");
  }
  if (bgCache !== m.background?.data) {
    bgCache = m.background?.data;
    if (bgCache) $("floorImage").setAttribute("href", bgCache); else $("floorImage").removeAttribute("href");
  }
  $("floorImage").setAttribute("opacity", m.background?.opacity ?? .7);
  $("emptyFloor").style.display = m.background || m.floorPlan ? "none" : "";
  $("gridLayer").style.display = $("showGrid").checked ? "" : "none";
  const nextRooms = JSON.stringify([state.events, state.roomActivities, state.actors.map(a =>
    [a.id, a.roomId, a.aggregated])]);
  if (nextRooms !== roomStamp) {
    roomStamp = nextRooms;
    $("roomLayer").replaceChildren(...m.rooms.map(r => {
    const events = state.events.filter(e => e.roomId === r.id);
    const occupants = state.actors.filter(a => a.roomId === r.id && a.aggregated);
    const humans = occupants.filter(a => a.kind === "human").reduce((n, a) => n + a.count, 0);
    const robots = occupants.filter(a => a.kind === "robot").length;
    const anchor = roomAnchor(r);
    const g = shape("g", { class: "stage-room", "data-room": r.id }, m.floorPlan ? [] : [
      shape("rect", { x: r.x, y: 900 - r.y - r.height, width: r.width, height: r.height, fill: r.color, "fill-opacity": .06, stroke: r.color, rx: 8 }),
      shape("text", { x: r.x + 12, y: 900 - r.y - r.height + 28, fill: r.color, text: r.name }),
    ]);
    events.forEach(e => g.append(eventGraphic(r, e)));
    const activity = state.roomActivities?.find(activity => activity.roomId === r.id);
    if (activity) {
      const graphic = eventGraphic(r, {
        id: `robot-room-${r.id}`, state: "meeting", text: activity.text,
        hatchStyle: "diagonal", hatchColor: "#73d9ba",
      });
      graphic.removeAttribute("data-stage-action");
      graphic.setAttribute("data-room-activity", r.id);
      graphic.setAttribute("pointer-events", "none");
      if (events.length) graphic.querySelector("text").setAttribute("y", 900 - roomAnchor(r).y + 75);
      g.append(graphic);
    }
    if (occupants.length) {
      const title = occupants.map(a => `${a.name}${a.kind === "human" ? ` ${a.count}名` : ""}`).join(" / ");
      const badgeX = r.cells ? anchor.x - 100 : r.x + 12, badgeY = r.cells ? 900 - anchor.y + 65 : 900 - r.y - 48;
      g.append(shape("title", { text: title }), shape("rect", { x: badgeX, y: badgeY, width: 220, height: 32, rx: 8, fill: "#262938", stroke: r.color }),
        shape("text", { x: badgeX + 12, y: badgeY + 22, fill: "#e6e2f9", "font-size": 17, text: `人 ${humans}名  /  ロボット ${robots}台` }));
    }
    return g;
    }));
  }
  const paths = [];
  const nextPaths = String($("showPaths").checked);
  if (nextPaths !== pathStamp) {
    pathStamp = nextPaths;
    if ($("showPaths").checked) for (const t of m.tracks.filter(t => t.initial && !t.muted)) {
    let from = t.initial;
    for (const a of t.actions.filter(a => a.type === "move" && a.motion !== "rotate").sort((a, b) =>
      (state.actionStates[a.id]?.start ?? Infinity) - (state.actionStates[b.id]?.start ?? Infinity))) {
      paths.push(shape("line", { x1: from.x, y1: 900 - from.y, x2: a.x, y2: 900 - a.y, stroke: t.color, "stroke-width": 2, "stroke-dasharray": "8 8", opacity: .3 }));
      from = a;
    }
  }
    $("pathLayer").replaceChildren(...paths);
  }
  const nextDisplays = JSON.stringify([state.displays, state.roomActivities, selection.action,
    state.actors.map(a => [a.id, a.aggregated])]);
  if (nextDisplays !== displayStamp) {
    displayStamp = nextDisplays;
    $("effectLayer").replaceChildren(...state.displays.filter(d =>
    !roomActivityActors.has(d.actorId) &&
    !state.actors.find(a => a.id === d.actorId)?.aggregated).map(d => {
    const actor = state.actors.find(a => a.id === d.actorId);
    const graphic = displayGraphic(d, actor ? actor.x : d.x, actor ? actor.y + 75 : d.y);
    if (actor) graphic.dataset.followActor = actor.id;
    if (selection.action === d.actionId) graphic.classList.add("selected");
    return graphic;
    }));
  }
  for (const graphic of $("effectLayer").querySelectorAll("[data-follow-actor]")) {
    const actor = state.actors.find(a => a.id === graphic.dataset.followActor);
    graphic.setAttribute("transform", `translate(${actor.x} ${900 - actor.y - 75})`);
  }
  const actors = [];
  for (const a of state.actors) {
    if (roomActivityActors.has(a.id)) continue;
    if (a.aggregated && selection.track !== a.id) continue;
    const g = actorGlyph(a);
    g.setAttribute("class", "stage-robot"); g.setAttribute("data-actor", a.id);
    g.setAttribute("opacity", a.aggregated ? .35 : 1);
    g.append(shape("text", { x: 0, y: 78, class: "robot-label", "text-anchor": "middle", text: `${a.name}${a.kind === "human" ? ` ×${a.count}` : ""}${a.aggregated ? "（在室・編集位置）" : ""}` }));
    actors.push(g);
  }
  if (!options.preserveActors) $("robotLayer").replaceChildren(...actors);
  renderStageFocus(state, roomActivityActors);
  const a = selectedAction(), t = selectedTrack();
  $("handleLayer").replaceChildren(...(a && a.motion !== "rotate" && ["move", "show"].includes(a.type) ? [
    shape("circle", { cx: a.x, cy: 900 - a.y, r: 12, fill: "#242038", stroke: "#ddc7ff", "stroke-width": 3, class: "waypoint", "data-waypoint": a.id }),
    shape("text", { x: a.x + 20, y: 900 - a.y - 15, fill: t.color, "font-size": 18, text: "POINT" }),
  ] : []));
  $("pickHint").hidden = true; $("proximity").hidden = true;
  for (const card of document.querySelectorAll(".action-node")) {
    const status = state.actionStates[card.dataset.action]?.status ?? "waiting";
    if (card.dataset.status !== status) {
      card.classList.remove("waiting", "running", "complete", "blocked", "failed", "timeout");
      card.classList.add(status); card.dataset.status = status;
    }
  }
  playhead();
}
function renderStageFocus(state, roomActivityActors) {
      let layer = $("stageSelection");
      if (!layer) { layer = shape("g", { id: "stageSelection", "pointer-events": "none" }); $("stage").append(layer); }
      const track = selectedTrack(), action = selectedAction();
      const actor = state.actors.find(a => a.id === track?.id && !roomActivityActors.has(a.id));
      const roomId = selection.room ?? (track?.kind === "room" ? action?.roomId || track.roomId : null);
      const room = map().rooms.find(r => r.id === roomId);
      const key = actor ? `actor:${actor.id}` : room ? `room:${room.id}` : "";
      if (focusMap !== map() || focusKey !== key) {
        focusMap = map(); focusKey = key; layer.replaceChildren();
        if (actor || room) {
          const bounds = actor ? { x: actor.kind === "robot" ? -ROBOT_SIDE / 2 - 12 : -46,
            y: actor.kind === "robot" ? -ROBOT_SIDE / 2 - 12 : -48,
            width: actor.kind === "robot" ? ROBOT_SIDE + 24 : 92,
            height: actor.kind === "robot" ? ROBOT_SIDE + 24 : 102 } :
            { x: room.x - 6, y: 900 - room.y - room.height - 6, width: room.width + 12, height: room.height + 12 };
          for (const style of ["selection-outline", "selection-runner"]) layer.append(shape("rect", {
            ...bounds, rx: actor ? 22 : 14, pathLength: 100, class: style,
          }));
          layer.setAttribute("data-focus", key);
        } else layer.removeAttribute("data-focus");
      }
      layer.setAttribute("transform", actor ? `translate(${actor.x} ${900 - actor.y})` : "");
    }
function playhead() {
  $("previewTime").textContent = formatTime(time); $("timelineTime").textContent = formatTime(time);
  const duration = Math.max(0, planFor(map()).duration);
  $("previewSeek").max = String(duration);
  $("previewSeek").value = String(Math.min(time, duration));
  $("previewSeek").setAttribute("aria-valuetext", `${formatTime(time)} / ${formatTime(duration)}`);
  $("playhead").style.left = `${time * px + 16}px`;
}
function stagePoint(e, mode = selectedAction()?.coordinateMode ?? "grid") {
  const p = new DOMPoint(e.clientX, e.clientY).matrixTransform($("stage").getScreenCTM().inverse());
  return coordinatePoint(p.x, 900 - p.y, mode);
}
$("stage").addEventListener("pointermove", e => { const p = stagePoint(e); $("stageCursor").textContent = `X ${p.x}  Y ${p.y}`; });
$("stage").addEventListener("click", safe(e => {
  if (previewPanel.classList.contains("preview-expanded")) return;
  const room = e.target.closest("[data-room]"), actor = e.target.closest("[data-actor]"),
    handle = e.target.closest("[data-waypoint]"), effect = e.target.closest("[data-stage-action]");
  if (handle) { revealSelection(); openAction(selection.track, handle.dataset.waypoint); }
  else if (effect) {
    const entry = entries(map()).find(({ a }) => a.id === effect.dataset.stageAction);
    if (!entry) throw new Error("表示に対応するアクションが見つかりません。");
    choose(entry.t.id, entry.a.id); revealSelection();
  }
  else if (actor) {
    selection = { track: actor.dataset.actor };
    selectedBlocks.clear();
    renderTimeline(); renderInspector(); preview({ preserveActors: true }); revealSelection();
  }
  else if (room) selectRoom(room.dataset.room);
}));
$("stage").addEventListener("dblclick", safe(e => {
  if (previewPanel.classList.contains("preview-expanded")) return;
  const actor = e.target.closest("[data-actor]");
  const track = map().tracks.find(t => t.id === actor?.dataset.actor);
  if (track?.kind === "robot") openSequenceEditor(track.id);
}));
$("stage").addEventListener("dragover", e => {
  if (!previewPanel.classList.contains("preview-expanded")) showDropPreview(e, selectedTrack());
});
$("stage").addEventListener("dragleave", e => { if (!$("stage").contains(e.relatedTarget)) clearDropPreview(); });
$("stage").addEventListener("drop", safe(e => {
  e.preventDefault();
  if (previewPanel.classList.contains("preview-expanded")) return;
  const t = selectedTrack(), candidate = dropCandidate(e, t);
  clearDropPreview();
  if (!candidate) return;
  if (candidate.reason) throw new Error(candidate.reason);
  openAction(t.id, null, candidate.type, candidate.overrides);
}));
function addRoom() {
  return editCurrentMap();
}
$("addRoom").onclick = safe(addRoom);
document.querySelectorAll("[data-add]").forEach(b => {
  b.onclick = safe(() => addTrack(b.dataset.add));
  b.draggable = true;
  b.addEventListener("dragstart", e => {
    paletteDragKind = b.dataset.add; paletteDragType = null; dropCache = null;
    e.dataTransfer.setData("application/x-scene-track", paletteDragKind);
    e.dataTransfer.effectAllowed = "copy";
  });
  b.addEventListener("dragend", () => { paletteDragKind = null; dropCache = null; clearDropPreview(); });
});
function trackInsertion(event) {
  const y = event.clientY - $("lanes").getBoundingClientRect().top;
  return clamp(Math.floor((y + 36) / 72), 0, map().tracks.length);
}
function previewTrackDrop(event) {
  const kind = paletteDragKind ?? event.dataTransfer?.getData("application/x-scene-track");
  if (!Object.hasOwn(KINDS, kind)) return null;
  const index = trackInsertion(event);
  const key = `track:${kind}`;
  if (dropCache?.key !== key) {
    let reason = "";
    try { trackForPlacement(clone(map()), kind); } catch (error) { reason = error.message; }
    dropCache = { key, value: reason };
  }
  event.preventDefault(); event.stopPropagation();
  event.dataTransfer.dropEffect = dropCache.value ? "none" : "copy";
  clearDropPreview();
  $("timelineCanvas").append(node("div", {
    class: `drop-preview track-drop-preview${dropCache.value ? " invalid" : ""}`,
    style: `top:${35 + index * 72}px`,
    role: "status", text: dropCache.value || `＋ ${KINDS[kind]}の行をここに追加`,
  }));
  return { kind, index, reason: dropCache.value };
}
for (const surface of [$("timelineScroll"), $("trackLabels")]) {
  surface.addEventListener("dragover", e => {
    if (paletteDragKind || e.dataTransfer?.types.includes("application/x-scene-track")) previewTrackDrop(e);
    else if (!e.defaultPrevented) {
      const index = clamp(Math.floor((e.clientY - $("lanes").getBoundingClientRect().top) / 72),
        0, map().tracks.length - 1);
      const track = map().tracks[index], lane = $("lanes").children[index];
      if (track && lane) showDropPreview(e, track, lane);
    }
  }, true);
  surface.addEventListener("drop", safe(e => {
    const candidate = previewTrackDrop(e);
    if (candidate) {
      clearDropPreview(); paletteDragKind = null; dropCache = null;
      if (candidate.reason) throw new Error(candidate.reason);
      addTrack(candidate.kind, undefined, candidate.index);
    } else if (surface === $("trackLabels")) {
      e.preventDefault(); clearDropPreview();
      const index = clamp(Math.floor((e.clientY - $("lanes").getBoundingClientRect().top) / 72),
        0, map().tracks.length - 1);
      const track = map().tracks[index], lane = $("lanes").children[index];
      if (!track || !lane) throw new Error("先に配置先の行を追加してください。");
      const action = dropCandidate(e, track, lane);
      if (action?.reason) throw new Error(action.reason);
      if (action) openAction(track.id, null, action.type, action.overrides);
    }
  }), true);
  surface.addEventListener("dragleave", e => { if (!surface.contains(e.relatedTarget)) clearDropPreview(); });
}
$("emptyTrack").onclick = safe(() => addTrack(selectedTrack()?.kind ?? "robot"));
$("addTrackMenu").onclick = () => { document.querySelector(".palette").scrollIntoView({ block: "nearest" }); notify("右のパレットから追加する行を選択してください。"); };
$("actionPalette").replaceChildren(...Object.entries(TYPES).map(([type, name]) => {
  const b = button(`${type === "move" ? "⌖" : "✦"} ${name}`, () => {
    const t = selectedTrack(); if (!t) throw new Error("配置先の行を選択してください。"); openAction(t.id, null, type, { position: quantize(time) });
  }, "action-palette-item");
  b.draggable = true; b.dataset.type = type;
  b.addEventListener("dragstart", e => {
    paletteDragType = type; paletteDragKind = null; dropCache = null;
    e.dataTransfer.setData("application/x-scene-action", type); e.dataTransfer.effectAllowed = "copy";
  });
  b.addEventListener("dragend", () => { paletteDragType = null; dropCache = null; clearDropPreview(); });
  return b;
}));
for (const [state, color] of [["meeting", "#a69bff"], ["fire", "#ff9670"], ["outage", "#8a98b0"]]) {
  const pattern = shape("pattern", { id: `hatch-${state}`, width: 24, height: 24, patternUnits: "userSpaceOnUse" }, [
    shape("path", { d: "M-6 6L6 -6 M0 24L24 0 M18 30L30 18", stroke: color, "stroke-width": 5 }),
    shape("animateTransform", { attributeName: "patternTransform", type: "translate", from: "0 0", to: "24 0", dur: state === "fire" ? "1s" : "3s", repeatCount: "indefinite" }),
  ]);
  $("stage").querySelector("defs").append(pattern);
}
const stageZoom = select("拡大", "1", [["1", "全体"], ["1.5", "150%"], ["2", "200%"], ["3", "300%"], ["4", "400%"]], v => { scale = Number(v); applyZoom(); });
stageZoom.classList.add("stage-zoom"); document.querySelector(".preview-tools").append(stageZoom);
function applyZoom() {
  $("stage").style.width = scale === 1 ? "" : `${Math.max(600, document.querySelector(".stage-wrap").clientWidth - 60) * scale}px`;
  $("stage").style.height = scale === 1 ? "" : "auto";
  $("stage").classList.toggle("zoomed", scale > 1); document.querySelector(".stage-wrap").classList.toggle("is-zoomed", scale > 1);
}
const previewPanel = document.querySelector(".preview");
const previewTransport = previewPanel.querySelector(".transport");
let previewScale = 1, controlsTimer, scrubbingPreview = false;
function showPreviewControls() {
  if (!previewPanel.classList.contains("preview-expanded")) return;
  clearTimeout(controlsTimer);
  previewPanel.classList.add("controls-visible");
  controlsTimer = setTimeout(() => {
    if (scrubbingPreview || previewTransport.querySelector(":focus-visible")) {
      showPreviewControls(); return;
    }
    previewPanel.classList.remove("controls-visible");
  }, 2400);
}
previewPanel.addEventListener("pointermove", showPreviewControls);
previewPanel.addEventListener("pointerdown", showPreviewControls);
previewTransport.addEventListener("focusin", showPreviewControls);
$("previewSeek").addEventListener("pointerdown", () => { scrubbingPreview = true; });
for (const event of ["pointerup", "pointercancel"]) document.addEventListener(event, () => {
  if (!scrubbingPreview) return;
  scrubbingPreview = false; showPreviewControls();
});
$("previewSeek").oninput = e => {
  pause(); time = clamp(Number(e.target.value), 0, planFor(map()).duration);
  preview(); showPreviewControls();
};
function expandedPreview(expanded) {
  if (expanded && !previewPanel.classList.contains("preview-expanded")) {
    previewScale = scale; scale = 1;
  } else if (!expanded && previewPanel.classList.contains("preview-expanded")) scale = previewScale;
  previewPanel.classList.toggle("preview-expanded", expanded);
  $("stage").setAttribute("preserveAspectRatio", expanded ? "none" : "xMidYMid meet");
  clearTimeout(controlsTimer);
  if (expanded) showPreviewControls();
  else {
    previewPanel.classList.remove("controls-visible");
    scrubbingPreview = false;
  }
  if (!expanded) {
    $("fullscreenStatus").hidden = true; $("fullscreenStatus").textContent = "";
  }
  $("fullscreenPreview").textContent = expanded ? "全画面を終了" : "全画面";
  $("fullscreenPreview").setAttribute("aria-pressed", String(expanded));
  stageZoom.querySelector("select").value = String(scale);
  applyZoom();
}
$("fullscreenPreview").onclick = safe(async () => {
  if (document.fullscreenElement === previewPanel) {
    await document.exitFullscreen(); expandedPreview(false); return;
  }
  if (previewPanel.classList.contains("preview-expanded")) { expandedPreview(false); return; }
  expandedPreview(true);
  if (previewPanel.requestFullscreen) {
    try { await previewPanel.requestFullscreen(); }
    catch (error) {
      const message = `ブラウザーの全画面表示が拒否されました。画面内で最大化します：${error.message}`;
      $("fullscreenStatus").textContent = message; $("fullscreenStatus").hidden = false;
      notify(message, true);
    }
  } else {
    const message = "ブラウザーが全画面APIに未対応のため、画面内で最大化しています。";
    $("fullscreenStatus").textContent = message; $("fullscreenStatus").hidden = false;
    notify(message);
  }
});
$("fitStage").onclick = () => $("fullscreenPreview").click();
document.addEventListener("fullscreenchange", () => {
  expandedPreview(document.fullscreenElement === previewPanel);
});
document.addEventListener("keydown", e => {
  if (previewPanel.classList.contains("preview-expanded") &&
    ["Tab", " ", "ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) showPreviewControls();
  if (previewPanel.classList.contains("preview-expanded") && e.key === "Tab") {
    const controls = [...previewTransport.querySelectorAll("button:not(:disabled),input,select")];
    const index = controls.indexOf(document.activeElement);
    if (index < 0 || !e.shiftKey && index === controls.length - 1 || e.shiftKey && index === 0) {
      e.preventDefault();
      controls[e.shiftKey ? controls.length - 1 : 0].focus();
    }
  }
  if (e.key === "Escape" && !document.fullscreenElement) expandedPreview(false);
});
$("showGrid").onchange = preview; $("showPaths").onchange = preview;
$("timelineScroll").addEventListener("scroll", () => { $("trackLabels").scrollTop = $("timelineScroll").scrollTop; });
$("trackLabels").addEventListener("wheel", e => { e.preventDefault(); $("timelineScroll").scrollTop += e.deltaY; }, { passive: false });
$("ruler").onpointerdown = e => {
  if (e.button !== 0) return; pause(); const r = $("ruler"); r.setPointerCapture(e.pointerId);
  const move = event => { time = clamp((event.clientX - r.getBoundingClientRect().left - 16) / px, 0, 3600); preview(); };
  move(e); const finish = () => { r.removeEventListener("pointermove", move); r.removeEventListener("pointerup", finish); r.removeEventListener("pointercancel", finish); };
  r.addEventListener("pointermove", move); r.addEventListener("pointerup", finish); r.addEventListener("pointercancel", finish);
};
function toggle() {
  if (running) pause(); else { running = true; last = performance.now(); $("play").textContent = "Ⅱ"; $("play").setAttribute("aria-label", "一時停止"); }
}
$("play").onclick = toggle; $("home").onclick = () => { pause(); time = 0; preview(); };
$("loop").onclick = () => { looping = !looping; $("loop").classList.toggle("active", looping); $("loop").setAttribute("aria-pressed", looping); };
$("speed").onchange = e => { speed = Number(e.target.value); };
$("zoom").oninput = e => { px = Number(e.target.value); renderTimeline(); };
$("snap").onclick = () => { snapping = !snapping; $("snap").classList.toggle("active", snapping); $("snap").setAttribute("aria-pressed", snapping); };
$("fitTimeline").onclick = () => { px = clamp(($("timelineScroll").clientWidth - 180) / horizon(), 12, 100); $("zoom").value = px; renderTimeline(); };
for (const [id, direction] of [["previous", -1], ["next", 1]]) $(id).onclick = () => {
  pause(); const s = previewState(map(), 3600);
  const points = [...new Set([0, ...Object.values(s.actionStates).flatMap(a => [a.start, a.end]).filter(Number.isFinite)])].sort((a, b) => a - b);
  time = direction === 1 ? points.find(t => t > time + .001) ?? time : points.findLast(t => t < time - .001) ?? 0; preview();
};
function animate(now) {
  if (running && !dragging) {
    if (now - last < 1000 / 30) { requestAnimationFrame(animate); return; }
    time += Math.min((now - last) / 1000, .2) * speed;
    const end = planFor(map()).duration;
    if (Number.isFinite(end) && time > end + .5) { if (looping) time = 0; else pause(); }
    preview();
  }
  last = now; requestAnimationFrame(animate);
}
function history(direction) {
  pause(); const from = direction === "undo" ? undo : redo, to = direction === "undo" ? redo : undo;
  if (!from.length) return;
  durableHistory.record(projectForSave(from.at(-1)), direction === "undo" ? "元に戻す" : "やり直す");
  to.push(project); project = from.pop();
  if (!project.maps.some(m => m.id === mapId)) mapId = project.maps[0].id;
  selection = {}; dirty = true; persistLocal(); render();
}
$("undo").onclick = safe(() => history("undo")); $("redo").onclick = safe(() => history("redo"));
$("openHistory").onclick = safe(async () => {
  pause();
  const dialog = $("historyDialog"), list = $("historyRecords");
  list.replaceChildren();
  dialog.showModal();
  const records = await durableHistory.list();
  if (!durableHistory.enabled) throw new Error("このサーバーでは履歴保存が無効です。");
  let shown = 0;
  const more = button("以前の履歴を表示", () => appendPage());
  const appendPage = () => {
    more.remove();
    const page = [...records].reverse().slice(shown, shown + 50);
    for (const record of page) {
      const row = node("div", { class: "history-record" });
      row.append(node("span", { text: `#${record.revision} · ${new Date(record.timestamp).toLocaleString()} · ${record.label}` }),
        button("この状態を適用", safe(async () => {
          if (!await confirm("履歴を適用",
            `履歴 #${record.revision} の状態へ切り替えます。現在や後続の履歴は削除せず、新しい履歴として保存します。`)) return;
          const snapshot = await durableHistory.get(record.revision);
          const next = validateProject(useTimelineOnly(clone(snapshot.project)));
          durableHistory.record(projectForSave(next), `履歴 #${record.revision} を再適用`, record.revision);
          undo.push(project); redo = []; project = next;
          mapId = project.maps[0].id; selection = {}; time = 0; dirty = true;
          persistLocal(); dialog.close(); render();
          notify(`履歴 #${record.revision} を適用しました。後の履歴も再適用できます。`);
        })));
      list.append(row);
    }
    shown += page.length; more.hidden = shown >= records.length;
    list.append(more);
  };
  appendPage();
  if (!records.length) list.append(node("p", { text: "保存済みの履歴はありません。" }));
});
$("closeHistory").onclick = () => $("historyDialog").close();
$("retryHistory").onclick = safe(() => durableHistory.retry());
$("executionMode").onclick = safe(async () => {
  if (!await confirm("時間軸実行v4へ切替",
    "先にJSONを保存してください。位置はグリッド中央へ、幅は実行秒数へ変わります。開始時刻・速度・後続が変わります。通れない経路があれば切替を拒否します。グリッドMAPの整備が必要です。旧版で開けないv4になります。Undoで戻せます。")) return;
  commit((p, m) => { enableTimedMap(m); }, "時間軸実行に切り替えました。実行時刻・通行予測を確認してください。");
  time = 0; preview();
});
$("projectName").onchange = safe(e => commit(p => { p.name = e.target.value; }));
$("duration").closest("label").style.display = "none";
function addRoomTracks(m, previousRooms) {
  for (const room of m.rooms.filter(r => !previousRooms.has(r.id))) {
    const track = newTrack(m, "room");
    track.name = room.name; track.roomId = room.id; track.color = room.color; m.tracks.push(track);
  }
}
async function editCurrentMap() {
  pause();
  const original = map(), edited = await editMap(original, candidate => {
    const p = clone(project);
    const replacement = clone(candidate);
    addRoomTracks(replacement, new Set(original.rooms.map(r => r.id)));
    p.maps[p.maps.findIndex(m => m.id === original.id)] = replacement;
    validateEdit(p);
  });
  if (!edited) return;
  for (const track of edited.tracks.filter(t => t.kind === "room")) {
    const before = original.rooms.find(r => r.id === track.roomId);
    const after = edited.rooms.find(r => r.id === track.roomId);
    if (before && after && track.name === before.name) track.name = after.name;
  }
  addRoomTracks(edited, new Set(original.rooms.map(r => r.id)));
  commit(p => { p.maps[p.maps.findIndex(m => m.id === original.id)] = edited; }, "マップを更新しました。シーケンスの接続は保持しています。");
}
$("editMap").onclick = safe(editCurrentMap);
function selectMapLayout() {
  const dialog = node("dialog", { class: "layout-picker", "aria-label": "シーケンスのマップを選択" });
  const form = node("form"), choices = node("div", { class: "layout-choices" });
  let choice = project.maps[0]?.id ?? "";
  for (const m of project.maps) {
    const input = node("input", { type: "radio", name: "map-layout", value: m.id,
      "aria-label": m.name });
    input.checked = m.id === choice; input.onchange = () => { choice = m.id; };
    const preview = shape("svg", { viewBox: "0 0 1600 900", "aria-hidden": "true" });
    if (m.background) preview.append(shape("image", { href: m.background.data,
      width: 1600, height: 900, preserveAspectRatio: "none" }));
    preview.append(renderFloorPlan(m));
    choices.append(node("label", { class: "layout-choice" }, [input, preview, node("strong", { text: m.name })]));
  }
  const blank = node("input", { type: "radio", name: "map-layout", value: "", "aria-label": "新しくマップを描く" });
  blank.onchange = () => { choice = ""; };
  choices.append(node("label", { class: "layout-choice blank" }, [blank,
    node("span", { class: "layout-blank", text: "＋" }), node("strong", { text: "新しくマップを描く" })]));
  form.append(node("h2", { text: "このシーケンスで使うマップは？" }),
    node("p", { class: "help", text: "既存の見た目を選ぶと、部屋・家具・床材をコピーします。動作は空で開始し、元のタブは変更しません。以後のマップ編集も各タブで独立します。" }),
    choices, node("div", { class: "dialog-actions" }, [
      button("キャンセル", () => { dialog.returnValue = "cancel"; dialog.close(); }),
      node("button", { type: "submit", class: "primary", text: "このマップで作成" }),
    ]));
  form.onsubmit = event => { event.preventDefault(); dialog.returnValue = "ok"; dialog.close(); };
  dialog.append(form); document.body.append(dialog); dialog.showModal();
  return new Promise(resolve => dialog.addEventListener("close", () => {
    const result = dialog.returnValue === "ok" ? choice : null;
    dialog.remove(); resolve(result);
  }, { once: true }));
}
$("addMap").onclick = safe(async () => {
  if (project.maps.length >= 8) throw new Error("マップは最大8件です。");
  pause();
  const layoutId = await selectMapLayout();
  if (layoutId === null) return;
  if (layoutId) {
    const source = project.maps.find(m => m.id === layoutId);
    if (!source) throw new Error("選択したマップが見つかりません。");
    const copied = copyMapLayout(source, `シーケンス ${project.maps.length + 1} · ${source.name}`.slice(0, 120));
    commit(p => { p.maps.push(copied); }, "マップをコピーして新しいシーケンスを作成しました。");
    mapId = copied.id; time = 0; selection = {}; render(); return;
  }
  const edited = await editMap({
    id: uid(), name: `マップ ${project.maps.length + 1}`, background: null, rooms: [], tracks: [],
    executionMode: "timed",
    floorPlan: { doors: [], furniture: [] },
  });
  if (!edited) return;
  addRoomTracks(edited, new Set());
  commit(p => { p.maps.push(edited); }, "マップと部屋の行を追加しました。");
  mapId = edited.id; time = 0; selection = {}; render();
});
$("openLatestDemo").onclick = safe(async () => {
  const existing = project.maps.find(m => m.demoRevision === 1);
  if (existing) { pause(); mapId = existing.id; time = 0; selection = {}; render(); return; }
  if (project.maps.length >= 8) throw new Error("マップは最大8件です。先にJSON保存し、不要なタブを削除してください。");
  pause();
  if (!await confirm("最新テストマップを開く",
    "人物5人・家具・自動ドアを含む最新のテストシーケンスを別タブに追加します。現在のマップは上書きしません。")) return;
  const demo = createFleetDemoMap().maps[0];
  demo.facingTurns = true; addFacingTurns(demo);
  commit(p => { p.maps.push(demo); }, "最新テストマップを開きました。以前のマップは元のタブに残っています。");
  mapId = demo.id; time = 0; selection = {}; render();
  $("timelineScroll").scrollTop = 0; $("timelineScroll").scrollLeft = 0;
});
$("renameMap").onclick = () => renameMap(mapId);
$("prepareFacingTurns").onclick = safe(async () => {
  pause();
  if (!await confirm("全マップに旋回バーを追加",
    "進行方向を向いてから直進するよう、独立した旋回バーを追加します。旋回時間を全行へ挿入するため、後続の開始時刻と、挿入時刻をまたぐバーの長さが変わります。今後の移動編集にも適用します。元に戻すことができます。")) return;
  commit(p => {
    p.facingTurns = true;
    for (const m of p.maps) m.facingTurns = true;
  }, "全マップに旋回バーを追加しました。時間軸の開始・終了と連携を確認してください。");
});
$("openOfficeDemo").onclick = safe(async () => {
  pause();
  let demo = project.maps.find(m => m.officeDemoRevision === 2) ??
    project.maps.find(m => m.officeDemoRevision);
  if (demo && demo.officeDemoRevision < 2) {
    if (!await confirm("オフィステストを更新",
      "社員とゲスト3名の案内・会議・清掃シナリオへ更新します。既存のオフィステストは元のタブに残し、新しいタブを追加します。")) return;
    demo = null;
  }
  demo = project.maps.find(m => m.officeDemoRevision === 2) ?? demo;
  if (!demo) {
    if (project.maps.length >= 8) throw new Error("マップは最大8件です。不要なタブを削除してから追加してください。");
    demo = createOfficeDemoMap().maps[0];
    commit(p => { p.maps.push(demo); }, "オフィスのテストマップを追加しました。既存のマップは保持しています。");
  }
  mapId = demo.id; time = 0; selection = {}; render();
  $("timelineScroll").scrollTop = 0; $("timelineScroll").scrollLeft = 0;
});
$("deleteMap").onclick = safe(async () => {
  if (project.maps.length === 1) throw new Error("最後のマップは削除できません。");
  if (await confirm("マップを削除", "このマップのシーケンス・背景・部屋をまとめて削除します。")) {
    commit(p => { p.maps = p.maps.filter(m => m.id !== mapId); }); time = 0; selection = {}; render();
  }
});
async function imageInfo(data) {
  const image = new Image(); image.src = data; await image.decode();
  if (!image.naturalWidth || image.naturalWidth > 16384 || image.naturalHeight > 16384) throw new Error("画像は各辺16384px以下にしてください。");
  if (Math.abs(image.naturalWidth / image.naturalHeight - 16 / 9) > .02) throw new Error("平面図は16:9に切り出してから読み込んでください。");
  return image;
}
$("importFloor").onclick = safe(editCurrentMap);
$("removeFloor").onclick = safe(() => commit((p, m) => { m.background = null; }));
$("opacity").onchange = safe(e => commit((p, m) => { if (m.background) m.background.opacity = Number(e.target.value); }));
function download() {
  validateProject(project);
  const blob = new Blob([JSON.stringify(projectForSave(project), null, 2)], { type: "application/json" });
  if (blob.size > 80 * 1024 * 1024) throw new Error("保存JSONが80MiBを超えています。背景画像の容量を減らしてください。");
  const url = URL.createObjectURL(blob);
  const a = node("a", { href: url, download: `${project.name.replace(/[\\/:*?"<>|]/g, "_") || "scene"}.robot-scene.json` });
  a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); dirty = false; render();
  notify("全マップ入りJSONの保存操作を開始しました。ダウンロード完了を確認してください。");
}
$("saveProject").onclick = safe(download); $("openProject").onclick = () => $("projectFile").click();
$("doorMode").onchange = safe(e => {
  commit((p, m) => { m.doorMode = e.target.value; },
    e.target.value === "story" ? "ストーリー確認：施錠を警告して移動を継続します。実機通行の許可ではありません。" :
      "連携確認：施錠中の通過を停止します。");
});
$("addCoordinationDemo").onclick = safe(() => {
  const demo = createCoordinationDemoMap($("coordinationDemo").value).maps[0];
  commit(p => { p.maps.push(demo); }, "2台連携シナリオを追加しました。");
  mapId = demo.id; selection = {}; selectedBlocks.clear(); time = 0; render();
});
$("openScenarioLibrary").onclick = safe(() => {
  pause();
  const dialog = node("dialog", { class: "scenario-library-dialog", "aria-label": "テストシナリオ集" });
  const close = () => { dialog.close(); dialog.remove(); };
  dialog.append(node("header", { class: "modal-heading" }, [
    node("h2", { text: "テストシナリオ集 · 16本" }), button("閉じる", close),
  ]), node("p", { class: "help", text: "選んだ1本を新しいタブへ追加します。既存の編集は保持します（最大8タブ）。検知・AI判断・建物連携は自動再生の模擬演出です。" }));
  const error = node("p", { role: "alert", class: "sequence-error" });
  for (const group of [...new Set(SCENARIO_LIBRARY.map(item => item.group))]) {
    dialog.append(node("h3", { text: group }));
    for (const item of SCENARIO_LIBRARY.filter(item => item.group === group)) {
      const card = node("article", { class: "scenario-library-card", "data-scenario": item.id }, [
        node("div", {}, [node("strong", { text: item.name }), node("p", { text: item.description })]),
        button("追加", safe(() => {
          error.textContent = "";
          if (project.maps.length >= 8) {
            error.textContent = "マップは最大8件です。JSON保存後、不要なタブを削除してから追加してください。";
            error.scrollIntoView({ block: "nearest" }); return;
          }
          const demo = createLibraryScenario(item.id).maps[0];
          commit(p => { p.maps.push(demo); }, `${item.name}を追加しました。`);
          mapId = demo.id; selection = {}; selectedBlocks.clear(); time = 0; render(); close();
        })),
      ]);
      dialog.append(card);
    }
  }
  dialog.append(error);
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
  dialog.addEventListener("keydown", event => event.stopPropagation());
  document.body.append(dialog); dialog.showModal();
});
$("exportScenario").onclick = safe(() => {
  const output = exportScenario(map());
  const url = URL.createObjectURL(new Blob([JSON.stringify(output, null, 2)], { type: "application/json" }));
  node("a", { href: url, download: "scenario-draft.json" }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  notify("連携検討用の予定データを出力しました。実機実行用ではありません。");
});
$("projectFile").onchange = safe(async e => {
  const file = e.target.files[0]; e.target.value = ""; if (!file) return;
  if (file.size > 80 * 1024 * 1024) throw new Error("プロジェクトは80MB以下にしてください。");
  const p = JSON.parse(await file.text());
  if (p.schema === "robot-scene/v1") throw new Error("旧v1は時間クリップ方式のため読込できません。元のJSONは変更せず保管してください。新規プロジェクトはv4の時間軸実行で作成します。");
  useTimelineOnly(p); validateProject(p);
  const removedOldDemo = replaceOldDemoMaps(p);
  refreshDemoScenarios(p); validateProject(p);
  for (const m of p.maps) if (m.background) await imageInfo(m.background.data);
  if (dirty && !await confirm("プロジェクトを開く", "現在の変更を置き換えます。必要ならキャンセルして保存してください。")) return;
  durableHistory.record(projectForSave(p), "JSONプロジェクト読込");
  pause(); undo.push(project); redo = []; project = p; mapId = p.maps[0].id; selection = {}; time = 0; dirty = false; persistLocal(); render();
  if (removedOldDemo) notify("古いテストマップを削除し、現在のテストマップへ整理しました。");
});
$("newProject").onclick = safe(async () => {
  if (!await confirm("新規プロジェクト", "現在の内容を置き換えます。必要なら先にJSON保存してください。")) return;
  const next = freshProject();
  durableHistory.record(projectForSave(next), "新規プロジェクト");
  pause(); undo.push(project); redo = []; project = next; mapId = project.maps[0].id; selection = {}; time = 0; dirty = true; persistLocal(); render();
});
document.addEventListener("keydown", safe(async e => {
  if (document.querySelector("dialog[open]")) return;
  const typing = ["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName);
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); download(); return; }
  if (typing) return;
  if (e.code === "Space") { e.preventDefault(); toggle(); }
  if (previewPanel.classList.contains("preview-expanded")) return;
  if (e.key === "Delete") { e.preventDefault(); await deleteSelection(); }
  if (e.ctrlKey || e.metaKey) {
    if (e.key.toLowerCase() === "z") { e.preventDefault(); history(e.shiftKey ? "redo" : "undo"); }
    if (e.key.toLowerCase() === "d") { e.preventDefault(); duplicateAction(); }
  }
}));
window.addEventListener("beforeunload", e => { if (dirty || durableHistory.pending) { e.preventDefault(); e.returnValue = ""; } });
document.addEventListener("visibilitychange", () => { if (document.hidden) pause(); });
window.addEventListener("resize", () => { applyZoom(); if (!dragging) renderTimeline(); });
let recovery = "", restoredChanged = false;
try {
  const saved = localStorage.getItem(STORE) ?? localStorage.getItem("robot-scene-studio.v3") ?? localStorage.getItem("robot-scene-studio.v2");
  if (saved) {
    const stored = JSON.parse(saved);
    const removedHumanTurns = stored.maps?.some(m => m.tracks?.some(t => t.kind === "human" &&
      t.actions?.some(a => a.type === "move" && a.motion === "rotate")));
    const defaultedStoryDoors = stored.maps?.some(m => m.doorMode === undefined);
    const migrated = validateProject(useTimelineOnly(clone(stored)));
    const removedOldDemo = replaceOldDemoMaps(migrated);
    const refreshedDemo = refreshDemoScenarios(migrated);
    validateProject(migrated);
    if (removedHumanTurns && !localStorage.getItem("robot-scene-studio.backup.before-human-turn-removal"))
      localStorage.setItem("robot-scene-studio.backup.before-human-turn-removal", saved);
    if (refreshedDemo && !localStorage.getItem("robot-scene-studio.backup.before-short-demo"))
      localStorage.setItem("robot-scene-studio.backup.before-short-demo", saved);
    if (removedOldDemo && !localStorage.getItem("robot-scene-studio.backup.before-old-demo-removal"))
      localStorage.setItem("robot-scene-studio.backup.before-old-demo-removal", saved);
    restoredChanged = JSON.stringify(migrated) !== JSON.stringify(stored);
    if (restoredChanged && !localStorage.getItem("robot-scene-studio.backup.before-timeline-only"))
      localStorage.setItem("robot-scene-studio.backup.before-timeline-only", saved);
    project = migrated; mapId = project.maps[0].id;
    recovery = defaultedStoryDoors ? "未設定の扉確認をストーリー確認へ切り替えました。施錠を警告して移動を継続します。実機通行の許可ではありません。" :
      removedHumanTurns ? "人間の旋回バーを削除しました。他のバーの時刻は保持し、元データは退避しています。" :
      refreshedDemo ? "テストシナリオを短縮し、充電場所の家具を整理しました。元データは退避済みです。" :
      removedOldDemo ? "古いテストマップを削除し、現在のテストマップへ整理しました。他のマップは保持しています。" : restoredChanged ?
      "元データを退避し、接続条件・合流を解除しました。バーの開始時刻と長さだけで実行します。" :
      "時間軸実行の作業状態を復元しました。";
  }
  else if (localStorage.getItem("robot-scene-studio.v1")) recovery = "旧v1の自動保存は残したまま、時間軸実行v4を新規に開いています。";
} catch (e) {
  recovery = `自動保存を復元できません：${e.message}。元データ保護のため自動保存を停止しました。作業はJSON保存してください。`;
  autosave.stop(recovery);
  restoredChanged = false;
  $("storageStatus").textContent = "AUTOSAVE FAILED";
}
document.querySelector(".floor-upload small").textContent = "32 × 18 GRID · 部屋 / 廊下 / ドア / 家具";
document.querySelector(".version").textContent = "α 0.6";
document.body.inert = true;
try {
  const latest = await durableHistory.initialize();
  if (latest) {
    if (JSON.stringify(projectForSave(project)) !== JSON.stringify(latest)) {
      const stored = localStorage.getItem(STORE);
      if (stored) localStorage.setItem("robot-scene-studio.backup.before-server-history", stored);
    }
    project = validateProject(useTimelineOnly(clone(latest)));
    mapId = project.maps[0].id;
    const defaultedStoryDoors = latest.maps.some(m => m.doorMode === undefined);
    if (JSON.stringify(projectForSave(project)) !== JSON.stringify(latest))
      durableHistory.record(projectForSave(project), "保存履歴の互換変換");
    persistLocal();
    recovery = defaultedStoryDoors ?
      "最新履歴を復元し、未設定の扉確認をストーリー確認へ切り替えました。施錠を警告して移動を継続します。実機通行の許可ではありません。" :
      "PC上に保存した最新の編集履歴を復元しました。";
  } else if (durableHistory.enabled) {
    durableHistory.record(projectForSave(project), "履歴記録開始");
    persistLocal();
  } else if (restoredChanged) persistLocal();
} catch (error) {
  $("historyStatus").textContent = `履歴初期化失敗：${error.message}`;
  recovery = `履歴を読み込めません：${error.message}。データ保護のため編集を停止しています。サーバーを確認し再読込してください。JSON保存は可能です。`;
  document.querySelector(".workspace").inert = true;
  for (const id of ["newProject", "projectFile", "openProject", "openLatestDemo", "openOfficeDemo", "openScenarioLibrary", "undo", "redo", "deleteMap", "renameMap", "addMap"])
    if ($(id)) $(id).disabled = true;
}
document.body.inert = false;
render(); notify(recovery || "時間軸の位置と幅が実行に反映されます。通行予測は実機の安全保証ではありません。");
requestAnimationFrame(animate);
