// Theme effects drawn on the two canvases around the Cytoscape map (themes.css --sky, --orbits):
// - a starfield or fireflies on the canvas behind the map, shifted with the map and the pointer for parallax;
// - in the space theme, stars orbiting each system on a tilted ring. The half of each ring behind the system is
//   drawn on the canvas under the map and the half in front on the canvas over it, so the stars pass behind and
//   in front of their system.
// Every draw takes `animate`: false (reduced motion) draws one still frame, with no twinkle or drift.

const TAU = Math.PI * 2;
const mod = (a, n) => ((a % n) + n) % n;

function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeSky(kind) {
  if (kind === 'stars') return starfield();
  if (kind === 'fireflies') return fireflies();
  return null;
}

// Three layers: many faint far stars that barely move, fewer brighter near ones that move most.
const STAR_TINTS = ['255,255,255', '255,255,255', '207,224,255', '255,233,196', '255,214,226'];
const STAR_LAYERS = [
  { count: 240, size: [0.4, 0.9], alpha: [0.25, 0.65], depth: 0.04, twinkle: 0.45 },
  { count: 90, size: [0.8, 1.4], alpha: [0.45, 0.85], depth: 0.1, twinkle: 0.3 },
  { count: 32, size: [1.3, 2.1], alpha: [0.7, 1], depth: 0.22, twinkle: 0.15 },
];

function starfield() {
  const r = rng(20261017);
  const between = ([a, b]) => a + (b - a) * r();
  const layers = STAR_LAYERS.map((layer) => ({
    ...layer,
    stars: Array.from({ length: layer.count }, () => ({
      x: r(), y: r(), size: between(layer.size), alpha: between(layer.alpha),
      tint: STAR_TINTS[Math.floor(r() * STAR_TINTS.length)], phase: r() * TAU, speed: 0.6 + r() * 1.4,
    })),
  }));
  let meteor = null;
  let nextMeteor = 5000;
  return {
    draw(g, w, h, now, off, animate) {
      for (const layer of layers) {
        const ox = off.x * layer.depth;
        const oy = off.y * layer.depth;
        for (const s of layer.stars) {
          const twinkle = animate ? 1 - layer.twinkle * (0.5 + 0.5 * Math.sin(now * 0.001 * s.speed + s.phase)) : 1;
          g.fillStyle = `rgba(${s.tint},${(s.alpha * twinkle).toFixed(3)})`;
          g.beginPath();
          g.arc(mod(s.x * w + ox, w), mod(s.y * h + oy, h), s.size, 0, TAU);
          g.fill();
        }
      }
      if (!animate) return;
      // Now and then, a shooting star.
      if (!meteor && now > nextMeteor) meteor = { t0: now, x: r() * w * 0.7, y: r() * h * 0.4, len: 110 + r() * 120, angle: Math.PI * (0.16 + r() * 0.12) };
      if (!meteor) return;
      const p = (now - meteor.t0) / 900;
      if (p >= 1) { meteor = null; nextMeteor = now + 7000 + r() * 9000; return; }
      const dx = Math.cos(meteor.angle);
      const dy = Math.sin(meteor.angle);
      const hx = meteor.x + dx * p * 420;
      const hy = meteor.y + dy * p * 420;
      const tail = g.createLinearGradient(hx - dx * meteor.len, hy - dy * meteor.len, hx, hy);
      tail.addColorStop(0, 'rgba(255,255,255,0)');
      tail.addColorStop(1, `rgba(255,255,255,${(0.85 * Math.sin(p * Math.PI)).toFixed(3)})`);
      g.strokeStyle = tail;
      g.lineWidth = 1.6;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(hx - dx * meteor.len, hy - dy * meteor.len);
      g.lineTo(hx, hy);
      g.stroke();
    },
  };
}

