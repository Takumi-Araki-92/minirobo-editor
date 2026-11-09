import { randomUUID } from "node:crypto";
import { createFleetBundle } from "./public/fleet-bundle.js";

export class FleetError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function createFleetSession({ clock = Date.now, leaseMs = 10000 } = {}) {
  let bundle = null, session = null;
  const require = (condition, message, status = 400) => {
    if (!condition) throw new FleetError(message, status);
  };
  const live = () => {
    if (session && clock() - session.seen > leaseMs) session = null;
    return session;
  };
  const owner = input => {
    require(live() && input?.client_token === session.token,
      "展示セッションが無効です。展示モードへ入り直してください。", 409);
    return session;
  };
  return {
    status() {
      const current = live();
      return {
        schema: "scene-fleet-status/v1", ready: !!current, bundle_id: bundle?.bundle_id ?? null,
        mode: current?.state.mode ?? "offline", selected_index: current?.state.selected_index ?? null,
        time_s: current?.state.time_s ?? 0,
        pending_command: current?.pending?.id ?? null,
        last_command: current?.last ?? null,
        scenarios: bundle?.scenarios.map(item => ({
          index: item.index, map_id: item.map_id, name: item.name, duration_s: item.duration_s,
          executable: item.executable, errors: item.validation.errors,
        })) ?? [],
      };
    },
    begin(project) {
      require(!live(), "別の展示画面が接続中です。先にその展示モードを終了してください。", 409);
      let created;
      try { created = createFleetBundle(project); }
      catch (error) { throw new FleetError(error.message); }
      bundle = created;
      session = {
        token: randomUUID(), seen: clock(), pending: null, last: null, lastInput: null,
        state: { mode: "waiting", selected_index: null, time_s: 0 },
      };
      return { client_token: session.token, bundle: structuredClone(bundle), status: this.status() };
    },
    bundle() {
      require(bundle, "連携用セットが未登録です。展示モードを開始してください。", 404);
      return structuredClone(bundle);
    },
    scenario(index) {
      const item = bundle?.scenarios.find(item => item.index === index);
      require(item, "指定indexのシナリオがありません。", 404);
      return { bundle_id: bundle.bundle_id, ...structuredClone(item) };
    },
    heartbeat(input) {
      const current = owner(input);
      const state = input.state;
      require(state && ["waiting", "selected", "running", "paused", "finished"].includes(state.mode) &&
        Number.isFinite(state.time_s) && state.time_s >= 0 &&
        (state.selected_index === null || bundle.scenarios.some(item =>
          item.index === state.selected_index)), "展示状態が不正です。");
      if (input.ack) {
        require(current.pending && input.ack.id === current.pending.id &&
          (input.ack.error === undefined || typeof input.ack.error === "string" &&
            input.ack.error.length <= 1000), "受領確認のIDまたはエラーが不正です。", 409);
        current.last = { id: current.pending.id, status: input.ack.error ? "failed" : "applied",
          ...(input.ack.error ? { error: input.ack.error } : {}) };
        current.lastInput = current.pending;
        current.pending = null;
      }
      current.state = {
        mode: state.mode, selected_index: state.selected_index, time_s: state.time_s,
      };
      current.seen = clock();
      return { command: current.pending ? structuredClone(current.pending) : null };
    },
    command(input) {
      const current = live();
      require(current, "展示画面が待機していません。展示モードを開始してください。", 409);
      require(input && typeof input.id === "string" && /^[\w-]{1,80}$/.test(input.id) &&
        ["select", "start", "pause", "reset"].includes(input.type) &&
        input.bundle_id === bundle.bundle_id, "指示形式またはbundle_idが不正です。", 409);
      require(input.type === "select" ? Number.isInteger(input.index) &&
        bundle.scenarios.some(item => item.index === input.index) : input.index === undefined,
      "selectには有効なindexを指定し、他の指示にはindexを付けないでください。");
      if (input.type === "select") {
        const item = bundle.scenarios.find(item => item.index === input.index);
        require(item.executable, `index ${item.index}「${item.name}」は実行できません：${item.validation.errors.join(" / ")}`, 422);
      }
      const command = { id: input.id, type: input.type, bundle_id: input.bundle_id,
        ...(input.type === "select" ? { index: input.index } : {}) };
      if (current.last?.id === input.id || current.pending?.id === input.id) {
        require(JSON.stringify(command) === JSON.stringify(
          current.pending?.id === input.id ? current.pending : current.lastInput),
        "同じ指示IDで内容を変更できません。", 409);
        return current.last?.id === input.id ? current.last : { id: input.id, status: "accepted" };
      }
      require(!current.pending, "前の指示の受領確認を待ってください。", 409);
      require(command.type === "select" || current.state.selected_index !== null,
        "先にselectを送り、適用を確認してください。", 409);
      current.pending = command;
      return { id: command.id, status: "accepted" };
    },
    end(input) { owner(input); session = null; return { ready: false }; },
  };
}

export async function handleFleetRequest(req, res, fleet, port) {
  if (!req.url?.startsWith("/api/fleet")) return false;
  const reply = (status, data) => res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  }).end(JSON.stringify(data));
  try {
    if (req.headers.origin && ![`http://localhost:${port}`, `http://127.0.0.1:${port}`]
      .includes(req.headers.origin)) throw new FleetError("別オリジンからの連携アクセスは拒否しました。", 403);
    if (req.method === "GET") {
      if (req.url === "/api/fleet") reply(200, fleet.status());
      else if (req.url === "/api/fleet/bundle") reply(200, fleet.bundle());
      else {
        const match = /^\/api\/fleet\/scenarios\/([1-9]\d*)$/.exec(req.url);
        if (!match) throw new FleetError("連携APIが見つかりません。", 404);
        reply(200, fleet.scenario(Number(match[1])));
      }
    } else if (req.method === "POST" &&
      ["/api/fleet/session", "/api/fleet/heartbeat", "/api/fleet/end", "/api/fleet/commands"].includes(req.url)) {
      if (req.headers["content-type"] !== "application/json") throw new FleetError("JSONで送信してください。", 415);
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 100 * 1024 * 1024) throw new FleetError("連携要求は100MiB以下にしてください。", 413);
        chunks.push(chunk);
      }
      let input;
      try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { throw new FleetError("JSONが不正です。"); }
      if (req.url === "/api/fleet/session") reply(201, fleet.begin(input?.project));
      else if (req.url === "/api/fleet/commands") reply(202, fleet.command(input));
      else if (req.url === "/api/fleet/heartbeat") reply(200, fleet.heartbeat(input));
      else reply(200, fleet.end(input));
    } else throw new FleetError("連携APIが見つかりません。", 404);
  } catch (error) {
    console.error("Fleet API:", error);
    reply(error instanceof FleetError ? error.status : 500,
      { error: error.message || "フリート連携に失敗しました。" });
  }
  return true;
}
