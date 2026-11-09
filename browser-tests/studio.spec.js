import { test, expect } from "@playwright/test";
import { createProject, newTrack, newAction, enableTimedMap, projectForSave, useTimelineOnly } from "../public/model.js";
import { regionBounds, mergedDoors } from "../public/floor-plan.js";
import { createFleetDemoMap, createOfficeDemoMap } from "../public/demo-map.js";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", error => { throw error; });
});

function fixture() {
  const project = createProject({ ordered: true }), map = project.maps[0];
  map.tracks = [];
  map.rooms = [{ id: "room", name: "広場", kind: "corridor", material: "wood",
    color: "#123456", cells: Array.from({ length: 576 }, (_, i) => i),
    x: 0, y: 0, width: 1600, height: 900 }];
  map.floorPlan = { doors: [], furniture: [] };
  enableTimedMap(map); project.schema = "robot-scene/v4";
  for (let i = 0; i < 2; i++) {
    const t = newTrack(map, "robot"); map.tracks.push(t);
    t.initial = { x: 125, y: 125 + i * 250, yaw: 0, roomId: "room" };
    for (let j = 0; j < (i ? 1 : 2); j++) {
      const a = newAction(map, t, "move");
      Object.assign(a, { name: `move-${i}-${j}`, x: 325 + j * 200, y: 125 + i * 250,
        position: j * 8, runSeconds: 6 });
      t.actions.push(a);
    }
  }
  return useTimelineOnly(project);
}
async function seed(page, project = fixture()) {
  await page.addInitScript(p => {
    if (!sessionStorage.getItem("test-seeded")) {
      localStorage.setItem("robot-scene-studio.v4", JSON.stringify(p));
      sessionStorage.setItem("test-seeded", "1");
    }
  }, project);
  await page.goto("/");
  await expect(page.locator(".action-node")).toHaveCount(
    project.maps[0].tracks.reduce((count, track) =>
      count + track.actions.filter(a => a.type !== "join").length, 0));
}
const saved = page => page.evaluate(() => JSON.parse(localStorage.getItem("robot-scene-studio.v4")));
const activeEditor = page => page.locator("#actionDialog:visible, .sequence-dialog");
const editorError = page => activeEditor(page).locator("#actionError, .sequence-error");
const editorApply = page => activeEditor(page).getByRole("button", { name: "適用", exact: true });
const editorCancel = page => activeEditor(page).getByRole("button", { name: "キャンセル", exact: true });

test("bulk sequence popup applies atomically, cancels cleanly and edits from a row double click", async ({ page }) => {
  await seed(page);
  const original = projectForSave(await saved(page));
  await page.locator(".track-label").first().dblclick();
  const popup = page.getByRole("dialog", { name: "シーケンスを一括設定", exact: true });
  await expect(popup).toBeVisible();
  await popup.getByLabel("名称", { exact: true }).fill("Changed only in draft");
  await popup.getByRole("button", { name: "キャンセル", exact: true }).click();
  expect(projectForSave(await saved(page))).toEqual(original);
  await page.locator(".track-label").first().dblclick();
  await popup.getByLabel("名称", { exact: true }).fill("一括設定ロボット");
  await popup.getByLabel("開始（秒）").first().fill("1");
  await popup.getByRole("button", { name: "適用", exact: true }).click();
  await expect(popup).toHaveCount(0);
  await expect.poll(async () => (await saved(page)).maps[0].tracks[0].name).toBe("一括設定ロボット");
  expect((await saved(page)).maps[0].tracks[0].actions[0].position).toBe(1);
  await page.locator("#undo").click();
  await expect.poll(async () => projectForSave(await saved(page))).toEqual(original);
  await page.locator("#redo").click();
  await expect.poll(async () => (await saved(page)).maps[0].tracks[0].name).toBe("一括設定ロボット");
  await page.reload();
  await expect(page.locator(".track-label").first()).toContainText("一括設定ロボット");
});

test("cross-row block selection moves as one group and rejects overlaps atomically", async ({ page }) => {
  await seed(page);
  const before = await saved(page), tracks = before.maps[0].tracks;
  const first = page.locator(`[data-action="${tracks[0].actions[0].id}"]`);
  const second = page.locator(`[data-action="${tracks[1].actions[0].id}"]`);
  await first.click();
  await second.click({ modifiers: ["Control"] });
  await expect(page.locator("#selectionTools")).toContainText("2件選択");
  await page.getByLabel("まとめて調整する秒数").fill("2");
  await page.getByRole("button", { name: "開始をずらす", exact: true }).click();
  await expect.poll(async () => (await saved(page)).maps[0].tracks[0].actions[0].position).toBe(2);
  expect((await saved(page)).maps[0].tracks[1].actions[0].position).toBe(2);
  const shifted = await saved(page);
  await page.getByLabel("まとめて調整する秒数").fill("1");
  await page.getByRole("button", { name: "長さを調整", exact: true }).click();
  await expect(page.locator("#notice")).toContainText("重な");
  expect(await saved(page)).toEqual(shifted);
  const box = await second.boundingBox();
  await page.mouse.move(box.x + 30, box.y + 20); await page.mouse.down();
  await page.mouse.move(box.x + 4, box.y + 20, { steps: 5 }); await page.mouse.up();
  await expect.poll(async () => (await saved(page)).maps[0].tracks[0].actions[0].position).toBe(1);
  expect((await saved(page)).maps[0].tracks[1].actions[0].position).toBe(1);
  await page.locator("#undo").click();
  await expect.poll(() => saved(page)).toEqual(shifted);
});

test("adding a robot immediately shows its body and opens a cancellable sequence popup", async ({ page }) => {
  await seed(page);
  await page.locator('[data-add="robot"]').click();
  const popup = page.getByRole("dialog", { name: "シーケンスを一括設定", exact: true });
  await expect(popup).toBeVisible();
  await expect(popup.locator("[data-robot-body]")).toHaveAttribute("data-size-mm", "100");
  await expect(page.locator("#robotLayer [data-actor]")).toHaveCount(3);
  await popup.getByRole("button", { name: "初期位置をMAPで配置", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "MAPで位置を指定", exact: true });
  await expect(picker.locator("[data-robot-body]")).toHaveAttribute("data-size-mm", "100");
  await picker.getByRole("button", { name: "閉じる", exact: true }).click();
  await popup.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect.poll(async () => (await saved(page)).maps[0].tracks.length).toBe(3);
  expect((await saved(page)).maps[0].tracks[2].actions).toHaveLength(0);
});

test("story door default migrates old maps without stopping robots and preserves strict choice", async ({ page }) => {
  const project = fixture(), map = project.maps[0], human = newTrack(map, "robot");
  delete map.doorMode;
  human.initial = { x: 125, y: 425, yaw: 0, roomId: "room" }; map.tracks = [human];
  const room = map.rooms[0];
  map.rooms = [{ ...room, width: 800, cells: room.cells.filter(i => i % 32 < 16) },
    { ...room, id: "right", name: "Right", x: 800, width: 800, cells: room.cells.filter(i => i % 32 >= 16) }];
  map.floorPlan.doors = Array.from({ length: 6 }, (_, index) => ({
    id: `locked-${index}`, roomId: "room", cell: (6 + index) * 32 + 15, edge: "right",
  }));
  human.actions.push(Object.assign(newAction(map, human, "move"), { x: 1475, y: 425,
    roomId: "right", position: 0, runSeconds: 10 }));
  await seed(page, project);
  await expect(page.getByLabel("扉の確認モード")).toHaveValue("story");
  await expect(page.locator("#safetyWarnings")).toContainText("実機通行の許可ではありません");
  await page.locator("#next").click();
  await expect(page.locator(`#robotLayer [data-actor="${human.id}"]`)).toHaveAttribute("transform", "translate(1475 475)");
  await expect.poll(async () => (await saved(page)).maps[0].doorMode).toBe("story");
  await page.reload();
  await expect(page.getByLabel("扉の確認モード")).toHaveValue("story");
  await page.locator(".timeline-settings summary").click();
  await page.getByLabel("扉の確認モード").selectOption("strict");
  await expect(page.locator("#safetyWarnings")).toContainText("施錠");
  await expect.poll(async () => (await saved(page)).maps[0].doorMode).toBe("strict");
  await page.reload();
  await expect(page.getByLabel("扉の確認モード")).toHaveValue("strict");
  await expect(page.locator("#safetyWarnings")).toContainText("施錠");
});

