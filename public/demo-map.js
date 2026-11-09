import { createProject, newAction, newTrack, uid, addFacingTurns } from "./model.js";
import { GRID_COLUMNS, GRID_ROWS, regionBounds } from "./floor-plan.js";

const cellAt = (column, row) => (GRID_ROWS - row - 1) * GRID_COLUMNS + column;
const cellsIn = (columns, rows) => {
  const cells = [];
  for (const row of rows) for (const column of columns) cells.push(cellAt(column, row));
  return cells.sort((a, b) => a - b);
};
const range = (start, end) => Array.from({ length: end - start + 1 }, (_, index) => start + index);
const makeRoom = (name, kind, material, cells, color) => ({
  id: uid(), name, kind, material, cells, ...regionBounds(cells), color,
});

export function replaceOldDemoMaps(project) {
  const legacyNames = ["マップ 1 · テスト", "最新テスト · 人物5人", "Smart Building Fleet Demo"];
  const old = project.maps.filter(map => !map.demoRevision && legacyNames.includes(map.name));
  if (!old.length) return false;
  const current = project.maps.find(map => map.demoRevision === 1);
  const replacement = current ?? createFleetDemoMap().maps[0];
  const first = project.maps.indexOf(old[0]);
  project.maps = project.maps.filter(map => !old.includes(map));
  if (!current) project.maps.splice(first, 0, replacement);
  return true;
}

function addAction(map, track, type, properties) {
  const action = newAction(map, track, type);
  Object.assign(action, {
    ...properties,
    dwell: 0,
  });
  track.actions.push(action);
  return action;
}

function addMove(map, track, name, position, runSeconds, x, y, roomId, options = {}) {
  return addAction(map, track, "move", {
    name, position, runSeconds, x, y, roomId, ...options,
  });
}

