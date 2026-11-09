import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHistoryStore } from "../history-store.js";
import { createProject, useTimelineOnly, projectForSave } from "../public/model.js";

let store, directory, offline;
test.beforeEach(async ({ page }) => {
  directory = await mkdtemp(join(tmpdir(), "studio-browser-history-"));
  store = await openHistoryStore(directory); offline = false;
  const project = useTimelineOnly(createProject({ ordered: true }));
  project.name = "Initial";
  await store.append({ expectedRevision: 0, id: "initial", label: "Initial", project: projectForSave(project) });
  page.on("pageerror", error => { throw error; });
  await page.route("**/api/history**", async route => {
    if (offline) { await route.abort("connectionfailed"); return; }
    try {
      const request = route.request(), path = new URL(request.url()).pathname;
      const value = request.method() === "POST" ? await store.append(request.postDataJSON()) :
        path === "/api/history" ? { enabled: true, records: store.list() } :
          store.get(Number(path.split("/").at(-1)));
      await route.fulfill({ json: value });
    } catch (error) {
      await route.fulfill({ status: error.status ?? 500, json: { error: error.message } });
    }
  });
  await page.goto("/");
  await expect(page.locator("#projectName")).toHaveValue("Initial");
});
test.afterEach(async () => { await store.close(); await rm(directory, { recursive: true }); });

async function rename(page, name) {
  await page.locator("#projectName").fill(name);
  await page.locator("#projectName").press("Tab");
}

test("all confirmed edits persist across reload, browser clearing and roll-forward", async ({ page }) => {
  await rename(page, "A"); await rename(page, "B"); await rename(page, "C");
  await expect.poll(() => store.list().length).toBe(4);
  expect(store.list().map(record => store.get(record.revision).project.name)).toEqual(["Initial", "A", "B", "C"]);
  await page.locator("#undo").click();
  await expect.poll(() => store.list().length).toBe(5);
  expect(store.get().project.name).toBe("B");
  await page.locator("#redo").click();
  await expect.poll(() => store.list().length).toBe(6);
  expect(store.get().project.name).toBe("C");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.locator("#projectName")).toHaveValue("C");
  await page.locator("#openHistory").click();
  const a = page.locator(".history-record").filter({ hasText: "#2 ·" });
  await a.getByRole("button", { name: "この状態を適用" }).click();
  await page.locator('#confirmDialog button[value="ok"]').click();
  await expect(page.locator("#projectName")).toHaveValue("A");
  await expect.poll(() => store.list().length).toBe(7);
  expect(store.get().restoredFrom).toBe(2);
  await page.locator("#openHistory").click();
  const c = page.locator(".history-record").filter({ hasText: "#4 ·" });
  await c.getByRole("button", { name: "この状態を適用" }).click();
  await page.locator('#confirmDialog button[value="ok"]').click();
  await expect(page.locator("#projectName")).toHaveValue("C");
  await expect.poll(() => store.list().length).toBe(8);
  expect(store.get(4).project.name).toBe("C");
  await page.reload();
  await expect(page.locator("#projectName")).toHaveValue("C");
});

test("failed history writes remain queued, block further edits and recover on retry", async ({ page }) => {
  offline = true;
  await rename(page, "Offline");
  await expect(page.locator("#historyStatus")).toContainText("履歴未保存");
  await rename(page, "Not accepted");
  await expect(page.locator("#notice")).toContainText("停止");
  expect(store.list().length).toBe(1);
  offline = false;
  await page.locator("#openHistory").click();
  await page.locator("#retryHistory").click();
  await expect.poll(() => store.list().length).toBe(2);
  expect(store.get().project.name).toBe("Offline");
  await page.locator("#closeHistory").click();
  await page.reload();
  await expect(page.locator("#projectName")).toHaveValue("Offline");
});

test("stale tabs cannot overwrite another editor's durable history", async ({ page }) => {
  const newer = structuredClone(store.get().project); newer.name = "Other editor";
  await store.append({ expectedRevision: 1, id: "external", label: "external", project: newer });
  await rename(page, "Stale edit");
  await expect(page.locator("#historyStatus")).toContainText("別の画面");
  expect(store.get().project.name).toBe("Other editor");
  expect(store.list().length).toBe(2);
});