test("map tools persist independent walls, flapper gates, monitors and hidden room labels", async ({ page }) => {
  const project = fixture(); project.maps[0].tracks = [];
  await seed(page, project);
  await page.locator("#editMap").click();
  const editor = page.locator("#mapEditorDialog"), canvas = editor.locator(".me-canvas");
  await editor.getByRole("button", { name: "部屋編集モード", exact: true }).click();
  await draw(page, canvas, 425, 425);
  await editor.getByRole("checkbox", { name: "部屋名表示", exact: true }).uncheck();
  await editor.getByRole("button", { name: "━ 間仕切り壁", exact: true }).click();
  await draw(page, canvas, 800, 200, 800, 700);
  await editor.getByRole("button", { name: "▤ フラッパーゲート", exact: true }).click();
  await draw(page, canvas, 1025, 325, 1275, 475);
  await editor.getByRole("button", { name: "▣ 家具", exact: true }).click();
  await editor.getByLabel("家具の種類").selectOption({ label: "受付モニター" });
  await draw(page, canvas, 225, 175, 325, 175);
  await editor.getByRole("button", { name: "マップに適用", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect.poll(async () => (await saved(page)).maps[0].floorPlan.walls?.length).toBe(4);
  const m = (await saved(page)).maps[0];
  expect(m.floorPlan.doors).toHaveLength(1);
  expect(m.floorPlan.doors[0].kind).toBe("flapper");
  expect(m.floorPlan.walls.some(wall => wall.id === m.floorPlan.doors[0].wallId)).toBe(true);
  expect(m.floorPlan.furniture).toHaveLength(1);
  expect(m.rooms[0].name).toBe("広場");
  expect(m.navigation.doors[0].memberIds).toContain(m.floorPlan.doors[0].id);
  await expect(page.locator("#floorLayer").getByText("広場", { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.locator("#doorLayer [data-auto-door]")).toHaveCount(1);
});

test("two-robot coordination scenarios can be added without replacing the current map", async ({ page }) => {
  await seed(page);
  await page.locator(".timeline-settings summary").click();
  for (const [kind, count] of [["fire", 2], ["yield", 3]]) {
    await page.getByLabel("連携シナリオを選択").selectOption(kind);
    await page.getByRole("button", { name: "シナリオを追加", exact: true }).click();
    await expect.poll(async () => (await saved(page)).maps.length).toBe(count);
    await expect(page.locator("#safetyWarnings")).not.toBeVisible();
    expect((await saved(page)).maps.at(-1).tracks.filter(t => t.kind === "robot")).toHaveLength(2);
  }
});

test("elevator add tool creates a persistent elevator region", async ({ page }) => {
  const project = fixture(); project.maps[0].tracks = [];
  await seed(page, project);
  await page.locator("#editMap").click();
  const editor = page.locator("#mapEditorDialog"), canvas = editor.locator(".me-canvas");
  await editor.getByRole("button", { name: "▥ エレベーターを追加", exact: true }).click();
  await editor.getByRole("button", { name: "＋ 新しい領域", exact: true }).click();
  await editor.getByRole("combobox", { name: /^描画/ }).selectOption("rectangle");
  await draw(page, canvas, 1125, 125, 1425, 375);
  await expect(canvas.locator("[data-elevator]")).toHaveCount(1);
  await editor.getByRole("button", { name: "マップに適用", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect.poll(async () => (await saved(page)).maps[0].rooms.some(room => room.appearance === "elevator")).toBe(true);
  await page.reload();
  await expect(page.locator("#floorLayer [data-elevator]")).toHaveCount(1);
});

test("named equipment can be selected as an individual unlock target and persists as v5", async ({ page }) => {
  const project = fixture(), map = project.maps[0];
  const controls = newTrack(map, "room"); controls.roomId = "room"; map.tracks = [controls];
  const unlock = Object.assign(newAction(map, controls, "unlock"), { position: 0, runSeconds: 10 });
  controls.actions.push(unlock);
  map.floorPlan.walls = [{ id: "wall", roomId: "room", x1: 800, y1: 0, x2: 800, y2: 900 }];
  map.floorPlan.doors = [{ id: "gate", name: "Entrance Gate", kind: "flapper", roomId: "room",
    wallId: "wall", x1: 800, y1: 350, x2: 800, y2: 650 }];
  await seed(page, project);
  await page.locator(".action-node").dblclick();
  await page.getByLabel("解錠する部屋").selectOption("door:gate");
  await page.locator('#actionForm button[type="submit"]').click();
  await expect.poll(async () => (await saved(page)).schema).toBe("robot-scene/v5");
  expect((await saved(page)).maps[0].tracks[0].actions[0].doorId).toBe("gate");
  await page.reload();
  await page.locator(".action-node").dblclick();
  await expect(page.getByLabel("解錠する部屋")).toHaveValue("door:gate");
});

test("row dragging preserves action times and popup arrows reorder chronological action numbers", async ({ page }) => {
  const project = fixture(), map = project.maps[0], track = map.tracks[0];
  track.actions = [Object.assign(newAction(map, track, "wait"), { name: "First wait", position: 0, runSeconds: 2 }),
    Object.assign(newAction(map, track, "wait"), { name: "Second wait", position: 4, runSeconds: 3 })];
  await seed(page, project);
  const ids = map.tracks.map(t => t.id);
  await page.locator(".track-label").first().dragTo(page.locator(".track-label").last(),
    { targetPosition: { x: 45, y: 30 } });
  await expect.poll(async () => (await saved(page)).maps[0].tracks.map(t => t.id)).toEqual([...ids].reverse());
  expect((await saved(page)).maps[0].tracks[1].actions.map(a => a.position)).toEqual([0, 4]);
  await page.locator(".track-label").last().dblclick();
  const popup = page.getByRole("dialog", { name: "シーケンスを一括設定", exact: true });
  await popup.locator(".sequence-row").last().getByRole("button", { name: "↑", exact: true }).click();
  await popup.getByRole("button", { name: "適用", exact: true }).click();
  await expect.poll(async () => (await saved(page)).maps[0].tracks[1].actions[0].name).toBe("Second wait");
  expect((await saved(page)).maps[0].tracks[1].actions.map(a => a.position)).toEqual([0, 5]);
  await expect(page.locator(".lane").last().locator(".action-node").first()).toContainText("1. Second wait");
});

for (const kind of ["move", "rotate", "show", "event-start", "wait"]) {
  test(`visible bar edges match ${kind} execution boundaries and MAP rendering`, async ({ page }) => {
    const p = fixture(), m = p.maps[0];
    m.tracks = [];
    const actor = kind === "move" || kind === "rotate";
    const t = newTrack(m, actor ? "robot" : kind === "event-start" ? "room" : "display");
    if (actor) t.initial = { x: 125, y: 125, yaw: 0, roomId: "room" };
    m.tracks.push(t);
    const a = newAction(m, t, kind === "rotate" ? "move" : kind);
    Object.assign(a, { position: 2, runSeconds: 4, x: 325, y: 125, yaw: 90,
      roomId: "room", text: "BOUNDARY", ...(kind === "rotate" ? { motion: "rotate", angularSpeed: 90 } : {}) });
    t.actions.push(a);
    await seed(page, p);
    await page.locator(".track-label").first().click();
    const card = page.locator(".action-node");
    await card.click();
    const graphic = page.locator(`#stage [data-stage-action="${a.id}"]`);
    const readActor = () => page.locator("#robotLayer [data-actor]").evaluate(n => ({
      position: n.getAttribute("transform"), heading: n.querySelector("g")?.getAttribute("transform"),
    }));
    for (const zoom of [26, 100]) {
      await page.locator("#zoom").fill(String(zoom)); await page.locator("#zoom").dispatchEvent("input");
      await page.locator("#timelineScroll").evaluate(n => { n.scrollLeft = 0; });
      await page.locator("#home").click();
      const before = actor ? await readActor() : null;
      const cardRect = await card.boundingBox();
      const zero = await page.locator(".tick").first().boundingBox();
      const headAtZero = await page.locator("#playhead").boundingBox();
      expect(Math.abs(zero.x - headAtZero.x)).toBeLessThan(1);
      expect(cardRect.width).toBeCloseTo(4 * zoom, 1);
      const seek = async at => {
        await page.locator("#timelineScroll").evaluate((n, left) => { n.scrollLeft = left; },
          Math.max(0, at * zoom - 200));
        const ruler = await page.locator("#ruler").boundingBox();
        const hit = await page.evaluate(({ x, y }) => {
          const n = document.elementFromPoint(x, y);
          return { tag: n?.tagName, id: n?.id, className: n?.getAttribute("class") };
        }, { x: ruler.x + 16 + at * zoom, y: ruler.y + 10 });
        expect(hit.id, JSON.stringify({ at, zoom, ruler, hit })).toBe("ruler");
        await page.mouse.click(ruler.x + 16 + at * zoom, ruler.y + 10);
      };
      await seek(1.9);
      await expect(card).toHaveClass(/waiting/);
      if (actor) expect(await readActor()).toEqual(before);
      if (["show", "event-start"].includes(kind)) await expect(graphic).toHaveCount(0);
      await page.locator("#home").click(); await page.locator("#next").click();
      await expect(page.locator("#previewTime")).toHaveText("00:02.00");
      await expect(card).toHaveClass(/running/);
      const startHead = await page.locator("#playhead").boundingBox();
      expect(Math.abs(startHead.x - cardRect.x)).toBeLessThan(1);
      if (actor) expect(await readActor()).toEqual(before);
      if (["show", "event-start"].includes(kind)) await expect(graphic).toHaveCount(1);
      await seek(4);
      if (kind === "move") {
        const pose = await readActor();
        const x = Number(pose.position.match(/translate\(([-\d.]+)/)[1]);
        expect(x).toBeCloseTo(225, 0);
      }
      if (kind === "rotate") {
        const pose = await readActor();
        const angle = Number(pose.heading.match(/rotate\(([-\d.]+)/)[1]);
        expect(angle).toBeCloseTo(-45, 0);
      }
      await seek(5.9);
      await expect(card).toHaveClass(/running/);
      if (["show", "event-start"].includes(kind)) await expect(graphic).toHaveCount(1);
      await page.locator("#next").click();
      await expect(page.locator("#previewTime")).toHaveText("00:06.00");
      await expect(card).toHaveClass(/complete/);
      const endHead = await page.locator("#playhead").boundingBox();
      const endCard = await card.boundingBox();
      expect(Math.abs(endHead.x - endCard.x - endCard.width)).toBeLessThan(1);
      if (kind === "move") expect((await readActor()).position).toBe("translate(325 775)");
      if (kind === "rotate") expect((await readActor()).heading).toBe("rotate(-90)");
      if (["show", "event-start"].includes(kind)) await expect(graphic).toHaveCount(0);
      const ended = actor ? await readActor() : null;
      await seek(7);
      if (actor) expect(await readActor()).toEqual(ended);
    }
  });
}

test("short positive-duration bars keep their true duration width at low zoom", async ({ page }) => {
  const p = fixture(), t = p.maps[0].tracks[0];
  t.actions[0].runSeconds = .1;
  await seed(page, p);
  await page.locator("#zoom").fill("12"); await page.locator("#zoom").dispatchEvent("input");
  expect((await page.locator(".action-node").first().boundingBox()).width).toBeCloseTo(1.2, 1);
  await page.locator("#home").click(); await page.locator("#next").click();
  await expect(page.locator("#previewTime")).toHaveText("00:00.10");
  const card = await page.locator(".action-node").first().boundingBox();
  const head = await page.locator("#playhead").boundingBox();
  expect(Math.abs(head.x - card.x - card.width)).toBeLessThan(1);
});

test("continuous playback follows visible bars for move, rotation, display, event and wait", async ({ page }) => {
  const p = fixture(), m = p.maps[0];
  m.tracks = [];
  for (const kind of ["move", "rotate", "show", "event-start", "wait"]) {
    const t = newTrack(m, ["move", "rotate"].includes(kind) ? "robot" :
      kind === "event-start" ? "room" : "display");
    if (t.initial) t.initial = { x: 125, y: kind === "move" ? 125 : 325, yaw: 0, roomId: "room" };
    const a = newAction(m, t, kind === "rotate" ? "move" : kind);
    Object.assign(a, { name: kind, position: 2, runSeconds: 4, roomId: "room", text: kind,
      x: 325, y: 125, ...(kind === "rotate" ? { motion: "rotate", angularSpeed: 90, yaw: 90 } : {}) });
    t.actions.push(a); m.tracks.push(t);
  }
  await page.clock.install();
  await seed(page, p);
  await page.locator(".track-label").first().click();
  await page.locator("#play").click();
  await page.clock.runFor(1900);
  await expect(page.locator(".action-node.waiting")).toHaveCount(5);
  await page.clock.runFor(200);
  await expect(page.locator(".action-node.running")).toHaveCount(5);
  await expect(page.locator("#effectLayer [data-stage-action]")).toHaveCount(1);
  await expect(page.locator("#roomLayer [data-stage-action]")).toHaveCount(1);
  await page.clock.runFor(3800);
  await expect(page.locator(".action-node.running")).toHaveCount(5);
  await page.clock.runFor(200);
  await expect(page.locator(".action-node.complete")).toHaveCount(5);
  await expect(page.locator("#effectLayer [data-stage-action]")).toHaveCount(0);
  await expect(page.locator("#roomLayer [data-stage-action]")).toHaveCount(0);
  await expect(page.locator(`#robotLayer [data-actor="${m.tracks[0].id}"]`))
    .toHaveAttribute("transform", "translate(325 775)");
  await expect(page.locator(`#robotLayer [data-actor="${m.tracks[1].id}"] > g`))
    .toHaveAttribute("transform", "rotate(-90)");
});

test("hide and event-end execute at their exact visible timeline positions", async ({ page }) => {
  const p = fixture(), m = p.maps[0];
  m.tracks = [];
  const make = (kind, type, position, seconds, props = {}) => {
    const t = newTrack(m, kind); m.tracks.push(t);
    const a = Object.assign(newAction(m, t, type),
      { position, runSeconds: seconds, roomId: "room", text: "ENDS", ...props });
    t.actions.push(a); return { t, a };
  };
  const show = make("display", "show", 0, 8);
  const hide = Object.assign(newAction(m, show.t, "hide"), { position: 4, runSeconds: 1 });
  const event = make("room", "event-start", 0, 8);
  const end = Object.assign(newAction(m, event.t, "event-end"), { position: 4, runSeconds: 1 });
  // 終了項目を別行に置き、長く残る表示とイベントを指定時刻で消すことを検証する。
  const hideTrack = newTrack(m, "display"); hideTrack.actions.push(hide); m.tracks.push(hideTrack);
  const endTrack = newTrack(m, "room"); endTrack.actions.push(end); m.tracks.push(endTrack);
  await seed(page, p);
  const card = a => page.locator(`.action-node[data-action="${a.id}"]`);
  const graphic = a => page.locator(`#stage [data-stage-action="${a.id}"]`);
  await expect(graphic(show.a)).toHaveCount(1); await expect(graphic(event.a)).toHaveCount(1);
  await expect(card(hide)).toHaveClass(/waiting/); await expect(card(end)).toHaveClass(/waiting/);
  await page.locator("#next").click();
  await expect(page.locator("#previewTime")).toHaveText("00:04.00");
  await expect(graphic(show.a)).toHaveCount(0); await expect(graphic(event.a)).toHaveCount(0);
  await expect(card(hide)).toHaveClass(/running/); await expect(card(end)).toHaveClass(/running/);
  await page.locator("#next").click();
  await expect(page.locator("#previewTime")).toHaveText("00:05.00");
  await expect(card(hide)).toHaveClass(/complete/); await expect(card(end)).toHaveClass(/complete/);
  for (const a of [hide, end]) {
    const bar = await card(a).boundingBox(), marker = await page.locator("#playhead").boundingBox();
    expect(Math.abs(marker.x - bar.x - bar.width)).toBeLessThan(1);
  }
});

test("timeline-only controls have no pins, edges, join palette or condition editor", async ({ page }) => {
  const p = fixture(), tracks = p.maps[0].tracks;
  tracks[1].actions[0].trigger = { mode: "all", sources: tracks[0].actions.map(a => ({
    actionId: a.id, event: "complete", delay: 0,
  })) };
  delete p.maps[0].timelineOnly;
  await seed(page, p);
  await expect(page.locator("[data-input], [data-output], #connectionLayer, .connection-filter")).toHaveCount(0);
  await page.locator(".action-node").first().dblclick();
  await expect(page.locator(".trigger-source, .trigger-pages")).toHaveCount(0);
  await expect(page.getByLabel("条件の組み方")).toHaveCount(0);
  await editorCancel(page).click();
  await page.locator(".track-label").first().click();
  await expect(page.getByRole("button", { name: "＋ 合流", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "＋ 待機", exact: true })).toBeVisible();
});


test("selected controls highlight their actor or room with a persistent animated outline", async ({ page }) => {
  const p = fixture(), m = p.maps[0];
  const human = newTrack(m, "human");
  human.initial = { x: 925, y: 625, yaw: 0, roomId: "room" };
  human.actions.push(newAction(m, human, "wait")); m.tracks.push(human);
  const room = newTrack(m, "room");
  const event = newAction(m, room, "event-start"); event.roomId = "room";
  room.actions.push(event); m.tracks.push(room);
  await seed(page, p);
  for (const index of [0, 2, 3]) {
    await page.locator(".lane").nth(index).locator(".action-node").first().click();
    const expected = index === 3 ? "room:room" : `actor:${m.tracks[index].id}`;
    await expect(page.locator("#stageSelection")).toHaveAttribute("data-focus", expected);
    await expect(page.locator(".selection-runner")).toHaveCount(1);
    expect(await page.locator(".selection-runner").evaluate(n => getComputedStyle(n).animationName)).toBe("selection-orbit");
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await page.locator(".selection-runner").evaluate(n => getComputedStyle(n).animationName)).toBe("none");
});

test("office demo adds a separate map once, preserves existing maps and survives reload", async ({ page }) => {
  const project = fixture();
  await seed(page, project);
  const original = projectForSave(project).maps[0];
  await page.getByRole("button", { name: "オフィステスト", exact: true }).click();
  await expect(page.locator("#mapTabs [aria-selected=true]")).toContainText("テストマップ 2 · オフィス");
  await expect(page.locator("#robotLayer [data-actor]")).toHaveCount(3);
  await expect(page.locator("[data-room-activity]")).toContainText("監視中");
  await expect(page.locator("#safetyWarnings")).not.toBeVisible();
  await expect.poll(async () => (await saved(page)).maps.length).toBe(2);
  expect((await saved(page)).maps[0]).toEqual(original);
  await page.locator("#undo").click();
  await expect(page.locator("#mapTabs [role=tab]")).toHaveCount(1);
  await page.locator("#redo").click();
  await expect(page.locator("#mapTabs [role=tab]")).toHaveCount(2);
  await page.reload();
  await page.getByRole("button", { name: "オフィステスト", exact: true }).click();
  await expect(page.locator("#mapTabs [role=tab]")).toHaveCount(2);
  await expect(page.locator("#mapTabs [aria-selected=true]")).toContainText("オフィス");
  await expect(page.locator("#floorLayer [data-elevator]")).toHaveCount(1);
  expect((await saved(page)).maps[0]).toEqual(original);
});

test("facing turns apply to all maps once, persist and can be undone", async ({ page }) => {
  const project = fixture();
  project.maps[0].tracks[0].initial.yaw = 90;
  const second = fixture().maps[0];
  second.name = "Another sequence";
  second.rooms[0].id = "second-room";
  second.tracks[0].initial.yaw = 90;
  for (const track of second.tracks) {
    track.initial.roomId = "second-room";
    for (const action of track.actions) action.roomId = "second-room";
  }
  project.maps.push(second);
  await seed(page, project);
  await page.locator("#prepareFacingTurns").click();
  await page.locator('#confirmDialog button[value="ok"]').click();
  await expect.poll(async () => (await saved(page)).facingTurns).toBe(true);
  for (const map of (await saved(page)).maps) {
    expect(map.tracks.flatMap(track => track.actions).filter(a => a.motion === "rotate")).toHaveLength(1);
    expect(map.tracks[0].actions.find(a => a.name === "move-0-0").position).toBe(1);
  }
  await page.locator("#undo").click();
  await expect.poll(async () => (await saved(page)).facingTurns).toBeUndefined();
  await page.locator("#redo").click();
  await expect.poll(async () => (await saved(page)).facingTurns).toBe(true);
  await page.reload();
  await page.locator("#prepareFacingTurns").click();
  await page.locator('#confirmDialog button[value="ok"]').click();
  expect((await saved(page)).maps[0].tracks[0].actions.filter(a => a.motion === "rotate")).toHaveLength(1);
});

for (const viewport of [{ width: 1920, height: 1080 }, { width: 1280, height: 720 },
  { width: 816, height: 639 }, { width: 640, height: 800 }]) {
test(`preview fullscreen fits the whole map and restores zoom at ${viewport.width}px`, async ({ page }) => {
  await page.setViewportSize(viewport);
  await seed(page);
  const zoom = page.locator(".stage-zoom select");
  await zoom.selectOption("2");
  await page.locator("#fitStage").click();
  await expect(page.locator(".preview")).toHaveClass(/preview-expanded/);
  await expect(page.locator("#fullscreenPreview")).toHaveAttribute("aria-pressed", "true");
  await expect(zoom).toHaveValue("1");
  const size = await page.locator(".preview").boundingBox();
  expect(Math.abs(size.width - viewport.width)).toBeLessThan(2);
  expect(Math.abs(size.height - viewport.height)).toBeLessThan(2);
  const stage = await page.locator("#stage").boundingBox();
  expect(stage.x).toBe(0); expect(stage.y).toBe(0);
  expect(Math.abs(stage.width - viewport.width)).toBeLessThan(1);
  expect(Math.abs(stage.height - viewport.height)).toBeLessThan(1);
  await expect(page.locator("#stage")).toHaveAttribute("preserveAspectRatio", "none");
  await expect(page.locator(".preview>.panel-heading")).toBeHidden();
  await expect(page.locator(".stage-meta")).toBeHidden();
  await expect(page.locator(".axis-label").first()).toBeHidden();
  await expect(page.locator("#pathLayer")).toBeHidden();
  const corners = await page.locator("#stage").evaluate(svg => {
    const matrix = svg.getScreenCTM();
    return [new DOMPoint(0, 0), new DOMPoint(1600, 900)].map(p => {
      const { x, y } = p.matrixTransform(matrix); return { x, y };
    });
  });
  expect(corners[0]).toEqual({ x: 0, y: 0 });
  expect(Math.abs(corners[1].x - viewport.width)).toBeLessThan(1);
  expect(Math.abs(corners[1].y - viewport.height)).toBeLessThan(1);
  await expect(page.locator("#play")).toBeInViewport();
  await page.locator("#play").click();
  await expect(page.locator("#play")).toHaveAttribute("aria-label", "一時停止");
  await page.locator("#play").click();
  await page.locator("#fullscreenPreview").click();
  await expect(page.locator(".preview")).not.toHaveClass(/preview-expanded/);
  await expect(zoom).toHaveValue("2");
  await expect(page.locator("#stage")).toHaveAttribute("preserveAspectRatio", "xMidYMid meet");
  await page.locator("#fullscreenPreview").click();
  await page.evaluate(async () => {
    if (document.fullscreenElement) await document.exitFullscreen();
    else document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });
  await expect(page.locator(".preview")).not.toHaveClass(/preview-expanded/);
});
}

test("exhibition controls reveal on mouse movement, seek, loop and disappear without changing map data", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await seed(page);
  const original = await saved(page);
  await page.locator("#fitStage").click();
  await page.mouse.move(640, 200);
  const transport = page.getByRole("group", { name: "プレビュー再生操作", includeHidden: true });
  await expect(transport).toBeVisible();
  const style = await transport.evaluate(el => ({
    background: getComputedStyle(el).backgroundColor, position: getComputedStyle(el).position,
  }));
  expect(style.background).toMatch(/^rgba\(/);
  expect(style.position).toBe("absolute");
  await expect(transport).toBeHidden({ timeout: 5000 });
  await page.mouse.move(650, 200);
  await expect(transport).toBeVisible();
  await page.getByLabel("プレビュー再生位置").fill("3.5");
  await expect(page.locator("#previewTime")).toHaveText("00:03.50");
  await page.locator("#loop").click();
  await expect(page.locator("#loop")).toHaveAttribute("aria-pressed", "true");
  await page.locator("#play").click();
  await expect(page.locator("#previewTime")).not.toHaveText("00:03.50");
  await page.mouse.move(640, 200);
  await expect(transport).toBeHidden({ timeout: 5000 });
  await page.keyboard.press("Space");
  await expect(transport).toBeVisible();
  await expect(page.locator("#play")).toHaveAttribute("aria-label", "再生");
  await page.mouse.click(100, 100);
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("プレビュー再生位置")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator("#fullscreenPreview")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("プレビュー再生位置")).toBeFocused();
  await page.mouse.click(100, 100);
  await page.keyboard.press("Delete");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await page.locator("#fullscreenPreview").click();
  expect(await saved(page)).toEqual(original);
});

test("fullscreen denial is visible inside the expanded preview and Escape restores the editor", async ({ page }) => {
  await seed(page);
  await page.locator(".preview").evaluate(panel => {
    panel.requestFullscreen = () => Promise.reject(new Error("Fullscreen denied for test"));
  });
  await page.locator("#fullscreenPreview").click();
  await expect(page.locator("#fullscreenStatus")).toBeVisible();
  await expect(page.locator("#fullscreenStatus")).toContainText("Fullscreen denied for test");
  await expect(page.locator(".preview")).toHaveClass(/preview-expanded/);
  await page.keyboard.press("Escape");
  await expect(page.locator(".preview")).not.toHaveClass(/preview-expanded/);
  await expect(page.locator("#fullscreenStatus")).toBeHidden();
});

test("old office demo is retained while the employee and guests version is added once", async ({ page }) => {
  const project = fixture();
  project.maps[0].officeDemoRevision = 1;
  await seed(page, project);
  const original = projectForSave(project).maps[0];
  await page.locator("#openOfficeDemo").click();
  await page.locator('#confirmDialog button[value="ok"]').click();
  await expect.poll(async () => (await saved(page)).maps.length).toBe(2);
  const data = await saved(page);
  expect(data.maps[0]).toEqual(original);
  expect(data.maps[1].officeDemoRevision).toBe(2);
  expect(data.maps[1].tracks.filter(track => track.kind === "human").map(track => track.count)).toEqual([1, 3]);
  await expect(page.locator("#floorLayer [data-elevator-floor]")).toHaveCount(1);
  await page.locator("#openOfficeDemo").click();
  await expect(page.locator("#confirmDialog")).not.toBeVisible();
  await expect(page.locator("#mapTabs [role=tab]")).toHaveCount(2);
});

test("human rotation bars migrate away and human movement editor offers no rotation", async ({ page }) => {
  const project = fixture(), map = project.maps[0], human = newTrack(map, "human");
  human.initial = { x: 725, y: 725, yaw: 90, roomId: "room" };
  const turn = Object.assign(newAction(map, human, "move"), { motion: "rotate",
    position: 0, runSeconds: 1, rotationSeconds: 1, angularSpeed: 90, yaw: 180 });
  const move = Object.assign(newAction(map, human, "move"), { position: 2,
    runSeconds: 3, x: 925, y: 725, roomId: "room" });
  human.actions.push(turn, move); map.tracks.push(human);
  await page.addInitScript(p => localStorage.setItem("robot-scene-studio.v4", JSON.stringify(p)), project);
  await page.goto("/");
  await expect(page.locator(".action-node")).toHaveCount(4);
  await expect.poll(async () => (await saved(page)).maps[0].tracks.at(-1).actions.length).toBe(1);
  expect((await saved(page)).maps[0].tracks.at(-1).actions[0]).toMatchObject({
    id: move.id, position: 2, runSeconds: 3,
  });
  expect(await page.evaluate(() => !!localStorage.getItem(
    "robot-scene-studio.backup.before-human-turn-removal"))).toBe(true);
  const transforms = await page.locator("#robotLayer [data-actor]").last()
    .locator("g[transform]").evaluateAll(nodes => nodes.map(n => n.getAttribute("transform")));
  expect(transforms.every(value => !value.includes("rotate"))).toBe(true);
  await page.locator(".lane").last().locator(".action-node").dblclick();
  await expect(page.locator(".motion-switch")).toHaveCount(0);
});

test("furnished fleet scenario is the default with people, an elevator and meeting events", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#mapTabs [aria-selected=true]")).toContainText("テスト");
  await expect(page.locator("#addFleetDemo")).toHaveCount(0);
  await expect(page.locator("#robotLayer [data-actor]")).toHaveCount(3);
  const people = page.locator("#trackLabels .track-label").first();
  await expect(people).toContainText("人間 · 会議参加者（5人）");
  await expect(people).toBeInViewport();
  await expect(page.locator(".lane").first().locator(".action-node")).toHaveCount(2);
  const human = page.locator("#robotLayer [data-actor]").first();
  const start = await human.getAttribute("transform");
  await expect(page.locator("#floorLayer [data-elevator]")).toHaveCount(1);
  await expect(page.locator("#floorLayer [data-hall-continuation]")).toHaveCount(1);
  expect(await page.locator("#floorLayer [data-furniture]").count()).toBeGreaterThan(10);
  await page.locator("#timelineScroll").evaluate(n => { n.scrollLeft = 100; });
  const ruler = await page.locator("#ruler").boundingBox();
  await page.mouse.click(ruler.x + 16 + 4 * 26, ruler.y + 10);
  await expect(page.locator("#roomLayer .stage-room")).toContainText(["人 5名"]);
  await page.locator("#home").click();
  const seek = async at => {
    await page.locator("#timelineScroll").evaluate(n => { n.scrollLeft = 0; });
    const r = await page.locator("#ruler").boundingBox();
    await page.mouse.click(r.x + 16 + at * 26, r.y + 10);
  };
  await seek(2.5);
  expect(await human.getAttribute("transform")).not.toBe(start);
  await page.locator("#home").click();
  expect(await human.getAttribute("transform")).toBe(start);
  await expect(page.locator("#safetyWarnings")).not.toBeVisible();
});

test("people and their timeline remain visible in a compact embedded browser", async ({ page }) => {
  await page.setViewportSize({ width: 816, height: 639 });
  await page.goto("/");
  await expect(page.locator("#trackLabels .track-label").first()).toContainText("人間 · 会議参加者（5人）");
  await expect(page.locator("#trackLabels .track-label").first()).toBeInViewport({ ratio: 1 });
  await expect(page.locator(".lane").first().locator(".action-node").first()).toBeInViewport({ ratio: 1 });
  await expect(page.locator("#stage")).toBeInViewport({ ratio: 1 });
  expect((await page.locator("#stage").boundingBox()).height).toBeGreaterThan(120);
  await page.locator("#timelineScroll").evaluate(n => { n.scrollTop = n.scrollHeight; });
  await expect(page.locator("#trackLabels .track-label").last()).toBeInViewport({ ratio: .99 });
});

test("latest demo recovery opens a fresh scenario without overwriting existing maps", async ({ page }) => {
  const project = projectForSave(fixture());
  await seed(page, project);
  const original = projectForSave(project).maps;
  await expect(page.locator(".version")).toHaveText("α 0.6");
  await page.locator("#openLatestDemo").click();
  await page.locator('#confirmDialog button[value="cancel"]').click();
  expect((await saved(page)).maps).toEqual(original);
  await page.locator("#openLatestDemo").click();
  await page.locator('#confirmDialog button[value="ok"]').click();
  await expect(page.locator("#mapTabs [aria-selected=true]")).toContainText("テストマップ");
  await expect(page.locator("#trackLabels .track-label").first()).toContainText("会議参加者");
  await expect(page.locator("#safetyWarnings")).not.toBeVisible();
  await expect.poll(async () => (await saved(page)).maps.length).toBe(2);
  expect((await saved(page)).maps.slice(0, 1)).toEqual(original);
  await page.locator("#undo").click();
  await expect.poll(async () => (await saved(page)).maps).toEqual(original);
  await page.locator("#redo").click();
  await expect.poll(async () => (await saved(page)).maps.length).toBe(2);
  await page.locator("#saveProject").click();
  await page.reload();
  await expect(page.locator("#mapTabs [role=tab]")).toHaveCount(2);
  expect((await saved(page)).maps.slice(0, 1)).toEqual(original);
});

test("old test maps are removed once while unrelated maps are preserved", async ({ page }) => {
  const p = projectForSave(fixture()), original = structuredClone(p.maps[0]);
  const old = createFleetDemoMap().maps[0];
  delete old.demoRevision; old.name = "マップ 1 · テスト";
  p.maps.unshift(old);
  await seed(page, p);
  await expect(page.locator("#mapTabs [role=tab]")).toHaveCount(2);
  await expect(page.locator("#mapTabs")).not.toContainText("マップ 1 · テスト");
  await expect(page.locator("#mapTabs [role=tab]").first()).toHaveText("テストマップ");
  await expect.poll(async () => (await saved(page)).maps[0].demoRevision).toBe(1);
  expect((await saved(page)).maps[1]).toEqual(original);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("robot-scene-studio.backup.before-old-demo-removal"))))
    .toEqual(p);
  await page.locator("#saveProject").click(); await page.reload();
  await expect(page.locator("#mapTabs [role=tab]")).toHaveCount(2);
  await page.locator("#openLatestDemo").click();
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(page.locator("#mapTabs [role=tab]")).toHaveCount(2);
});

test("tab double-click renames inline with Enter, blur, cancellation and history", async ({ page }) => {
  const p = projectForSave(fixture()), second = structuredClone(p.maps[0]);
  second.id = "second-map"; second.name = "別マップ"; second.rooms = []; second.tracks = [];
  second.floorPlan = { doors: [], furniture: [] }; delete second.navigation;
  p.maps.push(second);
  await seed(page, p);
  const tabs = page.locator("#mapTabs [role=tab]");
  await tabs.nth(1).dblclick();
  const input = page.getByLabel("タブ名", { exact: true });
  await input.fill("名称変更"); await input.press("Enter");
  await expect(tabs.nth(1)).toHaveText("名称変更");
  await expect.poll(async () => (await saved(page)).maps[1].name).toBe("名称変更");
  await tabs.nth(1).dblclick(); await input.fill("取消"); await input.press("Escape");
  await expect(tabs.nth(1)).toHaveText("名称変更");
  await tabs.nth(1).dblclick(); await input.fill("   "); await input.press("Enter");
  await expect(page.locator("#notice.error")).toContainText("タブ名");
  await input.fill("フォーカス確定"); await input.press("Tab");
  await expect(tabs.nth(1)).toHaveText("フォーカス確定");
  await page.locator("#undo").click(); await expect(tabs.nth(1)).toHaveText("名称変更");
  await page.locator("#redo").click(); await expect(tabs.nth(1)).toHaveText("フォーカス確定");
  await expect.poll(async () => (await saved(page)).maps[1].name).toBe("フォーカス確定");
  await page.locator("#saveProject").click(); await page.reload();
  await expect(tabs.nth(1)).toHaveText("フォーカス確定");
});

for (const target of [8.3, 12.7]) for (const edge of ["start", "end"]) {
  test(`Shift dragging aligns ${edge} with ${target}s and shows the matching vertical line`, async ({ page }) => {
    const p = fixture(), m = p.maps[0]; m.tracks = [];
    for (const [position, duration] of [[2, 2.1], [8.3, 4.4]]) {
      const t = newTrack(m, "display");
      t.actions.push(Object.assign(newAction(m, t, "wait"), { position, runSeconds: duration }));
      m.tracks.push(t);
    }
    await seed(page, p);
    const card = page.locator(".action-node").first(), bounds = await card.boundingBox();
    const desired = target - (edge === "end" ? 2.1 : 0);
    await page.mouse.move(bounds.x + 15, bounds.y + 12); await page.mouse.down();
    await page.keyboard.down("Shift");
    await page.mouse.move(bounds.x + 15 + (desired - 2) * 26 + 6, bounds.y + 12, { steps: 10 });
    const guide = page.locator("#timelineAlignment");
    await expect.poll(async () => Number(await guide.getAttribute("data-time"))).toBeCloseTo(target, 6);
    const g = await guide.boundingBox(), moved = await card.boundingBox();
    expect(Math.abs(g.x - moved.x - (edge === "end" ? moved.width : 0))).toBeLessThan(1);
    await expect(guide).toContainText("待機");
    await page.mouse.up(); await page.keyboard.up("Shift");
    await expect(guide).toHaveCount(0);
    await expect.poll(async () => (await saved(page)).maps[0].tracks[0].actions[0].position)
      .toBeCloseTo(desired, 6);
  });
}

test("Shift resize and live modifier changes show guides and Escape restores duration", async ({ page }) => {
  const p = fixture(), m = p.maps[0]; m.tracks = [];
  for (const [position, duration] of [[2, 2.1], [8.3, 4.4]]) {
    const t = newTrack(m, "display");
    t.actions.push(Object.assign(newAction(m, t, "wait"), { position, runSeconds: duration }));
    m.tracks.push(t);
  }
  await seed(page, p);
  const handle = page.locator(".duration-handle").first(), card = page.locator(".action-node").first();
  let r = await handle.boundingBox();
  await page.mouse.move(r.x + 4, r.y + 4); await page.mouse.down();
  await page.mouse.move(r.x + 4 + (8.3 - 4.1) * 26 + 6, r.y + 4);
  await expect(page.locator("#timelineAlignment")).toHaveCount(0);
  await page.keyboard.down("Shift");
  await expect(page.locator("#timelineAlignment")).toHaveAttribute("data-time", "8.3");
  await page.keyboard.up("Shift");
  await expect(page.locator("#timelineAlignment")).toHaveCount(0);
  await page.keyboard.down("Shift");
  await page.keyboard.press("Escape"); await page.mouse.up(); await page.keyboard.up("Shift");
  expect((await saved(page)).maps[0].tracks[0].actions[0].runSeconds).toBe(2.1);
  await expect(page.locator("#timelineAlignment")).toHaveCount(0);
  r = await handle.boundingBox();
  await page.mouse.move(r.x + 4, r.y + 4); await page.mouse.down(); await page.keyboard.down("Shift");
  await page.mouse.move(r.x + 4 + (8.3 - 4.1) * 26 + 6, r.y + 4);
  await page.mouse.up(); await page.keyboard.up("Shift");
  await expect.poll(async () => (await saved(page)).maps[0].tracks[0].actions[0].runSeconds)
    .toBeCloseTo(6.3, 6);
  expect((await card.boundingBox()).width).toBeCloseTo(6.3 * 26, 1);
});

test("alignment follows zoom and horizontal scrolling and releases without Shift or on cancellation", async ({ page }) => {
  const p = projectForSave(fixture()), m = p.maps[0]; m.tracks = [];
  for (const [position, duration] of [[10, 2.1], [16.3, 4.4]]) {
    const t = newTrack(m, "display");
    t.actions.push(Object.assign(newAction(m, t, "wait"), { position, runSeconds: duration }));
    m.tracks.push(t);
  }
  await seed(page, p);
  await page.locator("#zoom").fill("60"); await page.locator("#zoom").dispatchEvent("input");
  await page.locator("#timelineScroll").evaluate(n => { n.scrollLeft = 500; });
  const card = page.locator(".action-node").first(), r = await card.boundingBox();
  await page.mouse.move(r.x + 15, r.y + 12); await page.mouse.down();
  await page.locator("#timelineScroll").evaluate(n => { n.scrollLeft += 100; });
  const x = r.x + 15 + (16.3 - 10) * 60 - 100 + 6;
  await page.mouse.move(x, r.y + 12, { steps: 10 });
  await expect(page.locator("#timelineAlignment")).toHaveCount(0);
  await page.keyboard.down("Shift");
  await expect(page.locator("#timelineAlignment")).toHaveAttribute("data-time", "16.3");
  await page.keyboard.up("Shift");
  await expect(page.locator("#timelineAlignment")).toHaveCount(0);
  const grid = await card.evaluate(n => Number.parseFloat(n.style.left));
  expect(grid).toBeCloseTo(16.5 * 60 + 16, 5);
  await page.keyboard.down("Shift");
  await page.mouse.move(x + 3, r.y + 12);
  await expect(page.locator("#timelineAlignment")).toHaveCount(0);
  await page.mouse.move(x, r.y + 12);
  await expect(page.locator("#timelineAlignment")).toHaveCount(1);
  await page.keyboard.press("Escape"); await page.mouse.up(); await page.keyboard.up("Shift");
  await expect(page.locator("#timelineAlignment")).toHaveCount(0);
  expect((await saved(page)).maps[0].tracks[0].actions[0].position).toBe(10);
  expect(await card.evaluate(n => Number.parseFloat(n.style.left))).toBeCloseTo(616, 5);
});

test("new sequences choose layout thumbnails by radio and copy no actions or original IDs", async ({ page }) => {
  const project = fixture();
  await seed(page, project);
  const original = projectForSave(project).maps;
  await page.locator("#addMap").click();
  const picker = page.getByRole("dialog", { name: "シーケンスのマップを選択" });
  await expect(picker.locator(".layout-choice svg")).toHaveCount(1);
  await picker.getByRole("radio", { name: original[0].name, exact: true }).check();
  await picker.getByRole("button", { name: "このマップで作成", exact: true }).click();
  await expect.poll(async () => (await saved(page)).maps.length).toBe(2);
  const updated = await saved(page);
  expect(updated.maps[0]).toEqual(original[0]);
  expect(updated.maps[1].rooms[0].id).not.toBe(original[0].rooms[0].id);
  expect(updated.maps[1].rooms[0].cells).toEqual(original[0].rooms[0].cells);
  expect(updated.maps[1].tracks.every(t => !t.actions.length)).toBe(true);
  await page.locator("#undo").click();
  await expect.poll(async () => (await saved(page)).maps.length).toBe(1);
  expect((await saved(page)).maps).toEqual(original);
  await page.locator("#redo").click();
  await expect.poll(async () => (await saved(page)).maps.length).toBe(2);
  await page.reload();
  await expect(page.locator("#mapTabs [role=tab]")).toHaveCount(2);
  expect((await saved(page)).maps.slice(0, 1)).toEqual(original);
});

for (const kind of ["robot", "human"]) test(`automatic doors slide for an approaching ${kind} and close after passage and seek`, async ({ page }) => {
  const project = fixture(), map = project.maps[0];
  map.doorMode = "strict";
  const track = newTrack(map, kind);
  track.initial = { x: 125, y: 425, yaw: 0, roomId: "room" };
  map.tracks = [track];
  map.rooms = [
    { ...map.rooms[0], id: "room", name: "Left", x: 0, width: 800,
      cells: Array.from({ length: 576 }, (_, i) => i).filter(i => i % 32 < 16) },
    { ...map.rooms[0], id: "right", name: "Right", x: 800, width: 800,
      cells: Array.from({ length: 576 }, (_, i) => i).filter(i => i % 32 >= 16) },
  ];
  map.floorPlan.doors = Array.from({ length: 6 }, (_, index) => ({
    id: `door-${index}`, roomId: "room", cell: (6 + index) * 32 + 15, edge: "right",
  }));
  const move = newAction(map, track, "move");
  Object.assign(move, { x: 1475, y: 425, roomId: "right", position: 0, runSeconds: 10,
    trigger: { mode: "all", sources: [] } });
  track.actions = [move];
  const doors = newTrack(map, "room"); doors.roomId = "room";
  const unlock = newAction(map, doors, "unlock");
  Object.assign(unlock, { roomId: "room", position: 0, runSeconds: 5 });
  doors.actions.push(unlock); map.tracks.push(doors);
  await seed(page, project);
  const seek = async at => {
    await page.locator("#timelineScroll").evaluate((n, left) => { n.scrollLeft = left; },
      Math.max(0, at * 26 - 200));
    const ruler = await page.locator("#ruler").boundingBox();
    await page.mouse.click(ruler.x + 16 + at * 26, ruler.y + 10);
  };
  const door = page.locator("#doorLayer [data-auto-door]");
  await expect(door).toHaveCount(1);
  await expect(door).toHaveAttribute("data-state", "closed");
  await seek(5);
  await expect(door).toHaveAttribute("data-state", "open");
  await expect(door).toHaveAttribute("data-permission", "safety-hold");
  await expect(door.locator("[data-door-frame]")).toBeVisible();
  await expect(door.locator("[data-door-jamb]")).toHaveCount(2);
  expect(await door.locator("[data-door-leaf=left]").getAttribute("transform")).not.toBe("translate(0 0)");
  await expect(door.locator("[data-door-panels]")).toHaveAttribute("overflow", "hidden");
  for (const leaf of await door.locator("[data-door-leaf]").all()) {
    expect(await leaf.evaluate(element => {
      const viewport = element.parentElement;
      const box = element.getBBox(), matrix = element.transform.baseVal.consolidate().matrix;
      const left = box.x + matrix.e, right = left + box.width;
      const width = Number(viewport.getAttribute("width"));
      return viewport.tagName.toLowerCase() === "svg" && (right <= 0.1 || left >= width - 0.1);
    })).toBe(true);
  }
  await seek(6);
  await expect(door).toHaveAttribute("data-state", "closed");
  await expect(door).toHaveAttribute("data-permission", "locked");
  await seek(10);
  await expect(door).toHaveAttribute("data-state", "closed");
  await seek(5);
  await expect(door).toHaveAttribute("data-state", "open");
  await seek(0);
  await expect(door).toHaveAttribute("data-state", "closed");
  expect((await saved(page)).maps[0].floorPlan.doors).toEqual(map.floorPlan.doors);
  await expect(page.locator("#safetyWarnings")).not.toBeVisible();
  await page.locator(".track-label").nth(1).locator("button").first().click();
  await seek(5);
  await expect(door).toHaveAttribute("data-state", "closed");
  await expect(page.locator("#safetyWarnings")).toContainText("施錠中");
});

test("fleet meeting and security doors slide continuously across turn, arrival and departure boundaries", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const project = createFleetDemoMap(), map = project.maps[0];
  const doors = mergedDoors(map), roomId = name => map.rooms.find(r => r.name === name).id;
  const meeting = doors.find(d => d.roomId === roomId("Meeting Room 1") && d.points[0] === 400);
  const bay = doors.find(d => d.roomId === roomId("Security Waiting Bay"));
  await seed(page, project);
  await expect.poll(async () => (await saved(page)).maps[0].doorMode).toBe("story");
  const before = await saved(page);
  await page.locator("#fitStage").click();
  const values = await page.evaluate(({ meetingId, bayId }) => {
    const seek = document.querySelector("#previewSeek");
    const sample = at => {
      seek.value = String(at); seek.dispatchEvent(new Event("input", { bubbles: true }));
      return Object.fromEntries([meetingId, bayId].map(id => {
        const door = document.querySelector(`[data-door="${id}"]`);
        return [id, { openness: Number(door.dataset.openness),
          transform: door.querySelector("[data-door-leaf=left]").getAttribute("transform") }];
      }));
    };
    const points = [0, 3, 3.2, 3.4, 3.61, 4, 4.4, 4.6, 4.8, 5,
      11.39, 11.55, 11.7, 11.85, 12, 14.5, 14.65, 14.8, 14.95, 15.11];
    const samples = Object.fromEntries(points.map(at => [at, sample(at)]));
    let maxJump = 0;
    for (const [from, to, id] of [[2.8, 3.8, meetingId], [4.2, 5.2, meetingId],
      [11.2, 12.2, bayId], [14.3, 15.3, bayId]]) {
      let previous = sample(from)[id].openness;
      for (let at = from + .02; at <= to; at += .02) {
        const next = sample(at)[id].openness;
        maxJump = Math.max(maxJump, Math.abs(next - previous)); previous = next;
      }
    }
    return { samples, maxJump, backward: sample(11.7)[bayId] };
  }, { meetingId: meeting.id, bayId: bay.id });
  const at = (time, door) => values.samples[time][door.id].openness;
  expect(at(0, meeting)).toBe(0);
  expect(at(3, meeting)).toBeGreaterThan(.9);
  expect(at(3.2, meeting)).toBeLessThan(at(3, meeting));
  expect(at(3.4, meeting)).toBeGreaterThan(0);
  expect(at(3.61, meeting)).toBe(0);
  expect(at(4.6, meeting)).toBeGreaterThan(0);
  expect(at(4.8, meeting)).toBeGreaterThan(at(4.6, meeting));
  expect(at(11.39, bay)).toBe(0);
  expect(at(11.55, bay)).toBeGreaterThan(0);
  expect(at(11.7, bay)).toBeGreaterThan(at(11.55, bay));
  expect(at(11.85, bay)).toBeLessThan(1);
  expect(at(12, bay)).toBe(1);
  expect(at(14.5, bay)).toBe(1);
  expect(at(14.65, bay)).toBeLessThan(1);
  expect(at(14.95, bay)).toBeGreaterThan(0);
  expect(at(15.11, bay)).toBe(0);
  expect(values.maxJump).toBeLessThan(.04);
  expect(values.backward).toEqual(values.samples[11.7][bay.id]);
  expect(new Set([11.55, 11.7, 11.85].map(t => values.samples[t][bay.id].transform)).size).toBe(3);
  await page.mouse.move(640, 200);
  await page.locator("#fullscreenPreview").click();
  expect(await saved(page)).toEqual(before);
});

for (const [name, create] of [["fleet", createFleetDemoMap], ["office", createOfficeDemoMap]]) {
test(`demo ${name} door frames persist above room activities when open, closed and seeking backwards`, async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const project = create(), expected = mergedDoors(project.maps[0]).length;
  await seed(page, project);
  await page.locator("#fitStage").click();
  for (const at of [0, 5, 10, 15, 20, 30, 40, 15, 0]) {
    await page.mouse.move(640 + at, 200);
    await page.getByLabel("プレビュー再生位置").fill(String(at));
    const doors = page.locator("#doorLayer [data-auto-door]");
    await expect(doors).toHaveCount(expected);
    await expect(page.locator("#doorLayer [data-door-frame]")).toHaveCount(expected);
    for (const door of await doors.all()) {
      await expect(door.locator("[data-door-frame]")).toBeVisible();
      const bounds = await door.locator("[data-door-frame]").boundingBox();
      expect(bounds.width).toBeGreaterThan(0);
      expect(bounds.height).toBeGreaterThan(0);
    }
    expect(await page.locator("#doorLayer").evaluate(el => {
      const order = [...el.parentElement.children].map(node => node.id);
      return order.indexOf("doorLayer") > order.indexOf("roomLayer") &&
        order.indexOf("doorLayer") > order.indexOf("effectLayer") &&
        order.indexOf("doorLayer") < order.indexOf("robotLayer");
    })).toBe(true);
  }
});
}

test("office rooms show cleaning and surveillance, while unrelated doors stay closed", async ({ page }) => {
  const project = createOfficeDemoMap(), map = project.maps[0];
  await seed(page, project);
  const seek = async at => {
    await page.locator("#timelineScroll").evaluate((n, left) => { n.scrollLeft = left; },
      Math.max(0, at * 26 - 200));
    const ruler = await page.locator("#ruler").boundingBox();
    await page.mouse.click(ruler.x + 16 + at * 26, ruler.y + 10);
  };
  const chargingRoom = map.rooms.find(room => room.name === "Robot Station");
  await expect(page.locator(`[data-room-activity="${chargingRoom.id}"]`)).toHaveCount(0);
  // 受付に立つ社員・ゲストだけで、廊下の解錠済みドアを開かない。
  await expect(page.locator("#doorLayer [data-auto-door][data-state=open]")).toHaveCount(0);
  const clean = map.tracks.flatMap(track => track.actions).find(action => action.name === "清掃（3秒）");
  await seek(clean.position + 1);
  const meeting = map.rooms.find(room => room.name === "Meeting Room");
  const office = map.rooms.find(room => room.name === "Open Office");
  await expect(page.locator(`[data-room-activity="${meeting.id}"]`)).toContainText("掃除中");
  await expect(page.locator(`[data-room-activity="${office.id}"]`)).toContainText("監視中");
  const cleaner = map.tracks.find(track => track.robotRole === "cleaning");
  const security = map.tracks.find(track => track.robotRole === "security");
  await expect(page.locator(`#robotLayer [data-actor="${cleaner.id}"]`)).toHaveCount(0);
  await expect(page.locator(`#robotLayer [data-actor="${security.id}"]`)).toHaveCount(0);
  await page.locator(".track-label").nth(map.tracks.indexOf(cleaner)).click();
  await expect(page.locator(`#robotLayer [data-actor="${cleaner.id}"]`)).toHaveCount(0);
  await expect(page.locator("#stageSelection")).not.toHaveAttribute("data-focus", `actor:${cleaner.id}`);
  await seek(Math.max(...cleaner.actions.map(action => action.position + action.runSeconds)));
  await expect(page.locator(`[data-room-activity="${meeting.id}"]`)).toHaveCount(0);
  await expect(page.locator(`[data-room-activity="${chargingRoom.id}"]`)).toHaveCount(0);
  await expect(page.locator(`#robotLayer [data-actor="${cleaner.id}"]`)).toHaveCount(1);
  await seek(clean.position + 1);
  await expect(page.locator(`#robotLayer [data-actor="${cleaner.id}"]`)).toHaveCount(0);
});

test("robots remain visible while travelling through the entrance and turning after cleaning", async ({ page }) => {
  const project = createFleetDemoMap(), map = project.maps[0];
  const cleaner = map.tracks.find(track => track.robotRole === "cleaning");
  await seed(page, project);
  const seek = async at => {
    await page.locator("#timelineScroll").evaluate((el, left) => { el.scrollLeft = left; },
      Math.max(0, at * 26 - 200));
    const ruler = await page.locator("#ruler").boundingBox();
    await page.mouse.click(ruler.x + 16 + at * 26, ruler.y + 10);
  };
  const robot = page.locator(`#robotLayer [data-actor="${cleaner.id}"]`);
  const hall = map.rooms.find(room => room.name === "Entrance Hall");
  const trip = cleaner.actions.find(action => action.name === "Follow the lower corridor east");
  const clean = cleaner.actions.find(action => action.name === "Clean Meeting Room 1");
  const turn = cleaner.actions.find(action => action.name === "Face the return corridor");
  await seek(trip.position + .5);
  await expect(robot).toHaveCount(1);
  await expect(page.locator(`[data-room-activity="${hall.id}"]`)).toHaveCount(0);
  await seek(clean.position + .5);
  await expect(robot).toHaveCount(0);
  await seek(turn.position + .5);
  await expect(robot).toHaveCount(1);
  await seek(trip.position + .5);
  await expect(robot).toHaveCount(1);
});

test("unlocked automatic door stays closed for a nearby parallel route", async ({ page }) => {
  const project = fixture(), map = project.maps[0], human = newTrack(map, "human");
  human.initial = { x: 625, y: 325, yaw: 0, roomId: "room" };
  map.tracks = [human];
  map.rooms = [
    { ...map.rooms[0], width: 800, cells: map.rooms[0].cells.filter(i => i % 32 < 16) },
    { ...map.rooms[0], id: "right", name: "Right", x: 800, width: 800,
      cells: map.rooms[0].cells.filter(i => i % 32 >= 16) },
  ];
  map.floorPlan.doors = Array.from({ length: 6 }, (_, index) => ({
    id: `parallel-door-${index}`, roomId: "room", cell: (6 + index) * 32 + 15, edge: "right",
  }));
  const move = Object.assign(newAction(map, human, "move"), { x: 625, y: 625,
    roomId: "room", position: 0, runSeconds: 10 });
  human.actions.push(move);
  const doors = newTrack(map, "room"); doors.roomId = "room";
  doors.actions.push(Object.assign(newAction(map, doors, "unlock"), { position: 0, runSeconds: 11,
    roomId: "room" }));
  map.tracks.push(doors);
  await seed(page, project);
  const door = page.locator("#doorLayer [data-auto-door]");
  await expect(door).toHaveAttribute("data-permission", "unlocked");
  await expect(door).toHaveAttribute("data-state", "closed");
  const ruler = await page.locator("#ruler").boundingBox();
  await page.mouse.click(ruler.x + 16 + 4 * 26, ruler.y + 10);
  await expect(door).toHaveAttribute("data-state", "closed");
  await page.locator("#home").click();
  await expect(door).toHaveAttribute("data-state", "closed");
});

test("room unlock controls choose actual room names and persist their exact bar duration", async ({ page }) => {
  const project = fixture(), map = project.maps[0];
  const initialRoom = map.rooms[0];
  map.rooms = [
    { ...initialRoom, width: 800, cells: initialRoom.cells.filter(i => i % 32 < 16) },
    { ...initialRoom, id: "other-room", name: "Meeting B", x: 800, width: 800,
      cells: initialRoom.cells.filter(i => i % 32 >= 16) },
  ];
  const doors = newTrack(map, "room"); doors.roomId = initialRoom.id;
  map.tracks.push(doors);
  await seed(page, project);
  await page.locator(".track-label").last().click();
  await page.locator("#actionPalette").getByRole("button", { name: "✦ ドア解錠", exact: true }).click();
  const dialog = page.locator("#actionDialog");
  const room = dialog.getByRole("combobox", { name: "解錠する部屋", exact: true });
  await expect(room.locator("option")).toHaveText(["部屋・設備を選択", "広場", "Meeting B"]);
  await room.selectOption("other-room");
  await expect(dialog.getByRole("textbox", { name: "アクション名", exact: true })).toHaveValue("Meeting B解錠");
  await dialog.getByRole("spinbutton", { name: "実行にかける秒数", exact: true }).fill("8");
  await dialog.getByRole("button", { name: "適用", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect.poll(async () => (await saved(page)).maps[0].tracks.at(-1).actions.length).toBe(1);
  const action = (await saved(page)).maps[0].tracks.at(-1).actions[0];
  expect(action.type).toBe("unlock");
  expect(action.roomId).toBe("other-room");
  expect(action.runSeconds).toBe(8);
  await page.reload();
  await expect(page.locator(".action-node").last()).toContainText("Meeting B解錠");
});

test("robot role selection changes its game-style body and preserves a physical 100mm footprint", async ({ page }) => {
  await seed(page);
  await page.locator(".track-label").first().click();
  for (const role of ["cleaning", "security", "delivery"]) {
    await page.getByRole("combobox", { name: "ロボット種別", exact: true }).selectOption(role);
    await expect.poll(async () => (await saved(page)).maps[0].tracks[0].robotRole).toBe(role);
    const actor = page.locator("#robotLayer [data-actor]").first();
    await expect(actor.locator("[data-robot-role]")).toHaveAttribute("data-robot-role", role);
    const body = actor.locator("[data-robot-body]");
    const side = Number(await body.getAttribute("width"));
    const widthMm = 50 * 25.4 * 16 / Math.hypot(16, 9);
    expect(side * widthMm / 1600).toBeCloseTo(100, 8);
    expect(Number(await body.getAttribute("height"))).toBe(side);
  }
  await page.reload();
  await expect(page.locator("#robotLayer [data-robot-role]").first()).toHaveAttribute("data-robot-role", "delivery");
});

test("charging mask creation has no walls or obstacles and supports local undo, selection deletion and reload", async ({ page }) => {
  await seed(page);
  await page.locator("#editMap").click();
  const dialog = page.locator("#mapEditorDialog"), canvas = dialog.locator("svg.me-canvas");
  await page.getByRole("button", { name: "部屋編集モード", exact: true }).click();
  await page.getByRole("button", { name: "⚡ 充電スペース", exact: true }).click();
  await draw(page, canvas, 825, 125, 1025, 325);
  await expect(canvas.locator("[data-charging-zone]")).toHaveCount(1);
  await dialog.getByRole("button", { name: "↶ 戻す", exact: true }).click();
  await expect(canvas.locator("[data-charging-zone]")).toHaveCount(0);
  await dialog.getByRole("button", { name: "↷ やり直す", exact: true }).click();
  await expect(canvas.locator("[data-charging-zone]")).toHaveCount(1);
  await dialog.getByRole("button", { name: "マップに適用", exact: true }).click();
  await expect.poll(async () => (await saved(page)).maps[0].floorPlan.chargingZones?.length).toBe(1);
  const data = (await saved(page)).maps[0];
  expect(data.navigation.obstacles).toHaveLength(0);
  expect(data.floorPlan.doors).toHaveLength(0);
  expect(data.rooms).toHaveLength(1);
  await page.reload();
  await expect(page.locator("#floorLayer [data-charging-zone]")).toHaveCount(1);
  await page.locator("#editMap").click();
  await page.getByRole("button", { name: "部屋編集モード", exact: true }).click();
  await draw(page, page.locator("svg.me-canvas"), 925, 225);
  await page.getByRole("button", { name: "選択物を削除", exact: true }).click();
  await expect(page.locator("svg.me-canvas [data-charging-zone]")).toHaveCount(0);
  await page.getByRole("button", { name: "マップに適用", exact: true }).click();
  await expect.poll(async () => (await saved(page)).maps[0].floorPlan.chargingZones?.length).toBe(0);
});

for (const kind of ["human"]) test(`first actor controls request an initial MAP position for ${kind}`, async ({ page }) => {
  const p = fixture();
  const track = newTrack(p.maps[0], kind);
  track.initial = { x: 725, y: 725, yaw: 0, roomId: "room" };
  p.maps[0].tracks.push(track);
  await seed(page, p);
  await page.locator(".track-label").last().click();
  const control = kind === "human" ? "＋ 待機" : "＋ 移動";
  await page.getByRole("button", { name: control, exact: true }).click();
  await expect(page.getByRole("heading", { name: "初期位置をどこにしますか？" })).toBeVisible();
  await expect(page.locator("#actionDialog")).not.toBeVisible();
  await page.getByRole("button", { name: "閉じる", exact: true }).click();
  expect(await saved(page)).toEqual(p);
  await page.getByRole("button", { name: control, exact: true }).click();
  const picker = page.locator(".coordinate-dialog .action-map-picker");
  const cancelledChoice = await svgPoint(picker, 625, 375);
  await page.mouse.click(cancelledChoice.x, cancelledChoice.y);
  await page.getByLabel("初期の向き（°）", { exact: true }).fill("45");
  await page.keyboard.press("Escape");
  expect(await saved(page)).toEqual(p);
  await page.getByRole("button", { name: control, exact: true }).click();
  if (kind === "robot") {
    const invalid = await svgPoint(picker, 25, 875);
    await page.mouse.click(invalid.x, invalid.y);
    await expect(page.getByRole("heading", { name: "初期位置をどこにしますか？" })).toBeVisible();
    await expect(page.locator(".coordinate-dialog").getByRole("button", { name: "適用", exact: true })).toBeDisabled();
  }
  const firstChoice = await svgPoint(picker, 625, 375);
  await page.mouse.click(firstChoice.x, firstChoice.y);
  await expect(page.locator("#actionDialog")).not.toBeVisible();
  expect(await saved(page)).toEqual(p);
  const valid = await svgPoint(picker, 725, 375);
  await page.mouse.click(valid.x, valid.y);
  await expect(page.locator(".coordinate-dialog")).toBeVisible();
  expect(await saved(page)).toEqual(p);
  const initialDialog = page.locator(".coordinate-dialog");
  const apply = initialDialog.getByRole("button", { name: "適用", exact: true });
  const yaw = initialDialog.getByLabel("初期の向き（°）", { exact: true });
  await yaw.fill("181"); await expect(apply).toBeDisabled();
  await yaw.fill(""); await expect(apply).toBeDisabled();
  await yaw.fill("90");
  await expect(initialDialog.locator("[data-initial-heading]")).toHaveAttribute("transform", "rotate(-90)");
  await expect(apply).toBeEnabled();
  const layout = await initialDialog.boundingBox(), footer = await initialDialog.locator(".initial-coordinate-actions").boundingBox();
  const buttonBox = await apply.boundingBox();
  expect(Math.abs(buttonBox.x + buttonBox.width - footer.x - footer.width)).toBeLessThan(1);
  expect(buttonBox.y).toBeGreaterThan(layout.y + layout.height / 2);
  expect(buttonBox.y + buttonBox.height).toBeLessThanOrEqual(720);
  await apply.click();
  await expect(page.locator("#actionDialog")).toBeVisible();
  await expect.poll(async () => (await saved(page)).maps[0].tracks.at(-1).initial.x).toBe(725);
  await expect.poll(async () => (await saved(page)).maps[0].tracks.at(-1).initial.y).toBe(525);
  expect((await saved(page)).maps[0].tracks.at(-1).initial.yaw).toBe(90);
  await page.locator("#actionForm button[type=submit]").click();
  await expect.poll(async () => (await saved(page)).maps[0].tracks.at(-1).actions.length).toBe(1);
  await page.locator(".track-label").last().click();
  await page.getByRole("button", { name: "＋ 待機", exact: true }).click();
  await expect(page.locator("#actionDialog")).toBeVisible();
  await expect(page.locator(".coordinate-dialog")).toHaveCount(0);
  await page.locator("#cancelAction").click();
});

test("inserting earlier actor actions prompts for initial position but ordinary edits do not", async ({ page }) => {
  const p = fixture();
  p.maps[0].tracks[0].kind = "human"; p.maps[0].tracks[0].count = 1;
  p.maps[0].tracks[0].actions.forEach(a => { a.position += 8; });
  await seed(page, p);
  await page.locator(".action-node").first().dblclick();
  await expect(page.locator("#actionDialog")).toBeVisible();
  await expect(page.locator(".coordinate-dialog")).toHaveCount(0);
  await page.locator("#cancelAction").click();
  await page.locator('#actionPalette [data-type="move"]').dragTo(page.locator(".lane").first(),
    { targetPosition: { x: 5, y: 35 } });
  await expect(page.getByRole("heading", { name: "初期位置をどこにしますか？" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".coordinate-dialog")).toHaveCount(0);
  expect(await saved(page)).toEqual(p);
});

test("dragging changes actual start and resizing changes travel duration", async ({ page }) => {
  await seed(page);
  const card = page.locator(".action-node").first(), box = await card.boundingBox();
  await page.mouse.move(box.x + 25, box.y + 12); await page.mouse.down();
  await page.mouse.move(box.x + 77, box.y + 12, { steps: 10 }); await page.mouse.up();
  await expect.poll(async () => (await saved(page)).maps[0].tracks[0].actions[0].position).toBe(2);
  const handle = page.locator(".action-node").first().locator(".duration-handle");
  const h = await handle.boundingBox();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2); await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 + 52, h.y + h.height / 2, { steps: 10 }); await page.mouse.up();
  await expect.poll(async () => (await saved(page)).maps[0].tracks[0].actions[0].runSeconds).toBe(8);
  await expect(page.locator(".action-node").first()).toHaveAttribute("title", /予定 2.00秒.*2.00〜10.00/);
  await expect(page.locator(".lane").first().locator(".action-node").nth(1)).toHaveClass(/blocked/);
  await expect(page.locator("#safetyWarnings")).toContainText("バーが重な");
});

test("map clicks snap to center; wall-crossing apply is rejected without replacing the project", async ({ page }) => {
  const p = fixture(), room = p.maps[0].rooms[0];
  p.maps[0].tracks[0].actions.pop();
  p.maps[0].tracks[0].actions[0].x = 325;
  room.cells = room.cells.filter(c => c % 32 < 10); Object.assign(room, regionBounds(room.cells));
  await page.addInitScript(p => localStorage.setItem("robot-scene-studio.v4", JSON.stringify(p)), p);
  await page.goto("/");
  await page.locator(".action-node").first().dblclick();
  const svg = page.locator(".action-spatial-map");
  const point = await svg.evaluate(s => {
    const p = new DOMPoint(622, 900 - 128).matrixTransform(s.getScreenCTM());
    return { x: p.x, y: p.y };
  });
  await page.mouse.click(point.x, point.y);
  await expect(editorError(page)).toContainText(/壁|通行/);
  await expect(page.locator(".action-spatial-map")).toHaveAttribute("data-invalid-destination", "true");
  await expect(editorApply(page)).toBeDisabled();
  await activeEditor(page).locator("form").dispatchEvent("submit");
  await expect(editorError(page)).toContainText(/壁|通行/);
  expect((await saved(page)).maps[0].tracks[0].actions[0].x).toBe(325);
  const validPoint = await page.locator(".action-spatial-map").evaluate(s => {
    const p = new DOMPoint(372, 900 - 178).matrixTransform(s.getScreenCTM());
    return { x: p.x, y: p.y };
  });
  await page.mouse.click(validPoint.x, validPoint.y);
  await expect(editorError(page)).toBeEmpty();
  await editorApply(page).click();
  await expect.poll(async () => (await saved(page)).maps[0].tracks[0].actions[0].x).toBe(375);
  expect((await saved(page)).maps[0].tracks[0].actions[0].y).toBe(175);
});

test("destination warnings appear before Apply for furniture, free cursor motion and invalid initial positions", async ({ page }) => {
  const p = fixture(), m = p.maps[0];
  m.floorPlan.furniture.push({ id: "obstacle", roomId: "room", cell: 15 * 32 + 8,
    type: "desk", rotation: 0 });
  await seed(page, p);
  await page.locator(".action-node").first().dblclick();
  await draw(page, page.locator(".action-spatial-map"), 425, 775);
  await expect(editorError(page)).toContainText("家具");
  await page.getByLabel("座標指定モード").selectOption("free");
  const svg = page.locator(".action-spatial-map");
  const invalid = await svgPoint(svg, 30, 775); await page.mouse.move(invalid.x, invalid.y);
  await expect(editorError(page)).toContainText("MAP外");
  const valid = await svgPoint(svg, 225, 675); await page.mouse.move(valid.x, valid.y);
  await expect(editorError(page)).toBeEmpty();
  await editorCancel(page).click();
  await page.locator("#trackLabels .track-label").first().click();
  await page.getByRole("button", { name: "初期位置を設定", exact: true }).click();
  await page.getByRole("button", { name: "MAPで初期位置を指定", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "MAPで位置を指定", exact: true });
  await draw(page, picker.locator("svg"), 25, 775);
  await expect(picker).toBeVisible();
  await expect(picker.locator("p.help").first()).toContainText("MAP外");
  expect((await saved(page)).maps[0].tracks[0].initial.x).toBe(125);
});

test("demo charging area accepts robot initial position and keeps it after reload", async ({ page }) => {
  const project = createFleetDemoMap();
  await seed(page, project);
  await page.locator("#trackLabels .track-label").filter({ hasText: "Cleaning Robot" }).click();
  await page.getByRole("button", { name: "初期位置を設定", exact: true }).click();
  const initial = page.getByRole("dialog", { name: "初期位置を設定", exact: true });
  await initial.getByRole("button", { name: "MAPで初期位置を指定", exact: true }).click();
  const picker = page.locator(".coordinate-dialog");
  await draw(page, picker.locator(".action-map-picker"), 175, 725);
  await expect(picker.getByRole("button", { name: "適用", exact: true })).toBeEnabled();
  await picker.getByRole("button", { name: "適用", exact: true }).click();
  await initial.getByRole("button", { name: "適用", exact: true }).click();
  await page.reload();
  const cleaner = (await saved(page)).maps[0].tracks.find(t => t.robotRole === "cleaning");
  expect(cleaner.initial).toMatchObject({ x: 175, y: 175 });
});

test("palette drag previews highlight time and map targets and mark incompatible or locked tracks as forbidden", async ({ page }) => {
  const p = fixture(), m = p.maps[0], room = newTrack(m, "room");
  room.roomId = "room"; m.tracks.push(room);
  await seed(page, p);
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  const source = page.locator('#actionPalette [data-type="move"]');
  await source.dispatchEvent("dragstart", { dataTransfer: transfer });
  const lane = page.locator(".lane").first(), bounds = await lane.boundingBox();
  const at = { clientX: bounds.x + 104, clientY: bounds.y + 30, dataTransfer: transfer };
  await lane.dispatchEvent("dragover", at);
  await expect(lane.locator(".drop-preview")).toContainText("3.4秒");
  const highlight = await lane.locator(".drop-preview").boundingBox();
  expect(Math.abs(highlight.x - at.clientX)).toBeLessThan(1);
  await expect(lane.locator(".drop-preview")).not.toHaveClass(/invalid/);
  await page.locator(".lane").last().dispatchEvent("dragover", at);
  await expect(page.locator(".lane").last().locator(".drop-preview")).toHaveClass(/invalid/);
  await expect(page.locator(".drop-preview")).toContainText("配置できません");
  await page.locator(".lane").last().dispatchEvent("drop", at);
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(page.locator(".drop-preview")).toHaveCount(0);
  await source.dispatchEvent("dragend", { dataTransfer: transfer });
  await page.locator("#trackLabels .track-label").first().click();
  await source.dispatchEvent("dragstart", { dataTransfer: transfer });
  const stage = page.locator("#stage");
  const valid = await svgPoint(stage, 425, 725);
  await stage.dispatchEvent("dragover", { clientX: valid.x, clientY: valid.y, dataTransfer: transfer });
  await expect(stage.locator(".drop-preview")).not.toHaveClass(/invalid/);
  await expect(stage.locator(".drop-preview text")).toContainText("X 425.0 / Y 175.0");
  const invalid = await svgPoint(stage, 25, 775);
  await stage.dispatchEvent("dragover", { clientX: invalid.x, clientY: invalid.y, dataTransfer: transfer });
  await expect(stage.locator(".drop-preview")).toHaveClass(/invalid/);
  await expect(stage.locator(".drop-preview text")).toContainText("MAP外");
  await stage.dispatchEvent("drop", { clientX: invalid.x, clientY: invalid.y, dataTransfer: transfer });
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await source.dispatchEvent("dragend", { dataTransfer: transfer });
  await source.dispatchEvent("dragstart", { dataTransfer: transfer });
  await lane.dispatchEvent("dragover", at); await lane.dispatchEvent("drop", at);
  await expect(activeEditor(page)).toBeVisible();
  await editorCancel(page).click();
  await source.dispatchEvent("dragend", { dataTransfer: transfer });
  await page.getByRole("button", { name: "ロボット 1 編集ロック", exact: true }).click();
  await source.dispatchEvent("dragstart", { dataTransfer: transfer });
  await lane.dispatchEvent("dragover", at);
  await expect(lane.locator(".drop-preview")).toContainText("ロック");
  await source.dispatchEvent("dragend", { dataTransfer: transfer });
  await expect(page.locator(".drop-preview")).toHaveCount(0);
  expect((await saved(page)).maps[0].tracks[0].actions).toHaveLength(2);
});

test("palette preview left edge matches cursor and saved card after zoom and horizontal scrolling", async ({ page }) => {
  const project = fixture(); project.maps[0].tracks[0].actions = [];
  await seed(page, project);
  const source = page.locator('#actionPalette [data-type="wait"]');
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  for (const zoom of [12, 60, 100]) {
    await page.locator("#zoom").fill(String(zoom)); await page.locator("#zoom").dispatchEvent("input");
    await page.locator("#timelineScroll").evaluate(n => { n.scrollLeft = 83; });
    const scroll = await page.locator("#timelineScroll").boundingBox();
    const lane = page.locator(".lane").first(), bounds = await lane.boundingBox();
    const at = { clientX: scroll.x + 173, clientY: bounds.y + 30, dataTransfer: transfer };
    await source.dispatchEvent("dragstart", { dataTransfer: transfer });
    await lane.dispatchEvent("dragover", at);
    const highlight = await lane.locator(".drop-preview").boundingBox();
    expect(Math.abs(highlight.x - at.clientX)).toBeLessThan(1);
    await lane.dispatchEvent("drop", at);
    await expect(activeEditor(page)).toBeVisible();
    await editorApply(page).click();
    const position = (at.clientX - bounds.x - 16) / zoom;
    await expect.poll(async () => (await saved(page)).maps[0].tracks[0].actions.at(-1)?.position)
      .toBeCloseTo(position, 6);
    const card = page.locator(".lane").first().locator(".action-node").last();
    const actual = await card.boundingBox();
    expect(Math.abs(actual.x - at.clientX)).toBeLessThan(1);
    await source.dispatchEvent("dragend", { dataTransfer: transfer });
    await page.locator("#undo").click();
    await expect.poll(async () => (await saved(page)).maps[0].tracks[0].actions.length).toBe(0);
  }
});

test("native palette dragging opens the matching timeline editor and clears placement highlights", async ({ page }) => {
  await seed(page);
  await page.locator('#actionPalette [data-type="move"]').dragTo(page.locator(".lane").first(),
    { targetPosition: { x: 220, y: 30 } });
  await expect(activeEditor(page)).toBeVisible();
  await expect(activeEditor(page).getByLabel("名称", { exact: true })).toHaveValue("ロボット 1");
  await expect(page.locator(".drop-preview")).toHaveCount(0);
  await editorCancel(page).click();
  expect((await saved(page)).maps[0].tracks[0].actions).toHaveLength(2);
});

test("two tabs cannot silently overwrite one another's autosave", async ({ page, context }) => {
  await seed(page);
  const other = await context.newPage(); await other.goto("/");
  await page.locator("#projectName").fill("first writer");
  await page.locator("#projectName").press("Tab");
  await expect.poll(async () => (await saved(page)).name).toBe("first writer");
  await expect(other.locator("#notice")).toContainText("自動保存を停止");
  await other.locator("#projectName").fill("stale writer");
  await other.locator("#projectName").press("Tab");
  await expect(other.locator("#storageStatus")).toContainText("FAILED");
  expect((await saved(page)).name).toBe("first writer");
  await expect(other.locator("#projectName")).toHaveValue("stale writer");
});

test("wait bars retain editable duration and no condition fields", async ({ page }) => {
  await seed(page);
  await page.locator("#trackLabels .track-label").first().click();
  await page.getByRole("button", { name: "＋ 待機", exact: true }).click();
  await page.getByLabel("待機する秒数").fill("3");
  await editorApply(page).click();
  await expect.poll(async () => (await saved(page)).maps[0].tracks[0].actions.at(-1).type).toBe("wait");
  await page.locator(".lane").first().locator(".action-node").last().dblclick();
  await page.getByLabel("待機する秒数").fill("5");
  await expect(page.locator(".trigger-source")).toHaveCount(0);
  await editorApply(page).click();
  await expect(activeEditor(page)).toHaveCount(0);
  await expect.poll(async () => (await saved(page)).maps[0].tracks[0].actions.at(-1).runSeconds).toBe(5);
});

test("legacy late conditions are removed and moving the bar changes only its start", async ({ page }) => {
  const p = fixture();
  delete p.maps[0].timelineOnly;
  p.maps[0].tracks[1].actions[0].trigger = { mode: "all", sources: [
    { actionId: p.maps[0].tracks[0].actions[0].id, event: "complete", delay: 0 },
  ] };
  await seed(page, p);
  const card = page.locator(".lane").nth(1).locator(".action-node").first();
  await expect(card).toHaveClass(/running/);
  await expect(page.locator("#safetyWarnings")).not.toBeVisible();
  const bounds = await card.boundingBox();
  await page.mouse.move(bounds.x + 30, bounds.y + 12); await page.mouse.down();
  await page.mouse.move(bounds.x + 30 + 8 * 26, bounds.y + 12, { steps: 12 }); await page.mouse.up();
  await expect.poll(async () => (await saved(page)).maps[0].tracks[1].actions[0].position).toBe(8);
  await expect(card).not.toHaveClass(/blocked/);
  await expect(card).toHaveAttribute("title", /8.00〜14.00/);
});

test("timeline ignores legacy physical timeout settings and completes at the bar right edge", async ({ page }) => {
  const p = fixture();
  Object.assign(p.maps[0].tracks[0].actions[0], { timeoutSeconds: 1, dwell: 10, simulationOutcome: "failed" });
  await seed(page, p);
  await page.locator(".action-node").first().dblclick();
  await expect(page.locator(".execution-options")).toHaveCount(0);
  await editorApply(page).click();
  const ruler = await page.locator("#ruler").boundingBox();
  await page.mouse.click(ruler.x + 2 * 26 + 16, ruler.y + 10);
  await expect(page.locator("#actionResult")).toContainText("実行中");
  await expect(page.locator("#actionResult")).toContainText("実測位置：未取得");
  await page.mouse.click(ruler.x + 6 * 26 + 16, ruler.y + 10);
  await expect(page.locator("#actionResult")).toContainText("成功");
  await expect(page.locator(".lane").first().locator(".action-node").nth(1)).not.toHaveClass(/blocked/);
});

async function svgPoint(svg, x, y) {
  return svg.evaluate((s, p) => {
    const at = new DOMPoint(p.x, p.y).matrixTransform(s.getScreenCTM());
    return { x: at.x, y: at.y };
  }, { x, y });
}
async function clickedWorld(svg, screen) {
  return svg.evaluate((s, p) => {
    const at = new DOMPoint(Math.floor(p.x), Math.floor(p.y)).matrixTransform(s.getScreenCTM().inverse());
    return { x: at.x, y: 900 - at.y };
  }, screen);
}
async function draw(page, svg, x1, y1, x2 = x1, y2 = y1) {
  const a = await svgPoint(svg, x1, y1), b = await svgPoint(svg, x2, y2);
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 }); await page.mouse.up();
}

