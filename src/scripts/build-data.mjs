#!/usr/bin/env node
// Builds the map's data from the catalogue in this repo (catalogue/: domains.json, systems.json, integrations/*.json).
//
//   node scripts/build-data.mjs            web/data/integrations.json + site.json, out/build-report.md,
//                                          and the generated wiki page in out/wiki/
//   node scripts/build-data.mjs --check    validate only: print problems, write nothing
//
// Exits 1 on errors (a record that would make the map wrong); the pipeline then stops before deploying, so the
// last good map stays live. Warnings and data gaps never fail the build.

import { writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { buildFromStore } from './lib/store.mjs';
import { readStore, readJsonFile } from './lib/files.mjs';
import { compareText } from './lib/catalogue.mjs';
import { renderCataloguePage } from './lib/wiki-page.mjs';
import { loadSite } from './lib/site.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..'); // src/: catalogue, config, web
const REPO = resolve(ROOT, '..'); // the repo: out/ (report, wiki page)
const inPipeline = /^true$/i.test(process.env.TF_BUILD ?? '');

const { values: args } = parseArgs({
  options: {
    catalogue: { type: 'string' },
    config: { type: 'string', default: join(ROOT, 'config') },
    out: { type: 'string' },
    report: { type: 'string' },
    page: { type: 'string' },
    check: { type: 'boolean', default: false },
  },
});

const rel = (p) => relative(REPO, p).replace(/\\/g, '/');

