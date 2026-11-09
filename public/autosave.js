export function createAutosave(storage, key, report, locks = null) {
  let baseline = storage.getItem(key), stopped = false, stopReason = "";
  const conflict = () => {
    stopped = true;
    report("別タブで保存が更新されました。このタブの自動保存を停止しました。JSON保存で作業を退避し、再読込してください。");
  };
  return {
    stop(reason) { stopped = true; stopReason = reason; },
    changed() {
      if (storage.getItem(key) !== baseline) conflict();
    },
    async save(value) {
      if (stopped) throw new Error(stopReason || "保存競合により自動保存は停止中です。JSONへ退避してください。");
      if (!locks) {
        stopped = true;
        throw new Error("ブラウザーが排他保存に対応していません。自動保存せずJSONへ退避してください。");
      }
      return locks.request(`${key}:write`, () => {
        if (stopped || storage.getItem(key) !== baseline) {
          if (!stopped) conflict();
          throw new Error("別タブとの保存競合を検出しました。JSONへ退避してください。");
        }
        const serialized = JSON.stringify(value);
        storage.setItem(key, serialized);
        baseline = serialized;
      });
    },
    get stopped() { return stopped; },
  };
}
