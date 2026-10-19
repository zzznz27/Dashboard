# Integration World Map: Design

This doc is the design reference for the map: the rules every design follows, how the data is drawn, the
layouts, animations and themes, how they're packaged as **presets** (designs), and how to try them, compare them
and pick between them without code changes. Examples use the sample catalogue in `src/catalogue/`.

---

## 1. Rules every design follows

These come from data-visualisation good practice. They apply to every preset.

- **Colour means domain.** Domains get categorical colours in a fixed order from a palette
  that has been checked for colour blindness. Colours are never assigned by rank, so
  filtering never repaints the systems that remain. The palette is validated against each
  theme's background before it ships.
- **Colour is never the only cue.** Six domains is more colours than can be told apart
  reliably when any two nodes can sit side by side. So domain is always shown a second way
  as well: cluster boxes with names (clusters view), a label on every node plus a legend
  (network view), or grouped row and column headers (matrix view).
- **Status colours are reserved.** The good/warning/serious/critical colours are never used
  for domains. Their only use is a ⚠ badge for uncertain data, always shown with an
  icon and a tooltip.
- **Highlight rather than recolour.** Selecting a system keeps it and its neighbours in
  colour and fades everything else to grey.
- **A table view always exists.** It's the accessible fallback and the place for exact lookups.
- **Hover works everywhere.** Every node, edge and matrix cell has a tooltip, and the
  clickable area is larger than the visible mark.
- **Motion respects the user.** If the operating system's *reduce motion* setting is on,
  all ambient animation is off, whatever the preset says (§5.4).
- **Text is never drawn in a series colour.** Labels use the text colours; the coloured
  mark next to them carries the identity.

**Palette check results (Clean Light and Ops Dark, using a data-visualisation palette validator)**

| Check | Clean Light (background `#fcfcfb`) | Ops Dark (background `#101a2b`) |
|-------|-----------------------------------|----------------------------------|
| Neighbouring colours (legend, matrix headers) | Pass. Worst colour-blind ΔE 9.1 (target ≥ 8). | Pass. Worst ΔE 8.4. |
| Contrast against background | Aqua, yellow and magenta are below 3:1. That's allowed only if every mark also has a visible label or a table view, which ours do: all nodes are labelled, and there's a table view. | Pass, all ≥ 3:1 |
| Any two colours side by side (graph views) | **Fails**, as expected for 6 colours | **Fails** |

So in the graph views, colour is never the only way to tell domains apart:
- **Clusters (L1):** named domain boxes.
- **Network (L2):** a domain line under each system name.
- **Matrix (L3):** text group headers.

The matrix ramp was re-stepped in Ops Dark so that every shade's number clears 4.5:1 contrast. The other themes'
domain colours are distinct hues but haven't had the same colour-blind check (§6); run it before relying on one.

## 2. Visual encoding (the same in every preset)

| Data | How it's shown |
|------|----------------|
| System | Node, labelled with its canonical name |
| Domain | Node colour **plus** cluster, legend or header (see §1) |
| How connected a system is | Node size (number of integrations). In the sample, the ERP is the largest. |
| Internal vs external | Node shape: rounded rectangle for internal (a platform your organisation runs), ellipse for external (a vendor or partner system) |
| Integrations between two systems | **One edge per direction per pair** (and per line kind, §4), width growing with count, count label when more than 1. Click to list them. Example: three integrations from the E-commerce Store to the ERP would be one edge labelled "3". |
| Direction | Arrowhead, plus line animation in presets that use it |
| Pattern | Line style (§4): **solid** = publish-subscribe or API (including claim-check); **dashed** = file or MFT; **dotted** = out-of-the-box or dual-write; thin grey = TBC or blank |
| Schedule / frequency | Animation speed (§5.2) |
| Uncertain data (`TBC`, `?`, blank) | Small ⚠ badge with tooltip text |

Edges are neutral grey by default. When a system is selected, its edges take the *source* system's domain colour.

**Domains** live in `src/catalogue/domains.json`; their order sets their colours (8 slots, then grey). The sample's:

| Domain | Sample systems |
|--------|---------|
| Finance | ERP, Bank, Payment Gateway, Expense Management |
| Customer | CRM, E-commerce Store, Marketing Platform |
| People | HR System, Payroll, Learning Platform |
| Operations | Warehouse Management, Shipping Carrier, Supplier Portal |
| IT & Security | Identity Provider, Service Desk |
| Data & Analytics | Data Warehouse |
| *Unassigned* (grey) | Any system whose domain isn't in `domains.json` (the check reports it) |

## 3. Layouts

**L1: Domain clusters ("world map")**
Systems are grouped into labelled boxes ("continents") by domain. Integrations are the
routes between them.

```text
┌ Finance ─────────────────────┐            ┌ Customer ──────────────────┐
│  Bank        Payment Gateway │◀══ 1 ══════│  E-commerce Store   CRM    │
│          ( ERP )             │◀══ 1 ══════│  Marketing Platform        │
│  Expense Management          │            └────────────────────────────┘
└──────────────┬───────────────┘
               │ 1       ┌ Data & Analytics ─┐   ┌ People ─────────────────────┐
               └────────▶│  Data Warehouse   │   │ HR System  Payroll  LMS     │
                         └───────────────────┘   └─────────────────────────────┘
```

- Good for: "which parts of the business depend on Finance?" and explaining the landscape to newcomers.
- Watch for: the boxes take space, and a domain with one system (Data & Analytics) looks sparse. The layout
  is spread out, so labels end up smaller than in the network view, and lines between domains are long.
- How: Cytoscape compound nodes (domain is the parent) with the `fcose` layout.

**L2: Force-directed network**
An organic layout with no boxes. Busy systems drift to the centre; in the sample, the ERP becomes the hub.

- Good for: spotting hubs, single points of failure, and systems that sit off on their own. The most readable
  at the default zoom.
- Watch for: positions could shift when the data changes, so the starting positions are seeded from system
  names: the same data always produces the same picture.
- How: Cytoscape `fcose` without parents; node size by number of integrations.

**L3: Adjacency matrix**
A grid with sources as rows and targets as columns. Each cell shows how many integrations
run from that source to that target, shaded light to dark in a single hue. Rows and columns
are grouped by domain.

```text
                       target →   ERP   Bank   CRM   Payroll   Data Warehouse
source ↓  ERP                      ·     1      ·      ·             1
          Bank                     1     ·      ·      ·             ·
          CRM                      1     ·      ·      ·             1
          Payroll                  1     1      ·      ·             ·
          HR System                ·     ·      ·      1             ·
```

- Good for: exact "does X talk to Y?" lookups, accessibility, and scaling to hundreds of integrations.
- Watch for: less visually striking, and it doesn't show indirect paths.
- How: plain HTML grid. Click a cell to list its integrations. A two-way integration counts in both directions' cells.

**Spacing.** Both graph layouts space nodes well apart. The settings are in `LAYOUTS` in
`src/web/js/views/graph.js`; a preset can override them with `layoutOptions`, no code needed. After the layout
runs, it's stretched sideways to the shape of the screen (at most 2×) before fitting, because force layouts come
out roughly square and would leave half a wide screen empty. Labels keep their on-screen size when the map is
zoomed out to fit: the text grows by up to 2× below 100% zoom.

**Candidates not built**

| Option | Notes |
|--------|-------|
| Hub & spoke | The busiest system at the centre, others in rings by connection count (Cytoscape `concentric`). Cheap to add as a preset. |
| Transit map | Metro-map look with right-angled lines and station dots (Cytoscape `taxi` edges). Fits the "world map" name; needs tuning. |
| Chord diagram | Attractive for showing volume between domains; weak for clicking into detail. Would need D3. |
| Sankey | **Not recommended.** Many integrations run both ways, which creates loops that Sankey diagrams handle badly. |

## 4. Line kinds