function gitCommit() {
  if (process.env.BUILD_SOURCEVERSION) return process.env.BUILD_SOURCEVERSION;
  try {
    return execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

// Azure Pipelines logging commands: https://learn.microsoft.com/azure/devops/pipelines/scripts/logging-commands
const vsoEscape = (s) => String(s).replace(/%/g, '%AZP25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
function logIssue(i, fallbackPath) {
  const prefix = i.integration && !String(i.message).startsWith(i.file ?? '\0') ? `${i.integration}: ` : '';
  if (inPipeline) {
    const props = [`type=${i.level}`, `sourcepath=${i.file ?? fallbackPath}`, `code=${i.code}`].join(';');
    console.log(`##vso[task.logissue ${props}]${vsoEscape(prefix + i.message)}`);
  } else {
    console.log(`  ${i.level.toUpperCase().padEnd(7)} ${i.code.padEnd(16)} ${prefix}${i.message}`);
  }
}

const mdCell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, '<br>');

function renderReport(data, issues, ctx) {
  const by = (pred) => issues.filter(pred);
  const errors = by((i) => i.level === 'error');
  const warnings = by((i) => i.level === 'warning');
  const gaps = by((i) => i.code === 'DATA_GAP');
  const notes = by((i) => i.level === 'info' && i.code !== 'DATA_GAP');
  const out = ['# World Map build report', ''];
  out.push(`- Generated: ${ctx.generatedAt}`);
  out.push(`- Data: \`${ctx.dir}\`${ctx.commit ? ` at \`${ctx.commit.slice(0, 8)}\`` : ''}`);
  if (data) {
    const c = data.counts;
    out.push(`- Result: **${c.integrations} integrations**, **${c.systems} systems**, **${c.edges} lines** on the map; ${c.warnings} warnings, ${c.dataGaps} data gaps`);
  }
  out.push('');
  if (errors.length) {
    out.push('## Errors (the map was not updated)', '', '| Code | Message |', '|---|---|');
    for (const i of errors) out.push(`| ${i.code} | ${mdCell(i.message)} |`);
    out.push('');
  }
  out.push('## Warnings', '');
  if (warnings.length) {
    out.push('| Code | Integration | Message |', '|---|---|---|');
    for (const i of warnings) out.push(`| ${i.code} | ${mdCell(i.integration ?? '')} | ${mdCell(i.message)} |`);
  } else out.push('None.');
  out.push('');
  if (notes.length) {
    out.push('## Notes', '', '| Code | Message |', '|---|---|');
    for (const i of notes) out.push(`| ${i.code} | ${mdCell(i.message)} |`);
    out.push('');
  }
  out.push('## Data gaps', '', 'Values that are blank, `TBC`, or end in `?`. These show a ⚠ on the map.', '');
  if (gaps.length) {
    const byIntegration = new Map();
    for (const g of gaps) byIntegration.set(g.integration, [...(byIntegration.get(g.integration) ?? []), g.message]);
    out.push('| Integration | Gaps |', '|---|---|');
    for (const [id, items] of byIntegration) out.push(`| ${mdCell(id)} | ${mdCell(items.join('; '))} |`);
  } else out.push('None.');
  out.push('');
  if (data) {
    const domainName = new Map(data.domains.map((d) => [d.id, d.name]));
    out.push('## Systems', '', '| System | Domain | Type | Integrations (out / in) |', '|---|---|---|---|');
    for (const s of [...data.systems].sort((a, b) => b.degree - a.degree || compareText(a.name, b.name))) {
      out.push(`| ${mdCell(s.name)} | ${mdCell(domainName.get(s.domain))} | ${s.type} | ${s.degree} (${s.outbound} / ${s.inbound}) |`);
    }
    out.push('');
  }
  return out.join('\n');
}

async function main() {
  // Config first. A broken file is one BAD_JSON error naming it, rather than a stack trace.
  const configIssues = [];
  const config = (name, { optional = false } = {}) => {
    const path = join(args.config, name);
    if (optional && !existsSync(path)) return null;
    const { value, issue } = readJsonFile(path, rel(path));
    if (issue) configIssues.push(issue);
    return value ?? null;
  };
  const source = config('source.json');
  const vocab = config('vocab.json');
  const logos = config('logos.json', { optional: true });
  if (configIssues.length) {
    for (const i of configIssues) logIssue(i, rel(args.config));
    console.log(`${args.check ? 'Check failed' : 'Failed'}: ${configIssues.length} error(s).`);
    if (inPipeline && !args.check) console.log('##vso[task.complete result=Failed;]');
    process.exit(1);
  }

  const dir = resolve(ROOT, args.catalogue ?? source.store.dir);
  const generatedAt = new Date().toISOString();
  const commit = gitCommit();

  const store = readStore(dir, rel);
  const logoDir = join(ROOT, 'web', 'logos');
  const logoFiles = new Set(existsSync(logoDir) ? await readdir(logoDir) : []);
  const { data, issues } = buildFromStore({
    store, vocab, logos, logoFiles,
    source: {
      kind: 'store', dir: rel(dir), repoUrl: source.store.repoUrl, commit,
      pageUrl: source.generatedPage.pageUrl, originalPageUrl: source.catalogue.pageUrl, settingsFound: true,
    },
    meta: { generatedAt, commit },
  });
  // Site settings and presets are checked in --check too, so a broken site.json or preset fails the pipeline's tests.
  const { site, issues: siteIssues } = await loadSite(args.config);
  const allIssues = [...issues, ...siteIssues];

  console.log(`World Map data: ${rel(dir)} (${store.integrations.length} integrations, ${store.systems.length} systems, ${store.domains.length} domains)`);
  for (const i of issues.filter((x) => x.level !== 'info')) logIssue(i, rel(dir));
  for (const i of siteIssues) logIssue(i, rel(join(args.config, 'presets')));
  const errors = allIssues.filter((i) => i.level === 'error').length;

  if (args.check) {
    const warnings = (data?.counts.warnings ?? 0) + siteIssues.filter((i) => i.level === 'warning').length;
    console.log(errors ? `Check failed: ${errors} error(s).` : `Check passed: ${warnings} warnings, ${data.counts.dataGaps} data gaps.`);
    process.exit(errors ? 1 : 0);
  }

  const reportPath = resolve(REPO, args.report ?? source.report);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, renderReport(data, allIssues, { generatedAt, commit, dir: rel(dir) }), 'utf8');
  if (errors) {
    console.log(`Failed: ${errors} error(s). Report: ${reportPath}`);
    if (inPipeline) console.log('##vso[task.complete result=Failed;]');
    process.exit(1);
  }

  const outPath = resolve(ROOT, args.out ?? source.output);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  await writeFile(join(dirname(outPath), 'site.json'), JSON.stringify(site, null, 2) + '\n', 'utf8');
  const pagePath = resolve(REPO, args.page ?? 'out/wiki', source.generatedPage.path);
  await mkdir(dirname(pagePath), { recursive: true });
  await writeFile(pagePath, renderCataloguePage({ store, data, source }), 'utf8');

  const c = data.counts;
  console.log(`Done: ${c.integrations} integrations, ${c.systems} systems, ${c.edges} lines; ${c.warnings} warnings, ${c.dataGaps} data gaps.`);
  console.log(`Data:   ${outPath}`);
  console.log(`Report: ${reportPath}`);
  console.log(`Wiki:   ${pagePath}`);
  if (inPipeline && c.warnings > 0) console.log('##vso[task.complete result=SucceededWithIssues;]');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