export function createFleetDemoMap({ legacy = false } = {}) {
  const project = createProject({ ordered: true });
  const map = project.maps[0];
  project.schema = "robot-scene/v4";
  project.name = "Fleet Demo";

  const entrance = makeRoom("Entrance Hall", "room", "tile",
    cellsIn(range(0, 7), range(0, 17)), "#d8d1bd");
  entrance.appearance = "continuing-hall";
  const corridorCells = new Set([
    ...cellsIn(range(8, 25), range(0, 5)),
    ...cellsIn(range(26, 31), range(0, 12)),
    ...cellsIn(range(16, 25), range(8, 12)),
  ]);
  const corridor = makeRoom("Z Corridor", "corridor", "concrete",
    [...corridorCells], "#bac5c1");
  const wc = makeRoom("WC", "room", "tile", cellsIn(range(13, 17), range(13, 17)), "#b8c5c7");
  const meetingOne = makeRoom("Meeting Room 1", "room", "carpet",
    cellsIn(range(8, 15), range(6, 12)), "#c9b8a5");
  const meetingTwo = makeRoom("Meeting Room 2", "room", "carpet",
    cellsIn(range(8, 12), range(13, 17)), "#c9b8a5");
  const elevator = makeRoom("EV", "room", "tile",
    cellsIn(range(18, 23), range(13, 17)), "#c3cdd0");
  elevator.appearance = "elevator";
  const securityBay = makeRoom("Security Waiting Bay", "room", "concrete",
    cellsIn(range(24, 31), range(13, 17)), "#aebdb6");
  const lounge = makeRoom("Lounge", "room", "wood",
    cellsIn(range(16, 25), range(6, 7)), "#d7c9ae");

  map.id = uid();
  map.name = "テストマップ";
  map.demoRevision = 1;
  map.executionMode = "timed";
  map.timelineOnly = true;
  map.rooms = [entrance, corridor, wc, meetingOne, meetingTwo, elevator, securityBay, lounge];
  const doorsFor = (roomId, cells) => cells.map(({ cell, edge }) => ({ id: uid(), roomId, cell, edge }));
  const upperRows = range(8, 12);
  map.floorPlan = {
    doors: [
      ...doorsFor(corridor.id, [
        ...range(0, 5).map(row => ({ cell: cellAt(8, row), edge: "left" })),
      ]),
      ...doorsFor(meetingOne.id, [
        ...upperRows.map(row => ({ cell: cellAt(8, row), edge: "left" })),
        ...upperRows.map(row => ({ cell: cellAt(15, row), edge: "right" })),
      ]),
      ...doorsFor(meetingTwo.id, range(13, 17).map(row => ({
        cell: cellAt(8, row), edge: "left",
      }))),
      ...doorsFor(elevator.id, range(18, 23).map(column => ({
        cell: cellAt(column, 13), edge: "bottom",
      }))),
      ...doorsFor(securityBay.id, range(26, 31).map(column => ({
        cell: cellAt(column, 13), edge: "bottom",
      }))),
      ...doorsFor(lounge.id, range(18, 22).map(column => ({
        cell: cellAt(column, 6), edge: "bottom",
      }))),
      ...doorsFor(wc.id, range(16, 17).map(column => ({
        cell: cellAt(column, 13), edge: "bottom",
      }))),
    ],
    furniture: [],
    chargingZones: [
      { id: uid(), name: "Cleaner Charging", x: 50, y: 50, width: 250, height: 250 },
      { id: uid(), name: "Security Charging", x: 1300, y: 650, width: 250, height: 250 },
    ],
  };
  const furnish = (room, type, columns, rows, rotation = 0) => {
    const cells = cellsIn(columns, rows);
    map.floorPlan.furniture.push({ id: uid(), roomId: room.id, type, cell: cells[0], cells, rotation });
  };
  furnish(meetingOne, "desk", range(9, 12), range(6, 7));
  furnish(meetingOne, "chair", [8], [7]);
  furnish(meetingOne, "chair", [13], [7], 180);
  furnish(meetingOne, "plant", [15], [6]);
  furnish(meetingTwo, "desk", range(10, 11), range(14, 15));
  furnish(meetingTwo, "chair", [9], [14]);
  furnish(meetingTwo, "chair", [12], [15], 180);
  furnish(entrance, "chair", range(0, 2), [0]);
  furnish(entrance, "chair", range(0, 2), [15]);
  furnish(entrance, "plant", range(0, 1), range(8, 9));
  furnish(entrance, "plant", [6], [16]);
  furnish(lounge, "chair", range(18, 21), [6]);
  furnish(lounge, "plant", [25], [6]);
  map.tracks = [];

  const security = newTrack(map, "robot");
  Object.assign(security, {
    name: "Security Robot", robotRole: "security",
    initial: { x: 1425, y: 175, yaw: 90, roomId: corridor.id },
  });
  map.tracks.push(security);

  const cleaner = newTrack(map, "robot");
  Object.assign(cleaner, {
    name: "Cleaning Robot", robotRole: "cleaning",
    initial: { x: 175, y: 175, yaw: 0, roomId: entrance.id },
  });
  map.tracks.push(cleaner);

  const attendees = newTrack(map, "human");
  Object.assign(attendees, { name: "人間 · 会議参加者（5人）", count: 5,
    initial: { x: 175, y: 525, yaw: 0, roomId: entrance.id } });
  map.tracks.unshift(attendees);
  addMove(map, attendees, "Enter Meeting Room 1", 0, 5, 525, 525, meetingOne.id);
  addMove(map, attendees, "Leave after the meeting", 24, 5, 175, 525, entrance.id);
  const meeting = newTrack(map, "room");
  meeting.name = "Meeting Room 1 Occupancy";
  meeting.roomId = meetingOne.id;
  map.tracks.push(meeting);

  addAction(map, meeting, "event-start", {
    name: "Meeting in progress (5 attendees)", position: 5, runSeconds: 19, x: 525, y: 525,
    roomId: meetingOne.id, text: "Meeting in progress",
  });
  addAction(map, meeting, "event-end", {
    name: "Meeting ends", position: 29, runSeconds: 1, x: 525, y: 525,
    roomId: meetingOne.id, text: "Meeting complete",
  });
  const unlock = (room, position, duration) => {
    const track = newTrack(map, "room");
    track.name = `${room.name} Doors`; track.roomId = room.id; map.tracks.push(track);
    addAction(map, track, "unlock", { name: `${room.name}解錠`,
      position, runSeconds: duration, roomId: room.id });
  };
  unlock(meetingOne, 0, 100);
  unlock(corridor, 38, 67);
  unlock(securityBay, 31, 9);

  addMove(map, security, "Yield: clear the shared corridor",
    32, 3, 1425, 525, corridor.id);
  addMove(map, security, "Face the waiting bay",
    35, 1, 1425, 525, corridor.id, {
      motion: "rotate", yaw: 90, angularSpeed: 90, rotationSeconds: 1,
    });
  addMove(map, security, "Enter the waiting bay",
    36, 2.5, 1425, 775, securityBay.id);

  let time = 39;
  const step = (duration) => {
    const position = time;
    time += duration;
    return position;
  };
  const move = (name, duration, x, y, roomId, options) =>
    addMove(map, cleaner, name, step(duration), duration, x, y, roomId, options);
  const rotate = (name, duration, yaw) => addMove(map, cleaner, name,
    step(duration), duration, cleaner.actions.at(-1)?.x ?? cleaner.initial.x,
    cleaner.actions.at(-1)?.y ?? cleaner.initial.y,
    cleaner.actions.at(-1)?.roomId ?? entrance.id,
    { motion: "rotate", yaw, angularSpeed: 90, rotationSeconds: duration });

  move("Follow the lower corridor east", 11, 1425, 175, corridor.id);
  rotate("Turn north at bend 1", 1, 90);
  move("Follow the vertical corridor north", 3, 1425, 525, corridor.id);
  rotate("Turn west at bend 2", 1, 180);
  move("Enter Meeting Room 1", 9.5, 625, 525, meetingOne.id);
  addAction(map, cleaner, "wait", {
    name: "Clean Meeting Room 1", position: step(12), runSeconds: 12,
    x: 625, y: 525, roomId: meetingOne.id,
  });
  rotate("Face the return corridor", 2, 0);
  move("Return east along the upper corridor", 9.5, 1425, 525, corridor.id);
  rotate("Turn south", 1, -90);
  move("Follow the vertical corridor south", 3, 1425, 175, corridor.id);
  rotate("Turn west toward charging", 1, 180);
  move("Return to the charging bay", 11, 175, 175, entrance.id);

  if (!legacy) compactDemo(map);
  return project;
}

