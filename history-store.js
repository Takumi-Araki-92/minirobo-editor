import { mkdir, readFile, readdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { validateProject } from "./public/model.js";

export class HistoryError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export async function openHistoryStore(directory) {
  await mkdir(directory, { recursive: true });
  const lockPath = join(directory, "writer.lock");
  let lock;
  try { lock = await open(lockPath, "wx"); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error(
      "履歴のwriter.lockが存在します。他のサーバーを終了してください。異常終了後は稼働していないことを確認し、このファイルだけを削除してください。");
    throw error;
  }
  await lock.writeFile(JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
  await lock.sync();
  const records = [];
  let queue = Promise.resolve();
  try {
    const names = (await readdir(directory)).filter(name => /^\d{10}\.json$/.test(name)).sort();
    for (const name of names) {
      const record = JSON.parse(await readFile(join(directory, name), "utf8"));
      if (record.revision !== records.length + 1 || Number(name.slice(0, 10)) !== record.revision ||
          record.hash !== digest(record.project))
        throw new Error(`履歴ファイルが破損しています：${name}。元データを保全して復旧してください。`);
      validateProject(record.project);
      records.push(record);
    }
  } catch (error) {
    await lock.close(); await unlink(lockPath); throw error;
  }
  const metadata = record => ({
    revision: record.revision, timestamp: record.timestamp, label: record.label,
    restoredFrom: record.restoredFrom ?? null, id: record.id,
  });
  return {
    list() { return records.map(metadata); },
    get(revision = records.length) {
      const record = records[revision - 1];
      if (!record) throw new HistoryError("指定した履歴がありません。", 404);
      return structuredClone(record);
    },
    append(input) {
      const work = queue.then(async () => {
        if (!input || !Number.isInteger(input.expectedRevision) || !/^[\w-]{1,80}$/.test(input.id ?? "") ||
            typeof input.label !== "string" || !input.label.trim() || input.label.length > 200)
          throw new HistoryError("履歴の保存要求が不正です。");
        const existing = records.find(record => record.id === input.id);
        if (existing) {
          if (existing.hash !== digest(input.project)) throw new HistoryError("履歴IDが競合しています。", 409);
          return metadata(existing);
        }
        if (input.expectedRevision !== records.length)
          throw new HistoryError("別の画面で履歴が更新されています。未保存データをJSON退避し、再読込してください。", 409);
        try { validateProject(input.project); }
        catch (error) { throw new HistoryError(`保存データが不正です：${error.message}`); }
        if (input.restoredFrom != null &&
            (!Number.isInteger(input.restoredFrom) || input.restoredFrom < 1 || input.restoredFrom > records.length))
          throw new HistoryError("復元元の履歴が不正です。");
        const record = {
          revision: records.length + 1, id: input.id, timestamp: new Date().toISOString(),
          label: input.label, restoredFrom: input.restoredFrom ?? null,
          project: structuredClone(input.project), hash: digest(input.project),
        };
        const target = join(directory, `${String(record.revision).padStart(10, "0")}.json`);
        const temporary = join(directory, `${randomUUID()}.tmp`);
        const file = await open(temporary, "wx");
        try { await file.writeFile(JSON.stringify(record)); await file.sync(); }
        finally { await file.close(); }
        await rename(temporary, target);
        records.push(record);
        return metadata(record);
      });
      queue = work.catch(() => {});
      return work;
    },
    async close() {
      await queue;
      await lock.close(); await unlink(lockPath);
    },
  };
}