test("map authoring covers zoning, materials, merged doors, furniture, local undo/redo and persistence", async ({ page }) => {
  await seed(page);
  await page.locator("#addMap").click();
  await page.getByRole("radio", { name: "新しくマップを描く", exact: true }).check();
  await page.getByRole("button", { name: "このマップで作成", exact: true }).click();
  const editor = page.locator("#mapEditorDialog"), canvas = editor.locator(".me-canvas");
  await editor.getByLabel("マップ名", { exact: true }).fill("検証用マップ");
  await editor.getByRole("button", { name: "＋ 新しい領域", exact: true }).click();
  await editor.getByRole("combobox", { name: /^描画/ }).selectOption("rectangle");
  await draw(page, canvas, 75, 175, 575, 725);
  await editor.getByRole("button", { name: "▤ 廊下を塗る", exact: true }).click();
  await editor.getByRole("button", { name: "＋ 新しい領域", exact: true }).click();
  await draw(page, canvas, 625, 275, 1075, 575);
  await editor.getByRole("button", { name: "部屋編集モード", exact: true }).click();
  await draw(page, canvas, 225, 325);
  await expect(editor.locator(".me-sidebar")).toBeVisible();
  await editor.getByLabel("領域名", { exact: true }).fill("執務室");
  await editor.getByLabel("領域名", { exact: true }).press("Tab");
  await editor.getByLabel("床材").selectOption("wood");
  await editor.getByRole("button", { name: "↔ 自動ドア", exact: true }).click();
  await draw(page, canvas, 600, 275);
  await expect(canvas.locator("[data-door]")).toHaveCount(1);
  await page.keyboard.press("Control+z");
  await expect(canvas.locator("[data-door]")).toHaveCount(0);
  await page.keyboard.press("Control+y");
  await expect(canvas.locator("[data-door]")).toHaveCount(1);
  await editor.getByRole("button", { name: "▣ 家具", exact: true }).click();
  for (const [type, variant, y] of [["desk", "long-desk", 225], ["chair", "bench", 325],
    ["plant", "large-plant", 525]]) {
    await editor.getByLabel("家具の種類").selectOption(type);
    await draw(page, canvas, 175, y, 275, type === "plant" ? y + 50 : y);
    await expect(canvas.locator(`[data-variant="${variant}"]`)).toHaveCount(1);
  }
  await editor.getByRole("button", { name: "90° 回転", exact: true }).click();
  await editor.getByRole("button", { name: "選択物を削除", exact: true }).click();
  await expect(canvas.locator("[data-furniture]")).toHaveCount(2);
  await page.keyboard.press("Control+z");
  await expect(canvas.locator("[data-furniture]")).toHaveCount(3);
  await editor.getByRole("button", { name: "マップに適用", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect.poll(async () => (await saved(page)).maps.length).toBe(2);
  const m = (await saved(page)).maps[1];
  expect(m.rooms.map(r => r.kind)).toEqual(["room", "corridor"]);
  expect(m.rooms[0].name).toBe("執務室");
  expect(m.rooms[0].material).toBe("wood");
  expect(m.floorPlan.doors).toHaveLength(6);
  expect(m.navigation.doors[0].memberIds).toHaveLength(6);
  expect(m.floorPlan.furniture.map(f => f.cells.length)).toEqual([3, 3, 6]);
  expect(m.tracks).toHaveLength(2);
  await page.locator("#editMap").click();
  await expect(page.locator(".me-canvas [data-furniture]")).toHaveCount(3);
  await page.locator("#mapEditorDialog").getByRole("button", { name: "キャンセル", exact: true }).click();
  await page.locator("#mapTabs button").first().click();
  await expect(page.locator(".action-node")).toHaveCount(3);
});

test("map apply validates the replacement map and keeps invalid edits open for correction", async ({ page }) => {
  await seed(page);
  await page.locator("#editMap").click();
  const editor = page.locator("#mapEditorDialog"), canvas = editor.locator(".me-canvas");
  await editor.getByRole("button", { name: "部屋編集モード", exact: true }).click();
  await draw(page, canvas, 425, 775);
  await editor.getByRole("button", { name: "▣ 家具", exact: true }).click();
  await draw(page, canvas, 425, 775);
  await editor.getByRole("button", { name: "マップに適用", exact: true }).click();
  await expect(editor).toBeVisible();
  await expect(editor.locator(".me-error")).toContainText("家具");
  expect((await saved(page)).maps[0].floorPlan.furniture).toHaveLength(0);
  await editor.getByRole("button", { name: "選択物を削除", exact: true }).click();
  await editor.getByRole("button", { name: "マップに適用", exact: true }).click();
  await expect(editor).toHaveCount(0);
});

test("initial pose, rotate editor, metadata locks, duplicate/delete and history work together", async ({ page }) => {
  await seed(page);
  await page.locator("#trackLabels .track-label").first().click();
  await page.getByRole("button", { name: "初期位置を設定", exact: true }).click();
  const initial = page.getByRole("dialog", { name: "初期位置を設定", exact: true });
  await initial.getByRole("button", { name: "MAPで初期位置を指定", exact: true }).click();
  await draw(page, page.locator(".action-map-picker"), 175, 725);
  await page.locator(".coordinate-dialog").getByRole("button", { name: "適用", exact: true }).click();
  await initial.getByLabel("初期の向き yaw", { exact: true }).fill("45");
  await initial.getByRole("button", { name: "適用", exact: true }).click();
  await expect.poll(async () => (await saved(page)).maps[0].tracks[0].initial.yaw).toBe(45);
  expect((await saved(page)).maps[0].tracks[0].initial.x).toBe(175);
  await page.getByRole("button", { name: "＋ 移動", exact: true }).click();
  await page.getByRole("button", { name: "↻ 回転", exact: true }).click();
  await page.getByLabel("回転後の角度（°）", { exact: true }).fill("90");
  await page.getByLabel("回転にかける秒数", { exact: true }).fill("2");
  await editorApply(page).click();
  await expect.poll(async () => (await saved(page)).maps[0].tracks[0].actions.at(-1).motion).toBe("rotate");
  await page.getByRole("button", { name: "複製", exact: true }).click();
  await expect.poll(async () => (await saved(page)).maps[0].tracks[0].actions.length).toBe(4);
  await page.getByRole("button", { name: "削除", exact: true }).click();
  await page.locator('#confirmDialog button[value="ok"]').click();
  await expect.poll(async () => (await saved(page)).maps[0].tracks[0].actions.length).toBe(3);
  await page.locator("#undo").click();
  await expect.poll(async () => (await saved(page)).maps[0].tracks[0].actions.length).toBe(4);
  await page.locator("#redo").click();
  await expect.poll(async () => (await saved(page)).maps[0].tracks[0].actions.length).toBe(3);
  await page.locator("#trackLabels .track-label").first().click();
  await page.getByRole("button", { name: "ロボット 1 編集ロック", exact: true }).click();
  await page.getByLabel("行名 / クラス名", { exact: true }).fill("locked rename");
  await page.getByLabel("行名 / クラス名", { exact: true }).press("Tab");
  await expect(page.locator("#notice")).toContainText("ロック");
  expect((await saved(page)).maps[0].tracks[0].name).toBe("ロボット 1");
});

test("JSON export/import, invalid import retention, new project and undo preserve contracts", async ({ page }) => {
  await seed(page);
  const downloadEvent = page.waitForEvent("download");
  await page.locator("#saveProject").click();
  const download = await downloadEvent;
  const stream = await download.createReadStream(), chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const data = Buffer.concat(chunks).toString("utf8"), exported = JSON.parse(data);
  expect(exported.schema).toBe("robot-scene/v5");
  expect(exported.maps[0].doorMode).toBe("story");
  expect(exported.maps[0].navigation.status).toBe("available");
  const broken = structuredClone(exported); broken.maps[0].tracks[0].robotId = 1;
  await page.locator("#projectFile").setInputFiles({ name: "invalid.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(broken)) });
  await expect(page.locator("#notice")).toContainText("重複");
  expect((await saved(page)).maps[0].tracks[0].robotId).toBe(0);
  exported.name = "再読込テスト";
  await page.locator("#projectFile").setInputFiles({ name: "valid.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(exported)) });
  await expect(page.locator("#projectName")).toHaveValue("再読込テスト");
  await expect.poll(async () => (await saved(page)).name).toBe("再読込テスト");
  await page.locator("#newProject").click();
  await page.locator('#confirmDialog button[value="ok"]').click();
  await expect(page.locator("#projectName")).toHaveValue("Robot scene");
  await expect(page.locator("#robotLayer [data-actor]")).toHaveCount(
    createFleetDemoMap().maps[0].tracks.filter(t => t.kind === "robot" || t.kind === "human").length);
  await expect(page.locator("#safetyWarnings")).not.toBeVisible();
  await page.locator("#undo").click();
  await expect(page.locator("#projectName")).toHaveValue("再読込テスト");
});

test("playback, seek, paths/grid, zoom, mute and map deletion remain independent of stored actions", async ({ page }) => {
  await seed(page);
  await page.locator("#showPaths").uncheck(); await expect(page.locator("#pathLayer line")).toHaveCount(0);
  await page.locator("#showPaths").check(); await expect(page.locator("#pathLayer line")).toHaveCount(3);
  await page.locator("#showGrid").uncheck(); await expect(page.locator("#gridLayer")).not.toBeVisible();
  await page.locator("#showGrid").check();
  await page.getByLabel("拡大").selectOption("2");
  await expect(page.locator("#stage")).toHaveClass(/zoomed/);
  await page.getByLabel("拡大").selectOption("1");
  await expect(page.locator("#stage")).not.toHaveClass(/zoomed/);
  await page.locator("#play").click();
  await expect(page.locator("#previewTime")).not.toHaveText("00:00.00");
  await page.locator("#play").click(); await expect(page.locator("#play")).toHaveAttribute("aria-label", "再生");
  await page.locator("#home").click(); await expect(page.locator("#previewTime")).toHaveText("00:00.00");
  await page.locator("#next").click(); await expect(page.locator("#previewTime")).toHaveText("00:06.00");
  await page.locator("#previous").click(); await expect(page.locator("#previewTime")).toHaveText("00:00.00");
  await page.getByRole("button", { name: "ロボット 2 プレビュー除外", exact: true }).click();
  await expect(page.locator("#robotLayer [data-actor]")).toHaveCount(1);
  await page.getByRole("button", { name: "ロボット 2 プレビュー除外", exact: true }).click();
  await expect(page.locator("#robotLayer [data-actor]")).toHaveCount(2);
  await page.locator("#deleteMap").click(); await expect(page.locator("#notice")).toContainText("最後");
});

test("server serves only local editor resources with restrictive browser headers", async ({ request }) => {
  for (const resource of ["/", "/app.js", "/model.js", "/safety.js", "/timed-plan.js",
    "/autosave.js", "/floor-plan.js", "/map-editor.js", "/style.css", "/map-editor.css"]) {
    const response = await request.get(resource);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-security-policy"]).toContain("connect-src 'self'");
    expect(response.headers()["cache-control"]).toBe("no-store");
    expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  }
  expect((await request.get("/package.json")).status()).toBe(404);
  expect((await request.post("/")).status()).toBe(404);
});

test("display templates and event styles edit on the map, then hide/end at their planned times", async ({ page }) => {
  const p = fixture(), m = p.maps[0];
  m.rooms[0].kind = "room";
  const display = newTrack(m, "display"), room = newTrack(m, "room");
  m.tracks.push(display, room); room.roomId = "room";
  await seed(page, p);
  await page.locator("#trackLabels .track-label").nth(2).click();
  await page.getByRole("button", { name: "＋ 表示", exact: true }).click();
  await page.getByLabel("表示テンプレート").selectOption("card");
  await page.getByLabel("表示する言葉", { exact: true }).fill("入口案内\nこちらへ");
  await draw(page, page.locator(".action-spatial-map"), 825, 375);
  await page.locator('#actionForm button[type="submit"]').click();
  await expect(page.locator("#effectLayer .template-card")).toContainText("入口案内");
  await page.getByRole("button", { name: "行の設定", exact: true }).click();
  await page.getByRole("button", { name: "＋ 表示を消去", exact: true }).click();
  await page.locator('#actionForm button[type="submit"]').click();
  await expect.poll(async () => (await saved(page)).maps[0].tracks[2].actions.length).toBe(2);
  const starts = (await saved(page)).maps[0].tracks[2].actions;
  expect(starts[1].targetId).toBe(starts[0].targetId);
  await page.locator("#trackLabels .track-label").nth(3).click();
  await page.getByRole("button", { name: "＋ イベント発生", exact: true }).click();
  await page.getByRole("combobox", { name: /^イベント/ }).selectOption("fire");
  await page.getByLabel("模様").selectOption("cross");
  await page.getByLabel("色", { exact: true }).fill("#ff3300");
  await page.getByLabel("表示する言葉", { exact: true }).fill("避難誘導");
  await page.locator('#actionForm button[type="submit"]').click();
  await expect(page.locator("#roomLayer")).toContainText("避難誘導");
  await page.getByRole("button", { name: "行の設定", exact: true }).click();
  await page.getByRole("button", { name: "＋ イベント終了", exact: true }).click();
  await page.locator('#actionForm button[type="submit"]').click();
  await expect.poll(async () => (await saved(page)).maps[0].tracks[3].actions.length).toBe(2);
  const plan = (await saved(page)).maps[0].tracks[3].actions;
  expect(plan[0].hatchStyle).toBe("cross"); expect(plan[0].hatchColor).toBe("#ff3300");
  await page.locator("#next").click();
  await expect(page.locator("#previewTime")).toHaveText("00:03.00");
  await expect(page.locator("#effectLayer .display-graphic")).toHaveCount(0);
  await expect(page.locator("#roomLayer [data-stage-action] .room-hatching")).toHaveCount(0);
  await expect(page.locator("#roomLayer")).not.toContainText("避難誘導");
  await expect(page.locator("#roomLayer [data-room-activity]")).toHaveCount(0);
  await expect(page.locator("#robotLayer [data-actor]")).toHaveCount(2);
});

test("malformed autosave remains recoverable and is not overwritten by an edited fallback project", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("robot-scene-studio.v4", "{broken save"));
  await page.goto("/");
  await expect(page.locator("#notice")).toContainText("復元できません");
  await page.locator("#projectName").fill("fallback edit"); await page.locator("#projectName").press("Tab");
  await expect(page.locator("#storageStatus")).toContainText("FAILED");
  expect(await page.evaluate(() => localStorage.getItem("robot-scene-studio.v4"))).toBe("{broken save");
  await expect(page.locator("#projectName")).toHaveValue("fallback edit");
});

test("legacy ordered projects migrate automatically and preserve original storage and backup", async ({ page }) => {
  const p = fixture(); p.schema = "robot-scene/v3"; p.maps[0].executionMode = "ordered";
  delete p.maps[0].timelineOnly;
  delete p.maps[0].doorMode;
  for (const t of p.maps[0].tracks) for (const a of t.actions) delete a.runSeconds;
  await page.addInitScript(p => localStorage.setItem("robot-scene-studio.v3", JSON.stringify(p)), p);
  await page.goto("/");
  await expect(page.locator("#executionMode")).not.toBeVisible();
  await expect.poll(async () => (await saved(page))?.schema).toBe("robot-scene/v5");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("robot-scene-studio.v3")).schema))
    .toBe("robot-scene/v3");
  expect((await saved(page)).maps[0].timelineOnly).toBe(true);
  expect((await saved(page)).maps[0].doorMode).toBe("story");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("robot-scene-studio.backup.before-timeline-only"))))
    .toEqual(p);
});

