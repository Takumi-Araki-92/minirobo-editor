import { test, expect } from "@playwright/test";
import { createProject, newTrack, newAction, useTimelineOnly, projectForSave } from "../public/model.js";

function fixture(kind = "robot") {
  const project = createProject({ ordered: true }), map = project.maps[0];
  map.executionMode = "timed";
  map.rooms = [{ id: "hall", name: "Hall", kind: "corridor", material: "tile",
    color: "#739a81", x: 0, y: 0, width: 1600, height: 900,
    cells: Array.from({ length: 576 }, (_, i) => i) }];
  map.floorPlan = { doors: [], furniture: [] };
  map.tracks = [];
  const robot = newTrack(map, kind);
  robot.initial = { x: 225, y: 225, yaw: 0, roomId: "hall" };
  map.tracks.push(robot);
  const move = Object.assign(newAction(map, robot, "move"), {
    name: "First move", position: 0, runSeconds: 3, x: 425, y: 225, roomId: "hall",
  });
  robot.actions.push(move);
  return useTimelineOnly(project);
}
const saved = page => page.evaluate(() => JSON.parse(localStorage.getItem("robot-scene-studio.v4")));
async function seed(page, project) {
  page.on("pageerror", error => { throw error; });
  await page.addInitScript(project => {
    if (!sessionStorage.getItem("sequence-seeded")) {
      localStorage.setItem("robot-scene-studio.v4", JSON.stringify(project));
      sessionStorage.setItem("sequence-seeded", "1");
    }
  }, projectForSave(project));
  await page.goto("/");
  await expect.poll(async () => (await saved(page)).maps[0].navigation?.status).toBe("available");
}
async function mapClick(page, svg, x, y) {
  const point = await svg.evaluate((el, point) => {
    const p = new DOMPoint(point.x, 900 - point.y).matrixTransform(el.getScreenCTM());
    return { x: p.x, y: p.y };
  }, { x, y });
  await page.mouse.click(point.x, point.y);
}
const popup = page => page.getByRole("dialog", { name: "シーケンスを一括設定", exact: true });

test("robot bar and actor edits use one bulk editor with the shared movement map", async ({ page }) => {
  await seed(page, fixture());
  const before = await saved(page);
  await page.locator(".action-node").dblclick();
  await expect(popup(page)).toBeVisible();
  await expect(page.locator("#actionDialog")).toBeHidden();
  await expect(popup(page).locator(".action-spatial-map")).toBeVisible();
  const bounds = await popup(page).locator(".action-spatial-map").boundingBox();
  expect(bounds.width).toBeGreaterThanOrEqual(300);
  expect(bounds.height).toBeGreaterThanOrEqual(160);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(720);
  await expect(popup(page).getByLabel("アクション名", { exact: true })).toHaveValue("First move");
  await popup(page).getByRole("button", { name: "キャンセル", exact: true }).click();
  await page.locator("#robotLayer [data-actor]").dblclick();
  await expect(popup(page)).toBeVisible();
  await popup(page).getByRole("button", { name: "キャンセル", exact: true }).click();
  expect(await saved(page)).toEqual(before);
});

test("bulk metadata errors are explicit and a corrected draft can be applied", async ({ page }) => {
  const project = fixture(), map = project.maps[0];
  const other = newTrack(map, "robot");
  other.initial = { x: 1225, y: 625, yaw: 0, roomId: "hall" };
  map.tracks.push(other);
  await seed(page, project);
  const before = await saved(page);
  await page.locator(".track-label").first().dblclick();
  await popup(page).getByLabel("ロボットID", { exact: true }).fill(String(other.robotId));
  await popup(page).getByRole("button", { name: "適用", exact: true }).click();
  await expect(popup(page).locator(".sequence-error")).not.toBeEmpty();
  expect(await saved(page)).toEqual(before);
  await popup(page).getByLabel("ロボットID", { exact: true }).fill("0");
  await popup(page).getByLabel("名称", { exact: true }).fill("Updated robot");
  await popup(page).getByRole("button", { name: "適用", exact: true }).click();
  await expect(popup(page)).toHaveCount(0);
  await expect.poll(async () => (await saved(page)).maps[0].tracks[0].name).toBe("Updated robot");
});

test("adding and repositioning moves stays a draft until bulk Apply and one undo restores all", async ({ page }) => {
  await seed(page, fixture());
  const before = await saved(page);
  await page.locator(".track-label").dblclick();
  await popup(page).getByRole("button", { name: "＋ 移動", exact: true }).click();
  const map = popup(page).locator(".action-spatial-map");
  await mapClick(page, map, 625, 225);
  await expect(popup(page)).toBeVisible();
  await expect(popup(page).locator("[data-sequence-action]")).toHaveCount(2);
  expect(await saved(page)).toEqual(before);
  await mapClick(page, map, 725, 225);
  await expect(popup(page).locator(".spatial-caption[aria-live]")).toContainText("725.00");
  await popup(page).getByRole("button", { name: "＋ 移動", exact: true }).click();
  const path = popup(page).locator(".action-spatial-map>line");
  await expect(path).toHaveAttribute("x1", "725");
  await mapClick(page, popup(page).locator(".action-spatial-map"), 925, 225);
  await popup(page).getByRole("button", { name: "適用", exact: true }).click();
  await expect(popup(page)).toHaveCount(0);
  await expect.poll(async () => (await saved(page)).maps[0].tracks[0].actions.length).toBe(3);
  const actions = (await saved(page)).maps[0].tracks[0].actions;
  expect(actions.map(a => a.x)).toEqual([425, 725, 925]);
  expect(actions.map(a => a.position)).toEqual([0, 3, 9]);
  await page.locator("#undo").click();
  await expect.poll(() => saved(page)).toEqual(before);
});

test("cancel and Escape discard robot move additions and coordinate changes", async ({ page }) => {
  await seed(page, fixture());
  const before = await saved(page);
  for (const cancel of ["button", "Escape"]) {
    await page.locator(".action-node").dblclick();
    await popup(page).getByRole("button", { name: "＋ 移動", exact: true }).click();
    await mapClick(page, popup(page).locator(".action-spatial-map"), 725, 225);
    if (cancel === "button") await popup(page).getByRole("button", { name: "キャンセル", exact: true }).click();
    else await page.keyboard.press("Escape");
    await expect(popup(page)).toHaveCount(0);
    expect(await saved(page)).toEqual(before);
  }
});

test("initial MAP picker permits repeated choices and applies only to the bulk draft", async ({ page }) => {
  await seed(page, fixture());
  const before = await saved(page);
  await page.locator(".track-label").dblclick();
  await popup(page).getByRole("button", { name: "初期位置をMAPで配置", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "MAPで位置を指定", exact: true });
  await mapClick(page, picker.locator("svg"), 325, 225);
  await expect(picker).toBeVisible();
  await mapClick(page, picker.locator("svg"), 225, 325);
  await expect(picker).toBeVisible();
  expect(await saved(page)).toEqual(before);
  await picker.getByRole("button", { name: "適用", exact: true }).click();
  await expect(picker).toHaveCount(0);
  expect(await saved(page)).toEqual(before);
  await popup(page).getByRole("button", { name: "キャンセル", exact: true }).click();
  expect(await saved(page)).toEqual(before);
});