function compactDemo(map) {
  const schedule = {
    "Enter Meeting Room 1": [0, 3],
    "Leave after the meeting": [5, 3],
    "Meeting in progress (5 attendees)": [3, 2],
    "Meeting ends": [8, 1],
    "Meeting Room 1解錠": [0, 54],
    "Z Corridor解錠": [14, 40],
    "Security Waiting Bay解錠": [7, 9],
    "Yield: clear the shared corridor": [8, 3],
    "Face the waiting bay": [11, 1],
    "Enter the waiting bay": [12, 2.5],
  };
  const cleaner = map.tracks.find(track => track.robotRole === "cleaning");
  let time = 15;
  for (const action of cleaner.actions) {
    const duration = action.runSeconds === 11 ? 7 : action.runSeconds === 9.5 ? 6 :
      action.runSeconds === 12 ? 3 : action.runSeconds === 3 ? 2 : action.runSeconds;
    Object.assign(action, { position: time, runSeconds: duration });
    time += duration;
  }
  for (const track of map.tracks.filter(track => track !== cleaner)) {
    for (const action of track.actions) {
      const timing = schedule[action.name];
      if (timing) [action.position, action.runSeconds] = timing;
    }
  }
  clearChargingSeats(map);
  map.demoScenarioRevision = 2;
}

function clearChargingSeats(map) {
  const hall = map.rooms.find(room => room.name === "Entrance Hall");
  const seats = new Set(cellsIn(range(0, 2), [15]));
  if (hall) map.floorPlan.furniture = map.floorPlan.furniture.filter(item =>
    !(item.roomId === hall.id && item.type === "chair" &&
      item.cells?.length === 3 && item.cells.every(cell => seats.has(cell))));
}

