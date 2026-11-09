import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { openHistoryStore, HistoryError } from "./history-store.js";
import { createFleetSession, handleFleetRequest } from "./fleet-session.js";

const port = Number(process.env.PORT ?? 3100);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
const history = process.env.HISTORY_MODE === "off" ? null : await openHistoryStore(
  process.env.HISTORY_DIR ?? fileURLToPath(new URL("./data/history", import.meta.url)));
const files = new Map([
  ["/", ["index.html", "text/html"]],
  ...["app.js", "model.js", "map-editor.js", "floor-plan.js", "safety.js", "timed-plan.js", "timeline-edit.js", "scenario-export.js", "scenario-library.js", "scenario-presentation.js", "autosave.js", "demo-map.js", "automatic-doors.js", "history-client.js"].map(name => [`/${name}`, [name, "text/javascript"]]),
  ["/map-editor.css", ["map-editor.css", "text/css"]],
  ["/style.css", ["style.css", "text/css"]],
]);
files.set("/fleet-bundle.js", ["fleet-bundle.js", "text/javascript"]);
const fleet = createFleetSession();
const server = http.createServer(async (req, res) => {
  const allowedHosts = [`localhost:${port}`, `127.0.0.1:${port}`];
  if (!allowedHosts.includes(req.headers.host)) { res.writeHead(403).end("Forbidden host"); return; }
  if (await handleFleetRequest(req, res, fleet, port)) return;
  if (req.url?.startsWith("/api/history")) {
    const reply = (status, data) => res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    }).end(JSON.stringify(data));
    if (req.headers.origin && !allowedHosts.map(host => `http://${host}`).includes(req.headers.origin)) {
      reply(403, { error: "別オリジンからの履歴アクセスは拒否しました。" }); return;
    }
    if (!history) { reply(200, { enabled: false, records: [] }); return; }
    try {
      if (req.method === "GET" && req.url === "/api/history") {
        reply(200, { enabled: true, records: history.list() }); return;
      }
      const match = /^\/api\/history\/([1-9]\d*)$/.exec(req.url);
      if (req.method === "GET" && match) { reply(200, history.get(Number(match[1]))); return; }
      if (req.method !== "POST" || req.url !== "/api/history") {
        reply(404, { error: "履歴APIが見つかりません。" }); return;
      }
      if (req.headers["content-type"] !== "application/json") throw new HistoryError("JSONで送信してください。", 415);
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 100 * 1024 * 1024) throw new HistoryError("履歴1件は100MiB以下にしてください。", 413);
        chunks.push(chunk);
      }
      let input;
      try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { throw new HistoryError("JSONが不正です。"); }
      reply(201, await history.append(input));
    } catch (error) {
      console.error("History API:", error);
      reply(error instanceof HistoryError ? error.status : 500,
        { error: error.message || "履歴の保存に失敗しました。" });
    }
    return;
  }
  const file = files.get(req.url);
  if (req.method !== "GET" || !file) { res.writeHead(404).end("Not found"); return; }
  try {
    const content = await readFile(new URL(`./public/${file[0]}`, import.meta.url));
    res.writeHead(200, {
      "Content-Type": `${file[1]}; charset=utf-8`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    }).end(content);
  } catch (error) {
    console.error(error);
    res.writeHead(500).end("Failed to load editor");
  }
});
server.on("error", async error => { console.error(error); process.exitCode = 1; await history?.close(); });
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  if (closing) return;
  closing = true;
  server.close(async () => {
    try { await history?.close(); }
    catch (error) { console.error(error); process.exitCode = 1; }
  });
});
server.listen(port, "127.0.0.1", () => console.log(`Robot Scene Studio: http://localhost:${port}`));