test("all action editors fit the desktop viewport and cancelling never commits drafts", async ({ page }) => {
  const p = fixture(), m = p.maps[0];
  const display = newTrack(m, "display"), room = newTrack(m, "room");
  m.tracks.push(display, room); room.roomId = "room";
  await seed(page, p);
  for (const [lane, names] of [[0, ["移動", "表示", "表示を消去", "待機"]],
    [3, ["イベント発生", "イベント終了"]]]) {
    await page.locator("#trackLabels .track-label").nth(lane).click();
    for (const name of names) {
      await page.getByRole("button", { name: `＋ ${name}`, exact: true }).click();
      await expect(page.locator(".action-spatial-map")).toBeVisible();
      const bounds = await activeEditor(page).evaluate(d => ({
        client: d.clientHeight, scroll: d.scrollHeight,
        top: d.getBoundingClientRect().top, bottom: d.getBoundingClientRect().bottom,
      }));
      expect(bounds.top, name).toBeGreaterThanOrEqual(0);
      expect(bounds.bottom, name).toBeLessThanOrEqual(720);
      expect(bounds.scroll, name).toBeLessThanOrEqual(bounds.client + 1);
      await page.keyboard.press("Escape");
      await expect(page.locator("#actionDialog")).not.toBeVisible();
    }
  }
  expect((await saved(page))).toEqual(p);
});