export function refreshDemoScenarios(project) {
  const targets = project.maps.filter(map => map.demoRevision === 1 && !map.demoScenarioRevision);
  if (!targets.length) return false;
  const original = createFleetDemoMap({ legacy: true }).maps[0];
  const updated = createFleetDemoMap().maps[0];
  for (const map of targets) {
    // 一部だけ時刻を更新すると、利用者が編集したバーと重なるため全体を保持する。
    const unchanged = map.tracks.length === original.tracks.length && map.tracks.every(track => {
      const before = original.tracks.find(item => item.name === track.name);
      return before && before.actions.length === track.actions.length && track.actions.every(action =>
        before.actions.some(old => old.name === action.name &&
          old.position === action.position && old.runSeconds === action.runSeconds));
    });
    for (const track of unchanged ? map.tracks : []) {
      const before = original.tracks.find(item => item.name === track.name);
      const after = updated.tracks.find(item => item.name === track.name);
      if (!before || !after) continue;
      for (const action of track.actions) {
        const old = before.actions.find(item => item.name === action.name);
        const next = after.actions.find(item => item.name === action.name);
        if (old && next && action.position === old.position && action.runSeconds === old.runSeconds)
          Object.assign(action, { position: next.position, runSeconds: next.runSeconds });
      }
    }
    clearChargingSeats(map);
    map.demoScenarioRevision = 2;
  }
  return true;
}

