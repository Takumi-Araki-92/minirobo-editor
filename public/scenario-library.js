import { createProject, newTrack, newAction, uid } from "./model.js";
import { regionBounds, roomContainsPoint } from "./floor-plan.js";

export const SCENARIO_LIBRARY = Object.freeze([
  { id: "daily-security", name: "日常運用1 · 夜間警備巡回", group: "日常運用", description: "昼は充電待機。夜になると警備が廊下を一周。用途別3台の予定ルートを表示。" },
  { id: "daily-cleaning", name: "日常運用2 · 夜間清掃", group: "日常運用", description: "昼は充電待機。夜に清掃が廊下とエントランスの汚れを清掃。" },
  { id: "daily-delivery", name: "日常運用3 · 荷物受取とEV乗車", group: "日常運用", description: "室内充電場所→セキュリティ扉→荷物受取→扉→EV呼出待機→乗車。" },
  { id: "tutorial-passage", name: "チュートリアル1 · 通路の優先管理", group: "チュートリアル", description: "群管理なしの対向停止と、B待機→A通行→B通行を同じマップで比較。" },
  { id: "tutorial-door", name: "チュートリアル2 · 扉の優先管理", group: "チュートリアル", description: "扉のIN/OUTで対向停止。A通過→一度閉扉→再開扉→B通過を比較。" },
  { id: "tutorial-fire", name: "チュートリアル3 · 火災時の役割分担", group: "チュートリアル", description: "口の字通路を反時計回りに走行。火災後、警備は誘導・清掃は退避。" },
  { id: "tutorial-crowd", name: "チュートリアル4 · 見えない混雑を回避", group: "チュートリアル", description: "建物がロボット視野外の混雑を把握。予定の左回りを右回りへ変更。" },
  { id: "tutorial-dirt", name: "チュートリアル5 · 利用跡だけ清掃", group: "チュートリアル", description: "会議参加者が退館。人がいた会議室とエントランスの一部だけを清掃。" },
  { id: "tutorial-vip", name: "チュートリアル6 · VIPお迎え", group: "チュートリアル", description: "車番認識の模擬通知→歓迎→扉連動→VIPと同行→EV目的階呼出。" },
  { id: "bcp", name: "異常時対応（BCP）", group: "応用デモ", description: "異常エリアへ警備が直行。清掃・配送は別々の待機スペースへ退避。" },
  { id: "garbage", name: "ゴミ検知→清掃出動", group: "応用デモ", description: "カメラによるゴミ検知を可視化し、清掃ロボットが対象ゾーンだけを清掃。" },
  { id: "occupancy", name: "人流変化→清掃出動", group: "応用デモ", description: "在室→退室→空室の色変化を表示し、利用終了後に清掃。" },
  { id: "learning", name: "拡張していくビル", group: "応用デモ", description: "蓄積データから汚れ・巡回需要を予測する模擬演出。ルート・頻度・役割を切替。" },
  { id: "hospitality", name: "おもてなしの進化", group: "応用デモ", description: "回答の模擬入力→案内先をハイライト→配送ロボットが対応ゾーンへ移動。" },
  { id: "environment", name: "警備ロボット巡回→空調連動", group: "応用デモ", description: "巡回地点で環境をスキャン。建物へのデータ通知と空調状態の変化を表示。" },
  { id: "remote", name: "トラブル時の遠隔就労", group: "応用デモ", description: "エラー→遠隔就労者へ通知→ゲーム風HUDと操作指示→復旧の録画風デモ。実操縦ではありません。" },
]);

const palette = { security: "#8daeff", cleaning: "#64dcb2", delivery: "#ffcb81" };
const cells = (x1, y1, x2, y2) => {
  const result = [];
  for (let y = y1; y < y2; y += 50) for (let x = x1; x < x2; x += 50)
    result.push((17 - y / 50) * 32 + x / 50);
  return result;
};
const region = (name, kind, area, color = "#c5c6bc") => ({
  id: uid(), name, kind, material: "tile", color, cells: area, ...regionBounds(area),
});

