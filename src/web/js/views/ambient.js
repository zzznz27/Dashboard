// Ambient animations drawn on the canvas over the map (preset animation.ambient; 'ants' is drawn by Cytoscape).
// Each line carries travellers: one per integration on it (up to 4), spaced out, each at its own schedule's speed.
// On a two-way line a traveller goes out, fades into the far end, pauses, then a reply comes back.
// The modes draw the same travellers differently:
//   flow       small dots
//   comets     a glowing head with a fading tail (tail length follows speed)
//   packets    data blocks riding the line; replies on a two-way line are outlined
//   pulse      a light band sweeping the line; the receiving system rings when it lands
//   water      ripples running along the line, splashing at the receiving system
//   lightning  a jagged bolt along the line that forks and flashes at the receiving end

const TAU = Math.PI * 2;
const clamp01 = (t) => Math.min(1, Math.max(0, t));

export function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Mixes two #rrggbb colours (t = 0 gives a, 1 gives b).
export function mixHex(a, b, t) {
  const n = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [x, y] = [n(a), n(b)];
  if (x.some(Number.isNaN) || y.some(Number.isNaN)) return a;
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;
}

// Relative luminance (0 = black, 1 = white) of a #rrggbb colour; 1 if it can't be read.
export function luminance(hex) {
  const v = [1, 3, 5].map((i) => parseInt(String(hex).slice(i, i + 2), 16) / 255);
  if (v.some(Number.isNaN)) return 1;
  const [r, g, b] = v.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Point at t (0..1) on a Bezier curve through the given points (de Casteljau).
export function pointAt(pts, t) {
  let p = pts;
  while (p.length > 1) {
    const next = [];
    for (let i = 0; i < p.length - 1; i++) next.push({ x: p[i].x + (p[i + 1].x - p[i].x) * t, y: p[i].y + (p[i + 1].y - p[i].y) * t });
    p = next;
  }
  return p[0];
}

function tangentAt(pts, t) {
  const a = pointAt(pts, clamp01(t - 0.01));
  const b = pointAt(pts, clamp01(t + 0.01));
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
}

// A two-way exchange: out over `dur`, fading into the far end as it lands; a gap with nothing on the line; then
// a reply fades out of the far end and travels back; another gap at home. Returns where it is (t: 0 = source,
// 1 = target), which way it's going (dir) and how visible it is (alpha). `offset` staggers several on one line.
const EXCHANGE_GAP = 0.3; // of a leg
const EXCHANGE_FADE = 0.15; // of a leg, at each end of a trip
export function exchangeAt(now, dur, offset) {
  const gap = dur * EXCHANGE_GAP;
  const cycle = 2 * (dur + gap);
  const u = (((now / cycle) + offset) % 1) * cycle;
  const fade = (f) => Math.min(1, f / EXCHANGE_FADE, (1 - f) / EXCHANGE_FADE);
  if (u < dur) return { t: u / dur, dir: 1, alpha: fade(u / dur) };
  if (u < dur + gap) return { t: 1, dir: 1, alpha: 0 };
  if (u < 2 * dur + gap) {
    const f = (u - dur - gap) / dur;
    return { t: 1 - f, dir: -1, alpha: fade(f) };
  }
  return { t: 0, dir: -1, alpha: 0 };
}

function travellersOf(e, now) {
  const out = [];
  for (let k = 0; k < e.n; k++) {
    if (!e.twoWay) { out.push({ t: (now / e.dur + k / e.n) % 1, dir: 1, alpha: 1, k }); continue; }
    const x = exchangeAt(now, e.dur, k / e.n);
    if (x.alpha > 0.02) out.push({ ...x, k });
  }
  return out;
}

// Moments a traveller landed in the last `within` ms, and at which end ('to' = target, 'from' = source).
function arrivalsOf(e, now, within) {
  const out = [];
  for (let k = 0; k < e.n; k++) {
    if (!e.twoWay) {
      const age = ((now / e.dur + k / e.n) % 1) * e.dur;
      if (age < within) out.push({ end: 'to', age });
      continue;
    }
    const gap = e.dur * EXCHANGE_GAP;
    const cycle = 2 * (e.dur + gap);
    const u = (((now / cycle) + k / e.n) % 1) * cycle;
    if (u >= e.dur && u - e.dur < within) out.push({ end: 'to', age: u - e.dur });
    const home = 2 * e.dur + gap;
    if (u >= home && u - home < within) out.push({ end: 'from', age: u - home });
  }
  return out;
}

function segment(g, pts, t0, t1) {
  const a = pointAt(pts, clamp01(t0));
  const b = pointAt(pts, clamp01(t1));
  g.beginPath();
  g.moveTo(a.x, a.y);
  g.lineTo(b.x, b.y);
  g.stroke();
}

function ring(g, c, radius, colour, alpha, width) {
  g.globalAlpha = alpha;
  g.strokeStyle = colour;
  g.lineWidth = width;
  g.beginPath();
  g.arc(c.x, c.y, radius, 0, TAU);
  g.stroke();
}

const RENDER = {
  flow(g, e, now, st) {
    const r = Math.max(2.2, Math.min(3.2, 2.8 * st.zoom));
    for (const tr of travellersOf(e, now)) {
      const p = pointAt(e.pts, tr.t);
      g.globalAlpha = tr.alpha;
      g.beginPath();
      g.arc(p.x, p.y, r, 0, TAU);
      g.shadowColor = e.colour;
      g.shadowBlur = st.glow;
      if (e.unscheduled) {
        g.fillStyle = st.surface;
        g.fill();
        g.shadowBlur = 0;
        g.lineWidth = 1.5;
        g.strokeStyle = e.colour;
        g.stroke();
      } else {
        g.fillStyle = e.colour;
        g.fill();
        g.shadowBlur = 0;
        g.lineWidth = 1;
        g.strokeStyle = st.surface;
        g.stroke();
      }
    }
  },

  comets(g, e, now, st) {
    const r = Math.max(1.8, Math.min(2.8, 2.4 * st.zoom));
    const tail = { fast: 0.24, medium: 0.17, slow: 0.11 }[e.speed] ?? 0.12;
    const steps = 12;
    g.lineCap = 'round';
    for (const tr of travellersOf(e, now)) {
      let prev = pointAt(e.pts, tr.t);
      for (let i = 1; i <= steps; i++) {
        const t = tr.t - tr.dir * tail * (i / steps);
        if (t < 0 || t > 1) break;
        const p = pointAt(e.pts, t);
        const fade = 1 - i / steps;
        g.globalAlpha = tr.alpha * fade * (e.unscheduled ? 0.45 : 0.8);
        g.strokeStyle = e.colour;
        g.lineWidth = r * 1.8 * fade + 0.4;
        g.beginPath();
        g.moveTo(prev.x, prev.y);
        g.lineTo(p.x, p.y);
        g.stroke();
        prev = p;
      }
      const head = pointAt(e.pts, tr.t);
      g.globalAlpha = tr.alpha;
      g.shadowColor = e.colour;
      g.shadowBlur = Math.max(8, st.glow);
      g.fillStyle = e.colour;
      g.beginPath();
      g.arc(head.x, head.y, r, 0, TAU);
      g.fill();
      g.shadowBlur = 0;
      g.fillStyle = mixHex(e.colour, '#ffffff', 0.7);
      g.beginPath();
      g.arc(head.x, head.y, r * 0.45, 0, TAU);
      g.fill();
    }
  },

  packets(g, e, now, st) {
    const s = Math.max(0.8, Math.min(1.2, st.zoom));
    const w = 10 * s;
    const h = 6 * s;
    for (const tr of travellersOf(e, now)) {
      const p = pointAt(e.pts, tr.t);
      const d = tangentAt(e.pts, tr.t);
      const reply = e.twoWay && tr.dir < 0;
      const hollow = reply || e.unscheduled;
      g.save();
      g.translate(p.x, p.y);
      g.rotate(Math.atan2(d.y, d.x));
      g.globalAlpha = tr.alpha;
      g.beginPath();
      g.roundRect(-w / 2, -h / 2, w, h, 1.6 * s);
      if (hollow) {
        g.fillStyle = st.surface;
        g.fill();
        g.lineWidth = 1.4;
        g.strokeStyle = e.colour;
        g.stroke();
      } else {
        g.shadowColor = e.colour;
        g.shadowBlur = st.glow;
        g.fillStyle = e.colour;
        g.fill();
        g.shadowBlur = 0;
      }
      // Three bits that change as it travels.
      const bits = Math.floor(now / 180 + tr.k * 5);
      g.fillStyle = hollow ? e.colour : st.surface;
      for (let i = 0; i < 3; i++) {
        if (((bits >> i) & 1) === 0) continue;
        g.fillRect(-w / 2 + 2 * s + i * 2.4 * s, -1.1 * s, 1.4 * s, 2.2 * s);
      }
      g.restore();
    }
  },

  pulse(g, e, now, st) {
    const steps = 8;
    g.lineCap = 'round';
    for (const tr of travellersOf(e, now)) {
      const from = tr.t - tr.dir * 0.16;
      g.strokeStyle = e.colour;
      g.shadowColor = e.colour;
      g.shadowBlur = Math.max(8, st.glow);
      g.lineWidth = e.width + 2.5;
      for (let i = 0; i < steps; i++) {
        g.globalAlpha = tr.alpha * (0.15 + 0.85 * ((i + 1) / steps)) * (e.unscheduled ? 0.5 : 1);
        segment(g, e.pts, from + (tr.t - from) * (i / steps), from + (tr.t - from) * ((i + 1) / steps));
      }
      g.shadowBlur = 0;
    }
    const LIFE = 700;
    for (const a of arrivalsOf(e, now, LIFE)) {
      const f = a.age / LIFE;
      const c = a.end === 'to' ? e.to : e.from;
      const r0 = a.end === 'to' ? e.rTo : e.rFrom;
      ring(g, c, r0 + 3 + f * 18 * st.scale, e.colour, (1 - f) * 0.85, 2.2 * (1 - f) + 0.6);
    }
  },

  water(g, e, now, st) {
    // Which way it's running: a one-way line always forwards; a two-way line follows its exchange, calm in the gaps.
    let dir = 1;
    let strength = 1;
    if (e.twoWay) {
      const x = exchangeAt(now, e.dur, 0);
      dir = x.dir;
      strength = x.alpha;
    }
    const crest = mixHex(e.colour, '#ffffff', st.dark ? 0.45 : 0.25);
    const N = 28;
    const waves = 3;
    g.lineCap = 'round';
    g.strokeStyle = e.colour;
    g.globalAlpha = e.unscheduled ? 0.1 : 0.16;
    g.lineWidth = e.width + 4;
    segment(g, e.pts, 0, 1);
    if (strength > 0.02) {
      g.strokeStyle = crest;
      g.lineWidth = e.width + 1.8;
      for (let i = 0; i < N; i++) {
        const s0 = i / N;
        const wave = Math.max(0, Math.sin(TAU * (s0 - dir * (now / e.dur)) * waves)) ** 4;
        if (wave < 0.03) continue;
        g.globalAlpha = (0.15 + 0.75 * wave) * strength * (e.unscheduled ? 0.5 : 1);
        segment(g, e.pts, s0, s0 + 1 / N);
      }
    }
    const LIFE = 1100;
    for (const a of arrivalsOf(e, now, LIFE)) {
      const f = a.age / LIFE;
      const c = a.end === 'to' ? e.to : e.from;
      const r0 = a.end === 'to' ? e.rTo : e.rFrom;
      ring(g, c, r0 + 2 + f * 14 * st.scale, crest, (1 - f) * 0.55, 1.6);
      if (f > 0.25) ring(g, c, r0 + 2 + (f - 0.25) * 14 * st.scale, crest, (1 - f) * 0.4, 1.2);
    }
  },

  lightning(g, e, now, st) {
    const LIFE = 320;
    const core = st.dark ? '#ffffff' : mixHex(e.colour, '#000000', 0.25);
    for (let k = 0; k < e.n; k++) {
      const pos = now / e.dur + k / e.n;
      const cycle = Math.floor(pos);
      const age = (pos - cycle) * e.dur;
      if (age > LIFE) continue;
      const rand = rng(e.seed * 7919 + cycle * 131 + k * 17);
      const back = e.twoWay && cycle % 2 === 1; // a two-way line strikes each way in turn
      // On, off, on, fade: the flicker of a real strike.
      const alpha = (age < 50 ? 1 : age < 90 ? 0.25 : age < 140 ? 0.9 : Math.max(0, 1 - (age - 140) / (LIFE - 140))) * (e.unscheduled ? 0.5 : 1);
      const M = 14;
      const amp = 7 * st.scale;
      const bolt = [];
      for (let i = 0; i <= M; i++) {
        const s = i / M;
        const p = pointAt(e.pts, s);
        const d = tangentAt(e.pts, s);
        const off = i === 0 || i === M ? 0 : (rand() * 2 - 1) * amp * Math.sin(Math.PI * s);
        bolt.push({ x: p.x - d.y * off, y: p.y + d.x * off });
      }
      // A short fork from somewhere along the middle.
      const fi = 3 + Math.floor(rand() * (M - 6));
      const fork = [bolt[fi]];
      const fd = tangentAt(e.pts, fi / M);
      const turn = (rand() < 0.5 ? -1 : 1) * (0.5 + rand() * 0.4);
      for (let i = 1; i <= 3; i++) {
        const prev = fork[i - 1];
        const len = (14 - i * 3) * st.scale;
        const ang = Math.atan2(fd.y, fd.x) + (back ? Math.PI : 0) + turn + (rand() - 0.5) * 0.5;
        fork.push({ x: prev.x + Math.cos(ang) * len, y: prev.y + Math.sin(ang) * len });
      }
      for (const [width, colour, a, blur] of [[3.4, e.colour, 0.55, Math.max(12, st.glow)], [1.2, core, 1, 0]]) {
        g.globalAlpha = alpha * a;
        g.strokeStyle = colour;
        g.lineWidth = width;
        g.lineJoin = 'round';
        g.shadowColor = e.colour;
        g.shadowBlur = blur;
        for (const line of [bolt, fork]) {
          g.beginPath();
          g.moveTo(line[0].x, line[0].y);
          for (const p of line.slice(1)) g.lineTo(p.x, p.y);
          g.stroke();
        }
      }
      g.shadowBlur = 0;
      // The receiving end lights up.
      const c = back ? e.from : e.to;
      const r0 = (back ? e.rFrom : e.rTo) * 2.2;
      const flash = g.createRadialGradient(c.x, c.y, 0, c.x, c.y, r0);
      flash.addColorStop(0, mixHex(e.colour, '#ffffff', 0.5));
      flash.addColorStop(1, 'rgba(255,255,255,0)');
      g.globalAlpha = alpha * 0.6;
      g.fillStyle = flash;
      g.beginPath();
      g.arc(c.x, c.y, r0, 0, TAU);
      g.fill();
    }
  },
};

export const CANVAS_MODES = Object.keys(RENDER);

export function drawAmbient(mode, g, edges, now, style) {
  const render = RENDER[mode];
  if (!render) return;
  for (const e of edges) render(g, e, now + (e.shift ?? 0), style);
  g.globalAlpha = 1;
  g.shadowBlur = 0;
}