A line's style shows its integrations' **kind**: solid for publish-subscribe / API, dashed for file, dotted for out of
the box / dual-write, thin dash-dot for not yet known. The data build sets each integration's kind (`lineKindOf` in
`src/scripts/lib/catalogue.mjs`): its pattern's group from `src/config/vocab.json`, except that a publish-subscribe or
not-yet-known pattern with a `File…` or `Recurring Import/Export` protocol at either end is a file integration. In
the sample, Supplier Portal → ERP *supplier invoices* (Claim-Check, File → API) and ERP → Data Warehouse
*financial transactions* (Publisher-Subscriber (Claim-Check), Recurring Export → File (Blob Storage)) are file
integrations. The Pattern filter and the legend use the same kinds.

**One line per kind** between a pair of systems, by default: if a pair has both file and API integrations, it shows
a dashed line beside a solid one, instead of one solid line hiding the file integrations. **One line per pair** in
⚙ Map settings merges them, drawn as the kind most of its integrations are (ties: API, file, out of the box,
unknown); its details list the kinds it carries.

Dash and dot spacing is set in screen pixels and scaled with zoom, so patterns stay visible when the map is zoomed out
(dots 7 px apart).

**Two-way patterns.** A pattern marked `"twoWay": true` in `src/config/vocab.json` (in the sample, *Synchronous POST
Request*: the E-commerce Store asks the Warehouse Management system for stock levels and gets them back in the same
call) gets its own line between the two systems, with arrows at both ends. The one-way lines stay as they are.
Animations travel both ways along it, the matrix counts it in both directions' cells, and the panel and tooltips
show ↔.

## 5. Animations

Animations apply to the graph views (L1, L2). The matrix (L3) gets hover and selection highlighting only.

### 5.1 Base options

| ID | Name | What it does | Notes |
|----|------|--------------|-------|
| A0 | None | Static | Forced on when *reduce motion* is set, and for printing |
| A1 | **Line animation** (`animation.ambient`) | Something travels along each line from source to target; speed follows frequency (§5.2). Styles in §5.3. | The most informative option; can be noisy. Viewers can limit it to the selected system (§5.4). |
| A2 | Marching ants | The dashes of each edge move towards the target | Shows direction only. Moving dashes clash with the dashed and dotted pattern lines, so presets using ants show pattern in the tooltip and details panel instead of in line style (`"edges": { "styleBy": "none" }`). |
| A3 | Focus pulse (`onSelect`) | No constant motion. On selection, neighbours ripple in and everything else fades (about 300 ms). | Calm; good default |
| A4 | Settle on load (`settle`) | The layout visibly settles over about 1 s on first load, then stops | Gives a sense of "live" without constant motion |

### 5.2 Frequency → speed

| Schedule value (from `vocab.json`) | Speed |
|---------------------------------|------|
| Event-based, real-time, 5 minutes | Fast (~1.4 s per trip along the line) |
| Every 30 minutes, "can be > 30 mins" | Medium (~3 s) |
| Daily, fortnightly, monthly | Slow (~5.5 s) |
| TBC, N/A, blank | **Hollow** dots at a steady ~3.5 s. Set `"animateUnscheduled": false` in a preset to keep these lines still instead. |
| Any value ending in `?` | Treated as the base value, plus the ⚠ badge |

Each line shows up to 4 travellers, one per integration. Every line moves, including unscheduled ones, and slow
trips stay under 6 s: when slow lines barely moved, the busiest lines in the centre looked frozen and people read
the animation as broken.

### 5.3 Line animation styles

| Style (`ambient`) | What moves | Two-way lines |
|---|---|---|
| `flow` | Small dots (radius about 3 px) | A dot goes out, fades on landing, then a reply comes back |
| `comets` | A glowing head with a tail; longer tails for more frequent schedules | Same |
| `packets` | Small data blocks lined up with the line, bits changing as they go | Replies are outlined |
| `pulse` | A band of light sweeps the line; the receiving system rings on arrival | Same |
| `water` | Ripples run along the line and splash at the receiving system | Flows out, calm, flows back |
| `lightning` | A forked bolt along the line, flickering, lighting up the receiving system | Strikes each way in turn |
| `ants` | Dashes along the line | Forward, then back |

