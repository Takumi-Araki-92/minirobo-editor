import {
  GRID_COLUMNS, GRID_ROWS, CELL_SIZE, CELL_COUNT, MATERIALS, EDGES,
  FURNITURE_TYPES, regionBounds, rectangleCells, boundaryEdge, renderFloorPlan,
  validateFloorPlan, removeRegion, nearestDoorWall, mergedDoors,
  furnitureCells, rotateFurniture, SCREEN_WIDTH_MM, SCREEN_HEIGHT_MM, GRID_CELL_MM,
  equipmentRectangle, sixCellDoor, rectangularGate, elevatorPlacement,
} from "./floor-plan.js";

export { renderFloorPlan } from "./floor-plan.js";

const newId = () => crypto.randomUUID();
const colorPalette = ["#8d9bff", "#58d8ca", "#ffbd70", "#73bafa", "#bd9afa"];

export async function editMap(map, validate = () => {}) {
  if (document.getElementById("mapEditorDialog")) throw new Error("マップエディターは既に開いています。");
  let draft = structuredClone(map);
  const originalRoomIds = new Set(map.rooms.map(room => room.id));
  draft.floorPlan ??= { doors: [], furniture: [] };
  draft.floorPlan.walls ??= [];
  let selectedId = draft.rooms[0]?.id ?? "";
  let tool = "room", drawMode = "brush", selectedItem = null, stroke = null;
  let editorMode = "zoning", roomMenuOpen = false;
  let pendingElevatorId = null;
  const undo = [], redo = [];
  let historyState;
  let initializationError = "";
  const element = (tag, attributes = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes)) {
      if (key === "text") node.textContent = value;
      else if (key === "class") node.className = value;
      else node.setAttribute(key, value);
    }
    node.append(...children);
    return node;
  };
  const button = (label, callback, className = "") => {
    const node = element("button", { type: "button", text: label, class: className });
    node.addEventListener("click", callback);
    return node;
  };
  const label = (title, control) => element("label", { class: "me-field" },
    [element("span", { text: title }), control]);
  const select = options => element("select", {}, options.map(([value, title]) =>
    element("option", { value, text: title })));

  // 旧矩形の変換は作業コピーだけに行い、取消時には元の寸法も残す。
  try {
    const occupied = new Set(draft.rooms.filter(room => Array.isArray(room.cells))
      .flatMap(room => room.cells));
    for (const room of draft.rooms) {
      if (!Array.isArray(room.cells)) {
        const candidates = rectangleCells(room).filter(cell => !occupied.has(cell));
        if (!candidates.length) {
          const centerX = room.x + room.width / 2, centerY = room.y + room.height / 2;
          const available = Array.from({ length: CELL_COUNT }, (_, cell) => cell)
            .filter(cell => !occupied.has(cell));
          available.sort((a, b) => {
            const distance = cell => ((cell % GRID_COLUMNS + .5) * CELL_SIZE - centerX) ** 2 +
              ((GRID_ROWS - Math.floor(cell / GRID_COLUMNS) - .5) * CELL_SIZE - centerY) ** 2;
            return distance(a) - distance(b);
          });
          if (available.length) candidates.push(available[0]);
        }
        room.cells = candidates;
        candidates.forEach(cell => occupied.add(cell));
      }
      room.kind ??= "room";
      room.material ??= room.kind === "corridor" ? "tile" : "concrete";
      if (room.cells.length) Object.assign(room, regionBounds(room.cells));
    }
    validateFloorPlan(draft);
  } catch (error) { initializationError = error.message; }

  const dialog = element("dialog", { id: "mapEditorDialog", class: "map-editor-dialog" });
  const mapName = element("input", { type: "text", maxlength: 120, "aria-label": "マップ名" });
  mapName.value = draft.name ?? "";
  const cancel = button("キャンセル", () => finish(null));
  const apply = button("マップに適用", save, "me-primary");
  const header = element("header", { class: "me-header" }, [
    element("div", {}, [element("small", { text: "FLOOR PLAN STUDIO" }),
      element("h2", { text: "グリッドで間取りを作成" })]),
    label("マップ名", mapName),
    element("div", { class: "me-header-actions" }, [cancel, apply]),
  ]);
  const regionSelect = select([]);
  const regionName = element("input", { type: "text", maxlength: 120 });
  const kind = select([["room", "部屋"], ["corridor", "廊下"]]);
  const material = select(MATERIALS.map(value => [value, {
    wood: "木目 / Wood", tile: "タイル / Tile", carpet: "カーペット / Carpet", concrete: "コンクリート / Concrete",
  }[value]]));
  const color = element("input", { type: "color" });
  const edge = select([["auto", "自動：近い壁にスナップ"], ...EDGES.map(value => [value, {
    top: "上辺", bottom: "下辺", left: "左辺", right: "右辺",
  }[value]])]);
  const furnitureType = select(FURNITURE_TYPES.map(value => [value, {
    desk: "デスク", chair: "チェア", plant: "観葉植物", "reception-monitor": "受付モニター",
  }[value]]));
  const objectName = element("input", { type: "text", maxlength: 120, "aria-label": "設備名" });
  const doorKind = select([["automatic", "自動ドア"], ["flapper", "フラッパーゲート"]]);
  const entrance = select([["bottom", "下辺入口 / 上下通行"], ["top", "上辺入口 / 上下通行"],
    ["left", "左辺入口 / 左右通行"], ["right", "右辺入口 / 左右通行"]]);
  entrance.setAttribute("aria-label", "新規設備の入口方向");
  entrance.addEventListener("change", () => { stroke = null; render(); });
  const createLabelToggle = () => {
    const checkbox = element("input", { type: "checkbox", "aria-label": "部屋名表示" });
    checkbox.checked = draft.floorPlan.showRoomLabels !== false;
    checkbox.addEventListener("change", () => {
      draft.floorPlan.showRoomLabels = checkbox.checked;
      syncLabelToggles();
      render();
    });
    return checkbox;
  };
  const zoningLabelToggle = createLabelToggle();
  const sidebarLabelToggle = createLabelToggle();
  function syncLabelToggles() {
    zoningLabelToggle.checked = draft.floorPlan.showRoomLabels !== false;
    sidebarLabelToggle.checked = zoningLabelToggle.checked;
  }
  const rotation = select([0, 90, 180, 270].map(value => [String(value), `${value}°`]));
  const errorBox = element("div", { class: "me-error", role: "alert", "aria-live": "polite" });
  const status = element("div", { class: "me-status", "aria-live": "polite" });
  const toolButtons = new Map();
  const tools = element("div", { class: "me-tools", role: "toolbar", "aria-label": "描画ツール" });
  const undoButton = button("↶ 戻す", () => history("undo"));
  const redoButton = button("↷ やり直す", () => history("redo"));
  const zoningButton = button("ゾーニングモード", () => switchMode("zoning"));
  const roomButton = button("部屋編集モード", () => switchMode("room"));
  const modeBar = element("div", { class: "me-mode-bar", role: "toolbar", "aria-label": "マップ編集モード" },
    [zoningButton, roomButton, undoButton, redoButton]);
  for (const [value, title] of [
    ["room", "▧ 部屋を塗る"], ["corridor", "▤ 廊下を塗る"], ["erase", "⌫ 消しゴム"],
    ["elevator", "▥ エレベーターを追加"], ["select", "↖ 選択"], ["door", "↔ 自動ドア"],
    ["gate", "▤ フラッパーゲート"], ["partition", "━ 間仕切り壁"],
    ["furniture", "▣ 家具"], ["charging", "⚡ 充電スペース"],
  ]) {
    const node = button(title, () => {
      if (value === "elevator") {
        stroke = null; selectedItem = null;
        tool = "elevator";
        createRegion();
        return;
      }
      tool = value; stroke = null; selectedItem = null; setError(""); syncTools(); render();
    });
    toolButtons.set(value, node); tools.append(node);
  }
  const mode = select([["brush", "自由に塗る"], ["rectangle", "長方形ドラッグ"]]);
  mode.addEventListener("change", () => { drawMode = mode.value; stroke = null; render(); });
  const zoningControls = element("div", { class: "me-zoning-controls" }, [
    label("編集中の領域", regionSelect), button("＋ 新しい領域", createRegion),
    button("領域を削除", deleteRegion), label("描画", mode),
    label("部屋名表示", zoningLabelToggle),
  ]);
  tools.append(zoningControls, label("新規EV・ゲートの入口方向", entrance),
    element("p", { class: "me-help", text: "EVは入口6セル・奥行自由。ゲートは長方形ドラッグ。自動ドアはクリック位置から右／下へ連続6セルを一括配置（既存設備は変更しません）。" }));
  const sidebar = element("aside", { class: "me-sidebar" }, [
    element("h3", { text: "選択した部屋を編集" }),
    label("領域名", regionName), label("種類", kind), label("床材", material), label("アクセント", color),
    label("部屋名表示", sidebarLabelToggle),
    element("h3", { text: "ドア / 壁 / 家具" }),
    element("p", { class: "me-help", text: "自動ドアは6セル幅。ゲートは同じ部屋・廊下内に長方形でドラッグし、入口方向で通行軸を選びます。床領域は変更しません。" }),
    label("ドアの辺（通常は自動）", edge),
    label("家具の種類", furnitureType), label("家具の向き（反時計回り）", rotation),
    label("設備名", objectName), label("ドア種別", doorKind),
    element("div", { class: "me-item-actions" }, [
      button("90° 回転", rotateItem), button("選択物を削除", deleteItem),
    ]),
    element("p", { class: "me-help", text: "家具はドラッグ範囲のサイズで作成。複数セルは長机・長椅子、植物は縦横自由のサイズ。部屋の形状はゾーニングで編集。" }),
  ]);
  const ns = "http://www.w3.org/2000/svg";
  const canvas = document.createElementNS(ns, "svg");
  canvas.setAttribute("viewBox", "0 0 1600 900");
  canvas.setAttribute("role", "img");
  canvas.setAttribute("tabindex", "0");
  canvas.setAttribute("aria-label", "間取り。左上から32列18行、X右向きY上向き。");
  canvas.classList.add("me-canvas");
  const viewport = element("div", { class: "me-viewport" }, [canvas]);
  const workspace = element("section", { class: "me-workspace" }, [
    tools, viewport, element("div", { class: "me-coordinate-key",
      text: `50インチ・16:9の表示面 約${SCREEN_WIDTH_MM.toFixed(1)} × ${SCREEN_HEIGHT_MM.toFixed(1)} mm（ベゼル除外） · 32 × 18分割 · 1セル 約${GRID_CELL_MM.toFixed(1)} × ${GRID_CELL_MM.toFixed(1)} mm（50座標単位、実測ではない） · 家具は長方形ドラッグ · Ctrl+Z / Ctrl+Y` }),
    status, errorBox,
  ]);
  dialog.append(header, modeBar, element("div", { class: "me-body" }, [sidebar, workspace]));
  document.body.append(dialog);
  let resolveResult;
  const result = new Promise(resolve => { resolveResult = resolve; });
  let finished = false;
  function finish(value) {
    if (finished) return;
    finished = true;
    dialog.close(); dialog.remove(); resolveResult(value);
  }
  function setError(message) { errorBox.textContent = message; errorBox.hidden = !message; }
  function selectedRoom() { return draft.rooms.find(room => room.id === selectedId); }
  function snapshot() {
    return { map: structuredClone(draft), name: mapName.value, selectedId, selectedItem,
      pendingElevatorId, tool };
  }
  function recordHistory() {
    const state = snapshot();
    if (historyState && (JSON.stringify(state.map) !== JSON.stringify(historyState.map) ||
      state.name !== historyState.name)) {
      undo.push(historyState); if (undo.length > 100) undo.shift(); redo.length = 0;
    }
    historyState = state;
    undoButton.disabled = !undo.length; redoButton.disabled = !redo.length;
  }
  function history(direction) {
    if (stroke) { stroke = null; render(); return; }
    const from = direction === "undo" ? undo : redo, to = direction === "undo" ? redo : undo;
    if (!from.length) return;
    to.push(snapshot());
    const state = from.pop();
    draft = structuredClone(state.map); mapName.value = state.name;
    selectedId = state.selectedId; selectedItem = state.selectedItem;
    pendingElevatorId = state.pendingElevatorId;
    tool = state.tool;
    historyState = snapshot();
    roomMenuOpen = editorMode === "room" && !!selectedRoom();
    setError(""); syncFields(); syncTools(); render();
    canvas.focus({ preventScroll: true });
  }
  function switchMode(value) {
    stroke = null; selectedItem = null; editorMode = value; roomMenuOpen = false;
    tool = value === "room" ? "select" : selectedRoom()?.kind ?? "room";
    setError(""); syncTools(); render();
  }
  function syncTools() {
    for (const [value, node] of toolButtons) {
      node.hidden = editorMode === "zoning"
        ? ["door", "gate", "partition", "furniture", "charging", "select"].includes(value)
        : ["room", "corridor", "erase", "elevator"].includes(value);
      node.classList.toggle("active", value === tool);
      node.setAttribute("aria-pressed", String(value === tool));
    }
    zoningControls.hidden = editorMode !== "zoning";
    zoningButton.setAttribute("aria-pressed", editorMode === "zoning");
    roomButton.setAttribute("aria-pressed", editorMode === "room");
    zoningButton.classList.toggle("active", editorMode === "zoning");
    roomButton.classList.toggle("active", editorMode === "room");
  }
  function syncFields() {
    regionSelect.replaceChildren(...draft.rooms.map(room =>
      element("option", { value: room.id, text: `${room.kind === "corridor" ? "廊下" : "部屋"} · ${room.name}` })));
    regionSelect.value = selectedId;
    const room = selectedRoom();
    for (const field of [regionName, kind, material, color]) field.disabled = !room;
    regionName.value = room?.name ?? "";
    kind.value = room?.kind ?? "room";
    material.value = room?.material ?? "concrete";
    color.value = room?.color ?? "#8d9bff";
    const object = [...draft.floorPlan.doors, ...draft.floorPlan.walls]
      .find(item => item.id === selectedItem);
    objectName.value = object?.name ?? "";
    objectName.disabled = !object;
    doorKind.disabled = !draft.floorPlan.doors.some(item => item.id === selectedItem);
    doorKind.value = draft.floorPlan.doors.find(item => item.id === selectedItem)?.kind ?? "automatic";
  }
  function createRegion() {
    if (selectedRoom()?.appearance === "elevator" && !selectedRoom().cells.length) return;
    if (draft.rooms.length >= 100) { setError("領域は100件までです。"); return; }
    const regionName = tool === "corridor" ? "廊下" : tool === "elevator" ? "エレベーター" : "部屋";
    const room = {
      id: newId(), name: `${regionName} ${draft.rooms.length + 1}`,
      x: 0, y: 0, width: 50, height: 50,
      color: colorPalette[draft.rooms.length % colorPalette.length], cells: [],
      kind: tool === "corridor" ? "corridor" : "room",
      material: tool === "corridor" ? "tile" : "concrete",
      ...(tool === "elevator" ? { appearance: "elevator" } : {}),
    };
    draft.rooms.push(room); selectedId = room.id; selectedItem = null;
    if (tool === "elevator") pendingElevatorId = room.id;
    else if (!["room", "corridor"].includes(tool)) tool = room.kind;
    setError(""); syncFields(); syncTools(); render();
  }
  function deleteRegion() {
    try {
      if (!selectedRoom()) throw new Error("削除する領域を選択してください。");
      const updated = removeRegion(draft, selectedId);
      draft.rooms = updated.rooms;
      draft.floorPlan = updated.floorPlan;
      selectedId = draft.rooms[0]?.id ?? "";
      selectedItem = null; stroke = null;
      setError(""); syncFields(); render();
    } catch (error) { setError(error.message); }
  }
  function render() {
    sidebar.hidden = editorMode !== "room" || !roomMenuOpen || !selectedRoom();
    dialog.classList.toggle("me-context-open", !sidebar.hidden);
    canvas.replaceChildren(renderFloorPlan({ ...draft, rooms: draft.rooms.filter(room => room.cells?.length) }));
    const grid = document.createElementNS(ns, "path");
    const commands = [];
    for (let x = 0; x <= 1600; x += CELL_SIZE) commands.push(`M${x} 0V900`);
    for (let y = 0; y <= 900; y += CELL_SIZE) commands.push(`M0 ${y}H1600`);
    grid.setAttribute("d", commands.join(""));
    grid.setAttribute("class", "me-grid");
    canvas.append(grid);
    const svgPath = (cells, className) => {
      const path = document.createElementNS(ns, "path");
      path.setAttribute("d", cells.map(cell =>
        `M${cell % GRID_COLUMNS * CELL_SIZE} ${Math.floor(cell / GRID_COLUMNS) * CELL_SIZE}h50v50h-50Z`).join(""));
      path.setAttribute("class", className); path.setAttribute("pointer-events", "none");
      canvas.append(path);
    };
    const room = selectedRoom();
    if (room) svgPath(room.cells, "me-selection");
    if (stroke) svgPath([...stroke.cells], tool === "erase" ? "me-preview me-erase-preview" : "me-preview");
    if (selectedItem) {
      const item = [...draft.floorPlan.furniture, ...draft.floorPlan.doors].find(value => value.id === selectedItem);
      if (item && item.type) svgPath(furnitureCells(item), "me-item-selection");
      else if (item && Number.isInteger(item.cell)) svgPath([item.cell], "me-item-selection");
      const wall = draft.floorPlan.walls.find(value => value.id === selectedItem);
      if (wall) {
        const path = document.createElementNS(ns, "path");
        path.setAttribute("d", `M${wall.x1} ${wall.y1}L${wall.x2} ${wall.y2}`);
        path.setAttribute("class", "me-item-selection");
        path.setAttribute("pointer-events", "none");
        canvas.append(path);
      }
      const zone = draft.floorPlan.chargingZones?.find(z => z.id === selectedItem);
      if (zone) svgPath(rectangleCells(zone), "me-item-selection");
    }
    status.textContent = `${draft.rooms.length} 領域 / ${draft.rooms.reduce((sum, value) => sum + value.cells.length, 0)} セル` +
      `　·　${room ? `${room.name}: ${room.cells.length} セル` : "「新しい領域」を追加してください"}` +
      (selectedItem ? "　·　配置物を選択中" : "");
    const furniture = draft.floorPlan.furniture.find(item => item.id === selectedItem);
    const sizeCells = tool === "furniture" && stroke ? [...stroke.cells] :
      furniture ? furnitureCells(furniture) : null;
    if (sizeCells) {
      const bounds = regionBounds(sizeCells);
      status.textContent += `　·　${bounds.width / CELL_SIZE} × ${bounds.height / CELL_SIZE} セル` +
        ` / 約${(bounds.width / CELL_SIZE * GRID_CELL_MM).toFixed(1)} × ${(bounds.height / CELL_SIZE * GRID_CELL_MM).toFixed(1)} mm`;
    }
    recordHistory();
  }
  function removeInvalidFixtures() {
    const before = draft.floorPlan.furniture.length + draft.floorPlan.doors.length;
    draft.floorPlan.furniture = draft.floorPlan.furniture.filter(item =>
      furnitureCells(item).every(cell =>
        draft.rooms.find(room => room.id === item.roomId)?.cells.includes(cell)));
    const wallIds = new Set(draft.floorPlan.walls.map(wall => wall.id));
    draft.floorPlan.doors = draft.floorPlan.doors.filter(door => {
      if (Number.isFinite(door.x1)) return wallIds.has(door.wallId);
      const room = draft.rooms.find(value => value.id === door.roomId);
      return room && boundaryEdge(room, door.cell, door.edge);
    });
    if (before !== draft.floorPlan.furniture.length + draft.floorPlan.doors.length) {
      setError("形状変更により領域外になった家具・外周でなくなったドアを作業コピーから削除しました。");
    }
  }
  function commitStroke(cells) {
    setError("");
    if (tool === "elevator" && selectedId === pendingElevatorId) {
      try {
        const trial = elevatorPlacement(draft, pendingElevatorId, [...cells], entrance.value);
        draft = trial; pendingElevatorId = null; tool = "room";
        syncFields(); syncTools();
      } catch (error) { setError(error.message); }
      return;
    }
    if (tool === "erase") {
      const updates = draft.rooms.map(room => [room, room.cells.filter(cell => !cells.has(cell))]);
      const empty = updates.find(([room, remaining]) => room.cells.length && !remaining.length);
      if (empty) { setError(`「${empty[0].name}」の最後のセルは消せません。参照保護のため領域を維持します。`); return; }
      for (const [room, remaining] of updates) {
        room.cells = remaining;
        if (remaining.length) Object.assign(room, regionBounds(remaining));
      }
    } else {
      const room = selectedRoom();
      if (!room) { setError("先に「新しい領域」を追加してください。"); return; }
      const occupied = new Set(draft.rooms.filter(value => value !== room).flatMap(value => value.cells));
      if ([...cells].some(cell => occupied.has(cell))) {
        const overlaps = draft.rooms.filter(value => value !== room &&
          value.cells.some(cell => cells.has(cell)));
        if (room.appearance !== "elevator" || overlaps.some(value =>
          value.kind !== "corridor" || value.cells.every(cell => cells.has(cell)))) {
          setError("別の領域と重なっています。消しゴムで空けるか別のセルを選んでください。"); return;
        }
        // 広場・廊下を先に塗った場合も、エレベーターの専用領域を切り出せる。
        for (const corridor of overlaps) {
          corridor.cells = corridor.cells.filter(cell => !cells.has(cell));
          Object.assign(corridor, regionBounds(corridor.cells));
        }
      }
      room.cells = [...new Set([...room.cells, ...cells])].sort((a, b) => a - b);
      room.kind = tool;
      if (room.cells.length) Object.assign(room, regionBounds(room.cells));
    }
    removeInvalidFixtures(); syncFields();
  }
  function point(event) {
    const matrix = canvas.getScreenCTM();
    if (!matrix) return null;
    const position = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    if (position.x < 0 || position.x >= 1600 || position.y < 0 || position.y >= 900) return null;
    return Math.floor(position.y / CELL_SIZE) * GRID_COLUMNS + Math.floor(position.x / CELL_SIZE);
  }
  function canvasPoint(event) {
    const matrix = canvas.getScreenCTM();
    if (!matrix) return null;
    const position = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return { x: position.x, y: position.y };
  }
  function rectangle(start, end) {
    const cells = new Set();
    const x1 = start % GRID_COLUMNS, x2 = end % GRID_COLUMNS;
    const y1 = Math.floor(start / GRID_COLUMNS), y2 = Math.floor(end / GRID_COLUMNS);
    for (let row = Math.min(y1, y2); row <= Math.max(y1, y2); row++) {
      for (let column = Math.min(x1, x2); column <= Math.max(x1, x2); column++) cells.add(row * GRID_COLUMNS + column);
    }
    return cells;
  }
  function extendStroke(cell) {
    if (tool === "elevator" && selectedId === pendingElevatorId) {
      try {
        stroke.cells = new Set(equipmentRectangle(stroke.start, cell, entrance.value, true));
        stroke.invalid = false; setError("");
      } catch (error) {
        stroke.invalid = true; stroke.cells = new Set(); setError(error.message);
      }
    } else if (["furniture", "charging", "gate"].includes(tool) || drawMode === "rectangle") stroke.cells = rectangle(stroke.start, cell);
    else {
      // 高速ドラッグでもイベント間のセルが抜けないよう補間する。
      const from = stroke.last, x0 = from % GRID_COLUMNS, y0 = Math.floor(from / GRID_COLUMNS);
      const dx = cell % GRID_COLUMNS - x0, dy = Math.floor(cell / GRID_COLUMNS) - y0;
      const steps = Math.max(Math.abs(dx), Math.abs(dy), 1);
      for (let step = 0; step <= steps; step++) {
        stroke.cells.add(Math.round(y0 + dy * step / steps) * GRID_COLUMNS + Math.round(x0 + dx * step / steps));
      }
    }
    stroke.last = cell;
  }
  function placeDoor(event, previewOnly = false) {
    const p = canvasPoint(event);
    if (!p) return;
    const candidate = nearestDoorWall(draft, p.x, p.y, {
      roomId: selectedId, edge: edge.value, maxDistance: Math.max(30, 12 / canvas.getScreenCTM().a),
    });
    canvas.querySelector(".me-door-preview")?.remove();
    try {
      const doors = sixCellDoor(draft, candidate);
      if (previewOnly) {
        const line = document.createElementNS(ns, "path");
        line.setAttribute("d", doors.map(door => {
          if (door.wallId) return `M${door.x1} ${door.y1}L${door.x2} ${door.y2}`;
          const x = door.cell % GRID_COLUMNS * CELL_SIZE, y = Math.floor(door.cell / GRID_COLUMNS) * CELL_SIZE;
          return door.edge === "top" ? `M${x} ${y}h50` :
            door.edge === "bottom" ? `M${x} ${y + 50}h50` :
              door.edge === "left" ? `M${x} ${y}v50` : `M${x + 50} ${y}v50`;
        }).join(""));
        line.setAttribute("class", "me-door-preview");
        line.setAttribute("style", "fill:none;stroke:#ef9d36;stroke-width:10;pointer-events:none");
        canvas.append(line); return;
      }
      draft.floorPlan.doors.push(...doors);
      selectedItem = doors[0].id; selectedId = doors[0].roomId; roomMenuOpen = true;
      setError(""); syncFields(); render();
    } catch (error) { if (!previewOnly) setError(error.message); }
  }
  function placeGate(cells) {
    try {
      const { walls, door } = rectangularGate(draft, [...cells], entrance.value);
      draft.floorPlan.walls.push(...walls); draft.floorPlan.doors.push(door);
      selectedItem = door.id; selectedId = door.roomId; roomMenuOpen = true;
      setError(""); syncFields();
    } catch (error) { setError(error.message); }
  }
  function place(cell, target) {
    setError("");
    const room = draft.rooms.find(value => value.cells.includes(cell));
    if (tool === "select") {
      selectedItem = target.closest("[data-furniture]")?.getAttribute("data-furniture") ??
        target.closest("[data-door]")?.getAttribute("data-door") ??
        target.closest("[data-partition-wall]")?.getAttribute("data-partition-wall") ??
        target.closest("[data-charging-zone]")?.getAttribute("data-charging-zone") ?? null;
      if (!selectedItem) {
        const item = draft.floorPlan.furniture.find(value => furnitureCells(value).includes(cell));
        selectedItem = item?.id ?? null;
      }
      if (room) selectedId = room.id;
      roomMenuOpen = !!room;
      const item = draft.floorPlan.furniture.find(value => value.id === selectedItem);
      if (item) { rotation.value = String(item.rotation); furnitureType.value = item.type; }
      const door = draft.floorPlan.doors.find(value => value.id === selectedItem);
      if (door) doorKind.value = door.kind ?? "automatic";
      const equipment = [...draft.floorPlan.doors, ...draft.floorPlan.walls]
        .find(value => value.id === selectedItem);
      if (!room && equipment) selectedId = equipment.roomId;
      roomMenuOpen = !!selectedRoom();
      syncFields(); render(); return;
    }
  }
  function placeWall(start, end) {
    if (start === end) { setError("間仕切り壁は2セル以上の距離でドラッグしてください。"); return; }
    const room = draft.rooms.find(value => value.cells.includes(start)) ?? selectedRoom();
    if (!room) { setError("間仕切り壁の領域を選択してください。"); return; }
    const c1 = start % GRID_COLUMNS, c2 = end % GRID_COLUMNS;
    const r1 = Math.floor(start / GRID_COLUMNS), r2 = Math.floor(end / GRID_COLUMNS);
    const horizontal = Math.abs(c2 - c1) >= Math.abs(r2 - r1);
    const wall = horizontal ? {
      id: newId(), roomId: room.id, name: `Partition wall ${draft.floorPlan.walls.length + 1}`,
      x1: Math.min(c1, c2) * CELL_SIZE + CELL_SIZE / 2,
      y1: r1 * CELL_SIZE + CELL_SIZE / 2,
      x2: Math.max(c1, c2) * CELL_SIZE + CELL_SIZE / 2,
      y2: r1 * CELL_SIZE + CELL_SIZE / 2,
    } : {
      id: newId(), roomId: room.id, name: `Partition wall ${draft.floorPlan.walls.length + 1}`,
      x1: c1 * CELL_SIZE + CELL_SIZE / 2,
      y1: Math.min(r1, r2) * CELL_SIZE + CELL_SIZE / 2,
      x2: c1 * CELL_SIZE + CELL_SIZE / 2,
      y2: Math.max(r1, r2) * CELL_SIZE + CELL_SIZE / 2,
    };
    const trial = structuredClone(draft);
    trial.floorPlan.walls.push(wall);
    try { validateFloorPlan(trial); } catch (error) { setError(error.message); return; }
    draft.floorPlan.walls.push(wall); selectedItem = wall.id; selectedId = room.id;
    roomMenuOpen = true; setError(""); syncFields();
  }
  function placeFurniture(cells) {
    const occupied = [...cells].sort((a, b) => a - b);
    const room = draft.rooms.find(value => value.cells.includes(occupied[0]));
    if (!room) { setError("家具は領域内に配置してください。"); return; }
    const item = { id: newId(), roomId: room.id, cell: occupied[0], cells: occupied,
      type: furnitureType.value, rotation: Number(rotation.value) };
    const trial = structuredClone(draft);
    trial.floorPlan.furniture.push(item);
    try { validateFloorPlan(trial); } catch (error) { setError(error.message); return; }
    draft.floorPlan.furniture.push(item); selectedItem = item.id; selectedId = room.id;
    roomMenuOpen = true;
    setError(""); syncFields();
  }
  function placeCharging(cells) {
    const zone = { id: newId(), name: `CHARGING ${(draft.floorPlan.chargingZones?.length ?? 0) + 1}`,
      ...regionBounds([...cells]) };
    const trial = structuredClone(draft);
    trial.floorPlan.chargingZones ??= [];
    trial.floorPlan.chargingZones.push(zone);
    try { validateFloorPlan(trial); } catch (error) { setError(error.message); return; }
    draft.floorPlan.chargingZones = trial.floorPlan.chargingZones;
    selectedItem = zone.id; setError(""); syncFields();
  }
  function setRotation(value) {
    const index = draft.floorPlan.furniture.findIndex(item => item.id === selectedItem);
    if (index < 0) return;
    const item = draft.floorPlan.furniture[index];
    try {
      const rotated = rotateFurniture(item, value), trial = structuredClone(draft);
      trial.floorPlan.furniture[index] = rotated;
      validateFloorPlan(trial);
      draft.floorPlan.furniture[index] = rotated;
      setError("");
    } catch (error) { setError(error.message); }
    rotation.value = String(draft.floorPlan.furniture[index].rotation);
    render();
  }
  function rotateItem() {
    const item = draft.floorPlan.furniture.find(value => value.id === selectedItem);
    if (!item) { setError("回転する家具を「選択」でクリックしてください。ドアの辺は削除・再配置で変更できます。"); return; }
    setRotation((item.rotation + 90) % 360);
  }
  function deleteItem() {
    if (!selectedItem) { setError("削除する家具・ドアを「選択」でクリックしてください。"); return; }
    const group = mergedDoors(draft).find(d => d.memberIds.includes(selectedItem));
    const removed = new Set(group?.memberIds ?? [selectedItem]);
    const equipment = [...draft.floorPlan.doors, ...draft.floorPlan.walls]
      .find(item => item.id === selectedItem)?.equipmentId;
    if (equipment) {
      for (const item of [...draft.floorPlan.doors, ...draft.floorPlan.walls])
        if (item.equipmentId === equipment) removed.add(item.id);
      draft.floorPlan.walls = draft.floorPlan.walls.filter(item => !removed.has(item.id));
    }
    draft.floorPlan.furniture = draft.floorPlan.furniture.filter(item => item.id !== selectedItem);
    draft.floorPlan.doors = draft.floorPlan.doors.filter(item => !removed.has(item.id));
    if (draft.floorPlan.walls.some(item => item.id === selectedItem)) {
      draft.floorPlan.walls = draft.floorPlan.walls.filter(item => item.id !== selectedItem);
      draft.floorPlan.doors = draft.floorPlan.doors.filter(item => item.wallId !== selectedItem);
    }
    if (draft.floorPlan.chargingZones)
      draft.floorPlan.chargingZones = draft.floorPlan.chargingZones.filter(item => item.id !== selectedItem);
    selectedItem = null; setError(""); render();
  }
  function save() {
    try {
      if (stroke) throw new Error("ドラッグを終了してから適用してください。");
      if (!mapName.value.trim()) throw new Error("マップ名を入力してください。");
      if (mapName.value.trim().length > 120) throw new Error("マップ名は120文字以下で入力してください。");
      if (!draft.rooms.length) throw new Error("1つ以上の領域を描いてください。");
      const addedRooms = draft.rooms.filter(room => !originalRoomIds.has(room.id)).length;
      if ((draft.tracks?.length ?? 0) + addedRooms > 128) {
        throw new Error("新しい領域の部屋トラックを含めると128本を超えます。領域を追加する前にトラックを減らしてください。");
      }
      for (const room of draft.rooms) {
        if (!room.cells.length) throw new Error(`「${room.name}」を1セル以上描いてください。`);
      }
      validateFloorPlan(draft);
      draft.name = mapName.value.trim();
      draft.background = null;
      validate(draft);
      finish(structuredClone(draft));
    } catch (error) { setError(error.message); }
  }
  regionSelect.addEventListener("change", () => {
    selectedId = regionSelect.value; selectedItem = null; syncFields(); render();
  });
  for (const [control, property] of [[regionName, "name"], [kind, "kind"], [material, "material"], [color, "color"]]) {
    control.addEventListener(control === regionName ? "change" : "input", () => {
      const room = selectedRoom();
      if (room) {
        room[property] = control.value;
        if (property === "kind" && ["room", "corridor"].includes(tool)) { tool = control.value; syncTools(); }
        if (property !== "name") syncFields();
        else {
          const option = regionSelect.selectedOptions[0];
          if (option) option.textContent = `${room.kind === "corridor" ? "廊下" : "部屋"} · ${room.name}`;
        }
        render();
      }
    });
    mapName.addEventListener("change", recordHistory);
  }
  rotation.addEventListener("change", () => {
    setRotation(Number(rotation.value));
  });
  objectName.addEventListener("change", () => {
    const object = [...draft.floorPlan.doors, ...draft.floorPlan.walls]
      .find(item => item.id === selectedItem);
    if (!object) return;
    for (const item of [...draft.floorPlan.doors, ...draft.floorPlan.walls]) {
      if (item === object || object.openingId && item.openingId === object.openingId ||
        object.equipmentId && item.equipmentId === object.equipmentId) item.name = objectName.value;
    }
    render();
  });
  doorKind.addEventListener("change", () => {
    const door = draft.floorPlan.doors.find(item => item.id === selectedItem);
    if (!door) return;
    for (const item of draft.floorPlan.doors)
      if (item === door || door.openingId && item.openingId === door.openingId) item.kind = doorKind.value;
    render();
  });
  canvas.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    if (tool === "door") { event.preventDefault(); placeDoor(event); return; }
    const cell = point(event);
    if (cell === null) return;
    event.preventDefault();
    if (editorMode === "room") {
      const room = draft.rooms.find(r => r.cells.includes(cell));
      if (room) { selectedId = room.id; if (tool === "select") roomMenuOpen = true; }
      else if (tool === "select") roomMenuOpen = false;
    }
    if (tool === "select") { place(cell, event.target); return; }
    if (tool === "furniture") {
      if (!draft.rooms.some(room => room.cells.includes(cell))) {
        setError("家具は領域内からドラッグしてください。"); render(); return;
      }
      selectedItem = null; setError("");
    }
    canvas.setPointerCapture(event.pointerId);
    stroke = { start: cell, last: cell, cells: new Set([cell]), pointerId: event.pointerId };
    if (tool === "elevator") extendStroke(cell);
    render();
  });
  canvas.addEventListener("pointermove", event => {
    if (tool === "door") { placeDoor(event, true); return; }
    if (!stroke || event.pointerId !== stroke.pointerId) return;
    const cell = point(event);
    if (cell !== null) { extendStroke(cell); render(); }
  });
  canvas.addEventListener("pointerleave", () => canvas.querySelector(".me-door-preview")?.remove());
  canvas.addEventListener("pointerup", event => {
    if (!stroke || event.pointerId !== stroke.pointerId) return;
    const cell = point(event);
    if (cell !== null) extendStroke(cell);
    const cells = stroke.cells, start = stroke.start, end = stroke.last, invalid = stroke.invalid; stroke = null;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    if (invalid) { render(); return; }
    if (tool === "gate") placeGate(cells);
    else if (tool === "charging") placeCharging(cells);
    else if (tool === "furniture") placeFurniture(cells);
    else if (tool === "partition") placeWall(start, end);
    else commitStroke(cells);
    render();
  });
  canvas.addEventListener("pointercancel", () => { stroke = null; render(); });
  canvas.addEventListener("lostpointercapture", () => {
    if (stroke) { stroke = null; render(); }
  });
  dialog.addEventListener("cancel", event => { event.preventDefault(); finish(null); });
  dialog.addEventListener("close", () => { if (!finished) finish(null); });
  dialog.addEventListener("keydown", event => {
    event.stopPropagation();
    if (!(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    if (!["z", "y"].includes(key)) return;
    event.preventDefault();
    if (document.activeElement instanceof HTMLInputElement) document.activeElement.blur();
    canvas.focus({ preventScroll: true });
    history(key === "y" || event.shiftKey ? "redo" : "undo");
  });
  syncFields(); syncTools(); render(); setError(initializationError);
  try { dialog.showModal(); }
  catch (error) { dialog.remove(); throw error; }
  return result;
}
