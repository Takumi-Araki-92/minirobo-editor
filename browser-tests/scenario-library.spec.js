import { test, expect } from "@playwright/test";
import { SCENARIO_LIBRARY, createLibraryScenario } from "../public/scenario-library.js";
import { projectForSave } from "../public/model.js";

const saved = page => page.evaluate(() => JSON.parse(localStorage.getItem("robot-scene-studio.v4")));
async function seed(page, project = createLibraryScenario("daily-security")) {
  page.on("pageerror", error => { throw error; });
  await page.addInitScript(project => {
    if (!sessionStorage.getItem("scenario-library-seeded")) {
      localStorage.setItem("robot-scene-studio.v4", JSON.stringify(project));
      sessionStorage.setItem("scenario-library-seeded", "1");
    }
  }, projectForSave(project));
  await page.goto("/");
  await expect(page.locator(".track-label").first()).toBeVisible();
}
async function seek(page, time) {
  await page.locator("#previewSeek").evaluate((el, value) => {
    el.value = String(value); el.dispatchEvent(new Event("input", { bubbles: true }));
  }, time);
}
test("the library lists sixteen choices, preserves existing maps and supports undo, redo and reload", async ({ page }) => {
  await seed(page);
  const before = await saved(page);
  await page.locator("#openScenarioLibrary").click();
  const dialog = page.getByRole("dialog", { name: "テストシナリオ集", exact: true });
  await expect(dialog.locator("[data-scenario]")).toHaveCount(16);
  await dialog.getByRole("button", { name: "閉じる", exact: true }).click();
  expect(await saved(page)).toEqual(before);
  await page.locator("#openScenarioLibrary").click();
  await dialog.locator('[data-scenario="garbage"]').getByRole("button", { name: "追加", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("#mapTabs button")).toHaveCount(2);
  await expect.poll(async () => (await saved(page)).maps.length).toBe(2);
  expect((await saved(page)).maps[0]).toEqual(before.maps[0]);
  await expect(page.locator("#scenarioLayer [data-scenario-cue=scan]")).toHaveCount(1);
  await page.locator("#undo").click();
  await expect.poll(() => saved(page)).toEqual(before);
  await page.locator("#redo").click();
  await expect.poll(async () => (await saved(page)).maps[1]?.presentation.scenarioId).toBe("garbage");
  await page.locator("#saveProject").evaluate(el => el.click());
  await page.reload();
  await page.locator("#mapTabs button").last().click();
  await expect(page.locator("#scenarioLayer [data-scenario-cue=scan]")).toHaveCount(1);
});

test("each of sixteen choices loads a playable map with visible and deterministic presentation cues", async ({ page }) => {
  await seed(page);
  for (const spec of SCENARIO_LIBRARY) {
    await page.locator("#openScenarioLibrary").click();
    await page.locator(`[data-scenario="${spec.id}"]`).getByRole("button", { name: "追加", exact: true }).click();
    await expect.poll(async () => (await saved(page)).maps.length).toBe(2);
    const map = (await saved(page)).maps[1];
    expect(map.presentation.scenarioId).toBe(spec.id);
    await expect(page.locator("#safetyWarnings")).toBeHidden();
    await expect(page.locator("#scenarioLayer")).toContainText("SIMULATION ONLY");
    const target = map.presentation.cues.find(c => !["notice", "route"].includes(c.kind)) ?? map.presentation.cues[0];
    const time = target.start + .1;
    await seek(page, time);
    await expect(page.locator(`#scenarioLayer [data-scenario-cue="${target.kind}"]`).first()).toBeVisible();
    const markup = await page.locator("#scenarioLayer").innerHTML();
    await seek(page, 0); await seek(page, time);
    expect(await page.locator("#scenarioLayer").innerHTML()).toBe(markup);
    await page.locator("#undo").click();
    await expect.poll(async () => (await saved(page)).maps.length).toBe(1);
  }
});

test("dirty spots disappear after cleaning, reappear on seek, and are retained in exhibition fullscreen", async ({ page }) => {
  const project = createLibraryScenario("tutorial-dirt");
  await seed(page, project);
  const cues = project.maps[0].presentation.cues.filter(c => c.kind === "dirt");
  const start = Math.max(...cues.map(c => c.start)) + .1;
  await seek(page, start);
  await expect(page.locator("#scenarioLayer [data-scenario-cue=dirt]")).toHaveCount(2);
  await page.locator("#fullscreenPreview").click();
  await expect(page.locator(".preview-expanded #scenarioLayer [data-scenario-cue=dirt]")).toHaveCount(2);
  await page.keyboard.press("Escape");
  await seek(page, Math.max(...cues.map(c => c.end)) + .1);
  await expect(page.locator("#scenarioLayer [data-scenario-cue=dirt]")).toHaveCount(0);
  await seek(page, start);
  await expect(page.locator("#scenarioLayer [data-scenario-cue=dirt]")).toHaveCount(2);
});

test("the eight-tab limit refuses a library addition without changing existing data", async ({ page }) => {
  const project = createLibraryScenario("daily-security");
  for (const spec of SCENARIO_LIBRARY.slice(1, 8)) project.maps.push(createLibraryScenario(spec.id).maps[0]);
  await seed(page, project);
  const before = await saved(page);
  await page.locator("#openScenarioLibrary").click();
  await page.locator('[data-scenario="garbage"]').getByRole("button", { name: "追加", exact: true }).click();
  await expect(page.locator(".scenario-library-dialog [role=alert]")).toContainText("最大8件");
  expect(await saved(page)).toEqual(before);
  await page.keyboard.press("Escape");
  await expect(page.locator(".scenario-library-dialog")).toHaveCount(0);
});