export function createOfficeDemoMap() {
  const project = createProject({ ordered: true }), map = project.maps[0];
  project.schema = "robot-scene/v4";
  Object.assign(map, {
    name: "テストマップ 2 · オフィス（社員・ゲスト）", officeDemoRevision: 2, facingTurns: true,
    executionMode: "timed", timelineOnly: true, tracks: [],
  });
  const room = (name, kind, material, columns, rows, color) =>
    makeRoom(name, kind, material, cellsIn(range(...columns), range(...rows)), color);
  const reception = room("Reception", "room", "tile", [0, 7], [0, 17], "#d8d1bd");
  const corridor = room("Central Corridor", "corridor", "tile", [8, 31], [6, 11], "#c4cec9");
  const meeting = room("Meeting Room", "room", "carpet", [8, 19], [12, 17], "#c9b8a5");
  const office = room("Open Office", "room", "carpet", [20, 31], [12, 17], "#b9c9c5");
  const elevator = room("EV", "room", "tile", [8, 13], [0, 5], "#c3cdd0");
  elevator.appearance = "elevator";
  const charging = room("Robot Station", "room", "concrete", [14, 19], [0, 5], "#adbbb6");
  const workroom = room("Workroom", "room", "wood", [20, 31], [0, 5], "#d7c9ae");
  map.rooms = [reception, corridor, meeting, office, elevator, charging, workroom];
  const door = (target, columns, row, edge) => columns.map(column =>
    ({ id: uid(), roomId: target.id, cell: cellAt(column, row), edge }));
  map.floorPlan = {
    doors: [
      ...range(6, 11).map(row =>
        ({ id: uid(), roomId: corridor.id, cell: cellAt(8, row), edge: "left" })),
      ...door(meeting, range(12, 16), 12, "bottom"),
      ...door(office, range(24, 28), 12, "bottom"),
      ...door(elevator, range(8, 12), 5, "top"),
      ...door(charging, range(14, 18), 5, "top"),
      ...door(workroom, range(24, 28), 5, "top"),
    ],
    furniture: [],
    chargingZones: [{ id: uid(), name: "ROBOT DOCK", x: 725, y: 50, width: 200, height: 200 }],
  };
  const furniture = (target, type, columns, rows, rotation = 0) => {
    const cells = cellsIn(columns, rows);
    map.floorPlan.furniture.push({
      id: uid(), roomId: target.id, type, cells, cell: cells[0], rotation,
    });
  };
  furniture(reception, "desk", range(0, 2), range(12, 14));
  furniture(reception, "chair", [1], [15]);
  furniture(reception, "chair", [0], [3]);
  furniture(reception, "chair", [0], [4]);
  furniture(reception, "plant", [0], [17]);
  furniture(meeting, "desk", range(12, 16), [17]);
  furniture(meeting, "chair", [11], [17], 90);
  furniture(meeting, "chair", [17], [17], 270);
  for (const column of [21, 25, 29]) {
    furniture(office, "desk", [column, column + 1], [17]);
    if (column !== 25) furniture(office, "chair", [column], [16]);
    furniture(workroom, "desk", [column, column + 1], [0]);
    furniture(workroom, "chair", [column], [1], 180);
  }
  const actor = (kind, name, x, y, target, role) => {
    const track = newTrack(map, kind);
    Object.assign(track, { name, count: 1, initial: { x, y, yaw: 0, roomId: target.id } });
    if (role) track.robotRole = role;
    map.tracks.push(track);
    return track;
  };
  const person = actor("human", "社員 · 受付から会議室へ案内", 225, 575, reception);
  const guests = actor("human", "ゲスト · 来訪者3名", 225, 625, reception);
  guests.count = 3;
  const cleaner = actor("robot", "清掃 · 会議後に出動", 825, 175, charging, "cleaning");
  const security = actor("robot", "警備 · 廊下を先に通過", 225, 425, reception, "security");
  addMove(map, person, "会議室前へ", 0, 3, 725, 475, corridor.id);
  addMove(map, person, "入室", 3, 2, 725, 725, meeting.id);
  addMove(map, person, "会議後に退室", 7.5, 2, 725, 475, corridor.id);
  addMove(map, person, "受付へお見送り", 10, 3, 225, 575, reception.id);
  addMove(map, guests, "社員の案内で会議室前へ", .5, 3, 775, 425, corridor.id);
  addMove(map, guests, "社員に続いて入室", 3.5, 2, 775, 725, meeting.id);
  addMove(map, guests, "会議後に退室", 8, 2, 775, 425, corridor.id);
  addMove(map, guests, "受付へ戻る", 10.5, 3, 175, 625, reception.id);
  const events = newTrack(map, "room");
  Object.assign(events, { name: "会議室 · 利用状況", roomId: meeting.id });
  map.tracks.push(events);
  addAction(map, events, "event-start", { name: "会議（2秒）", position: 5.5, runSeconds: 2,
    x: 725, y: 725, roomId: meeting.id, text: "Meeting" });
  addAction(map, events, "event-end", { name: "退室完了", position: 10, runSeconds: 1,
    x: 725, y: 725, roomId: meeting.id, text: "Ready for cleaning" });
  addMove(map, security, "警備巡回 · 清掃は充電所で待機", 14, 6, 1325, 425, corridor.id);
  addMove(map, security, "執務室へ待避", 20, 2, 1325, 725, office.id);
  addMove(map, cleaner, "警備の通過後に廊下へ", 22, 2, 825, 425, corridor.id);
  addMove(map, cleaner, "会議室前へ移動", 24, 1, 725, 425, corridor.id);
  addMove(map, cleaner, "会議室へ入る", 25, 2, 725, 725, meeting.id);
  addAction(map, cleaner, "wait", { name: "清掃（3秒）", position: 27, runSeconds: 3 });
  addMove(map, cleaner, "清掃完了 · 廊下へ", 30, 2, 725, 425, corridor.id);
  addMove(map, cleaner, "充電所前へ", 32, 1, 825, 425, corridor.id);
  addMove(map, cleaner, "充電所へ帰還", 33, 2, 825, 175, charging.id);
  for (const [target, start, duration] of [[corridor, 0, 36], [meeting, 0, 33],
    [office, 19, 5], [charging, 21, 15]]) {
    const track = newTrack(map, "room");
    Object.assign(track, { name: `${target.name} Doors`, roomId: target.id });
    map.tracks.push(track);
    addAction(map, track, "unlock", { name: `${target.name}解錠`,
      position: start, runSeconds: duration, roomId: target.id });
  }
  addFacingTurns(map);
  return project;
}