// Fireflies drift on slow loops and blink at their own pace; nearer ones are bigger and move more with the map.
function fireflies() {
  const r = rng(7031);
  const flies = Array.from({ length: 48 }, () => ({
    x: r(), y: 0.2 + r() * 0.8, depth: 0.3 + r() * 0.7, phase: r() * TAU,
    fx: 0.00011 + r() * 0.00016, fy: 0.00009 + r() * 0.00014, amp: 0.02 + r() * 0.04,
    blink: 0.0008 + r() * 0.0012, tint: r() < 0.7 ? '242,233,120' : '190,240,120',
  }));
  return {
    draw(g, w, h, now, off, animate) {
      const t = animate ? now : 0;
      for (const f of flies) {
        const glow = animate ? Math.max(0, Math.sin(t * f.blink + f.phase)) ** 2 : 0.45;
        if (glow < 0.02) continue;
        const x = mod(f.x * w + Math.sin(t * f.fx + f.phase) * f.amp * w + off.x * 0.15 * f.depth, w);
        const y = mod(f.y * h + Math.cos(t * f.fy + f.phase * 1.3) * f.amp * h + off.y * 0.15 * f.depth, h);
        const radius = (2 + 6 * f.depth) * 2.2;
        const light = g.createRadialGradient(x, y, 0, x, y, radius);
        light.addColorStop(0, `rgba(${f.tint},${(0.95 * glow).toFixed(3)})`);
        light.addColorStop(0.25, `rgba(${f.tint},${(0.45 * glow).toFixed(3)})`);
        light.addColorStop(1, `rgba(${f.tint},0)`);
        g.fillStyle = light;
        g.beginPath();
        g.arc(x, y, radius, 0, TAU);
        g.fill();
      }
    },
  };
}

// One star per line a system has (up to 10), coloured like the system at the other end, on its own ring.
// Faster schedules orbit faster. Stars of systems outside the current selection fade back.
const ORBIT_MS = { fast: 7000, medium: 12000, slow: 20000, none: 16000 };
const MAX_STARS = 10;

export function makeOrbits(cy, seedOf) {
  const systems = cy.nodes('.system').map((n) => {
    const r = rng(seedOf(n.id()));
    const edges = n.connectedEdges('.link').toArray().slice(0, MAX_STARS);
    return {
      node: n,
      tilt: (r() - 0.5) * 1.1,
      stars: edges.map((e) => ({ edge: e, other: e.source().same(n) ? e.target() : e.source(), phase: r() * TAU })),
    };
  });
  return {
    draw(back, front, now, animate) {
      const zoom = cy.zoom();
      for (const o of systems) {
        const n = o.node;
        if (n.removed() || n.hasClass('hidden')) continue;
        const p = n.renderedPosition();
        const radius = n.renderedWidth() / 2;
        const dim = n.hasClass('faded') ? 0.18 : 1;
        const cos = Math.cos(o.tilt);
        const sin = Math.sin(o.tilt);
        const stars = o.stars.filter((s) => !s.edge.hasClass('hidden'));
        stars.forEach((s, i) => {
          const rx = radius * (1.5 + i * 0.24);
          const ry = rx * 0.32;
          // The ring: far half under the map, near half over it.
          for (const [g, from, to] of [[back, Math.PI, TAU], [front, 0, Math.PI]]) {
            g.strokeStyle = `rgba(200,210,255,${(0.1 * dim).toFixed(3)})`;
            g.lineWidth = 1;
            g.beginPath();
            g.ellipse(p.x, p.y, rx, ry, o.tilt, from, to);
            g.stroke();
          }
          const period = ORBIT_MS[s.edge.data('speed')] ?? ORBIT_MS.none;
          const angle = s.phase + (animate ? (now / period) * TAU : 0);
          const lx = rx * Math.cos(angle);
          const ly = ry * Math.sin(angle);
          const near = (Math.sin(angle) + 1) / 2; // 0 = far side, 1 = near side
          const g = near > 0.5 ? front : back;
          const colour = s.other.data('color');
          g.globalAlpha = (0.45 + 0.55 * near) * dim;
          g.shadowColor = colour;
          g.shadowBlur = 8 * near;
          g.fillStyle = colour;
          g.beginPath();
          g.arc(p.x + lx * cos - ly * sin, p.y + lx * sin + ly * cos, Math.max(1.2, Math.min(4, (1.6 + 1.6 * near) * Math.sqrt(zoom))), 0, TAU);
          g.fill();
          g.shadowBlur = 0;
          g.globalAlpha = 1;
        });
      }
    },
  };
}

// Sizes a canvas to its box at the screen's pixel density, clears it, and returns its context in CSS pixels.
export function prepCanvas(canvas, w, h) {
  const dpr = window.devicePixelRatio || 1;
  const pw = Math.round(w * dpr);
  const ph = Math.round(h * dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return g;
}
