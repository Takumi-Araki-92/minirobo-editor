import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { createLibraryScenario } from "../public/scenario-library.js";
import { createFleetBundle } from "../public/fleet-bundle.js";
import { createFleetSession } from "../fleet-session.js";

const project = () => {
  const value = createLibraryScenario("daily-security");
  value.maps.push(createLibraryScenario("tutorial-dirt").maps[0]);
  return value;
};
const state = (selected_index = null, mode = "waiting", time_s = 0) =>
  ({ selected_index, mode, time_s });

test("fleet bundle freezes one-based indices, full maps, initial poses and world-unit robot sequences", () => {
  const source = project(), before = structuredClone(source);
  const bundle = createFleetBundle(source);
  assert.deepEqual(source, before);
  assert.deepEqual(bundle.scenarios.map(item => [item.index, item.map_id]),
    source.maps.map((map, i) => [i + 1, map.id]));
  assert.equal(bundle.hardware_approved, false);
  assert.equal(bundle.simulation_only, true);
  for (const item of bundle.scenarios) {
    assert.equal(item.navigation.units, "ratio-coordinate");
    for (const robot of item.robots) {
      const track = source.maps[item.index - 1].tracks.find(track => track.id === robot.track_id);
      assert.deepEqual(robot.initial, track.initial);
      assert.equal(robot.sequence.length, track.actions.length);
      for (const action of robot.sequence.filter(action => action.to)) {
        const original = track.actions.find(item => item.id === action.action_id);
        assert.ok(Math.abs(action.to.x - original.x) < 1e-8);
        assert.ok(Math.abs(action.to.y - original.y) < 1e-8);
        assert.equal(action.start_s, original.position);
        assert.equal(action.end_s, original.position + original.runSeconds);
      }
    }
  }
  source.maps.reverse();
  source.maps[0].name = "changed";
  assert.equal(bundle.scenarios[0].map_id, before.maps[0].id);
  assert.notEqual(bundle.scenarios[1].name, "changed");
  assert.ok(bundle.scenarios[1].map.presentation);
});

test("fleet bundle rejects invalid schema but preserves every blocked action with explicit errors", () => {
  assert.throws(() => createFleetBundle({}), /形式|maps|schema|対応/);
  const source = project();
  const robot = source.maps[1].tracks.find(track => track.kind === "robot" && track.actions.length);
  robot.actions[1].position = robot.actions[0].position;
  const bundle = createFleetBundle(source);
  const item = bundle.scenarios[1];
  assert.equal(item.executable, false);
  assert.ok(item.validation.errors.length > 0);
  assert.equal(item.scenario_draft, null);
  assert.equal(item.robots[0].sequence.length, robot.actions.length);
  assert.ok(item.robots[0].sequence.every(action => !action.executable));
  const fleet = createFleetSession();
  const active = fleet.begin(source);
  assert.throws(() => fleet.command({ id: "invalid-select", type: "select", index: 2,
    bundle_id: active.bundle.bundle_id }), /index 2/);
});