test("muting a row does not block a different row that previously depended on it", async ({ page }) => {
  const p = fixture(), m = p.maps[0];
  delete m.timelineOnly;
  m.tracks[1].actions[0].trigger = { mode: "all",
    sources: [{ actionId: m.tracks[0].actions[0].id, event: "complete", delay: 0 }] };
  await seed(page, p);
  await page.getByRole("button", { name: "ロボット 1 プレビュー除外", exact: true }).click();
  await expect(page.locator(".lane").nth(1).locator(".action-node")).toHaveClass(/running/);
  await expect(page.locator("#safetyWarnings")).not.toContainText("ロボット 2");
});

test("map creation cancellation and tab rename/delete/undo preserve other sequences", async ({ page }) => {
  await seed(page);
  await page.locator("#addMap").click();
  await page.getByRole("radio", { name: "新しくマップを描く", exact: true }).check();
  await page.getByRole("button", { name: "このマップで作成", exact: true }).click();
  await page.locator("#mapEditorDialog").getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(page.locator("#mapTabs button")).toHaveCount(1);
  await page.locator("#addMap").click();
  await page.getByRole("radio", { name: "新しくマップを描く", exact: true }).check();
  await page.getByRole("button", { name: "このマップで作成", exact: true }).click();
  const editor = page.locator("#mapEditorDialog");
  await editor.getByRole("button", { name: "＋ 新しい領域", exact: true }).click();
  await draw(page, editor.locator(".me-canvas"), 125, 125);
  await editor.getByRole("button", { name: "マップに適用", exact: true }).click();
  await expect(page.locator("#mapTabs button")).toHaveCount(2);
  await page.locator("#renameMap").click();
  await page.getByLabel("タブ名", { exact: true }).fill("別シーン");
  await page.getByLabel("タブ名", { exact: true }).press("Tab");
  await expect(page.locator("#mapTabs button").last()).toHaveText("別シーン");
  await page.locator("#deleteMap").click();
  await page.locator('#confirmDialog button[value="ok"]').click();
  await expect(page.locator("#mapTabs button")).toHaveCount(1);
  await expect(page.locator(".action-node")).toHaveCount(3);
  await page.locator("#undo").click();
  await expect(page.locator("#mapTabs button")).toHaveCount(2);
  await expect(page.locator("#mapTabs button").last()).toHaveText("別シーン");
});

