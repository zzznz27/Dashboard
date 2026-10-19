// Graph views - domain clusters (L1) and force-directed network (L2) - rendered with Cytoscape.js + fcose.
// Positions are computed once per preset on the full catalogue and kept while filtering ("filters keep the frame").

import { readTokens, prefersReducedMotion, satellitesOn, selectionOnlyOn, hoverPreviewOn } from '../theme.js';
import { showTooltip, moveTooltip, hideTooltip, systemTip, edgeTip } from '../tooltip.js';
import { domainOf, linksOf, cellLinks, aggregate, lineKind } from '../data.js';
import { makeSky, makeOrbits, prepCanvas } from './effects.js';
import { drawAmbient, CANVAS_MODES, mixHex, luminance, pointAt } from './ambient.js';

/* global cytoscape, cytoscapeFcose */
if (window.cytoscape && window.cytoscapeFcose && !window.__worldmapFcose) {
  cytoscape.use(cytoscapeFcose);
  window.__worldmapFcose = true;
}

const PATTERN_LINE = { pubsub: 'solid', file: 'dashed', platform: 'dotted', unknown: 'unknown' };
// Time for one dot to travel a line, by schedule. 'none' = no schedule recorded (N/A, TBC, blank).
const FLOW_MS = { fast: 1400, medium: 3000, slow: 5500, none: 3500 };
// Fades for hover previews and filter changes, and the draw-on intro: each line traces for INTRO_MS, starting
// up to INTRO_STAGGER_MS later from left to right, so the lines sweep across the map once.
const FADE_MS = 220;
const INTRO_MS = 700;
const INTRO_STAGGER_MS = 500;
const ANT_PX_PER_S = { fast: 28, medium: 14, slow: 7, none: 10 };

// Label sizes at 100% zoom. Below 100% the text grows (up to LABEL_MAX_SCALE) so it stays readable on screen
// when a spread-out map is fitted to the window.
const LABEL = { system: 13, domain: 14, edge: 11, maxWidth: 150, margin: 6 };
const LABEL_MAX_SCALE = 2;
// Dash patterns (dash, gap, ...) for line styles, in screen pixels: they're scaled as the map zooms (dashScale) so
// dots and dashes stay visibly apart when zoomed out, rather than running together into a solid line.
const DASH = { 'ls-dashed': [7, 5], 'ls-dotted': [0.1, 7], 'ls-unknown': [10, 4, 1, 4] };
const DASH_MAX_SCALE = 3;

const LAYOUTS = {
  clusters: {
    quality: 'proof', nodeDimensionsIncludeLabels: true, packComponents: true,
    nodeRepulsion: 6000, idealEdgeLength: 75, edgeElasticity: 0.3, nestingFactor: 0.1, nodeSeparation: 75,
    gravity: 0.3, gravityCompound: 1.3, gravityRangeCompound: 1.5, numIter: 2500,
    tile: true, tilingPaddingVertical: 32, tilingPaddingHorizontal: 32,
  },
  network: {
    quality: 'proof', nodeDimensionsIncludeLabels: true, packComponents: true,
    nodeRepulsion: 16000, idealEdgeLength: 180, edgeElasticity: 0.45, nodeSeparation: 130,
    gravity: 0.2, numIter: 2500,
  },
};

// Text for a system without a mark: its name when it's one short word (Payroll), otherwise its initials.
function markText(name) {
  const short = name.replace(/^D365\s+/i, '');
  if (short.length <= 8 && /^[A-Za-z0-9]+$/.test(short)) return short;
  const words = short.split(/[^A-Za-z0-9]+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? '?').slice(0, 2)).toUpperCase();
}

// The width/height an SVG draws at, from its viewBox (an SVG with only a viewBox has no reliable natural size).
async function svgSize(url) {
  const text = await (await fetch(url)).text();
  const vb = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(text);
  return vb ? { w: Number(vb[1]), h: Number(vb[2]) } : null;
}

// Node marks. Each is drawn in solid white with its shape kept (via its transparency, after dropping any solid
// background), trimmed to what's visible, then sized to fill the node's shape: in a circle the mark's diagonal is a
// fixed share of the node, in a rounded square its longer side is. So a wide wordmark or a symbol with space
// around it in its file fills its node like the rest. The image covers the whole node.
// Small, because the map redraws every mark on each pan, zoom and hover. Returned as a short blob: URL, not a
// data: URL: Cytoscape re-reads the image string on every style change, and long data: URLs made the map lag. Cached.
const MARK_PX = 160;
const MARK_FILL = { ellipse: 0.84, 'round-rectangle': 0.6 };
const WORK_PX = 256;
const marks = new Map();

function nodeMark(key, shape, draw) {
  const cacheKey = `${shape}|${key}`;
  if (!marks.has(cacheKey)) {
    marks.set(cacheKey, (async () => {
      const work = document.createElement('canvas');
      work.width = WORK_PX;
      work.height = WORK_PX;
      const g = work.getContext('2d', { willReadFrequently: true });
      await draw(g);
      g.globalCompositeOperation = 'source-in';
      g.fillStyle = '#fff';
      g.fillRect(0, 0, WORK_PX, WORK_PX);
      const box = opaqueBox(g);
      const c = document.createElement('canvas');
      c.width = MARK_PX;
      c.height = MARK_PX;
      if (box) {
        const fill = MARK_FILL[shape] ?? MARK_FILL.ellipse;
        const scale = MARK_PX * fill / (shape === 'round-rectangle' ? Math.max(box.w, box.h) : Math.hypot(box.w, box.h));
        const [w, h] = [box.w * scale, box.h * scale];
        c.getContext('2d').drawImage(work, box.x, box.y, box.w, box.h, (MARK_PX - w) / 2, (MARK_PX - h) / 2, w, h);
      }
      return URL.createObjectURL(await new Promise((r) => c.toBlob(r, 'image/png')));
    })());
  }
  return marks.get(cacheKey);
}

