// Legend for the graph views. Domain keys are interactive: hover to emphasise, click to filter.
// The legend can be collapsed (it starts collapsed on small screens); its open sections survive redraws.

import { h, fill, swatch } from './dom.js';
import { satellitesOn } from './theme.js';
import { lineKind } from './data.js';

const NS = 'http://www.w3.org/2000/svg';
// Same dash patterns as the map's lines (graph.js).
const DASH = { file: '7 5', platform: '0.1 5', unknown: '10 3 1 3' };

// Open/closed state of the legend and its "How to read" section, kept across redraws for this page.
const open = { legend: !window.matchMedia('(max-width: 900px)').matches, howto: false };

function lineSample(colour, group) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', '26');
  svg.setAttribute('height', '8');
  svg.setAttribute('aria-hidden', 'true');
  const line = document.createElementNS(NS, 'line');
  for (const [k, v] of Object.entries({ x1: 2, y1: 4, x2: 24, y2: 4, stroke: colour, 'stroke-width': group === 'unknown' ? 1.5 : 2, 'stroke-linecap': 'round' })) line.setAttribute(k, v);
  if (DASH[group]) line.setAttribute('stroke-dasharray', DASH[group]);
  svg.append(line);
  return svg;
}

export function renderLegend(el, model, preset, ctx) {
  const { idx, tokens, data } = ctx;
  const present = new Set([...model.systemIds].map((id) => idx.systems.get(id)?.domain));
  const domains = data.domains.filter((d) => present.has(d.id));
  const groupsPresent = new Set([...model.edges.values()].map(lineKind));
  const showLines = preset.edges.styleBy === 'pattern' && preset.animation.ambient !== 'ants';
  const active = ctx.filters.domain;

  const domainKeys = domains.map((d) =>
    h('li', {}, h('button', {
      type: 'button',
      class: 'domain-key',
      'aria-pressed': String(active === d.id),
      dataset: { focusKey: `domain:${d.id}` },
      title: active === d.id ? 'Click to show all domains' : `Hover to highlight, click to show only ${d.name}`,
      onmouseenter: () => ctx.preview({ type: 'domain', id: d.id }),
      onmouseleave: () => ctx.preview(null),
      onfocus: () => ctx.preview({ type: 'domain', id: d.id }),
      onblur: () => ctx.preview(null),
      onclick: () => ctx.setFilter('domain', active === d.id ? '' : d.id),
    }, swatch(tokens.domain(d.slot)), d.name)),
  );

  const lineKeys = ['pubsub', 'file', 'platform', 'unknown']
    .filter((g) => groupsPresent.has(g))
    .map((g) => h('li', {}, lineSample(g === 'unknown' ? tokens.edgeUnknown : tokens.edge, g), data.patternGroups?.[g]?.label ?? g));

  const twoWayNote = ' On a two-way line it goes out, then a reply comes back.';
  const motion = {
    flow: `Moving dots show which way data flows. Faster = more frequent schedule${preset.animation.animateUnscheduled !== false ? '; hollow dots = no schedule recorded' : ''}.${twoWayNote}`,
    ants: 'Moving dashes show which way data flows. Faster = more frequent schedule.',
    comets: `Comets travel the way data flows. Faster, with a longer tail = more frequent schedule.${twoWayNote}`,
    packets: 'Data packets travel the way data flows. Faster = more frequent schedule. On a two-way line, outlined packets are the replies.',
    pulse: `A pulse of light travels the way data flows, and the receiving system rings when it lands. Faster = more frequent schedule.${twoWayNote}`,
    water: 'Ripples run the way data flows and splash at the receiving system. Faster = more frequent schedule.',
    lightning: 'A bolt strikes along each line and lights up the receiving system. More frequent schedule = more strikes.',
  }[preset.animation.ambient] ?? null;

  const legend = h('details', { class: 'legend-box', open: open.legend, ontoggle: (e) => { open.legend = e.target.open; } },
    h('summary', {}, 'Legend'),
    h('section', {}, h('h3', {}, 'Domains'), h('ul', {}, domainKeys)),
    showLines && lineKeys.length ? h('section', {}, h('h3', {}, 'Integration pattern'), h('ul', {}, lineKeys)) : null,
    h('details', { class: 'howto', open: open.howto, ontoggle: (e) => { open.howto = e.target.open; } }, h('summary', {}, 'How to read the map'), h('ul', {},
      h('li', {}, swatch(tokens.ink2, true), 'Internal'),
      h('li', {}, swatch(tokens.ink2), 'External'),
      h('li', {}, 'Bigger = more integrations'),
      h('li', {}, 'Arrow = direction of data · number = integrations on that line'),
      h('li', {}, '⚠ = some details not confirmed'),
      motion ? h('li', {}, motion) : null,
      tokens.orbits && satellitesOn() ? h('li', {}, 'Stars circling a system = its connections, in the colour of the system at the other end') : null,
      h('li', {}, 'Animation and satellites can be switched off under ⚙ (top right)'),
    )),
  );
  fill(el, legend);
}