test("robot/human collision warnings reach the editor and clear after a safe adjustment", async ({ page }) => {
  const p = fixture(), m = p.maps[0];
  const human = newTrack(m, "human");
  human.initial = { x: 225, y: 125, yaw: 0, roomId: "room" }; m.tracks.push(human);
  await seed(page, p);
  await expect(page.locator("#safetyWarnings")).toContainText(/ロボット 1 と 人 1.*接触/);
  await page.locator("#trackLabels .track-label").last().click();
  await expect(page.getByLabel("Y", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "初期位置を設定", exact: true }).click();
  const initial = page.getByRole("dialog", { name: "初期位置を設定", exact: true });
  await initial.getByRole("button", { name: "MAPで初期位置を指定", exact: true }).click();
  await draw(page, page.locator(".action-map-picker"), 225, 175);
  await page.locator(".coordinate-dialog").getByRole("button", { name: "適用", exact: true }).click();
  await initial.getByRole("button", { name: "適用", exact: true }).click();
  await expect(page.locator("#safetyWarnings")).not.toBeVisible();
  await page.locator("#undo").click();
  await expect(page.locator("#safetyWarnings")).toContainText("接触");
  await page.locator("#redo").click();
  await expect(page.locator("#safetyWarnings")).not.toBeVisible();
});

