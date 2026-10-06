/* Hero painting: reflex arcs converging on a single point of decision.
   p5.js 2 + p5.brush 2 in global mode (WEBGL). Painted progressively, then the loop stops. */

const HERO = {
  host: document.getElementById("hero-canvas"),
  reduce: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  INK: "#1b1813",
  GRAPHITE: "#4a4337",
  LILAC: "#9d86ff",
  PEACH: "#ff9f7d",
  ICE: "#6fc3dc",
  plan: [],
  cursor: 0,
  focal: { x: 0, y: 0 },
};

function setup() {
  const host = HERO.host;
  const w = host.clientWidth;
  const h = host.clientHeight;
  const canvas = createCanvas(w, h, WEBGL);
  canvas.parent(host);
  pixelDensity(Math.min(2, window.devicePixelRatio || 1));
  angleMode(DEGREES);
  randomSeed(11);
  noiseSeed(11);
  brush.load();
  brush.scaleBrushes(w < 760 ? 0.9 : 1.4);
  clear();
  HERO.focal = w < 760 ? { x: w * 0.72, y: h * 0.26 } : { x: w * 0.7, y: h * 0.44 };
  HERO.plan = heroPlan(w, h);
  if (HERO.reduce) {
    paintSteps(HERO.plan.length);
    noLoop();
  }
}

function draw() {
  paintSteps(2); // ~1 s to paint at 60 fps: slow enough to watch it happen
  if (HERO.cursor >= HERO.plan.length) noLoop();
}

function paintSteps(n) {
  push();
  translate(-width / 2, -height / 2);
  for (let i = 0; i < n && HERO.cursor < HERO.plan.length; i++) HERO.plan[HERO.cursor++]();
  pop();
}

/** The painting, as a list of deferred strokes (a few drawn per frame). */
function heroPlan(w, h) {
  const { INK, GRAPHITE, LILAC, PEACH, ICE, focal } = HERO;
  const steps = [];
  const R = Math.min(w, h);

  // 2. Reflex arcs: long field-bent strokes sweeping in toward the focal point.
  const arcs = w < 760 ? 30 : 58;
  for (let i = 0; i < arcs; i++) {
    steps.push(() => {
      // Start on a wide arc left of the focal point, mostly clear of the headline.
      const a0 = radians(random(150, 215));
      const r0 = random(0.36, 0.8) * Math.min(focal.x, w * 0.72);
      const sx = focal.x + Math.cos(a0) * r0;
      const sy = focal.y + Math.sin(a0) * r0 * 0.9;
      const ang = degrees(Math.atan2(focal.y - sy, focal.x - sx));
      const len = dist(sx, sy, focal.x, focal.y) * random(0.55, 1.02);
      const which = random(["HB", "2B", "HB", "cpencil", "charcoal"]);
      const col = random() < 0.12 ? random([LILAC, PEACH, ICE]) : random([GRAPHITE, INK, GRAPHITE]);
      brush.field(random(["curved", "waves", "hand"]));
      brush.set(which, col, random(0.5, 1.2));
      brush.flowLine(sx, sy, len, -ang);
      brush.noField();
    });
  }

  // 3. Concentric hand-drawn rings: the moment of decision.
  for (let k = 0; k < 6; k++) {
    steps.push(() => {
      brush.noFill();
      brush.set(k % 2 ? "pen" : "HB", k === 0 ? INK : GRAPHITE, k === 0 ? 1.2 : 0.7);
      brush.wiggle(0.6);
      brush.circle(focal.x, focal.y, 14 + k * k * 9 + random(-3, 3));
      brush.wiggle(0);
    });
  }

  // 4. Short tick marks orbiting the rings, like a seismograph of choices.
  for (let i = 0; i < 46; i++) {
    steps.push(() => {
      const a = random(0, 360);
      const r1 = random(70, 0.34 * R);
      const x = focal.x + Math.cos(radians(a)) * r1;
      const y = focal.y + Math.sin(radians(a)) * r1;
      brush.set("2H", GRAPHITE, 0.6);
      brush.line(x, y, x + random(-14, 14), y + random(-14, 14));
    });
  }

  // 5. The reflex itself: one dense ink dot.
  steps.push(() => {
    noStroke();
    fill(INK);
    circle(focal.x, focal.y, 12);
  });
  return steps;
}
