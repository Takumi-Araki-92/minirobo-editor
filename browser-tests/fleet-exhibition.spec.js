import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createLibraryScenario } from "../public/scenario-library.js";
import { projectForSave } from "../public/model.js";

const saved = page => page.evaluate(() => localStorage.getItem("robot-scene-studio.v4"));
const status = async request => (await request.get("/api/fleet")).json();
async function seed(page, includeInvalid = false) {
  const project = createLibraryScenario("daily-security");
  project.maps.push(createLibraryScenario("tutorial-dirt").maps[0]);
  if (includeInvalid) {
    const invalid = createLibraryScenario("daily-cleaning").maps[0];
    const track = invalid.tracks.find(track => track.kind === "robot" && track.actions.length > 1);
    track.actions[1].position = track.actions[0].position;
    project.maps.push(invalid);
  }
  await page.addInitScript(project => localStorage.setItem("robot-scene-studio.v4",
    JSON.stringify(project)), projectForSave(project));
  await page.goto("/");
  await expect(page.locator(".track-label").first()).toBeVisible();
}
async function command(request, bundle_id, id, type, extra = {}) {
  const response = await request.post("/api/fleet/commands", {
    data: { bundle_id, id, type, ...extra },
  });
  expect(response.status()).toBe(202);
  await expect.poll(async () => (await status(request)).last_command?.id).toBe(id);
  expect((await status(request)).last_command.status).toBe("applied");
}
test.beforeEach(async ({ request }) => {
  await expect.poll(async () => (await status(request)).ready, { timeout: 15000 }).toBe(false);
});
test.afterEach(async ({ page }) => {
  await page.keyboard.press("Escape");
});

test("exhibition waits robot-free, selects by index, starts separately, and leaves original work unchanged", async ({ page, request }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await seed(page, true);
  const before = await saved(page);
  const robotIds = await page.evaluate(() => JSON.parse(localStorage.getItem("robot-scene-studio.v4"))
    .maps[0].tracks.filter(track => track.kind === "robot").map(track => track.id));
  await page.locator("#exhibitionMode").click();
  await expect(page.locator(".fleet-exhibition.preview-expanded")).toBeVisible();
  await expect.poll(async () => (await status(request)).mode).toBe("waiting");
  await expect(page.locator("#play")).toBeDisabled();
  for (const id of robotIds) await expect(page.locator(`[data-actor="${id}"]`)).toHaveCount(0);
  const active = await status(request);
  expect(active.scenarios[2].executable).toBe(false);
  const refused = await request.post("/api/fleet/commands", {
    data: { bundle_id: active.bundle_id, id: "invalid-index", type: "select", index: 3 },
  });
  expect(refused.status()).toBe(422);
  const item = await (await request.get("/api/fleet/scenarios/2")).json();
  expect(item.robots.length).toBeGreaterThan(0);
  expect(item.robots[0].initial).toHaveProperty("yaw");
  await command(request, active.bundle_id, "select-two", "select", { index: 2 });
  await expect(page.locator("#fleetStatus")).toContainText("index 2");
  await expect(page.locator("#robotLayer [data-actor]")).not.toHaveCount(0);
  const allRobotIds = item.map.tracks.filter(track => track.kind === "robot").map(track => track.id);
  for (const id of allRobotIds) await expect(page.locator(`[data-actor="${id}"]`)).toHaveCount(0);
  expect((await status(request)).time_s).toBe(0);
  await page.keyboard.press("Space");
  expect((await status(request)).time_s).toBe(0);
  await command(request, active.bundle_id, "start-two", "start");
  await expect.poll(async () => (await status(request)).time_s).toBeGreaterThan(1);
  await command(request, active.bundle_id, "pause-two", "pause");
  expect((await status(request)).mode).toBe("paused");
  await command(request, active.bundle_id, "reset-two", "reset");
  expect((await status(request)).time_s).toBe(0);
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await status(request)).ready).toBe(false);
  await expect(page.locator(".fleet-exhibition")).toHaveCount(0);
  await expect(page.locator("#exhibitionMode")).toBeEnabled();
  await expect(page.locator("#play")).toBeEnabled();
  expect(await saved(page)).toBe(before);
  expect(errors).toEqual([]);
});

test("fleet export downloads full indexed map/robot sets without editing or suppressing normal fullscreen robots", async ({ page }) => {
  await seed(page);
  const before = await saved(page);
  await page.locator(".timeline-settings summary").click();
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#exportFleetBundle").click();
  const download = await downloadPromise;
  const bundle = JSON.parse(await readFile(await download.path(), "utf8"));
  expect(bundle.schema).toBe("scene-fleet-bundle/v1");
  expect(bundle.scenarios.map(item => item.index)).toEqual([1, 2]);
  expect(bundle.scenarios[1].map.presentation).toBeTruthy();
  expect(bundle.scenarios[0].robots[0].sequence.length).toBeGreaterThan(0);
  expect(await saved(page)).toBe(before);
  await page.locator("#fullscreenPreview").click();
  await expect(page.locator("#robotLayer [data-actor]").first()).toBeVisible();
  await expect(page.locator(".fleet-exhibition")).toHaveCount(0);
});

test("exhibition preserves dirt and doors and stops playback explicitly on communication failure", async ({ page, request }) => {
  await seed(page);
  await page.locator("#exhibitionMode").click();
  await expect.poll(async () => (await status(request)).ready).toBe(true);
  const active = await status(request);
  await command(request, active.bundle_id, "dirt-select", "select", { index: 2 });
  const item = await (await request.get("/api/fleet/scenarios/2")).json();
  const dirtyAt = Math.max(...item.map.presentation.cues.filter(cue => cue.kind === "dirt")
    .map(cue => cue.start)) + .1;
  await command(request, active.bundle_id, "dirt-start", "start");
  await expect.poll(async () => (await status(request)).time_s,
    { timeout: 30000 }).toBeGreaterThan(dirtyAt);
  await expect(page.locator("#scenarioLayer [data-scenario-cue=dirt]")).toHaveCount(2);
  await expect(page.locator("#doorLayer [data-auto-door]").first()).toBeVisible();
  await page.route("**/api/fleet/heartbeat", route => route.abort());
  await expect(page.locator("#fullscreenStatus")).toContainText("展示連携が停止");
  const time = await page.locator("#previewSeek").inputValue();
  await page.waitForTimeout(500);
  expect(await page.locator("#previewSeek").inputValue()).toBe(time);
});
