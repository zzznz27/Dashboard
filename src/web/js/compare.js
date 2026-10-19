// Side-by-side comparison of two presets on the same data: compare.html?left=<id>&right=<id>

import { h } from './dom.js';

const params = new URLSearchParams(location.search);
const site = await fetch('data/site.json', { cache: 'no-cache' }).then((r) => r.json());
const ids = site.presets.map((p) => p.id);
const pick = (wanted, fallback) => (ids.includes(wanted) ? wanted : fallback);
const state = {
  left: pick(params.get('left'), site.defaultPreset),
  right: pick(params.get('right'), ids.find((id) => id !== pick(params.get('left'), site.defaultPreset)) ?? ids[0]),
};

for (const side of ['left', 'right']) {
  const select = document.getElementById(side);
  select.replaceChildren(...site.presets.map((p) => h('option', { value: p.id, selected: p.id === state[side] }, p.label)));
  select.addEventListener('change', () => { state[side] = select.value; show(side); });
  show(side);
}

function show(side) {
  document.getElementById(`frame-${side}`).src = `index.html?preset=${encodeURIComponent(state[side])}&embed=1`;
  history.replaceState(null, '', `?left=${encodeURIComponent(state.left)}&right=${encodeURIComponent(state.right)}`);
}