export function createLibraryScenario(id) {
  const definition = SCENARIO_LIBRARY.find(item => item.id === id);
  if (!definition) throw new Error(`Unknown library scenario: ${id}`);
  const project = createProject({ ordered: true }), map = project.maps[0];
  project.name = definition.name; project.schema = "robot-scene/v5";
  Object.assign(map, { name: definition.name, executionMode: "timed", timelineOnly: true,
    doorMode: "strict", tracks: [], rooms: [], floorPlan: { doors: [], furniture: [], chargingZones: [] },
    presentation: { version: 1, scenarioId: id, cues: [] } });
  const cue = (kind, start, end, label, color, geometry = {}) =>
    map.presentation.cues.push({ kind, start, end, label, color, ...geometry });
  const note = (start, end, label, color = "#ffffff") => cue("notice", start, end, label, color);
  const zone = (kind, start, end, label, color, x, y, width, height) =>
    cue(kind, start, end, label, color, { x, y, width, height });
  const routeCue = (start, end, label, color, points) => cue("route", start, end, label, color, { points });
  const location = (x, y) => map.rooms.find(room => roomContainsPoint(room, x, y))?.id ?? "";
  const action = (track, type, start, seconds, name, extra = {}) => {
    const item = Object.assign(newAction(map, track, type),
      { position: start, runSeconds: seconds, name, dwell: 0, ...extra });
    track.actions.push(item); return item;
  };
  const robot = (role, x, y, name = { security: "警備ロボット", cleaning: "清掃ロボット", delivery: "配送ロボット" }[role]) => {
    const track = newTrack(map, "robot");
    Object.assign(track, { name, robotRole: role, color: palette[role],
      initial: { x, y, yaw: 0, roomId: location(x, y), coordinateMode: "free" } });
    map.tracks.push(track); return track;
  };
  const human = (x, y, name = "会議参加者", count = 4) => {
    const track = newTrack(map, "human");
    Object.assign(track, { name, count, initial: { x, y, yaw: 0,
      roomId: location(x, y), coordinateMode: "free" } });
    map.tracks.push(track); return track;
  };
  const positionOf = track => [...track.actions].reverse().find(a => a.type === "move") ?? track.initial;
  const travel = (track, start, points, name = "移動", speed = 140) => {
    let time = Math.max(start, ...track.actions.map(a => a.position + a.runSeconds));
    let from = positionOf(track);
    for (const [x, y] of points) {
      const distance = Math.hypot(x - from.x, y - from.y);
      if (distance < .01) continue;
      const yaw = track.kind === "human" ? 0 : Math.atan2(y - from.y, x - from.x) * 180 / Math.PI;
      const delta = Math.abs(((yaw - from.yaw + 540) % 360) - 180);
      if (track.kind === "robot" && delta > .01) {
        const seconds = Math.max(.5, delta / 180);
        action(track, "move", time, seconds, `進行方向へ旋回 · ${name}`,
          { x: from.x, y: from.y, yaw, motion: "rotate", rotationSeconds: seconds,
            angularSpeed: 180, roomId: location(from.x, from.y), coordinateMode: "free" });
        time += seconds;
      }
      const seconds = Math.max(1, distance / speed);
      from = action(track, "move", time, seconds, name,
        { x, y, yaw, roomId: location(x, y), coordinateMode: "free" });
      time += seconds;
    }
    return time;
  };
  const wait = (track, start, seconds, name) => action(track, "wait", start, seconds, name);
  const doorTrack = (room, windows, doorId) => {
    const track = newTrack(map, "room");
    Object.assign(track, { name: "建物連携 · 扉の解錠", roomId: room.id });
    map.tracks.push(track);
    for (const [start, end] of windows)
      action(track, "unlock", start, end - start, "通行許可", { roomId: room.id, ...(doorId ? { doorId } : {}) });
  };
  const boundaryDoor = (room, x, y, edge, count = 6) => {
    const openingId = uid();
    for (let i = 0; i < count; i++) {
      const cx = x + (["top", "bottom"].includes(edge) ? 50 * i : 0);
      const cy = y + (["left", "right"].includes(edge) ? 50 * i : 0);
      map.floorPlan.doors.push({ id: uid(), openingId, roomId: room.id,
        cell: cells(cx, cy, cx + 50, cy + 50)[0], edge });
    }
  };
  const building = () => {
    const entrance = region("エントランス", "corridor", cells(0, 0, 400, 900), "#d8d1bd");
    const meeting = region("会議室", "room", cells(650, 300, 950, 600), "#c9b8a5");
    const elevator = region("EV", "room", cells(950, 300, 1250, 600), "#c3cdd0");
    Object.assign(elevator, { appearance: "elevator", entranceEdge: "bottom" });
    const occupied = new Set([...entrance.cells, ...meeting.cells, ...elevator.cells]);
    const hall = region("口の字廊下", "corridor",
      cells(0, 0, 1600, 900).filter(cell => !occupied.has(cell)), "#bac5c1");
    map.rooms = [entrance, hall, meeting, elevator];
    boundaryDoor(entrance, 350, 300, "right");
    boundaryDoor(meeting, 650, 300, "left");
    boundaryDoor(elevator, 950, 300, "bottom");
    map.floorPlan.chargingZones = [
      { id: uid(), name: "警備充電", x: 100, y: 25, width: 250, height: 250 },
      { id: uid(), name: "清掃充電", x: 100, y: 625, width: 250, height: 250 },
      { id: uid(), name: "室内配送充電", x: 1300, y: 325, width: 250, height: 250 },
    ];
    doorTrack(entrance, [[0, 240]]);
    doorTrack(meeting, [[0, 240]]);
    doorTrack(elevator, [[0, 240]]);
    return { entrance, hall, meeting, elevator };
  };
  const passage = door => {
    const area = [...new Set([...cells(0, 300, 1600, 600), ...cells(0, 0, 450, 900),
      ...cells(1150, 0, 1600, 900)])];
    const hall = region("優先通路・両端待避場所", "corridor", area, "#b8c5c7");
    map.rooms = [hall];
    if (door) {
      map.floorPlan.walls = [{ id: uid(), roomId: hall.id, x1: 800, y1: 300, x2: 800, y2: 600 }];
      const wall = map.floorPlan.walls[0];
      map.floorPlan.doors.push({ id: uid(), name: "セキュリティ扉", roomId: hall.id,
        wallId: wall.id, kind: "automatic", x1: 800, y1: 300, x2: 800, y2: 600 });
    }
    return hall;
  };
  let end = 60;
  if (["tutorial-passage", "tutorial-door"].includes(id)) {
    const isDoor = id === "tutorial-door", hall = passage(isDoor);
    const a = robot("security", 225, 450, "A · 優先通行"), b = robot("cleaning", 1375, 450, "B · 待機して通行");
    const approach = Math.max(travel(a, 0, [[650, 450]], "管理なし · 対向接近"),
      travel(b, 0, [[950, 450]], "管理なし · 対向接近"));
    note(0, approach, "比較1：群管理なし · 両側から接近（衝突はさせない模擬デモ）", "#ffcb81");
    note(approach, 10, "群管理なし：中央で両にらみ。互いの進路を譲れず停止", "#ff817b");
    routeCue(approach, 10, "対向する進路", "#ff817b", [[650, 450], [950, 450], [650, 450]]);
    const pocket = travel(b, 10, [[1375, 450], [1375, 750]], "Bは入口の待機場所へ");
    note(10, pocket, "比較2：群管理あり · Aを優先、Bは通路入口で待機", "#64dcb2");
    const aCross = travel(a, pocket + 1, [[1375, 450]], "Aが優先通行");
    const aClear = travel(a, aCross, [[1375, 150]], "Aが出口を空ける");
    const bReturn = travel(b, aClear + 4, [[1375, 450]], "Bの通行許可");
    const bCross = travel(b, bReturn, [[225, 450]], "Bが通行");
    end = bCross + 4;
    zone("zone", 10, end, "B WAIT", "#64dcb2", 1200, 625, 300, 250);
    zone("zone", 10, end, "A CLEAR", "#8daeff", 1200, 25, 300, 250);
    if (isDoor) {
      zone("zone", 0, end, "IN", palette.security, 650, 310, 100, 100);
      zone("zone", 0, end, "OUT", palette.cleaning, 850, 310, 100, 100);
      doorTrack(hall, [[0, 10], [pocket, aClear + .8], [bReturn, end]], map.floorPlan.doors[0].id);
      note(pocket, aClear, "扉連携：Aの通過を許可", "#8daeff");
      note(aClear + 1, bReturn, "A通過完了 → 一度閉扉 → Bのため再開扉", "#ffcb81");
      note(bReturn, end, "B通過後に施錠 · IN / OUTを順番に通行", "#64dcb2");
    } else {
      note(pocket, aClear, "優先エリア使用中：A通行 / B待機", "#8daeff");
      note(aClear, end, "Aの通過完了を建物へ通知 → Bが通行", "#64dcb2");
    }
  } else {
    building();
    const loop = [[525, 150], [1425, 150], [1425, 750], [525, 750], [525, 450]];
    if (id.startsWith("daily-")) {
      const security = robot("security", 225, 150), cleaner = robot("cleaning", 225, 750);
      const delivery = robot("delivery", id === "daily-delivery" ? 1425 : 1100, 450);
      routeCue(0, 8, "警備：夜間巡回予定", palette.security, [[225, 150], ...loop]);
      routeCue(0, 8, "清掃：夜間清掃予定", palette.cleaning, [[225, 750], [225, 450], [525, 450], ...loop.slice(0, 4)]);
      routeCue(0, 8, "配送：受取→EV予定", palette.delivery, [[1425, 450], [1425, 150],
        [525, 150], [525, 450], [225, 450], [525, 450], [525, 150], [1100, 150], [1100, 450]]);
      if (id === "daily-security") {
        wait(security, 0, 8, "昼 · エントランス充電待機");
        end = travel(security, 8, [[225, 450], [525, 450], [525, 150], [1425, 150],
          [1425, 750], [525, 750], [525, 450], [225, 450], [225, 150]], "夜間巡回") + 4;
        note(0, 8, "昼：3台はそれぞれ待機 · 夜間へ時間を圧縮して切替");
        note(8, end, "夜：警備が廊下を一周 / 清掃・配送は待機", palette.security);
      } else if (id === "daily-cleaning") {
        wait(cleaner, 0, 8, "昼 · 充電待機");
        const start = travel(cleaner, 8, [[225, 450]], "エントランス清掃");
        zone("dirt", 8, start + 4, "夜間清掃対象 · エントランスの一部", "#bc8b52", 100, 325, 250, 250);
        wait(cleaner, start, 4, "エントランス清掃中");
        end = travel(cleaner, start + 4, [[525, 450], [525, 150], [1425, 150], [1425, 750],
          [525, 750], [525, 450], [225, 450], [225, 750]], "廊下清掃") + 4;
        routeCue(start + 4, end, "廊下清掃ルート", palette.cleaning, loop);
        note(0, 8, "昼：清掃ロボットは充電場所で待機");
        note(8, end, "夜：エントランスから廊下へ · 汚れ領域を清掃", palette.cleaning);
      } else {
        const pickup = travel(delivery, 3, [[1425, 150], [525, 150], [525, 450], [225, 450]], "セキュリティ扉を通り荷物受取");
        wait(delivery, pickup, 4, "昼 · エントランスで荷物受取");
        const call = travel(delivery, pickup + 4, [[525, 450], [525, 150], [1100, 150]], "セキュリティ扉を通りEV呼出場所へ");
        wait(delivery, call, 4, "EVを目的階へ呼出・待機");
        end = travel(delivery, call + 4, [[1100, 450]], "EV乗車") + 5;
        note(0, pickup, "昼：室内充電場所→セキュリティ扉→エントランス", palette.delivery);
        zone("zone", pickup, pickup + 4, "荷物受取", palette.delivery, 100, 325, 250, 250);
        note(call, call + 4, "建物連携：EVを目的階へ呼出（模擬）→到着待ち", palette.delivery);
        note(call + 4, end, "EVへ乗車 · 他フロア移動は到着表示で表現（実EV制御なし）", palette.delivery);
      }
    } else if (id === "tutorial-fire" || id === "bcp") {
      const security = robot("security", 1425, 150), cleaner = robot("cleaning", 525, 750);
      let alarm = 5;
      if (id === "tutorial-fire") {
        alarm = Math.max(travel(security, 0, [[1425, 750]], "反時計回り巡回"),
          travel(cleaner, 0, [[525, 450]], "反時計回り巡回"));
      }
      const retreat = travel(cleaner, alarm + 1, [[525, 450], [225, 450], [225, 750]], "避難者を妨げない場所へ退避");
      const arrive = travel(security, alarm + 1, [[1425, 750], [525, 750]], "異常エリアへ直行");
      if (id === "bcp") {
        const delivery = robot("delivery", 1100, 450);
        travel(delivery, alarm + 1, [[1100, 150]], "配送専用待機スペースへ");
      }
      end = Math.max(retreat, arrive) + 10;
      zone("fire", alarm, end, "異常・火災エリア", "#ff675e", 650, 600, 300, 250);
      zone("zone", alarm, end, "清掃 待機・退避", palette.cleaning, 100, 625, 250, 250);
      if (id === "bcp") zone("zone", alarm, end, "配送 待機", palette.delivery, 975, 25, 250, 250);
      note(0, alarm, "通常巡回 · 火災の発生を待つ", palette.security);
      note(alarm, arrive, "建物が異常を通知 → 警備は現場へ / 他ロボットは退避", "#ff817b");
      note(arrive, end, "警備：停止して避難誘導モード / 清掃・配送：待機維持", palette.security);
    } else if (id === "tutorial-crowd") {
      const delivery = robot("delivery", 1425, 150);
      routeCue(0, 6, "変更前：左回り（反時計回り）", "#ffcb81",
        [[1425, 150], [1425, 750], [525, 750], [525, 450]]);
      zone("crowd", 3, 60, "建物が把握した混雑 · ロボット視野外", "#ff817b", 450, 625, 400, 250);
      zone("scan", 0, 6, "ロボットの局所視野（模式）", palette.delivery, 1250, 25, 325, 275);
      routeCue(6, 60, "変更後：右回り（時計回り）", palette.cleaning,
        [[1425, 150], [525, 150], [525, 450]]);
      const arrive = travel(delivery, 7, [[525, 150], [525, 450]], "混雑を避けて右回りへ変更");
      end = arrive + 5;
      note(0, 3, "配送先への左回りルートを計画");
      note(3, 7, "建物の人流データ：ロボットから見えない先の混雑を通知", "#ff817b");
      note(7, end, "ロボットは混雑エリアへ近づかず、右回りルートで配送", palette.cleaning);
    } else if (["tutorial-dirt", "occupancy"].includes(id)) {
      const cleaner = robot("cleaning", 225, 750), people = human(800, 450);
      zone("zone", 0, 5, "会議中 · 在室4名", "#ffcb81", 650, 300, 300, 300);
      const exit = travel(people, 5, [[525, 450], [225, 450], [75, 450]], "会議終了・エントランスから退館", 110);
      zone("zone", exit, 90, "退館済・屋外", "#8daeff", 0, 325, 100, 250);
      zone("zone", 5, exit, "退室を検知", "#ffcb81", 650, 300, 300, 300);
      const entry = travel(cleaner, exit + 2, [[225, 450], [525, 450], [800, 450]], "空室になった会議室へ");
      zone("dirt", exit, entry + 5, "利用跡・清掃対象", "#bc8b52", 675, 325, 250, 250);
      zone("zone", exit, end + 50, "空室 · 建物が清掃を依頼", palette.cleaning, 650, 300, 300, 300);
      wait(cleaner, entry, 5, "会議室清掃");
      let finish = entry + 5;
      if (id === "tutorial-dirt") {
        finish = travel(cleaner, finish, [[525, 450], [225, 450]], "人が歩いたエントランスの一部へ");
        zone("dirt", exit, finish + 5, "歩行跡だけ清掃 · 全面ではない", "#bc8b52", 100, 325, 250, 250);
        wait(cleaner, finish, 5, "エントランスの利用跡だけ清掃");
        finish += 5;
      }
      end = travel(cleaner, finish, [[525, 450], [225, 450], [225, 750]], "清掃完了・充電場所へ") + 3;
      note(0, exit, "会議中→参加者退館 · 在室データの変化を建物が把握");
      note(exit, end, "人がいた場所だけを可視化して清掃依頼 · 全面清掃はしない", palette.cleaning);
    } else if (id === "tutorial-vip") {
      const security = robot("security", 225, 150), vip = human(75, 450, "VIP（架空）", 1);
      zone("car", 0, 7, "車番 DEMO · VIP判定（模擬）", "#ffcb81", 0, 325, 150, 250);
      const welcome = travel(security, 3, [[225, 450]], "玄関で歓迎表示");
      const leadStart = welcome + 2;
      const lead = travel(security, leadStart, [[525, 450], [525, 150], [1100, 150]], "VIPをEVへご案内", 100);
      const clear = travel(security, lead, [[1100, 450]], "EV目的階呼出・乗車口を空ける", 100);
      const follow = travel(vip, leadStart + 3, [[225, 450], [525, 450], [525, 150], [1100, 150]], "警備と同行", 100);
      end = Math.max(clear, follow) + 6;
      note(0, 3, "建物カメラ：車番認識→VIP到着と判断（架空データ・模擬）", "#ffcb81");
      note(welcome, leadStart, "警備サイネージ：WELCOME / ご来館ありがとうございます", palette.security);
      note(leadStart, follow, "VIPと同行 · セキュリティ扉は通行許可と接近に連動", palette.security);
      note(follow, end, "建物へEV呼出要求 · VIPの目的階を指定（模擬）", palette.delivery);
    } else if (id === "garbage") {
      const cleaner = robot("cleaning", 225, 750);
      const arrive = travel(cleaner, 6, [[225, 450], [525, 450]], "カメラが指定したゴミ箇所へ");
      wait(cleaner, arrive, 6, "対象ゾーンのみ清掃");
      zone("dirt", 2, arrive + 6, "カメラ検知 · ゴミ位置", "#bc8b52", 425, 350, 200, 200);
      zone("scan", 0, 3, "AI CAMERA（模擬）", "#8daeff", 425, 350, 200, 200);
      end = travel(cleaner, arrive + 6, [[225, 450], [225, 750]], "清掃完了・帰還") + 4;
      note(2, arrive, "カメラがゴミ位置を検知 → 建物が対象座標を清掃へ通知", "#ffcb81");
      note(arrive, arrive + 6, "清掃中：対象ゾーンだけを清掃", palette.cleaning);
      note(arrive + 6, end, "清掃完了を建物へ通知 · 汚れ表示を解除", palette.cleaning);
    } else if (id === "learning") {
      const cleaner = robot("cleaning", 225, 750), security = robot("security", 1425, 150);
      const arrive = travel(cleaner, 6, [[225, 450], [525, 450]], "利用履歴から先回り清掃");
      const patrol = travel(security, 6, [[1425, 750], [1125, 750]], "巡回需要の高い場所へ役割切替");
      wait(cleaner, arrive, 5, "予測清掃");
      const repeat = travel(cleaner, arrive + 5, [[525, 150], [525, 450]], "高頻度ゾーンを再巡回");
      end = Math.max(patrol, repeat) + 5;
      zone("zone", 3, arrive, "蓄積データ：次の汚れを予測", "#ffcb81", 425, 350, 200, 200);
      zone("dirt", arrive, arrive + 5, "予測箇所の清掃", "#bc8b52", 425, 350, 200, 200);
      zone("zone", 6, end, "警備の重点巡回エリア", palette.security, 1000, 650, 250, 200);
      note(0, 6, "履歴蓄積→需要予測（説明用の模擬データ・実AI学習ではない）");
      note(6, end, "ルート変更・清掃頻度UP・警備の重点巡回へ役割配分を切替", palette.cleaning);
    } else if (id === "hospitality") {
      const delivery = robot("delivery", 225, 450);
      const arrive = travel(delivery, 6, [[525, 450], [525, 150], [1100, 150]], "回答に応じた案内先へ");
      end = arrive + 5;
      note(0, 3, "お客様への質問：どちらへご案内しますか？（自動再生の模擬回答）");
      note(3, 6, "回答：エレベータ · 案内先を個別にハイライト", palette.delivery);
      zone("zone", 3, end, "選択された案内先：EV", palette.delivery, 950, 300, 300, 300);
      routeCue(6, end, "回答に合わせた案内ルート", palette.delivery, [[225, 450], [525, 450], [525, 150], [1100, 150]]);
      note(6, end, "配送ロボットが対応ゾーンへ · 回答の実入力は次段階", palette.delivery);
    } else if (id === "environment") {
      const security = robot("security", 225, 150);
      let time = travel(security, 2, [[225, 450], [525, 450], [525, 150]], "環境データ収集巡回");
      for (const [x, y, label] of [[1425, 150, "温度高め"], [1425, 750, "CO2高め"], [525, 750, "快適"]]) {
        time = travel(security, time, [[x, y]], "環境測定地点へ");
        zone("scan", time, time + 3, `SCAN · ${label}（模擬）`, palette.security, x - 100, y - 100, 200, 200);
        note(time, time + 3, "ロボット＝動くセンサー · 環境データを建物へ通知", palette.security);
        zone("zone", time + 3, time + 7, "空調：データに応じて調整", palette.cleaning, x - 100, y - 100, 200, 200);
        wait(security, time, 4, "環境スキャン・空調連動"); time += 4;
      }
      end = time + 4;
      note(0, 2, "警備巡回と環境計測 · 実センサー・空調へは接続しない");
    } else if (id === "remote") {
      const delivery = robot("delivery", 1425, 150);
      const error = travel(delivery, 0, [[1425, 450]], "配送中");
      wait(delivery, error, 8, "ERROR · 遠隔就労者の対応待ち");
      zone("zone", error, error + 8, "ERROR / HELP", "#ff817b", 1300, 325, 250, 250);
      note(error, error + 4, "ERROR→遠隔就労者へ通知（模擬） · ロボット停止", "#ff817b");
      note(error + 4, error + 8, "REMOTE HUD  [↑↓←→]  CONNECTED（録画風・実操作不可）", "#64dcb2");
      const finish = travel(delivery, error + 8, [[1425, 750], [1125, 750]], "REMOTE: UP / LEFT");
      routeCue(error + 8, finish, "遠隔操作指示：↑ 次に ←（自動再生）", "#64dcb2",
        [[1425, 450], [1425, 750], [1125, 750]]);
      end = finish + 5;
      note(error + 8, finish, "遠隔就労者の指示で復旧する様子を自動再生（実通信なし）", "#64dcb2");
      note(finish, end, "復旧完了→自動運用へ復帰", palette.delivery);
    }
  }
  for (const track of map.tracks) for (const item of track.actions)
    if (item.type === "unlock") item.runSeconds = Math.min(item.runSeconds, end - item.position);
  map.presentation.cues = map.presentation.cues.filter(item => item.start < end)
    .map(item => ({ ...item, end: Math.min(item.end, end) }));
  note(0, end, "SIMULATION ONLY · 検知・判断・建物連携・遠隔操作は説明用の自動再生", "#b6c1cc");
  const clock = newTrack(map, "display");
  clock.name = "デモ終端・説明保持"; map.tracks.push(clock);
  wait(clock, 0, end, "シナリオ再生時間");
  return project;
}
