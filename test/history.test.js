import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHistoryStore } from "../history-store.js";
import { createHistoryClient } from "../public/history-client.js";
import { createProject } from "../public/model.js";

const project = name => ({ ...createProject({ ordered: true }), name });
const input = (expectedRevision, name, extra = {}) => ({
  expectedRevision, id: `edit-${expectedRevision}-${name}`, label: name, project: project(name), ...extra,
});
const memory = () => {
  const data = new Map();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
};
const transport = store => async (path, options = {}) => {
  try {
    const data = options.method === "POST" ? await store.append(JSON.parse(options.body)) :
      path === "/api/history" ? { enabled: true, records: store.list() } :
        store.get(Number(path.split("/").at(-1)));
    return { ok: true, json: async () => data };
  } catch (error) {
    return { ok: false, json: async () => ({ error: error.message }) };
  }
};

test("disk history survives restart and can roll forward after applying an older snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-history-"));
  let store;
  try {
    store = await openHistoryStore(directory);
    await store.append(input(0, "A"));
    await store.append(input(1, "B"));
    const a = store.get(1).project;
    await store.append(input(2, "restore-A", { project: a, restoredFrom: 1 }));
    await store.close();
    store = await openHistoryStore(directory);
    assert.equal(store.get().project.name, "A");
    const b = store.get(2).project;
    await store.append(input(3, "roll-forward-B", { project: b, restoredFrom: 2 }));
    assert.equal(store.get().project.name, "B");
    assert.equal(store.list().length, 4);
    assert.equal(store.get(3).restoredFrom, 1);
    assert.equal(JSON.parse(await readFile(join(directory, "0000000002.json"), "utf8")).project.name, "B");
  } finally { await store?.close(); await rm(directory, { recursive: true }); }
});

test("disk history rejects competing writers and stale revisions without overwriting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-history-conflict-"));
  const store = await openHistoryStore(directory);
  try {
    await assert.rejects(openHistoryStore(directory), /writer.lock/);
    const first = input(0, "A");
    await store.append(first);
    assert.equal((await store.append(first)).revision, 1);
    await assert.rejects(store.append(input(0, "B")), /別の画面/);
    await assert.rejects(store.append(input(1, "invalid", { project: {} })));
    assert.equal(store.list().length, 1);
  } finally { await store.close(); await rm(directory, { recursive: true }); }
});

test("corrupt committed history is reported instead of silently skipping a revision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-history-corrupt-"));
  try {
    const store = await openHistoryStore(directory);
    await store.append(input(0, "A"));
    await store.close();
    await writeFile(join(directory, "0000000001.json"), "{}");
    await assert.rejects(openHistoryStore(directory), /破損/);
  } finally { await rm(directory, { recursive: true }); }
});

test("client preserves every rapid edit and resumes unsent history after a restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-history-client-"));
  const store = await openHistoryStore(directory), storage = memory(), messages = [];
  let offline = false;
  const request = async (...args) => {
    if (offline) throw new Error("offline");
    return transport(store)(...args);
  };
  try {
    const client = createHistoryClient(storage, (...args) => messages.push(args), request);
    await client.initialize();
    client.record(project("A"), "A");
    client.record(project("B"), "B");
    client.record(project("C"), "C");
    await client.list();
    assert.deepEqual(store.list().map(record => record.label), ["A", "B", "C"]);
    offline = true;
    client.record(project("D"), "D");
    await client.list().catch(error => assert.match(error.message, /offline/));
    assert.equal(client.pending, true);
    assert.ok(messages.some(([message, error]) => error && message.includes("offline")));
    offline = false;
    const reopened = createHistoryClient(storage, () => {}, request);
    assert.equal((await reopened.initialize()).name, "D");
    assert.equal(store.list().length, 4);
    const clearedBrowser = createHistoryClient(memory(), () => {}, request);
    assert.equal((await clearedBrowser.initialize()).name, "D");
  } finally { await store.close(); await rm(directory, { recursive: true }); }
});

test("client rejects edits when local pending backup is full or another editor advances history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-history-quota-"));
  const store = await openHistoryStore(directory), storage = memory();
  try {
    const client = createHistoryClient(storage, () => {}, transport(store));
    await client.initialize();
    storage.setItem = () => { throw new Error("quota"); };
    assert.throws(() => client.record(project("A"), "A"), /quota/);
    assert.equal(client.pending, false);
    assert.equal(store.list().length, 0);
    const other = createHistoryClient(memory(), () => {}, transport(store));
    await other.initialize();
    await store.append(input(0, "external"));
    other.record(project("conflict"), "conflict");
    await other.list();
    assert.equal(other.failed, true);
    assert.equal(other.pending, true);
    assert.throws(() => other.record(project("next"), "next"), /停止/);
    assert.equal(store.get().project.name, "external");
  } finally { await store.close(); await rm(directory, { recursive: true }); }
});