// Draws a logo file centred and as large as fits, with any solid background dropped.
async function drawLogo(g, url) {
  const size = /\.svg$/i.test(url) ? await svgSize(url) : null;
  const img = new Image();
  img.src = url;
  await img.decode();
  const w = size?.w || img.naturalWidth || 1;
  const hgt = size?.h || img.naturalHeight || 1;
  const scale = WORK_PX / Math.max(w, hgt);
  const [dw, dh] = [w * scale, hgt * scale];
  g.drawImage(img, (WORK_PX - dw) / 2, (WORK_PX - dh) / 2, dw, dh);
  dropBackground(g, Math.ceil((WORK_PX - dw) / 2), Math.ceil((WORK_PX - dh) / 2), Math.floor(dw) - 1, Math.floor(dh) - 1);
}

function drawText(g, text) {
  g.font = '700 64px "Segoe UI", Roboto, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#fff';
  g.fillText(text, WORK_PX / 2, WORK_PX / 2, WORK_PX - 8);
}

// The bounding box of the visible pixels, or null if there are none.
function opaqueBox(g) {
  const { width, height } = g.canvas;
  const d = g.getImageData(0, 0, width, height).data;
  let [x0, y0, x1, y1] = [width, height, -1, -1];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (d[(y * width + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// A logo on a solid background (an app icon on a coloured square): makes the background transparent, so the
// white version shows the symbol rather than a solid block. A background is solid when most of the logo's edge is
// opaque. Its colour is blended from the colours at the logo's four corners, so a gradient drops out too, and a
// symbol touching the edge isn't mistaken for background.
function dropBackground(g, x0, y0, w, h) {
  const { width, height } = g.canvas;
  const img = g.getImageData(0, 0, width, height);
  const d = img.data;
  const at = (x, y) => (y * width + x) * 4;
  const x1 = x0 + w - 1;
  const y1 = y0 + h - 1;
  const edge = [];
  for (let x = x0; x <= x1; x++) edge.push(at(x, y0), at(x, y1));
  for (let y = y0; y <= y1; y++) edge.push(at(x0, y), at(x1, y));
  if (edge.filter((i) => d[i + 3] >= 250).length < edge.length * 0.75) return;
  // The first opaque pixel walking in from a corner (a rounded corner is transparent).
  const corner = (x, y, sx, sy) => {
    for (let k = 0; k < Math.min(w, h) / 4; k++) {
      const i = at(x + sx * k, y + sy * k);
      if (d[i + 3] >= 250) return [d[i], d[i + 1], d[i + 2]];
    }
    return null;
  };
  const tl = corner(x0, y0, 1, 1);
  const tr = corner(x1, y0, -1, 1);
  const bl = corner(x0, y1, 1, -1);
  const br = corner(x1, y1, -1, -1);
  if (!tl || !tr || !bl || !br) return;
  const clamp = (t) => Math.min(1, Math.max(0, t));
  for (let y = 0; y < height; y++) {
    const v = clamp((y - y0) / Math.max(1, h - 1));
    for (let x = 0; x < width; x++) {
      const i = at(x, y);
      if (!d[i + 3]) continue;
      const u = clamp((x - x0) / Math.max(1, w - 1));
      let diff = 0;
      for (let c = 0; c < 3; c++) {
        const bg = (tl[c] * (1 - u) + tr[c] * u) * (1 - v) + (bl[c] * (1 - u) + br[c] * u) * v;
        diff += Math.abs(d[i + c] - bg);
      }
      d[i + 3] = Math.round(d[i + 3] * clamp((diff - 24) / 72));
    }
  }
  g.putImageData(img, 0, 0);
}

// Seeded random so the same data always lays out the same way.
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash = (s) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7);

export class GraphView {
  constructor({ container, canvas, sky, ctx }) {
    this.container = container;
    this.canvas = canvas;
    this.skyCanvas = sky;
    this.pointer = { x: 0, y: 0, tx: 0, ty: 0 };
    // Pointer parallax for the sky layer: the target offset follows the pointer; frames ease towards it.
    this.onPointer = (e) => {
      const r = this.container.getBoundingClientRect();
      this.pointer.tx = -(e.clientX - r.left - r.width / 2) * 0.35;
      this.pointer.ty = -(e.clientY - r.top - r.height / 2) * 0.35;
    };
    this.ctx = ctx;
    this.cy = null;
    this.raf = 0;
    this.sel = null;
  }

  render(preset, model) {
    this.destroy();
    this.preset = preset;
    this.motion = !prefersReducedMotion();
    this.labelScale = 0;
    this.dashScale = 0;
    this.tokens = readTokens();
    // A dark ground, for animations that pick a contrasting colour (lightning's bright core, water's crests).
    this.dark = luminance(this.tokens.surface) < 0.2;
    this.cy = cytoscape({
      container: this.container,
      elements: this.buildElements(preset),
      style: this.stylesheet(preset, this.tokens),
      minZoom: 0.25,
      maxZoom: 3,
      boxSelectionEnabled: false,
      autounselectify: true,
    });
    this.preview = null;
    this.filtered = false;
    this.bindEvents();
    this.applyLogos(preset);
    this.runLayout(preset);
    this.applyFilter(model);
    this.startIntro(preset);
    this.skyFx = makeSky(this.tokens.sky);
    this.orbitFx = this.tokens.orbits && satellitesOn() ? makeOrbits(this.cy, hash) : null;
    if (this.skyFx) this.container.addEventListener('pointermove', this.onPointer);
    this.startAmbient();
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    clearTimeout(this.leaveTimer);
    this.intro = null;
    this.pulsing = null;
    if (this.cy) this.cy.destroy();
    this.cy = null;
    this.skyFx = null;
    this.orbitFx = null;
    this.container.removeEventListener('pointermove', this.onPointer);
    for (const c of [this.canvas, this.skyCanvas]) {
      const g = c.getContext('2d');
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, c.width, c.height);
    }
    hideTooltip();
  }

  resize() {
    this.cy?.resize();
  }

  zoomBy(factor) {
    const cy = this.cy;
    if (!cy) return;
    const level = Math.min(cy.maxZoom(), Math.max(cy.minZoom(), cy.zoom() * factor));
    cy.animate({ zoom: { level, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } } }, { duration: this.motion ? 200 : 0 });
  }

  fit() {
    const visible = this.cy?.elements(':visible');
    if (visible?.length) this.cy.animate({ fit: { eles: visible, padding: 48 } }, { duration: this.motion ? 300 : 0 });
  }

  // ---- Elements -----------------------------------------------------------

  buildElements(preset) {
    const { data, idx } = this.ctx;
    const t = this.tokens;
    const clusters = preset.layout === 'clusters';
    const active = data.systems.filter((s) => s.degree > 0);
    const els = [];
    if (clusters) {
      for (const d of data.domains) {
        if (active.some((s) => s.domain === d.id)) els.push({ group: 'nodes', data: { id: `domain:${d.id}`, label: d.name, color: t.domain(d.slot) }, classes: 'domain' });
      }
    }
    for (const s of active) {
      const d = domainOf(idx, s.id);
      // Logo designs need bigger nodes for the logo to read.
      const [min, span] = preset.nodes.logo === 'none' ? [26, 46] : [38, 40];
      const size = min + span * Math.sqrt((s.degree - 1) / Math.max(1, idx.maxDegree - 1));
      els.push({
        group: 'nodes',
        data: {
          id: s.id,
          label: preset.labels.showDomain ? `${s.name}\n${d.name}` : s.name,
          color: t.domain(d.slot),
          planet: t.planets ? `${mixHex(t.domain(d.slot), '#ffffff', 0.5)} ${t.domain(d.slot)} ${mixHex(t.domain(d.slot), '#000000', 0.6)}` : undefined,
          size: Math.round(size),
          shape: s.type === 'internal' ? 'round-rectangle' : 'ellipse',
          parent: clusters ? `domain:${s.domain}` : undefined,
        },
        classes: 'system',
      });
    }
    // Every line the catalogue can draw (filters only hide them), one per pair and kind unless lines are merged.
    for (const e of aggregate(data.integrations).values()) {
      els.push({ group: 'edges', data: { id: e.id, source: e.source, target: e.target, color: t.domain(domainOf(idx, e.source).slot), width: 2, label: '', count: 1, speed: 'none' }, classes: e.twoWay ? 'link two-way' : 'link' });
    }
    return els;
  }

  edgeVisual(agg) {
    const { preset } = this;
    const count = agg.integrations.length;
    const width = 2 + 4 * Math.sqrt((count - 1) / Math.max(1, this.ctx.idx.maxPair - 1));
    let line = 'solid';
    if (preset.animation.ambient === 'ants' && this.motion) line = 'ants';
    else if (preset.edges.styleBy === 'pattern') line = PATTERN_LINE[lineKind(agg)] ?? 'solid';
    let label = count > 1 ? String(count) : '';
    if (preset.edges.flagUncertain && agg.flagged) label = label ? `${label} ⚠` : '⚠';
    return { data: { width: Math.round(width * 10) / 10, label, count, speed: agg.speed, speeds: agg.speeds }, line };
  }

  // Shows what the filters match. With the preset's filterFade, items leaving fade out before they're removed and
  // items arriving fade in (not on the first draw).
  applyFilter(model) {
    this.model = model;
    const cy = this.cy;
    if (!cy) return;
    const fade = this.motion && this.preset.animation.filterFade !== false && this.filtered;
    this.filtered = true;
    clearTimeout(this.leaveTimer);
    const entering = [];
    const leaving = [];
    const show = (el, on) => {
      if (!fade) { el.toggleClass('hidden', !on); return; }
      if (on && el.hasClass('leaving')) el.removeClass('leaving');
      else if (on && el.hasClass('hidden')) { el.removeClass('hidden').addClass('entering'); entering.push(el); }
      else if (!on && !el.hasClass('hidden') && !el.hasClass('leaving')) { el.addClass('leaving'); leaving.push(el); }
      else if (!on && el.hasClass('leaving')) leaving.push(el);
    };
    cy.batch(() => {
      cy.nodes('.system').forEach((n) => show(n, model.systemIds.has(n.id())));
      cy.edges().forEach((e) => {
        const agg = model.edges.get(e.id());
        if (!agg) { show(e, false); return; }
        const v = this.edgeVisual(agg);
        e.removeClass('ls-dashed ls-dotted ls-ants ls-unknown');
        show(e, true);
        e.data(v.data);
        if (v.line !== 'solid') e.addClass(`ls-${v.line}`);
      });
      cy.nodes('.domain').forEach((d) => show(d, d.children('.system').some((n) => model.systemIds.has(n.id()))));
    });
    this.dashDirty = true;
    this.applyDash();
    // Arrivals start transparent and fade in once that's been drawn; leavers are removed once they've faded.
    if (entering.length) requestAnimationFrame(() => requestAnimationFrame(() => cy.batch(() => entering.forEach((el) => el.removeClass('entering')))));
    if (leaving.length) {
      this.leaveTimer = setTimeout(() => cy.batch(() => cy.elements('.leaving').removeClass('leaving').addClass('hidden')), FADE_MS + 40);
    }
    this.highlight(this.sel, { pulse: false });
  }

  // ---- Selection & emphasis ---------------------------------------------

  highlight(sel, { pulse = true } = {}) {
    this.sel = sel;
    this.focused = false;
    const cy = this.cy;
    if (!cy) return;
    const focus = this.focusFor(sel);
    // Animation only narrows to the selection when the selection has something on the map.
    this.focused = Boolean(focus);
    this.preview = null;
    this.previewId = null;
    cy.batch(() => {
      cy.elements().removeClass('faded hl sel pv dim');
      if (!focus) return;
      focus.edges().addClass('hl');
      if (sel.type === 'system') cy.getElementById(sel.id).addClass('sel');
      cy.elements('.system, .link').not(focus).addClass('faded');
      cy.nodes('.domain').filter((d) => d.children().intersection(focus).empty()).addClass('faded');
    });
    if (pulse && focus && this.motion && this.preset.animation.onSelect === 'focus-pulse') this.pulse(focus.nodes('.system'));
  }

  focusFor(sel) {
    const cy = this.cy;
    if (!sel) return null;
    if (sel.type === 'system') {
      const n = cy.getElementById(sel.id);
      if (n.empty() || n.hasClass('hidden')) return null;
      const edges = n.connectedEdges().not('.hidden');
      return n.union(edges).union(edges.connectedNodes());
    }
    if (sel.type === 'domain') {
      const nodes = cy.nodes('.system').filter((n) => this.ctx.idx.systems.get(n.id())?.domain === sel.id).not('.hidden');
      const edges = nodes.connectedEdges().not('.hidden');
      return nodes.union(edges).union(edges.connectedNodes());
    }
    if (sel.type === 'cell') {
      let col = cy.collection();
      for (const e of cellLinks(this.model, sel.id)) col = col.union(cy.getElementById(e.id));
      col = col.not('.hidden');
      return col.empty() ? null : col.union(col.connectedNodes());
    }
    if (sel.type === 'edge') {
      const e = cy.getElementById(sel.id);
      return e.empty() || e.hasClass('hidden') ? null : e.union(e.connectedNodes());
    }
    if (sel.type === 'integration') {
      const i = this.ctx.idx.integrations.get(sel.key);
      if (!i) return null;
      let col = cy.collection();
      for (const link of linksOf(i)) col = col.union(cy.getElementById(link.id));
      col = col.not('.hidden');
      return col.empty() ? null : col.union(col.connectedNodes());
    }
    return null;
  }

  // Hover preview (Map settings): while nothing is selected, pointing at a system lightly dims everything it
  // isn't connected to, and its lines animate, until the pointer leaves. Selecting replaces it.
  previewSystem(id) {
    const cy = this.cy;
    if (!cy || this.focused) return;
    const focus = id && hoverPreviewOn() ? this.focusFor({ type: 'system', id }) : null;
    this.preview = focus;
    this.previewId = focus ? id : null;
    cy.batch(() => {
      cy.elements().removeClass('pv dim');
      if (!focus) return;
      focus.edges().addClass('pv');
      cy.elements('.system, .link').not(focus).addClass('dim');
      cy.nodes('.domain').filter((d) => d.children().intersection(focus).empty()).addClass('dim');
    });
  }

  // Selected neighbours briefly grow and settle, rippling outwards. A new pulse stops only the node's previous pulse:
  // stopping every animation on the node (ele.stop) would also cut off a fade it's in the middle of (style
  // transitions run as animations), leaving it stuck half-faded.
  pulse(nodes) {
    const pulsing = (this.pulsing ??= new Map());
    nodes.forEach((n, i) => {
      const s = n.data('size');
      setTimeout(() => {
        if (!this.cy || n.removed()) return;
        const run = { stopped: false, current: null };
        const previous = pulsing.get(n.id());
        if (previous) { previous.stopped = true; previous.current?.stop(); }
        pulsing.set(n.id(), run);
        const step = (style, duration, easing) => {
          if (run.stopped || n.removed()) return Promise.resolve(false);
          run.current = n.animation({ style, duration, easing });
          return run.current.play().promise().then(() => !run.stopped);
        };
        step({ width: s * 1.2, height: s * 1.2 }, 140, 'ease-out')
          .then((go) => go && step({ width: s, height: s }, 220, 'ease-in-out'))
          .then((go) => { if (go && !n.removed()) { n.removeStyle('width height'); pulsing.delete(n.id()); } });
      }, Math.min(i, 12) * 25);
    });
  }

  // ---- Events ---------------------------------------------------------------

  bindEvents() {
    const { cy, ctx } = this;
    const at = (evt) => [evt.originalEvent?.clientX ?? 0, evt.originalEvent?.clientY ?? 0];
    cy.on('zoom', () => this.scaleLabels());
    cy.on('tap', 'node.system', (evt) => ctx.select({ type: 'system', id: evt.target.id() }));
    cy.on('tap', 'edge', (evt) => ctx.select({ type: 'edge', id: evt.target.id() }));
    cy.on('tap', (evt) => { if (evt.target === cy) ctx.select(null); });
    cy.on('mouseover', 'node.system, edge', (evt) => {
      const el = evt.target;
      el.addClass('hover');
      this.container.style.cursor = 'pointer';
      const content = el.isNode()
        ? systemTip(ctx.idx.systems.get(el.id()), this.model, ctx)
        : edgeTip(this.model.edges.get(el.id()), ctx);
      showTooltip(...at(evt), content);
      if (el.isNode()) this.previewSystem(el.id());
    });
    cy.on('mousemove', (evt) => moveTooltip(...at(evt)));
    // Back onto the same system after leaving the map from it doesn't fire mouseover again, so moving over a system
    // starts its preview too.
    cy.on('mousemove', 'node.system', (evt) => { if (!this.focused && this.previewId !== evt.target.id() && hoverPreviewOn()) this.previewSystem(evt.target.id()); });
    cy.on('mouseout', 'node.system, edge', (evt) => {
      evt.target.removeClass('hover');
      this.container.style.cursor = '';
      hideTooltip();
      if (this.preview && evt.target.isNode()) this.previewSystem(null);
    });
    cy.on('pan zoom', hideTooltip);
    // Leaving the map straight off a system doesn't always fire its mouseout, so end any preview here too.
    if (this.onLeave) this.container.removeEventListener('mouseleave', this.onLeave);
    this.onLeave = () => { if (this.preview) this.previewSystem(null); };
    this.container.addEventListener('mouseleave', this.onLeave);
    this.bindKeyboard();
  }

  // Puts each system's mark on its node in white (preset nodes.logo "mark"). Images load asynchronously; a system
  // without a mark, or a mark that fails to load, shows its name or initials instead (markText).
  applyLogos(preset) {
    if (preset.nodes.logo !== 'mark') return;
    const cy = this.cy;
    cy.nodes('.system').forEach((n) => {
      const s = this.ctx.idx.systems.get(n.id());
      const shape = n.data('shape');
      const show = (url) => { if (this.cy === cy) n.style('background-image', url); };
      const text = () => { const t = markText(s.name); return nodeMark(`text|${t}`, shape, (g) => drawText(g, t)).then(show); };
      if (!s.mark) text();
      else nodeMark(s.mark, shape, (g) => drawLogo(g, s.mark)).then(show, text);
    });
  }

  // Keyboard: the map itself is focusable. Arrow keys move a cursor to the nearest system in that direction,
  // Enter or Space opens it, + and - zoom. The cursor shows like a hover, with its tooltip, and is announced.
  bindKeyboard() {
    const el = this.container;
    el.tabIndex = 0;
    el.setAttribute('role', 'application');
    el.setAttribute('aria-roledescription', 'integration map');
    el.setAttribute('aria-label', 'Integration map. Arrow keys move between systems, Enter opens one, plus and minus zoom. The Table view lists the same integrations.');
    if (this.onKey) el.removeEventListener('keydown', this.onKey);
    if (this.onBlur) el.removeEventListener('blur', this.onBlur);
    this.cursor = null;
    const DIRS = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] };
    this.onKey = (e) => {
      if (!this.cy) return;
      if (DIRS[e.key]) { e.preventDefault(); this.moveCursor(DIRS[e.key]); return; }
      if ((e.key === 'Enter' || e.key === ' ') && this.cursor && !this.cursor.removed()) {
        e.preventDefault();
        this.ctx.select({ type: 'system', id: this.cursor.id() });
        return;
      }
      if (e.key === '+' || e.key === '=') { e.preventDefault(); this.zoomBy(1.25); }
      if (e.key === '-' || e.key === '_') { e.preventDefault(); this.zoomBy(0.8); }
    };
    this.onBlur = () => { this.cursor?.removeClass('hover'); hideTooltip(); };
    el.addEventListener('keydown', this.onKey);
    el.addEventListener('blur', this.onBlur);
  }

  moveCursor([dx, dy]) {
    const nodes = this.cy.nodes('.system').not('.hidden');
    if (nodes.empty()) return;
    const current = this.cursor && !this.cursor.removed() && !this.cursor.hasClass('hidden') ? this.cursor : null;
    let next = null;
    if (!current) {
      next = nodes.max((n) => n.degree()).ele; // start from the most-connected system
    } else {
      // The nearest system ahead, preferring ones straight ahead over ones off to the side.
      const p = current.position();
      let best = Infinity;
      nodes.forEach((n) => {
        if (n.same(current)) return;
        const q = n.position();
        const along = (q.x - p.x) * dx + (q.y - p.y) * dy;
        if (along <= 0) return;
        const score = along + 2 * Math.abs((q.x - p.x) * dy - (q.y - p.y) * dx);
        if (score < best) { best = score; next = n; }
      });
      if (!next) return;
    }
    current?.removeClass('hover');
    this.cursor = next;
    next.addClass('hover');
    const s = this.ctx.idx.systems.get(next.id());
    const show = () => {
      const rp = next.renderedPosition();
      const r = this.container.getBoundingClientRect();
      showTooltip(r.left + rp.x, r.top + rp.y, systemTip(s, this.model, this.ctx));
    };
    const ext = this.cy.extent();
    const p = next.position();
    if (p.x < ext.x1 || p.x > ext.x2 || p.y < ext.y1 || p.y > ext.y2) {
      this.cy.animate({ center: { eles: next } }, { duration: this.motion ? 200 : 0, complete: show });
    } else {
      show();
    }
    this.ctx.announce?.(`${s.name}, ${domainOf(this.ctx.idx, s.id).name}. Press Enter for details.`);
  }

  // ---- Layout ---------------------------------------------------------------

  // Lays out once without animation, stretches the result sideways to the shape of the screen
  // (force layouts come out roughly square, which wastes a wide screen and shrinks the labels),
  // fits it, then optionally lets the nodes settle out from the middle into place.
  runLayout(preset) {
    const opts = {
      name: 'fcose',
      ...LAYOUTS[preset.layout] ?? LAYOUTS.network,
      ...preset.layoutOptions,
      randomize: true,
      animate: false,
      fit: false,
    };
    const seed = hash(this.cy.nodes().map((n) => n.id()).sort().join('|'));
    const random = Math.random;
    Math.random = mulberry32(seed);
    try {
      this.cy.layout(opts).run();
    } finally {
      Math.random = random;
    }

    const leaves = this.cy.nodes().filter((n) => !n.isParent());
    const bb = leaves.boundingBox({ includeLabels: true });
    const centre = { x: (bb.x1 + bb.x2) / 2, y: (bb.y1 + bb.y2) / 2 };
    const stretch = Math.min(2, Math.max(1, (this.cy.width() / this.cy.height()) / (bb.w / bb.h)));
    leaves.positions((n) => ({ x: centre.x + (n.position('x') - centre.x) * stretch, y: n.position('y') }));
    // Clear lines off systems once the map is at its final zoom and label size, then fit again (twice: fitting can
    // change the zoom, and so the labels' size).
    for (let i = 0; i < 2; i++) {
      this.cy.fit(this.cy.elements(), 48);
      this.scaleLabels();
      this.untangle();
    }
    this.cy.fit(this.cy.elements(), 48);
    this.scaleLabels();

    if (!(this.motion && preset.animation.settle)) return;
    const target = new Map(leaves.map((n) => [n.id(), { ...n.position() }]));
    leaves.positions((n) => ({ x: centre.x + (n.position('x') - centre.x) * 0.35, y: centre.y + (n.position('y') - centre.y) * 0.35 }));
    leaves.layout({ name: 'preset', positions: (n) => target.get(n.id()), fit: false, animate: true, animationDuration: 900, animationEasing: 'ease-out' }).run();
  }

  // The force layout can leave a system sitting on or against a line between two other systems, so the line looks as
  // if it runs through it or its name (a system label beside the lines into a busy hub). Push any system whose box (node and
  // label) comes within GAP screen pixels of a line it isn't part of out sideways, over a few passes. A system wedged
  // between two lines just bounces between them, so any still too close afterwards moves to the nearest clear spot
  // (searching outwards in a spiral). Lines are taken as straight between their ends. Runs at the final zoom, so the
  // gap is what's seen on screen.
  untangle() {
    const GAP = 14;
    const margin = GAP / this.cy.zoom();
    const systems = this.cy.nodes('.system');
    const links = this.cy.edges('.link');
    const boxOf = (n, at = n.position()) => {
      const b = n.boundingBox({ includeLabels: true, includeOverlays: false });
      const p = n.position();
      return { x1: b.x1 + at.x - p.x, x2: b.x2 + at.x - p.x, y1: b.y1 + at.y - p.y, y2: b.y2 + at.y - p.y, w: b.w, h: b.h };
    };
    // Lines between the same two systems are drawn as curves bowing apart (control-point-step-size 36), so they count
    // as wider by how far the outermost one bows.
    const bowOf = (e) => (e.parallelEdges('.link').length - 1) * 18;
    // How far a box sits inside a line's keep-clear band (0 = clear) and which way is out. Near either end the line is
    // entering its own system, so that part doesn't count.
    const intrusion = (box, a, b, bow = 0) => {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (!len) return null;
      const c = { x: (box.x1 + box.x2) / 2, y: (box.y1 + box.y2) / 2 };
      const t = ((c.x - a.x) * dx + (c.y - a.y) * dy) / (len * len);
      if (t <= 0.04 || t >= 0.96) return null;
      const nx = -dy / len;
      const ny = dx / len;
      const d = (c.x - a.x) * nx + (c.y - a.y) * ny;
      const need = (box.w / 2 + margin) * Math.abs(nx) + (box.h / 2 + margin) * Math.abs(ny) + bow;
      return Math.abs(d) < need ? { depth: need - Math.abs(d), nx: nx * (d < 0 ? -1 : 1), ny: ny * (d < 0 ? -1 : 1) } : null;
    };
    const overlaps = (p, q) => p.x1 - margin < q.x2 && q.x1 - margin < p.x2 && p.y1 - margin < q.y2 && q.y1 - margin < p.y2;
    // Would system n be clear at position `at`: its box off other lines and other systems, and its own lines off
    // other systems?
    const clearAt = (n, at) => {
      const box = boxOf(n, at);
      for (const e of links) {
        if (e.source().same(n) || e.target().same(n)) continue;
        if (intrusion(box, e.source().position(), e.target().position(), bowOf(e))) return false;
      }
      for (const m of systems) {
        if (m.same(n)) continue;
        const other = boxOf(m);
        if (overlaps(box, other)) return false;
        for (const e of n.connectedEdges('.link')) {
          const far = e.source().same(n) ? e.target() : e.source();
          if (far.same(m)) continue;
          if (intrusion(other, at, far.position(), bowOf(e))) return false;
        }
      }
      return true;
    };

    for (let pass = 0; pass < 8; pass++) {
      let moved = false;
      systems.forEach((n) => {
        for (const e of links) {
          if (e.source().same(n) || e.target().same(n)) continue;
          const hit = intrusion(boxOf(n), e.source().position(), e.target().position(), bowOf(e));
          if (!hit) continue;
          const p = n.position();
          n.position({ x: p.x + hit.nx * (hit.depth + 1), y: p.y + hit.ny * (hit.depth + 1) });
          moved = true;
        }
      });
      if (!moved) break;
    }

    const step = 8 / this.cy.zoom();
    systems.forEach((n) => {
      const p = { ...n.position() };
      const stuck = links.some((e) => !e.source().same(n) && !e.target().same(n) && intrusion(boxOf(n), e.source().position(), e.target().position(), bowOf(e)));
      if (!stuck) return;
      for (let r = step; r <= 40 * step; r += step) {
        for (let k = 0; k < 24; k++) {
          const at = { x: p.x + r * Math.cos((k / 24) * 2 * Math.PI), y: p.y + r * Math.sin((k / 24) * 2 * Math.PI) };
          if (clearAt(n, at)) { n.position(at); return; }
        }
      }
    });
  }

  // Sets each patterned line's dash pattern for the current zoom (DASH). Element styles, so they're reapplied after
  // a filter changes a line's style class, and cleared from lines that become solid.
  applyDash() {
    const k = Math.min(DASH_MAX_SCALE, Math.max(1, 1 / this.cy.zoom()));
    if (Math.abs(k - (this.dashScale ?? 0)) < 0.01 && !this.dashDirty) return;
    this.dashScale = k;
    this.dashDirty = false;
    this.cy.batch(() => this.cy.edges('.link').forEach((e) => {
      const cls = Object.keys(DASH).find((c) => e.hasClass(c));
      if (cls) e.style('line-dash-pattern', DASH[cls].map((d) => d * k));
      else e.removeStyle('line-dash-pattern');
    }));
  }

  // Keeps labels about the same size on screen when zoomed out (see LABEL). Element styles, so repeated zooms
  // overwrite rather than pile up stylesheet rules.
  scaleLabels() {
    this.applyDash();
    const k = Math.min(LABEL_MAX_SCALE, Math.max(1, 1 / this.cy.zoom()));
    if (Math.abs(k - this.labelScale) < 0.01) return;
    this.labelScale = k;
    this.cy.batch(() => {
      this.cy.nodes('.system').style({ 'font-size': LABEL.system * k, 'text-max-width': LABEL.maxWidth * k, 'text-margin-y': LABEL.margin * k });
      this.cy.nodes('.domain').style({ 'font-size': LABEL.domain * k });
      this.cy.edges().style({ 'font-size': LABEL.edge * k });
    });
  }

  // ---- Ambient animation ------------------------------------------------------

  // One loop drives the preset's ambient animation and the theme's effects (sky, orbits). With reduced motion
  // the effects are drawn still, and redrawn whenever the map moves so they stay with it.
  startAmbient() {
    const ambient = this.motion ? this.preset.animation.ambient : 'none';
    const effects = Boolean(this.skyFx || this.orbitFx);
    if (!this.motion) {
      if (!effects) return;
      let queued = false;
      const redraw = () => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => { queued = false; if (this.cy) this.drawFrame(0, false, false); });
      };
      this.cy.on('render', redraw);
      redraw();
      return;
    }
    if (ambient === 'none' && !effects && !this.intro) return;
    const canvasMode = CANVAS_MODES.includes(ambient) ? ambient : null;
    let frame = 0;
    const loop = (now) => {
      if (!this.cy) return;
      if (ambient === 'ants' && frame++ % 2 === 0) this.stepAnts(now);
      if (canvasMode || effects || this.intro) this.drawFrame(now, true, canvasMode);
      // With nothing else animating, the loop stops (and clears its canvas) once the intro has drawn.
      if (!canvasMode && !effects && ambient !== 'ants' && !this.intro) {
        prepCanvas(this.canvas, this.container.clientWidth, this.container.clientHeight);
        return;
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  drawFrame(now, animate, mode) {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const front = prepCanvas(this.canvas, w, h);
    if (this.skyFx || this.orbitFx) {
      const back = prepCanvas(this.skyCanvas, w, h);
      const pt = this.pointer;
      if (animate) { pt.x += (pt.tx - pt.x) * 0.06; pt.y += (pt.ty - pt.y) * 0.06; }
      const pan = this.cy.pan();
      this.skyFx?.draw(back, w, h, now, { x: pan.x + pt.x, y: pan.y + pt.y }, animate);
      this.orbitFx?.draw(back, front, now, animate);
    }
    if (mode) this.drawLines(front, now, mode);
    if (this.intro) this.drawIntro(front, now);
  }

  // Draw-on intro (preset drawOn, on by default): every line starts hidden and is traced from its source to its
  // target on the canvas, sweeping left to right across the map; each line appears as its trace finishes. Waits for the settle.
  startIntro(preset) {
    this.intro = null;
    if (!this.motion || preset.animation.drawOn === false) return;
    const edges = this.cy.edges('.link').not('.hidden');
    if (edges.empty()) return;
    const xs = edges.map((e) => e.source().position('x'));
    const x0 = Math.min(...xs);
    const span = Math.max(1, Math.max(...xs) - x0);
    const start = performance.now() + (preset.animation.settle ? 950 : 150);
    this.intro = { lines: edges.map((e) => ({ e, at: start + ((e.source().position('x') - x0) / span) * INTRO_STAGGER_MS, done: false })) };
    edges.addClass('intro');
  }

  drawIntro(g, now) {
    const { cy, tokens: t } = this;
    const zoom = cy.zoom();
    const pan = cy.pan();
    const toScreen = (p) => ({ x: p.x * zoom + pan.x, y: p.y * zoom + pan.y });
    let pending = 0;
    g.save();
    g.lineCap = 'round';
    g.globalAlpha = t.edgeOpacity;
    for (const l of this.intro.lines) {
      if (l.done) continue;
      const k = (now - l.at) / INTRO_MS;
      if (k >= 1 || l.e.removed() || l.e.hasClass('hidden') || l.e.hasClass('leaving')) { l.done = true; if (!l.e.removed()) l.e.removeClass('intro'); continue; }
      pending++;
      if (k <= 0) continue;
      const ease = 1 - (1 - k) ** 3;
      const pts = [l.e.sourceEndpoint(), ...(l.e.controlPoints() ?? []), l.e.targetEndpoint()].map(toScreen);
      // Traced in the line's own colour and dash pattern (stylesheet), so nothing changes when it appears.
      const unknown = l.e.hasClass('ls-unknown');
      const cls = Object.keys(DASH).find((c) => l.e.hasClass(c));
      g.setLineDash(cls ? DASH[cls].map((d) => d * (this.dashScale ?? 1) * zoom) : []);
      g.strokeStyle = unknown ? t.edgeUnknown : t.edgeTint === 'domain' ? l.e.data('color') : t.edge;
      g.lineWidth = l.e.data('width') * zoom;
      g.beginPath();
      const steps = 24;
      for (let i = 0; i <= steps; i++) {
        const p = pointAt(pts, (i / steps) * ease);
        if (i) g.lineTo(p.x, p.y); else g.moveTo(p.x, p.y);
      }
      g.stroke();
    }
    g.restore();
    if (!pending) this.intro = null;
  }

  // Hands each visible line to the ambient animation (ambient.js): its curve on screen, both ends, colour,
  // schedule speed and how many integrations it carries. A line carrying integrations on different schedules is
  // handed over once per schedule speed, each with its own travellers, offset so they don't start together. While something is selected, only its lines animate.
  // Lines with no recorded schedule animate at a steady pace, drawn fainter or hollow (or not at all if the
  // preset says so).
  drawLines(g, now, mode) {
    const { cy, tokens } = this;
    const zoom = cy.zoom();
    const pan = cy.pan();
    const toScreen = (p) => ({ x: p.x * zoom + pan.x, y: p.y * zoom + pan.y });
    const animateUnscheduled = this.preset.animation.animateUnscheduled !== false;
    // What animates: the selection, else a hover preview, else every line (none, with "Animate only what I select").
    const only = this.focused ? 'hl' : this.preview ? 'pv' : null;
    if (!only && selectionOnlyOn()) return;
    const lines = [];
    cy.edges().forEach((e) => {
      if (e.hasClass('hidden') || e.hasClass('leaving') || e.hasClass('intro') || (only && !e.hasClass(only))) return;
      const groups = Object.entries(e.data('speeds') ?? { [e.data('speed')]: e.data('count') });
      const src = e.source();
      const tgt = e.target();
      const base = {
        pts: [e.sourceEndpoint(), ...(e.controlPoints() ?? []), e.targetEndpoint()].map(toScreen),
        from: src.renderedPosition(), to: tgt.renderedPosition(),
        rFrom: src.renderedWidth() / 2, rTo: tgt.renderedWidth() / 2,
        colour: e.data('color'), twoWay: e.hasClass('two-way'), width: e.data('width') * zoom, seed: hash(e.id()),
      };
      // Up to 4 travellers on a line, shared between its schedule speeds (at least one each).
      const total = groups.reduce((n, [, c]) => n + c, 0) || 1;
      groups.forEach(([speed, count], gi) => {
        const unscheduled = !FLOW_MS[speed] || speed === 'none';
        if (unscheduled && !animateUnscheduled) return;
        const dur = FLOW_MS[speed] ?? FLOW_MS.none;
        lines.push({
          ...base, speed, dur, unscheduled, seed: base.seed + gi,
          n: Math.max(1, Math.round((Math.min(4, total) * count) / total)),
          shift: groups.length > 1 ? (gi / groups.length) * dur * 0.5 + gi * 700 : 0,
        });
      });
    });
    drawAmbient(mode, g, lines, now, { surface: tokens.surface, glow: tokens.glowStrength, zoom, scale: Math.max(0.7, Math.min(1.4, zoom)), dark: this.dark });
  }

  stepAnts(now) {
    const only = this.focused ? 'hl' : this.preview ? 'pv' : null;
    if (!only && selectionOnlyOn()) return;
    const animateUnscheduled = this.preset.animation.animateUnscheduled !== false;
    const t = now / 1000;
    this.cy.batch(() => {
      this.cy.edges('.ls-ants').forEach((e) => {
        if (e.hasClass('hidden')) return;
        const speed = e.data('speed');
        if ((speed === 'none' || !ANT_PX_PER_S[speed]) && !animateUnscheduled) return;
        const v = ANT_PX_PER_S[speed] ?? ANT_PX_PER_S.none;
        if (only && !e.hasClass(only)) return;
        // Two-way lines march forward for two seconds, then back.
        const travelled = e.hasClass('two-way') ? v * (2 - Math.abs((t % 4) - 2)) : t * v;
        e.style('line-dash-offset', -(travelled % 12));
      });
    });
  }

  // ---- Styles -------------------------------------------------------------------

  stylesheet(preset, t) {
    const a = preset.animation;
    const fadeMs = this.motion && (a.onSelect === 'focus-pulse' || a.filterFade !== false || a.drawOn !== false || hoverPreviewOn()) ? FADE_MS : 0;
    const transition = { 'transition-property': 'opacity, line-color, target-arrow-color, source-arrow-color', 'transition-duration': fadeMs };
    // Dark theme: a translucent border in the node's own colour reads as a halo and follows the node's shape.
    const glowNode = t.glow ? { 'border-color': 'data(color)', 'border-opacity': 0.35, 'border-width': 5 } : {};
    const glowEdge = t.glow ? { 'underlay-color': 'data(color)', 'underlay-opacity': 0.22, 'underlay-padding': 3 } : {};
    // The mark image covers the node, with the mark already sized to sit inside the node's shape (nodeMark), so it
    // needn't be clipped to the shape (clipping on every redraw is slow).
    const logoStyle = preset.nodes.logo === 'mark'
      ? { 'background-fit': 'none', 'background-width': '100%', 'background-height': '100%', 'background-clip': 'none' }
      : {};
    const text = { 'font-family': t.font, color: t.ink, 'text-background-color': t.surface, 'text-background-opacity': t.labelBgOpacity, 'text-background-padding': 2, 'text-background-shape': 'round-rectangle', 'min-zoomed-font-size': 7 };
    // Theme extras: a coloured halo under every node and line (neon), lines in their domain colour, planet shading.
    const nodeHalo = t.nodeGlow > 0 ? { 'underlay-color': 'data(color)', 'underlay-opacity': t.nodeGlow, 'underlay-padding': 7, 'underlay-shape': 'round-rectangle' } : {};
    const planet = t.planets ? { 'background-fill': 'radial-gradient', 'background-gradient-stop-colors': 'data(planet)', 'background-gradient-stop-positions': '0% 55% 100%' } : {};
    const edgeColour = t.edgeTint === 'domain' ? 'data(color)' : t.edge;
    const edgeHalo = t.edgeGlow > 0 ? { 'underlay-color': 'data(color)', 'underlay-opacity': t.edgeGlow, 'underlay-padding': 4 } : {};
    return [
      {
        selector: 'node.system',
        style: {
          ...text, ...transition,
          'background-color': 'data(color)', width: 'data(size)', height: 'data(size)', shape: 'data(shape)',
          'border-width': t.nodeOutlineWidth, 'border-color': t.nodeOutline,
          ...glowNode,
          ...nodeHalo,
          ...planet,
          ...logoStyle,
          label: 'data(label)', 'font-size': LABEL.system, 'font-weight': 500, 'line-height': 1.3,
          'text-valign': 'bottom', 'text-halign': 'center', 'text-margin-y': LABEL.margin, 'text-wrap': 'wrap', 'text-max-width': LABEL.maxWidth,
          'overlay-padding': 6, 'overlay-opacity': 0,
        },
      },
      {
        selector: 'node.domain',
        style: {
          ...transition,
          shape: 'round-rectangle', padding: 22,
          'background-color': 'data(color)', 'background-opacity': t.clusterFill,
          'border-width': 1.5, 'border-color': 'data(color)', 'border-opacity': 0.5,
          label: 'data(label)', 'font-family': t.font, 'font-size': LABEL.domain, 'font-weight': 600, color: t.ink2,
          'text-valign': 'top', 'text-halign': 'center', 'text-margin-y': -4,
          events: 'no',
        },
      },
      {
        selector: 'edge.link',
        style: {
          ...text, ...transition,
          width: 'data(width)', 'line-color': edgeColour, 'target-arrow-color': edgeColour, 'source-arrow-color': edgeColour, 'target-arrow-shape': 'triangle', 'arrow-scale': 0.9,
          'curve-style': 'bezier', 'control-point-step-size': 36, 'line-cap': 'round', opacity: t.edgeOpacity,
          ...edgeHalo,
          label: 'data(label)', 'font-size': LABEL.edge, 'font-weight': 600, color: t.ink2,
          'overlay-padding': 8, 'overlay-opacity': 0,
        },
      },
      { selector: 'edge.ls-dashed', style: { 'line-style': 'dashed', 'line-dash-pattern': DASH['ls-dashed'] } },
      { selector: 'edge.ls-dotted', style: { 'line-style': 'dashed', 'line-dash-pattern': DASH['ls-dotted'] } },
      { selector: 'edge.ls-ants', style: { 'line-style': 'dashed', 'line-dash-pattern': [6, 6] } },
      { selector: 'edge.two-way', style: { 'source-arrow-shape': 'triangle' } },
      ...(t.nodeGlow > 0 ? [{ selector: 'node.system[shape = "ellipse"]', style: { 'underlay-shape': 'ellipse' } }] : []),
      // "Not yet known" lines differ by pattern (dash-dot) as well as colour.
      { selector: 'edge.ls-unknown', style: { 'line-color': t.edgeUnknown, 'target-arrow-color': t.edgeUnknown, 'source-arrow-color': t.edgeUnknown, 'line-style': 'dashed', 'line-dash-pattern': DASH['ls-unknown'] } },
      { selector: '.hidden', style: { display: 'none' } },
      { selector: '.faded', style: { opacity: 0.25 } },
      { selector: '.dim', style: { opacity: 0.4 } },
      { selector: 'edge.hl, edge.pv', style: { ...glowEdge, 'line-color': 'data(color)', 'target-arrow-color': 'data(color)', 'source-arrow-color': 'data(color)', opacity: 1, 'z-index': 10 } },
      { selector: 'node.sel', style: { 'border-color': t.focus, 'border-width': 3 } },
      { selector: '.hover', style: { 'overlay-color': t.ink, 'overlay-opacity': 0.08 } },
      // Filter fades and the draw-on intro: last, so they win over the selection's opacity.
      { selector: '.entering, .leaving, edge.intro', style: { opacity: 0 } },
      { selector: '.leaving', style: { events: 'no' } },
    ];
  }
}