test("fleet session accepts commands only while connected, acknowledges serially and protects retries", () => {
  let now = 0;
  const fleet = createFleetSession({ clock: () => now, leaseMs: 100 });
  assert.equal(fleet.status().ready, false);
  assert.throws(() => fleet.bundle(), /未登録/);
  const value = fleet.begin(project()), token = value.client_token;
  const bundle_id = value.bundle.bundle_id;
  assert.equal(fleet.status().mode, "waiting");
  assert.throws(() => fleet.begin(project()), /接続中/);
  assert.throws(() => fleet.heartbeat({ client_token: "bad", state: state() }), /無効/);
  const send = (id, type, extra = {}) => fleet.command({ id, type, bundle_id, ...extra });
  assert.throws(() => send("start-before-select", "start"), /先にselect/);
  assert.throws(() => send("invalid", "select", { index: 0 }), /有効なindex/);
  assert.throws(() => fleet.command({ id: "stale", type: "select", index: 1, bundle_id: "stale" }), /bundle_id/);
  assert.equal(send("select-one", "select", { index: 2 }).status, "accepted");
  assert.equal(send("select-one", "select", { index: 2 }).status, "accepted");
  assert.throws(() => send("select-one", "select", { index: 1 }), /内容/);
  assert.throws(() => send("next", "start"), /前の指示/);
  const delivered = fleet.heartbeat({ client_token: token, state: state() });
  assert.equal(delivered.command.index, 2);
  assert.throws(() => fleet.heartbeat({ client_token: token, state: state(),
    ack: { id: "wrong" } }), /受領確認/);
  fleet.heartbeat({ client_token: token, state: state(2, "selected"), ack: { id: "select-one" } });
  assert.equal(send("select-one", "select", { index: 2 }).status, "applied");
  send("start", "start");
  fleet.heartbeat({ client_token: token, state: state(2, "running", 1), ack: { id: "start" } });
  assert.equal(fleet.status().mode, "running");
  assert.equal(fleet.scenario(2).map_id, value.bundle.scenarios[1].map_id);
  assert.throws(() => fleet.scenario(99), /ありません/);
  now = 101;
  assert.equal(fleet.status().ready, false);
  assert.throws(() => send("offline", "pause"), /待機/);
  assert.throws(() => fleet.heartbeat({ client_token: token, state: state() }), /無効/);
  assert.equal(fleet.bundle().bundle_id, bundle_id);
  const next = fleet.begin(project());
  assert.notEqual(next.bundle.bundle_id, bundle_id);
  fleet.end({ client_token: next.client_token });
  assert.equal(fleet.status().ready, false);
});

test("fleet HTTP API publishes snapshots, restricts origins, validates commands and clears ended sessions", async () => {
  const socket = createServer();
  socket.listen(0, "127.0.0.1"); await once(socket, "listening");
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const server = spawn(process.execPath, ["server.js"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: String(port), HISTORY_MODE: "off" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  server.stdout.on("data", data => { output += data; });
  server.stderr.on("data", data => { output += data; });
  const url = `http://127.0.0.1:${port}/api/fleet`;
  const post = (route, body, headers = {}) => fetch(url + route, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  try {
    const deadline = Date.now() + 10000;
    while (!output.includes("Robot Scene Studio:")) {
      if (server.exitCode !== null || Date.now() > deadline) throw new Error(output || "Server did not start");
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.equal((await (await fetch(url)).json()).ready, false);
    assert.equal((await fetch(url + "/bundle")).status, 404);
    assert.equal((await post("/session", { project: project() }, { Origin: "https://example.invalid" })).status, 403);
    assert.equal((await post("/session", { project: project() }, { "Content-Type": "text/plain" })).status, 415);
    const response = await post("/session", { project: project() });
    assert.equal(response.status, 201);
    const active = await response.json();
    assert.equal((await fetch(url + "/scenarios/2")).status, 200);
    assert.equal((await fetch(url + "/scenarios/0")).status, 404);
    assert.equal((await post("/commands", { id: "bad", type: "select", index: 99,
      bundle_id: active.bundle.bundle_id })).status, 400);
    assert.equal((await post("/commands", { id: "pick", type: "select", index: 2,
      bundle_id: active.bundle.bundle_id })).status, 202);
    const command = await (await post("/heartbeat", {
      client_token: active.client_token, state: state(),
    })).json();
    assert.equal(command.command.index, 2);
    await post("/heartbeat", { client_token: active.client_token,
      state: state(2, "selected"), ack: { id: "pick" } });
    const applied = await (await fetch(url)).json();
    assert.equal(applied.last_command.status, "applied");
    assert.equal(JSON.stringify(applied).includes(active.client_token), false);
    assert.equal((await post("/end", { client_token: active.client_token })).status, 200);
    assert.equal((await (await fetch(url)).json()).ready, false);
    assert.equal((await fetch(url + "/bundle")).status, 200);
  } finally {
    const exited = once(server, "exit"); server.kill(); await exited;
  }
});