test("legacy connections and joins migrate once, survive history and reload, and never prevent deletion", async ({ page }) => {
  const p = fixture(), m = p.maps[0];
  delete m.timelineOnly;
  for (const t of m.tracks) for (const a of t.actions) a.trigger = { mode: "all", sources: [] };
  const first = m.tracks[0].actions[0], other = m.tracks[1].actions[0];
  first.trigger.sources = [{ actionId: other.id, event: "complete", delay: 100 }];
  other.trigger.sources = [{ actionId: first.id, event: "complete", delay: 0 }];
  const join = newAction(m, m.tracks[1], "join");
  m.tracks[1].actions.push(join);
  await seed(page, p);
  const clean = async () => {
    const data = (await saved(page)).maps[0];
    expect(data.timelineOnly).toBe(true);
    expect(data.tracks.flatMap(t => t.actions).every(a => a.type !== "join" && !("trigger" in a))).toBe(true);
    await expect(page.locator("[data-input], [data-output], #connectionLayer")).toHaveCount(0);
  };
  await expect.poll(async () => (await saved(page)).maps[0].timelineOnly).toBe(true);
  const backup = await page.evaluate(() => localStorage.getItem("robot-scene-studio.backup.before-timeline-only"));
  expect(JSON.parse(backup)).toEqual(p);
  await clean();
  await expect(page.locator("#safetyWarnings")).not.toBeVisible();
  await page.locator(`.action-node[data-action="${first.id}"]`).click();
  await page.getByRole("button", { name: "削除", exact: true }).click();
  await page.locator('#confirmDialog button[value="ok"]').click();
  await expect(page.locator(".action-node")).toHaveCount(2);
  await page.locator("#undo").click();
  await expect(page.locator(".action-node")).toHaveCount(3);
  await expect.poll(async () => (await saved(page)).maps[0].tracks[0].actions.length).toBe(2);
  await clean();
  await page.locator("#redo").click();
  await expect.poll(async () => (await saved(page)).maps[0].tracks[0].actions.length).toBe(1);
  await page.locator("#saveProject").click();
  await page.reload();
  await expect(page.locator(".action-node")).toHaveCount(2);
  await clean();
  expect(await page.evaluate(() => localStorage.getItem("robot-scene-studio.backup.before-timeline-only"))).toBe(backup);
  await page.locator("#saveProject").click();
  await page.locator("#projectFile").setInputFiles({ name: "legacy.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(p)) });
  await expect(page.locator(".action-node")).toHaveCount(3);
  await expect.poll(async () => (await saved(page)).maps[0].tracks[0].actions.length).toBe(2);
  await clean();
});

test("free move follows cursor, Shift locks both axes, clicks freeze and target clicks resume", async ({ page }) => {
  await seed(page);
  await page.locator(".action-node").first().dblclick();
  await page.getByLabel("座標指定モード").selectOption("free");
  const svg = page.locator(".action-spatial-map");
  const move = async (x, y) => {
    const p = await svgPoint(svg, x, 900 - y);
    await page.mouse.move(p.x, p.y);
  };
  const position = () => svg.locator("[data-coordinate-target]").getAttribute("transform");
  await move(412, 192);
  await expect(svg).toHaveAttribute("data-following", "true");
  await expect.poll(position).toMatch(/translate\(41[12]/);
  const unconstrained = await position();
  await page.keyboard.down("Shift");
  await expect.poll(position).toMatch(/ 775\)/);
  await page.keyboard.up("Shift");
  await expect.poll(position).toBe(unconstrained);
  await page.keyboard.down("Shift"); await move(462, 202);
  await expect.poll(position).toMatch(/ 775\)/);
  await move(152, 462);
  await expect.poll(position).toMatch(/translate\(125 /);
  await page.keyboard.up("Shift");
  await move(412, 192);
  const first = await svgPoint(svg, 412, 708); await page.mouse.click(first.x, first.y);
  await expect(svg).toHaveAttribute("data-following", "false");
  const fixed = await position();
  await move(612, 392); expect(await position()).toBe(fixed);
  await svg.locator("[data-coordinate-target]").click();
  await expect(svg).toHaveAttribute("data-following", "true");
  await move(512, 242);
  const end = await svgPoint(svg, 512, 658), expected = await clickedWorld(svg, end);
  await page.mouse.click(end.x, end.y);
  await editorApply(page).click();
  await expect.poll(async () => (await saved(page)).maps[0].tracks[0].actions[0].coordinateMode).toBe("free");
  const a = (await saved(page)).maps[0].tracks[0].actions[0];
  expect(a.x).toBeCloseTo(expected.x, 5); expect(a.y).toBeCloseTo(expected.y, 5);
  await page.locator("#undo").click();
  await expect.poll(async () => (await saved(page)).maps[0].tracks[0].actions[0].x).toBe(325);
  await page.locator("#redo").click();
  await expect.poll(async () => (await saved(page)).maps[0].tracks[0].actions[0].coordinateMode).toBe("free");
  await page.locator(".action-node").first().dblclick();
  await page.getByLabel("座標指定モード").selectOption("grid");
  await editorApply(page).click();
  await expect.poll(async () => (await saved(page)).maps[0].tracks[0].actions[0].x).toBe(525);
  expect((await saved(page)).maps[0].tracks[0].actions[0].y).toBe(225);
  await page.locator(".action-node").first().dblclick();
  await page.getByLabel("座標指定モード").selectOption("free");
  const invalid = await svgPoint(svg, 10, 775); await page.mouse.click(invalid.x, invalid.y);
  await expect(editorApply(page)).toBeDisabled();
  await activeEditor(page).locator("form").dispatchEvent("submit");
  await expect(editorError(page)).toContainText("MAP外");
  expect((await saved(page)).maps[0].tracks[0].actions[0].x).toBe(525);
  await editorCancel(page).click();
});

test("free initial and display coordinates persist while cancelling a picker preserves its source", async ({ page }) => {
  await seed(page);
  await page.locator("#trackLabels .track-label").first().click();
  await page.getByRole("button", { name: "初期位置を設定", exact: true }).click();
  const initial = page.getByRole("dialog", { name: "初期位置を設定", exact: true });
  await initial.getByRole("button", { name: "MAPで初期位置を指定", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "MAPで位置を指定", exact: true });
  await picker.getByLabel("座標指定モード").selectOption("free");
  await draw(page, picker.locator("svg"), 182, 718);
  await picker.getByRole("button", { name: "閉じる", exact: true }).click();
  await expect(initial).toContainText("X 125 / Y 125");
  await initial.getByRole("button", { name: "MAPで初期位置を指定", exact: true }).click();
  await picker.getByLabel("座標指定モード").selectOption("free");
  await draw(page, picker.locator("svg"), 182, 718);
  await picker.getByLabel("初期の向き（°）", { exact: true }).fill("-45");
  await picker.getByRole("button", { name: "適用", exact: true }).click();
  await expect(initial.getByLabel("初期の向き yaw", { exact: true })).toHaveValue("-45");
  await initial.getByRole("button", { name: "適用", exact: true }).click();
  await expect.poll(async () => (await saved(page)).maps[0].tracks[0].initial.coordinateMode).toBe("free");
  expect((await saved(page)).maps[0].tracks[0].initial.x).toBeCloseTo(182, 0);
  expect((await saved(page)).maps[0].tracks[0].initial.yaw).toBe(-45);
  await page.locator('[data-add="display"]').click();
  await page.getByRole("button", { name: "＋ 表示", exact: true }).click();
  await page.getByLabel("表示する言葉", { exact: true }).fill("free label");
  await page.getByLabel("座標指定モード").selectOption("free");
  const svg = page.locator(".action-spatial-map");
  const expected = await clickedWorld(svg, await svgPoint(svg, 822, 322));
  await draw(page, svg, 822, 322);
  await page.locator('#actionForm button[type="submit"]').click();
  await expect.poll(async () => (await saved(page)).maps[0].tracks.at(-1).actions[0]?.coordinateMode).toBe("free");
  const a = (await saved(page)).maps[0].tracks.at(-1).actions[0];
  expect(a.x).toBeCloseTo(expected.x, 5); expect(a.y).toBeCloseTo(expected.y, 5);
});

test("Apply cannot bypass invalid targets on muted rows or after failures and keeps the editor open", async ({ page }) => {
  for (const mode of ["muted", "failed"]) {
    const p = fixture(), m = p.maps[0];
    if (mode === "muted") m.tracks[0].muted = true;
    else m.tracks[0].actions[0].simulationOutcome = "failed";
    await page.goto("/");
    await page.evaluate(p => localStorage.setItem("robot-scene-studio.v4", JSON.stringify(p)), p);
    page.once("dialog", d => d.accept()); await page.reload();
    const index = mode === "muted" ? 0 : 1;
    await page.locator(".lane").first().locator(".action-node").nth(index).dblclick();
    await draw(page, page.locator(".action-spatial-map"), 25, 775);
    await expect(editorError(page)).toContainText("MAP外");
    await expect(editorApply(page)).toBeDisabled();
    await activeEditor(page).locator("form").dispatchEvent("submit");
    await expect(activeEditor(page)).toBeVisible();
    expect((await saved(page)).maps[0].tracks[0].actions[index].x).toBe(index ? 525 : 325);
    await draw(page, page.locator(".action-spatial-map"), 425, 775);
    await expect(editorApply(page)).toBeEnabled();
    await editorApply(page).click();
    await expect(activeEditor(page)).toHaveCount(0);
    await expect.poll(async () => (await saved(page)).maps[0].tracks[0].actions[index].x).toBe(425);
  }
});

test("invalid imported initial poses disable Apply and can only be repaired using the MAP", async ({ page }) => {
  const p = fixture(); p.maps[0].tracks[0].initial.x = 25;
  await seed(page, p);
  await page.locator("#trackLabels .track-label").first().click();
  await expect(page.getByLabel("X", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Y", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "初期位置を設定", exact: true }).click();
  const initial = page.getByRole("dialog", { name: "初期位置を設定", exact: true });
  await expect(initial.getByRole("alert")).toContainText("MAP外");
  await expect(initial.getByRole("button", { name: "適用", exact: true })).toBeDisabled();
  await initial.locator("form").dispatchEvent("submit");
  await expect(initial).toBeVisible();
  expect((await saved(page)).maps[0].tracks[0].initial.x).toBe(25);
  await initial.getByRole("button", { name: "MAPで初期位置を指定", exact: true }).click();
  await draw(page, page.locator(".action-map-picker"), 175, 725);
  await page.locator(".coordinate-dialog").getByRole("button", { name: "適用", exact: true }).click();
  await expect(initial.getByRole("button", { name: "適用", exact: true })).toBeEnabled();
  await initial.getByRole("button", { name: "適用", exact: true }).click();
  await expect.poll(async () => (await saved(page)).maps[0].tracks[0].initial.x).toBe(175);
});

test("track palettes support insert previews and dropping new rows without mutating existing rows", async ({ page }) => {
  await seed(page);
  for (const kind of ["robot", "human", "display", "room"]) {
    const source = page.locator(`[data-add="${kind}"]`), transfer = await page.evaluateHandle(() => new DataTransfer());
    await source.dispatchEvent("dragstart", { dataTransfer: transfer });
    const lane = page.locator(".lane").first(), bounds = await lane.boundingBox();
    const event = { clientX: bounds.x + 120, clientY: bounds.y + 10, dataTransfer: transfer };
    await lane.dispatchEvent("dragover", event);
    await expect(page.locator(".track-drop-preview")).toContainText("ここに追加");
    await expect(page.locator(".track-drop-preview")).not.toHaveClass(/invalid/);
    await lane.dispatchEvent("drop", event);
    await source.dispatchEvent("dragend", { dataTransfer: transfer });
    if (kind === "robot") await page.getByRole("dialog", { name: "シーケンスを一括設定", exact: true })
      .getByRole("button", { name: "キャンセル", exact: true }).click();
    await expect(page.locator(".drop-preview")).toHaveCount(0);
    await expect.poll(async () => (await saved(page)).maps[0].tracks.length).toBe(3 + ["robot", "human", "display", "room"].indexOf(kind));
    await expect.poll(async () => (await saved(page)).maps[0].tracks[0].kind).toBe(kind);
    expect((await saved(page)).maps[0].tracks[0].actions).toHaveLength(0);
  }
  expect((await saved(page)).maps[0].tracks.at(-2).actions).toHaveLength(2);
  expect((await saved(page)).maps[0].tracks.at(-1).actions).toHaveLength(1);
  await page.locator("#undo").click();
  await expect.poll(async () => (await saved(page)).maps[0].tracks.length).toBe(5);
  await page.locator("#redo").click();
  await expect.poll(async () => (await saved(page)).maps[0].tracks.length).toBe(6);
});

test("native track dragging and full-room event highlighting show their placement before drop", async ({ page }) => {
  await seed(page);
  await page.locator('[data-add="room"]').dragTo(page.locator(".lane").first(),
    { targetPosition: { x: 120, y: 10 } });
  await expect(page.locator(".lane")).toHaveCount(3);
  await expect.poll(async () => (await saved(page)).maps[0].tracks[0].kind).toBe("room");
  const source = page.locator('#actionPalette [data-type="event-start"]');
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await source.dispatchEvent("dragstart", { dataTransfer: transfer });
  const stage = page.locator("#stage"), at = await svgPoint(stage, 825, 375);
  await stage.dispatchEvent("dragover", { clientX: at.x, clientY: at.y, dataTransfer: transfer });
  await expect(stage.locator(".drop-preview [data-room]")).not.toHaveCount(0);
  await stage.dispatchEvent("drop", { clientX: at.x, clientY: at.y, dataTransfer: transfer });
  await source.dispatchEvent("dragend", { dataTransfer: transfer });
  await expect(page.locator("#actionDialog")).toBeVisible();
  await expect(page.locator("#actionTitle")).toContainText("イベント発生");
  await page.locator("#cancelAction").click();
});

test("track drops work on an empty sequence and drag cancellation never creates a row", async ({ page }) => {
  const p = fixture(); p.maps[0].tracks = [];
  await page.addInitScript(p => localStorage.setItem("robot-scene-studio.v4", JSON.stringify(p)), p);
  await page.goto("/");
  const source = page.locator('[data-add="human"]');
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  const surface = page.locator("#timelineScroll"), bounds = await surface.boundingBox();
  const event = { clientX: bounds.x + 120, clientY: bounds.y + 80, dataTransfer: transfer };
  await source.dispatchEvent("dragstart", { dataTransfer: transfer });
  await surface.dispatchEvent("dragover", event);
  await expect(page.locator(".track-drop-preview")).toContainText("人の行をここに追加");
  await source.dispatchEvent("dragend", { dataTransfer: transfer });
  await expect(page.locator(".drop-preview")).toHaveCount(0);
  expect((await saved(page)).maps[0].tracks).toHaveLength(0);
  await source.dispatchEvent("dragstart", { dataTransfer: transfer });
  await surface.dispatchEvent("drop", event);
  await source.dispatchEvent("dragend", { dataTransfer: transfer });
  await expect(page.locator(".lane")).toHaveCount(1);
  await expect.poll(async () => (await saved(page)).maps[0].tracks.length).toBe(1);
  expect((await saved(page)).maps[0].tracks[0].kind).toBe("human");
});
