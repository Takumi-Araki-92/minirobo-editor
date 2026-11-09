import test from "node:test";
import assert from "node:assert/strict";
import { automaticDoorOpenness, ROBOT_SIDE } from "../public/floor-plan.js";

const horizontal = { x1: 500, y1: 450, x2: 800, y2: 450 };
const vertical = { x1: 650, y1: 300, x2: 650, y2: 600 };

test("automatic doors detect robots and humans from both sides in world coordinates", () => {
  for (const kind of ["human", "robot"]) {
    for (const sign of [-1, 1]) {
      assert.equal(automaticDoorOpenness(horizontal, [{ kind, x: 650, y: 450 + sign * 100 }]), 1);
      assert.equal(automaticDoorOpenness(vertical, [{ kind, x: 650 + sign * 100, y: 450 }]), 1);
      assert.equal(automaticDoorOpenness(horizontal, [{ kind, x: 650, y: 450 + sign * 500 }]), 0);
    }
  }
});

test("door sensor uses footprint clearance, opens progressively and stays open during passage", () => {
  const radius = Math.SQRT2 * ROBOT_SIDE / 2;
  for (const [kind, size] of [["robot", radius], ["human", 20]]) {
    const actor = distance => [{ kind, x: 650, y: 450 + distance }];
    assert.equal(automaticDoorOpenness(horizontal, actor(size + 200)), 0);
    assert.ok(Math.abs(automaticDoorOpenness(horizontal, actor(size + 150)) - .5) < 1e-10);
    assert.ok(Math.abs(automaticDoorOpenness(horizontal, actor(size + 100)) - 1) < 1e-10);
    assert.equal(automaticDoorOpenness(horizontal, actor(0)), 1);
  }
});

test("empty, removed and distant actors close the door; the nearest actor holds it open", () => {
  assert.equal(automaticDoorOpenness(horizontal, []), 0);
  assert.equal(automaticDoorOpenness(horizontal, [{ kind: "display", x: 650, y: 450 }]), 0);
  assert.equal(automaticDoorOpenness(horizontal, [
    { kind: "robot", x: 50, y: 50 }, { kind: "human", x: 650, y: 450 },
  ]), 1);
  assert.equal(automaticDoorOpenness(horizontal, [{ kind: "human", x: 100, y: 450 }]), 0);
});
