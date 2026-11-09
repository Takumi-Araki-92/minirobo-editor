export function createHistoryClient(storage, report, request = fetch) {
  const key = "robot-scene-studio.pending-history";
  let enabled = false, initialized = false, revision = 0, pending = [], failure = "", running = null;
  let baseline = storage.getItem(key);
  const persist = () => {
    if (storage.getItem(key) !== baseline)
      throw new Error("別タブで未送信履歴が更新されました。JSON退避して再読込してください。");
    const serialized = JSON.stringify({ revision, pending });
    storage.setItem(key, serialized); baseline = serialized;
  };
  async function api(path, options) {
    const response = await request(path, { cache: "no-store", ...options });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error ?? `履歴APIエラー：${response.status}`);
    return value;
  }
  async function drain() {
    if (!enabled || failure) return;
    while (pending.length) {
      try {
        const record = await api("/api/history", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...pending[0], expectedRevision: revision }),
        });
        revision = record.revision;
        const completed = pending.shift();
        try { persist(); }
        catch (error) { pending.unshift(completed); throw error; }
        report(pending.length ? `履歴保存中 · ${pending.length}件` : `履歴保存済み · #${revision}`, false);
      } catch (error) {
        failure = error.message;
        report(`履歴未保存：${failure}。再試行またはJSON保存してください。`, true);
        return;
      }
    }
  }
  function flush() {
    if (!running) running = drain().finally(() => { running = null; });
    return running;
  }
  return {
    async initialize() {
      const state = await api("/api/history");
      enabled = state.enabled;
      if (!enabled) { initialized = true; return null; }
      const saved = storage.getItem(key);
      if (saved) {
        const value = JSON.parse(saved);
        if (!Number.isInteger(value.revision) || !Array.isArray(value.pending))
          throw new Error("未送信履歴が破損しています。ブラウザーデータを保全してください。");
        revision = value.revision; pending = value.pending;
      } else revision = state.records.at(-1)?.revision ?? 0;
      if (pending.length) {
        await flush();
        if (failure) throw new Error(failure);
      } else revision = state.records.at(-1)?.revision ?? 0;
      const latest = revision ? await api(`/api/history/${revision}`) : null;
      initialized = true;
      report(revision ? `履歴保存済み · #${revision}` : "履歴保存の準備完了", false);
      return latest?.project ?? null;
    },
    record(project, label, restoredFrom = null) {
      if (!initialized) throw new Error("履歴を初期化できていないため編集できません。サーバーを確認し再読込してください。");
      if (!enabled) return;
      if (failure) throw new Error(`履歴保存が停止しています：${failure}`);
      const record = { id: crypto.randomUUID(), project: structuredClone(project),
        label: label.slice(0, 200), restoredFrom };
      pending.push(record);
      try { persist(); }
      catch (error) {
        pending.pop();
        report(`履歴の退避に失敗しました：${error.message}。変更を適用しません。`, true);
        throw error;
      }
      report(`履歴保存中 · ${pending.length}件`, false);
      void flush();
    },
    async list() { await flush(); return (await api("/api/history")).records; },
    async get(number) { return api(`/api/history/${number}`); },
    async retry() {
      failure = "";
      await flush();
      if (failure) throw new Error(failure);
    },
    get pending() { return pending.length > 0; },
    get failed() { return !!failure; },
    get enabled() { return enabled; },
  };
}