export function createCoordinationDemoMap(kind) {
  if (!["fire", "yield", "conflict"].includes(kind))
    throw new TypeError(`Unknown coordination demo: ${kind}`);
  const project = createOfficeDemoMap();
  const map = project.maps[0];
  const room = name => map.rooms.find(item => item.name === name);
  const corridor = room("Central Corridor");
  const meeting = room("Meeting Room");
  const charging = room("Robot Station");
  const office = room("Open Office");
  map.name = kind === "conflict" ? "競合例 · シミュレーション専用" :
    `Coordination Demo · ${kind}`;
  map.coordinationDemo = kind;
  if (kind === "conflict") map.simulationOnly = true;
  map.tracks = [];

  const robot = (name, role, x, y, yaw, location) => {
    const track = newTrack(map, "robot");
    Object.assign(track, {
      name, robotRole: role, initial: { x, y, yaw, roomId: location.id },
    });
    map.tracks.push(track);
    return track;
  };
  const cleaner = kind === "fire" ?
    robot("Cleaning Robot", "cleaning", 725, 725, -90, meeting) :
    robot("Cleaning Robot", "cleaning", 725, 425, 90, corridor);
  const security = kind === "fire" ?
    robot("Security Robot", "security", 825, 175, 90, charging) :
    robot("Security Robot", "security", 1325, 425, 180, corridor);

  if (kind === "fire") {
    const alarm = newTrack(map, "room");
    Object.assign(alarm, { name: "Meeting Room Fire Alarm", roomId: meeting.id });
    map.tracks.push(alarm);
    addAction(map, alarm, "event-start", {
      name: "Fire reported", position: 0, runSeconds: 30,
      x: 725, y: 725, roomId: meeting.id, state: "fire", text: "Fire reported",
    });
    addMove(map, cleaner, "Retreat from the fire to the corridor", 0, 3,
      725, 425, corridor.id);
    addMove(map, cleaner, "Continue retreat to reception", 3, 5,
      225, 425, room("Reception").id);
    addMove(map, security, "Respond through the corridor", 12, 2.5,
      825, 425, corridor.id);
    addMove(map, security, "Approach the meeting room", 14.5, 1,
      725, 425, corridor.id);
    addMove(map, security, "Enter the meeting room", 15.5, 3,
      725, 725, meeting.id);
  } else {
    addMove(map, cleaner, "Retreat into the meeting room", 0, 3,
      725, 725, meeting.id);
    addAction(map, cleaner, "wait", {
      name: kind === "conflict" ? "Simulation only: unsafe corridor wait" :
        "Wait while security clears the corridor",
      position: 3, runSeconds: kind === "conflict" ? 4 : 34,
      x: 725, y: 725, roomId: meeting.id,
    });
    addMove(map, cleaner, "Return to the corridor", kind === "conflict" ? 9 : 42, 3,
      725, 425, corridor.id);
    addMove(map, cleaner, "Return to the robot station approach", kind === "conflict" ? 15 : 45, 1,
      825, 425, corridor.id);
    addMove(map, cleaner, "Return to the robot station", kind === "conflict" ? 16 : 46, 2.5,
      825, 175, charging.id);

    addAction(map, security, "wait", {
      name: "Wait for cleaning robot to retreat", position: 0, runSeconds: 6,
      x: 1325, y: 425, roomId: corridor.id,
    });
    addMove(map, security, "Pass west through the shared corridor", 6, 5,
      825, 425, corridor.id);
    addMove(map, security, "Continue west through the shared corridor", 11, 4,
      425, 425, corridor.id);
    addMove(map, security, "Clear the corridor near the office door", 15, 9,
      1325, 425, corridor.id);
    addMove(map, security, "Retreat into the open office", 24, 3,
      1325, 725, office.id);
  }

  addFacingTurns(map);
  const doors = kind === "fire" ?
    [room("Reception"), corridor, meeting, charging] :
    [corridor, meeting, charging, office];
  for (const target of doors) {
    const controls = newTrack(map, "room");
    Object.assign(controls, { name: `${target.name} Doors`, roomId: target.id });
    map.tracks.push(controls);
    addAction(map, controls, "unlock", {
      name: `${target.name} unlocked`, position: 0,
      runSeconds: kind === "fire" ? 33 : 60, roomId: target.id,
    });
  }
  return project;
}
