import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProject } from "../public/model.js";

test("history HTTP API persists snapshots and rejects cross-origin writes and invalid payloads", async () => {
  const socket = createServer();
  socket.listen(0, "127.0.0.1"); await once(socket, "listening");
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const directory = await mkdtemp(join(tmpdir(), "studio-http-history-"));
  const process = spawn(globalThis.process.execPath, ["server.js"], {
    cwd: new URL("..", import.meta.url), env: { ...globalThis.process.env,
      PORT: String(port), HISTORY_DIR: directory, HISTORY_MODE: "on" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  process.stdout.on("data", data => { output += data; });
  process.stderr.on("data", data => { output += data; });
  const url = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + 10000;
    while (!output.includes("Robot Scene Studio:")) {
      if (process.exitCode !== null || Date.now() > deadline) throw new Error(output || "Server did not start");
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    const response = await fetch(url);
    assert.match(response.headers.get("content-security-policy"), /connect-src 'self'/);
    const payload = { expectedRevision: 0, id: "first", label: "編集",
      project: createProject({ ordered: true }) };
    const post = (body, headers = {}) => fetch(`${url}/api/history`, {
      method: "POST", headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    assert.equal((await post(payload, { Origin: "https://example.invalid" })).status, 403);
    assert.equal((await post({ ...payload, project: {} })).status, 400);
    assert.equal((await post(payload)).status, 201);
    const state = await (await fetch(`${url}/api/history`)).json();
    assert.equal(state.records.length, 1);
    const snapshot = await (await fetch(`${url}/api/history/1`)).json();
    assert.deepEqual(snapshot.project, payload.project);
    assert.equal((await post({ ...payload, id: "stale" })).status, 409);
    assert.equal((await fetch(`${url}/api/history/99`)).status, 404);
    assert.equal((await fetch(`${url}/data/history/0000000001.json`)).status, 404);
    assert.equal((await post(payload)).status, 201);
  } finally {
    const exited = once(process, "exit");
    process.kill();
    await exited;
    await rm(directory, { recursive: true });
  }
});
