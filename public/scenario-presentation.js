const colors = /^#[0-9a-f]{6}$/i;
const kinds = ["zone", "dirt", "crowd", "fire", "scan", "route", "notice", "car"];

export function validatePresentation(value) {
  const require = (condition, message) => { if (!condition) throw new Error(message); };
  require(value && value.version === 1 && Array.isArray(value.cues) && value.cues.length <= 160,
    "シナリオ演出の形式または件数が不正です。");
  require(typeof value.scenarioId === "string" && /^[a-z0-9-]{1,60}$/.test(value.scenarioId),
    "シナリオIDが不正です。");
  for (const cue of value.cues) {
    require(cue && kinds.includes(cue.kind) && Number.isFinite(cue.start) &&
      Number.isFinite(cue.end) && cue.start >= 0 && cue.end > cue.start && cue.end <= 86400,
    "シナリオ演出の種類・時刻が不正です。");
    require(typeof cue.label === "string" && cue.label.length <= 180 && colors.test(cue.color),
      "シナリオ演出の表示文字・色が不正です。");
    if (cue.kind === "route") {
      require(Array.isArray(cue.points) && cue.points.length >= 2 && cue.points.length <= 40 &&
        cue.points.every(p => Array.isArray(p) && p.length === 2 &&
          Number.isFinite(p[0]) && p[0] >= 0 && p[0] <= 1600 &&
          Number.isFinite(p[1]) && p[1] >= 0 && p[1] <= 900),
      "ルート演出の座標が不正です。");
    } else if (cue.kind !== "notice") {
      const { x, y, width, height } = cue;
      require([x, y, width, height].every(Number.isFinite) && x >= 0 && y >= 0 &&
        width > 0 && height > 0 && x + width <= 1600 && y + height <= 900,
      "対象ゾーンの座標が不正です。");
    }
  }
  return value;
}

export function presentationAt(presentation, time) {
  return (presentation?.cues ?? []).filter(cue => cue.start <= time && time < cue.end);
}

const svg = (tag, attributes, text) => {
  const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  if (text !== undefined) element.textContent = text;
  return element;
};

export function renderPresentation(layer, presentation, time) {
  const cues = presentationAt(presentation, time);
  const stamp = JSON.stringify(cues);
  if (layer.dataset.stamp === stamp) return;
  layer.dataset.stamp = stamp;
  layer.replaceChildren();
  let notice = 0;
  for (const cue of cues) {
    const group = svg("g", { "data-scenario-cue": cue.kind, "pointer-events": "none" });
    const text = (x, y, value, size = 23) => svg("text", {
      x, y, fill: cue.color, "font-size": size, "font-weight": 700,
      stroke: "#121923", "stroke-width": 5, "paint-order": "stroke",
    }, value);
    if (cue.kind === "notice") {
      const y = 16 + notice++ * 39;
      group.append(svg("rect", { x: 16, y, width: 1568, height: 35, rx: 7,
        fill: "#101922", opacity: .9, stroke: cue.color }), text(30, y + 25, cue.label, 22));
    } else if (cue.kind === "route") {
      group.append(svg("polyline", { points: cue.points.map(([x, y]) => `${x},${900 - y}`).join(" "),
        fill: "none", stroke: cue.color, "stroke-width": 7, "stroke-dasharray": "16 10", opacity: .8 }));
      for (let i = 1; i < cue.points.length; i++) {
        const [x, y] = cue.points[i], [px, py] = cue.points[i - 1];
        const angle = -Math.atan2(y - py, x - px) * 180 / Math.PI;
        group.append(svg("path", { d: "M-22 -13L0 0L-22 13", fill: "none",
          stroke: cue.color, "stroke-width": 7, transform: `translate(${x} ${900 - y}) rotate(${angle})` }));
      }
      const [x, y] = cue.points[0];
      group.append(text(Math.min(x, 1000), 900 - y - 25, cue.label));
    } else {
      const y = 900 - cue.y - cue.height;
      group.append(svg("rect", { x: cue.x, y, width: cue.width, height: cue.height,
        fill: cue.color, "fill-opacity": .2, stroke: cue.color, "stroke-width": 5,
        "stroke-dasharray": cue.kind === "zone" ? "12 8" : "none", rx: 12 }));
      if (["dirt", "crowd", "fire", "scan"].includes(cue.kind)) {
        for (let i = 0; i < 12; i++) {
          const x = cue.x + cue.width * ((i * 7 % 13 + 1) / 14);
          const cy = y + cue.height * ((i * 5 % 11 + 1) / 12);
          group.append(svg(cue.kind === "scan" ? "path" : "circle",
            cue.kind === "scan" ? { d: `M${x - 15} ${cy}h30M${x} ${cy - 15}v30`,
              stroke: cue.color, "stroke-width": 3 } :
              { cx: x, cy, r: cue.kind === "crowd" ? 11 : 6 + i % 4 * 3,
                fill: cue.color, opacity: .75 }));
        }
      }
      if (cue.kind === "car") {
        group.append(svg("rect", { x: cue.x + 15, y: y + 25, width: cue.width - 30,
          height: Math.max(20, cue.height - 65), rx: 20, fill: "#263d55", stroke: cue.color,
          "stroke-width": 4 }));
      }
      const label = text(cue.x + 10, y + 25, "", 20);
      const capacity = Math.max(5, Math.floor((cue.width - 20) / 20));
      const characters = [...cue.label];
      for (let offset = 0; offset < characters.length; offset += capacity) {
        label.append(svg("tspan", { x: cue.x + 10, dy: offset ? 24 : 0 },
          characters.slice(offset, offset + capacity).join("")));
      }
      group.append(label);
    }
    layer.append(group);
  }
}
