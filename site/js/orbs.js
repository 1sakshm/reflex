/* Thinking orbs (github.com/Jakubantalik/thinking-orbs, MIT) via its framework-free engine.
   Every <canvas data-orb="state" data-orb-size="px"> becomes a live orb, animated only while visible. */
import { MODE_DRAWS, resolvePreset } from "https://cdn.jsdelivr.net/npm/thinking-orbs@0.3.2/dist/engine.es.js";

const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const dpr = Math.min(2, window.devicePixelRatio || 1);
const orbs = [];

for (const canvas of document.querySelectorAll("canvas[data-orb]")) {
  const state = canvas.dataset.orb;
  const cssSize = Number(canvas.dataset.orbSize || 64);
  // Presets exist for 20 and 64; the big orbs use the detailed 64 profile, drawn larger.
  const { mode, speed, opts } = resolvePreset(state, cssSize <= 32 ? 20 : 64);
  const draw = MODE_DRAWS[mode];
  if (!draw) continue;
  canvas.width = cssSize * dpr;
  canvas.height = cssSize * dpr;
  canvas.style.width = cssSize + "px";
  canvas.style.height = cssSize + "px";
  const ctx = canvas.getContext("2d");
  const dark = !!canvas.closest(".section--dark, .closing");
  orbs.push({ canvas, ctx, draw, speed, opts, cssSize, dark, visible: false, offset: Math.random() * 10 });
}

const io = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      const orb = orbs.find((o) => o.canvas === entry.target);
      if (orb) orb.visible = entry.isIntersecting;
    }
  },
  { rootMargin: "120px" },
);
orbs.forEach((orb) => io.observe(orb.canvas));

function paint(orb, t) {
  const { ctx, cssSize } = orb;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssSize, cssSize);
  orb.draw(ctx, cssSize, (t + orb.offset) * orb.speed, orb.dark, orb.opts);
}

if (reduce) {
  orbs.forEach((orb) => paint(orb, 2));
} else {
  const start = performance.now();
  const frame = (now) => {
    const t = (now - start) / 1000;
    for (const orb of orbs) if (orb.visible) paint(orb, t);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