They're drawn by `src/web/js/views/ambient.js` on an overlay canvas sized to the map in CSS pixels (otherwise, at
125% or 150% display scaling, the dots drift off their lines).

### 5.4 Calm motion and reduced motion

Motion should support reading the map rather than compete with it:
- People can only follow a few moving things at once, and fewer when they're fast. Motion should be meaningful
  ([staged animation of dynamic networks](https://arxiv.org/pdf/2009.02005)).
- Animated changes between views helped people read charts, especially with simple staging
  ([Heer & Robertson 2007](https://idl.uw.edu/papers/animated-transitions)).
- Some people find animated lines distracting
  ([Holten et al. 2011](https://petra.isenberg.cc/publications/papers/Holten_2011_AEP.pdf)).
- Glanceable displays should change subtly and let people move between glancing and looking closely.
- Hover-to-highlight a system's connections is the most common way graph tools let people explore
  ([sigma.js](https://v4.sigmajs.org/how-to/interactivity/hover-search/)).

Two options are on for everyone (preset options under `animation`; set one to `false` to turn it off, or untick it
in the lab). Two more are each viewer's choice in ⚙ Map settings, off unless chosen, and remembered in that browser:

| Option | Where | What it does |
|---|---|---|
| Draw lines on load (`drawOn`) | On by default | After the settle, each line traces once from source to target, sweeping left to right, then stays still |
| Fade when filters change (`filterFade`) | On by default | Items a filter removes fade out, and items it brings back fade in, instead of popping (systems keep their places) |
| Animate only what I select | ⚙ Map settings | Lines stay still until a system is selected (or previewed on hover); then only its lines animate |
| Preview connections on hover | ⚙ Map settings | While nothing is selected, pointing at a system dims what it isn't connected to (to 40%), until the pointer leaves |

When the OS has *reduce motion* on (Windows: Settings → Accessibility → Visual effects → *Animation effects* off),
all motion is off: settle, line animation, the intro, fades and pulse, and theme effects are drawn still. The hover
preview still works, without the fade. The **Animations** switch in ⚙ Map settings overrides the OS setting either
way (on, or off when the OS allows motion); the choice is remembered in that browser.

Considered but not built: tapered lines (static), dot spacing by integration count, and bundled curved lines
(needs a layout rework).

## 6. Themes

Picked from the header; the choice is remembered in the browser. Until a viewer picks one, the page uses the
design's theme. `?theme=<id>` in the URL sets it too.

| Theme (`id`) | Look | Effect | Line animation |
|---|---|---|---|
| Clean Light (`clean-light`) | Light background, crisp lines | None | Packets |
| Ops Dark (`ops-dark`) | Dark navy background, high-contrast labels, soft glow | None | Packets |
| Neon (`neon`) | Near-black violet, saturated domain colours | Every node and line glows in its own colour | Pulse |
| Synthwave (`synthwave`) | Neon on a purple dusk | A perspective grid running to a glowing horizon | Pulse |
| Eucalypt (`eucalypt`) | Light, natural: sage, ochre, wattle gold, waterhole teal | None (calm) | Flow |
| Nature (`nature`) | Forest greens on pale moss | Topographic contour lines behind the map | Water |
| Forest Night (`forest-night`) | Deep green dark, soft glow | Fireflies drifting and blinking behind the map | Flow |
| Space (`space`) | Nebula backdrop | Parallax starfield with shooting stars, planet nodes, and stars orbiting each system in 3D (one per line, in the colour of the system at the other end; can be switched off in ⚙ Map settings) | Comets |

Each theme is a block of colour and type tokens in `src/web/styles/themes.css` (`:root[data-theme="<id>"]`), read
by the graph view for its Cytoscape style. Effects are tokens too (`--sky`, `--orbits`, `--planets`,
`--node-glow`…), drawn by `src/web/js/views/effects.js`. Ops Dark's glow is a translucent border in the node's own
colour: the library's underlay effect drew square halos behind round nodes. Text uses the system font; there are no
web fonts to load.

**Each theme has its own line animation** (the last column, `ambient` in `THEMES` in `src/web/js/theme.js`).
Picking a theme in the header brings its animation and logos and keeps the layout. In the design lab, a theme change
keeps the animation chosen there, so any mix can still be made and saved.

The World Map's own mark (the header icon in `src/web/index.html`, and `src/web/favicon.svg`) is recoloured per
theme by the `--logo-*` tokens.

## 7. Map details

- **Legend:** "How to read the map" is collapsed by default, so the legend doesn't cover the graph. On a short
  laptop screen (1280×720) the legend can still cover the bottom-left of the map.
- **Uncertain data:** a line carries ⚠ when any integration on it has unconfirmed details.
- **Filtering:** keeps the layout in place and hides what doesn't match. **Fit** re-centres the view.
- **Logos.** Logo files go in `src/web/logos/`; `src/config/logos.json` maps them to systems, and
  `src/web/logos/SOURCES.md` records the source of each. The sample ships with none.
  - **Panel and tooltips** (every design): the full-colour logo sits on a white chip beside the system name.
  - **One-colour marks on nodes** (`"nodes": { "logo": "mark" }`, every ready-made design): the brand's symbol drawn
    in white on the domain colour. A mark on a solid background has the background dropped first, blended from its
    four corner colours. Check each brand's guidelines before adding it: many don't allow recolouring.
  - A system without a mark shows its name if it's one short word (Payroll), otherwise its initials.
  - Each mark is trimmed to its visible content and sized to fill its node's shape: in a circle the mark's diagonal
    is 84% of the node, in a rounded square its longer side is 60%. Wide wordmarks fill their node like the rest.
  - Full-colour badges on nodes (the logo on a white disc ringed in the domain colour) were tried and dropped:
    wordmarks were unreadable at node size, and wide ones were squashed into a square.
  - Speed: each mark is drawn once to a small square image, kept as a short `blob:` URL. Long `data:` URLs made
    Cytoscape slow on every style change, and clipping each image to its node made every redraw slow.

## 8. Presets and iteration

### 8.1 Presets

A preset (design) is one JSON file in `src/config/presets/` that names a view, a layout, a theme and the animation
options. Options it leaves out take the defaults in `src/scripts/lib/site.mjs`, which also checks the values.

```json
{
  "id": "clusters-dark-flow",
  "label": "Control room",
  "round": 1,
  "view": "graph",
  "layout": "clusters",
  "theme": "ops-dark",
  "animation": { "ambient": "packets", "onSelect": "focus-pulse", "settle": true },
  "labels": { "showDomain": false },
  "edges": { "styleBy": "pattern", "flagUncertain": true },
  "nodes": { "logo": "mark" },
  "layoutOptions": {}
}
```

| Field | Values |
|---|---|
| `view` | `graph` or `matrix` |
| `layout` | `clusters` (L1) or `network` (L2); graph view only |
| `theme` | A theme `id` from §6 |
| `animation.ambient` | `none`, `flow`, `ants`, `comets`, `packets`, `pulse`, `water`, `lightning` |
| `animation.onSelect` | `none` or `focus-pulse` |
| `animation.settle`, `drawOn`, `filterFade`, `animateUnscheduled` | `true` / `false` (§5) |
| `labels.showDomain` | Show the domain under each system name (the network view's second cue for domain) |
| `edges.styleBy` | `pattern` (line style by kind) or `none` |
| `nodes.logo` | `mark` or `none` |
| `layoutOptions` | Overrides for the layout's spacing settings |
| `round` | Optional; the design round the preset was made in |

### 8.2 Trying, comparing, choosing

| Mechanism | How it works |
|-----------|--------------|
| **Preset by URL** | `?preset=clusters-dark-flow` loads that preset |
| **Lab panel** | **Customise…** in the Theme list (or `?lab=1`) shows a floating panel to mix layout, theme and animation live. Anyone can save a mix as their own design (kept in their browser, listed under *My designs*, shareable as a `.worldmap.json` file). On the local preview it also has **Copy as preset**, which gives you the JSON to save as a new preset file |
| **Side by side** | `compare.html?left=<id>&right=<id>` shows two presets next to each other on the same data |
| **Promote** | Set `defaultPreset` in `src/config/site.json`, merge, and it's live |
| **Roll back** | Set it back |

To view locally, run `npm run dev`, then open:

| Page | URL |
|------|-----|
| Default design | <http://localhost:8080/> |
| A specific preset | <http://localhost:8080/?preset=network-dark-ants> |
| Design lab | <http://localhost:8080/?lab=1> |
| Side by side | <http://localhost:8080/compare.html?left=clusters-light-marks&right=network-dark-ants> |

Editing a file in `src/config/presets/` only needs a browser refresh.

### 8.3 Ready-made designs

One per theme and layout, plus the two matrix designs, each following its theme's line animation (§6). The default
is `clusters-light-marks`.

| Preset | Label | View | Theme | Line animation |
|---|---|---|---|---|
| `clusters-light-marks` | Everyday | L1 Clusters | Clean Light | Packets |
| `network-light-calm` | Open web | L2 Network | Clean Light | Packets |
| `clusters-dark-flow` | Control room | L1 Clusters | Ops Dark | Packets |
| `network-dark-ants` | Night network | L2 Network | Ops Dark | Packets (line style off, domain under names) |
| `clusters-neon-flow` | Neon glow | L1 Clusters | Neon | Pulse |
| `network-neon-lightning` | Neon pulse | L2 Network | Neon | Pulse |
| `network-synthwave-pulse` | Synthwave | L2 Network | Synthwave | Pulse |
| `clusters-eucalypt-marks` | Eucalypt | L1 Clusters | Eucalypt | Flow |
| `clusters-nature-water` | Riverside | L1 Clusters | Nature | Water |
| `network-forest-night` | Fireflies | L2 Network | Forest Night | Flow |
| `network-space-orbits` | Deep space | L2 Network | Space | Comets |
| `clusters-space-lightning` | Space storm | L1 Clusters | Space | Lightning |
| `matrix-light` | Grid | L3 Matrix | Clean Light | (hover highlight) |
| `matrix-dark` | Grid after dark | L3 Matrix | Ops Dark | (hover highlight) |

Some ids keep the animation they were first built with (`-ants`, `-flow`, `-lightning`); the table shows what each
file sets now.

## 9. Custom themes and designs

**A new design** needs no code: save a mix from the lab, or add a JSON file to `src/config/presets/` (§8.1).

**A new theme:**
1. Add a `:root[data-theme="<id>"]` block to `src/web/styles/themes.css`, copying an existing theme's tokens:
   surfaces, ink, edge colours, `--domain-1` … `--domain-8` and `--domain-none`, glow and effect tokens, and the
   `--logo-*` colours for the World Map mark.
2. Add it to `THEMES` in `src/web/js/theme.js` (label and line animation) and in `src/scripts/lib/site.mjs`, which
   checks preset values.
3. Add a preset per layout that uses it (§8.3), following its line animation.
4. Check the domain colours: distinct for each slot in use, readable against the background (3:1, or labelled), and
   checked under colour-blindness (§1). If logos are on, white marks need about 3.5:1 against each domain colour.
   A domain's colour comes from its slot (its place in `domains.json`), so slot 1 should be the same kind of colour
   in every theme if you want domains to feel the same when switching.

**Viewers' own designs** stay in the viewer's browser, appear under *My designs*, and can be shared as a
`.worldmap.json` file (`src/web/js/designs.js`).

## 10. Review checklist

Use it for every design change. The examples use the sample catalogue; swap in your own systems.

1. **Find it:** someone new answers "What does Payroll send to the ERP?" Target: under 30 seconds.
2. **Impact:** "Which systems are affected if the Identity Provider is down?" Can you see it at a glance?
3. **Legibility:** readable on a 14" laptop at 100% zoom, and on a meeting-room screen.
4. **Motion:** after a minute of looking, is the animation helping or distracting?
5. **Accessibility:** check with the browser's colour-blindness emulation (deuteranopia,
   protanopia) and with *reduce motion* on.
6. **Growth:** load a synthetic dataset 3× the size of your catalogue. Is it still readable?
