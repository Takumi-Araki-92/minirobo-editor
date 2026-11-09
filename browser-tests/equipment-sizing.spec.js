import { test, expect } from "@playwright/test";
import { regionBounds } from "../public/floor-plan.js";

const cells = (x, y, width, height) => Array.from({ length: height }, (_, row) =>
  Array.from({ length: width }, (_, column) => (y + row) * 32 + x + column)).flat();
const fixture = (occupied = cells(0, 0, 32, 18)) => ({
  id: "equipment-map", name: "Equipment", tracks: [], background: null,
  rooms: [{ id: "floor", name: "Hall", color: "#739a81", kind: "corridor",
    material: "concrete", cells: occupied, ...regionBounds(occupied) }],
  floorPlan: { walls: [], doors: [], furniture: [] },
});
async function open(page, map = fixture()) {
  await page.goto("/");
  await page.evaluate(async map => {
    const { editMap } = await import("/map-editor.js");
    window.equipmentResult = undefined;
    editMap(map).then(result => { window.equipmentResult = result; });
  }, map);
  await expect(page.locator("#mapEditorDialog")).toBeVisible();
}
async function position(page, column, row) {
  return page.locator(".me-canvas").evaluate((svg, { column, row }) => {
    const point = new DOMPoint(column * 50, row * 50).matrixTransform(svg.getScreenCTM());
    return { x: point.x, y: point.y };
  }, { column, row });
}
async function drag(page, from, to) {
  const start = await position(page, ...from), end = await position(page, ...to);
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 6 }); await page.mouse.up();
}
async function apply(page) {
  await page.getByRole("button", { name: "マップに適用", exact: true }).click();
  await expect(page.locator("#mapEditorDialog")).toHaveCount(0);
  return page.evaluate(() => window.equipmentResult);
}

test("rectangular gates preserve hall cells and undo, redo, rename and group deletion", async ({ page }) => {
  const map = fixture();
  await open(page, map);
  await page.getByRole("button", { name: "部屋編集モード", exact: true }).click();
  await page.getByLabel("新規設備の入口方向", { exact: true }).selectOption("left");
  await page.getByRole("button", { name: /フラッパーゲート/, exact: false }).click();
  await drag(page, [3.5, 3.5], [9.5, 7.5]);
  await expect(page.locator(".me-canvas [data-door-kind=flapper]")).toHaveCount(1);
  await expect(page.locator(".me-canvas g[data-partition-wall]")).toHaveCount(3);
  await expect(page.locator(".me-canvas line[data-partition-wall]")).toHaveCount(4);
  await page.getByLabel("設備名", { exact: true }).fill("Area gate");
  await page.getByLabel("設備名", { exact: true }).press("Tab");
  await page.getByRole("button", { name: "選択物を削除", exact: true }).click();
  await expect(page.locator(".me-canvas [data-door]")).toHaveCount(0);
  await expect(page.locator(".me-canvas [data-partition-wall]")).toHaveCount(0);
  await page.getByRole("button", { name: "↶ 戻す", exact: true }).click();
  await expect(page.locator(".me-canvas [data-door-kind=flapper]")).toHaveCount(1);
  await page.getByRole("button", { name: "↷ やり直す", exact: true }).click();
  await expect(page.locator(".me-canvas [data-door]")).toHaveCount(0);
  await page.getByRole("button", { name: "↶ 戻す", exact: true }).click();
  const result = await apply(page);
  expect(result.rooms).toEqual(map.rooms);
  expect(result.floorPlan.doors[0].name).toBe("Area gate");
  expect(result.floorPlan.doors[0].x1).toBe(result.floorPlan.doors[0].x2);
  expect(result.floorPlan.walls).toHaveLength(3);
});

for (const orientation of ["bottom", "left"]) {
  test(`new EV ${orientation} entrance is six cells while depth follows drag`, async ({ page }) => {
    await open(page);
    await page.getByLabel("新規設備の入口方向", { exact: true }).selectOption(orientation);
    await page.getByRole("button", { name: /エレベーターを追加/ }).click();
    await drag(page, [5.5, 3.5], [15.5, 6.5]);
    await expect(page.locator(".me-error")).toBeHidden();
    const result = await apply(page), elevator = result.rooms.find(room => room.appearance === "elevator");
    expect(elevator.entranceEdge).toBe(orientation);
    expect(orientation === "bottom" ? elevator.width : elevator.height).toBe(300);
    expect(orientation === "bottom" ? elevator.height : elevator.width).toBe(orientation === "bottom" ? 200 : 550);
    expect(result.floorPlan.doors).toHaveLength(6);
    expect(result.floorPlan.doors.every(door => door.edge === orientation)).toBe(true);
    expect(result.rooms.reduce((sum, room) => sum + room.cells.length, 0)).toBe(576);
  });
}

test("automatic doors place one six-cell opening and do not resize a legacy door", async ({ page }) => {
  const map = fixture();
  map.floorPlan.doors.push({ id: "legacy", roomId: "floor", cell: 17 * 32, edge: "bottom" });
  await open(page, map);
  await page.getByRole("button", { name: "部屋編集モード", exact: true }).click();
  await page.getByRole("button", { name: /自動ドア/ }).click();
  const target = await position(page, 3.5, .02);
  await page.mouse.click(target.x, target.y);
  await expect(page.locator(".me-canvas [data-door]")).toHaveCount(2);
  const result = await apply(page);
  expect(result.floorPlan.doors).toHaveLength(7);
  expect(result.floorPlan.doors[0]).toEqual(map.floorPlan.doors[0]);
  expect(new Set(result.floorPlan.doors.slice(1).map(door => door.openingId)).size).toBe(1);
});

test("short boundaries and out-of-map EV width show explicit errors without partial placement", async ({ page }) => {
  await open(page, fixture(cells(0, 0, 4, 4)));
  await page.getByRole("button", { name: "部屋編集モード", exact: true }).click();
  await page.getByRole("button", { name: /自動ドア/ }).click();
  const target = await position(page, .5, .02);
  await page.mouse.click(target.x, target.y);
  await expect(page.locator(".me-error")).toContainText("6セル");
  await expect(page.locator(".me-canvas [data-door]")).toHaveCount(0);
  await page.getByRole("button", { name: "ゾーニングモード", exact: true }).click();
  await page.getByRole("button", { name: /エレベーターを追加/ }).click();
  await drag(page, [30.5, 4.5], [31.5, 7.5]);
  await expect(page.locator(".me-error")).toContainText("6セル");
  await expect(page.locator(".me-canvas [data-elevator]")).toHaveCount(0);
  await page.getByRole("button", { name: "キャンセル", exact: true }).click();
  expect(await page.evaluate(() => window.equipmentResult)).toBeNull();
});
