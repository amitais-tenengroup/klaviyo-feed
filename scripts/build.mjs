// Feed build: fetch source -> validate -> filter -> publish -> snapshots & stats -> static site.
//
//   node scripts/build.mjs                 normal build (used by the 3x/day schedule)
//   node scripts/build.mjs --mode force    skip the drop guard
//   node scripts/build.mjs --mode rollback swap the live feed with the previous version
//
// State lives in ./state (persisted on the `feed-state` branch by the workflow).
// The public site is written to ./_site and deployed to GitHub Pages.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const STATE = path.join(ROOT, 'state');
const SITE = path.join(ROOT, '_site');
const cfg = JSON.parse(await fs.readFile(path.join(ROOT, 'feed.config.json'), 'utf8'));
const modeArg = process.argv.indexOf('--mode');
const mode = (modeArg >= 0 && process.argv[modeArg + 1]) || 'build';
if (!['build', 'force', 'rollback'].includes(mode)) throw new Error(`Unknown mode "${mode}"`);

const WINDOWS = [7, 30, 90];
const LIST_CAP = 1000;
const P = {
  feed: path.join(STATE, cfg.feedFile),
  feedMeta: path.join(STATE, 'feed-meta.json'),
  prev: path.join(STATE, 'previous.json'),
  prevMeta: path.join(STATE, 'previous-meta.json'),
  index: path.join(STATE, 'latest-index.json'),
  stats: path.join(STATE, 'stats.json'),
  runs: path.join(STATE, 'runs.json'),
  history: path.join(STATE, 'history.json'),
  snapDir: path.join(STATE, 'snap'),
};

// ---------- rules ----------

// An item is kept only if it has at least one non-blank category.
// Source format is a comma-separated string ("Ring Sale,All Rings"); arrays are handled too.
export function hasCategory(item) {
  const c = item.Categories;
  if (Array.isArray(c)) return c.some((s) => String(s).trim() !== '');
  if (typeof c === 'string') return c.split(',').some((s) => s.trim() !== '');
  return false;
}

const inStock = (item) => item.availability === 'In Stock';

// ---------- helpers ----------

const day = (d = new Date()) => d.toISOString().slice(0, 10);
const addDays = (iso, n) => day(new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000));
const exists = (f) => fs.access(f).then(() => true, () => false);
async function readJSON(f, fallback) {
  try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return fallback; }
}
const writeJSON = (f, v) => fs.writeFile(f, JSON.stringify(v));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function fetchWithRetry(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(120_000) });
      if (res.ok) return res;
      last = new Error(`Source returned HTTP ${res.status}`);
      if (res.status < 500) break;
    } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 10_000 * (i + 1)));
  }
  throw last;
}

// ---------- build ----------

async function build(run, { force }) {
  // 1. Fetch source
  const res = await fetchWithRetry(cfg.sourceUrl);
  const bytes = Buffer.from(await res.arrayBuffer());
  const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  run.sourceBytes = bytes.length;
  run.sourceLastModified = res.headers.get('last-modified');

  // 2. Parse & validate
  let items;
  try { items = JSON.parse(bytes.toString('utf8', hasBom ? 3 : 0)); }
  catch (e) { throw new Error(`Source is not valid JSON: ${e.message}`); }
  if (!Array.isArray(items)) throw new Error('Source JSON is not an array');
  if (items.length < cfg.minItems) throw new Error(`Source has ${items.length} items (< minItems ${cfg.minItems})`);
  const noSku = items.filter((x) => !x || !x.SKU).length;
  if (noSku) throw new Error(`${noSku} source items have no SKU`);

  // 3. Filter
  const kept = [];
  const excluded = [];
  for (const it of items) (hasCategory(it) ? kept : excluded).push(it);
  run.sourceCount = items.length;
  run.keptCount = kept.length;
  run.excludedCount = excluded.length;

  // 4. Guard against a sudden collapse of the catalog
  const prevIndex = await readJSON(P.index, null);
  const prevCount = prevIndex ? Object.keys(prevIndex.items).length : 0;
  if (!force && prevCount && kept.length < prevCount * (1 - cfg.maxDropPct / 100)) {
    throw new Error(
      `Guard: feed would drop from ${prevCount} to ${kept.length} items (> ${cfg.maxDropPct}%). ` +
      'Not published. Run the workflow manually with mode "force" if this is intended.'
    );
  }

  // 5. Serialize exactly like the source (compact JSON, same key order, BOM if source had one)
  const out = Buffer.from((hasBom ? '﻿' : '') + JSON.stringify(kept), 'utf8');
  const hash = sha256(out);
  run.feedBytes = out.length;
  run.sha256 = hash;

  // 6. Publish (the site is deployed as one unit, so Klaviyo sees either the old or the new file)
  const meta = await readJSON(P.feedMeta, null);
  if (meta?.sha256 === hash) {
    run.status = 'unchanged';
  } else {
    if (await exists(P.feed)) {
      await fs.copyFile(P.feed, P.prev);
      await writeJSON(P.prevMeta, meta);
    }
    await fs.writeFile(P.feed, out);
    await writeJSON(P.feedMeta, { sha256: hash, builtAt: run.startedAt, count: kept.length, runId: run.id });
    run.status = 'published';
  }

  // 7. Snapshots, history and dashboard stats
  await writeState({ kept, excluded, run });
}

// ---------- state / stats ----------

const toRow = (it) => ({
  t: it.Title,
  a: inStock(it) ? 1 : 0,
  q: Number(it.$inventory_quantity) || 0,
  p: it.Price,
  pt: it.product_type,
  f: it.Family,
  c: it.Categories,
  l: it.ProductLink,
  i: it.ImageUrl,
});

async function writeState({ kept, excluded, run }) {
  const today = day();
  const index = { builtAt: run.startedAt, items: {}, excluded: {} };
  for (const it of kept) index.items[it.SKU] = toRow(it);
  for (const it of excluded) index.excluded[it.SKU] = toRow(it);
  await writeJSON(P.index, index);

  // Daily snapshot (last build of the day wins): sku -> [title, inStock, price, link]
  await fs.mkdir(P.snapDir, { recursive: true });
  const snap = {};
  for (const [sku, r] of Object.entries(index.items)) snap[sku] = [r.t, r.a, r.p, r.l];
  await writeJSON(path.join(P.snapDir, `${today}.json`), snap);

  // Prune old snapshots
  const oldestKeep = addDays(today, -cfg.historyDays);
  const snapDays = (await fs.readdir(P.snapDir)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, 10)).sort();
  for (const d of snapDays.filter((d) => d < oldestKeep)) await fs.rm(path.join(P.snapDir, `${d}.json`));
  const available = snapDays.filter((d) => d >= oldestKeep);

  // Changes vs N days ago (or vs the oldest snapshot if history is still shorter than N)
  const changes = {};
  const cache = {};
  for (const n of WINDOWS) {
    const target = addDays(today, -n);
    const older = available.filter((d) => d <= target);
    const baseDay = older.length ? older[older.length - 1] : available.find((d) => d < today);
    if (!baseDay) { changes[n] = { baseline: null, partial: true }; continue; }
    cache[baseDay] ||= await readJSON(path.join(P.snapDir, `${baseDay}.json`), {});
    changes[n] = { baseline: baseDay, partial: baseDay > target, ...diff(cache[baseDay], index.items) };
  }

  // Daily history for the chart
  const history = await readJSON(P.history, []);
  const point = {
    date: today,
    total: kept.length,
    inStock: kept.filter(inStock).length,
    outOfStock: kept.filter((x) => !inStock(x)).length,
    excluded: excluded.length,
    source: run.sourceCount,
  };
  const i = history.findIndex((h) => h.date === today);
  if (i >= 0) history[i] = point; else history.push(point);
  history.sort((a, b) => a.date.localeCompare(b.date));
  await writeJSON(P.history, history.slice(-400));

  const meta = await readJSON(P.feedMeta, {});
  await writeJSON(P.stats, {
    generatedAt: run.startedAt,
    sourceUrl: cfg.sourceUrl,
    feedFile: cfg.feedFile,
    repo: process.env.GITHUB_REPOSITORY || null,
    source: { count: run.sourceCount, bytes: run.sourceBytes, lastModified: run.sourceLastModified },
    feed: {
      count: point.total,
      inStock: point.inStock,
      outOfStock: point.outOfStock,
      bytes: (await fs.stat(P.feed)).size,
      sha256: meta.sha256,
      publishedAt: meta.builtAt,
    },
    excluded: {
      count: excluded.length,
      inStock: excluded.filter(inStock).length,
      outOfStock: excluded.filter((x) => !inStock(x)).length,
    },
    changes,
    historyStart: available[0] || today,
  });
}

function diff(base, cur) {
  const added = [], removed = [], wentOutOfStock = [], backInStock = [], priceChanged = [];
  for (const [sku, r] of Object.entries(cur)) {
    const b = base[sku];
    if (!b) { added.push({ sku, t: r.t, l: r.l, a: r.a, p: r.p }); continue; }
    if (b[1] === 1 && r.a === 0) wentOutOfStock.push({ sku, t: r.t, l: r.l });
    if (b[1] === 0 && r.a === 1) backInStock.push({ sku, t: r.t, l: r.l });
    if (String(b[2]) !== String(r.p)) priceChanged.push({ sku, t: r.t, l: r.l, from: b[2], to: r.p });
  }
  for (const [sku, b] of Object.entries(base)) if (!cur[sku]) removed.push({ sku, t: b[0], l: b[3] });
  const pack = (arr) => ({ count: arr.length, items: arr.slice(0, LIST_CAP) });
  return {
    added: pack(added),
    removed: pack(removed),
    wentOutOfStock: pack(wentOutOfStock),
    backInStock: pack(backInStock),
    priceChanged: pack(priceChanged),
  };
}

// ---------- rollback ----------

async function rollback(run) {
  if (!(await exists(P.prev))) throw new Error('No previous version stored');
  const tmp = P.feed + '.tmp';
  const [curMeta, prevMeta] = [await readJSON(P.feedMeta, null), await readJSON(P.prevMeta, null)];
  await fs.rename(P.feed, tmp);
  await fs.rename(P.prev, P.feed);
  await fs.rename(tmp, P.prev);
  await writeJSON(P.feedMeta, { ...prevMeta, restoredAt: run.startedAt });
  await writeJSON(P.prevMeta, curMeta);

  // Refresh the headline numbers for the restored file
  const text = await fs.readFile(P.feed, 'utf8');
  const items = JSON.parse(text.replace(/^﻿/, ''));
  const stats = await readJSON(P.stats, {});
  stats.feed = {
    ...stats.feed,
    count: items.length,
    inStock: items.filter(inStock).length,
    outOfStock: items.filter((x) => !inStock(x)).length,
    bytes: Buffer.byteLength(text),
    sha256: prevMeta?.sha256,
    publishedAt: prevMeta?.builtAt,
  };
  stats.rolledBackAt = run.startedAt;
  await writeJSON(P.stats, stats);
  run.keptCount = items.length;
  run.sha256 = prevMeta?.sha256;
  run.status = 'rolled-back';
}

// ---------- static site ----------

async function writeSite() {
  await fs.rm(SITE, { recursive: true, force: true });
  await fs.mkdir(path.join(SITE, 'admin', 'data'), { recursive: true });
  if (await exists(P.feed)) await fs.copyFile(P.feed, path.join(SITE, cfg.feedFile));
  await fs.copyFile(path.join(ROOT, 'site', 'admin.html'), path.join(SITE, 'admin', 'index.html'));
  const data = { stats: P.stats, history: P.history, runs: P.runs, products: P.index };
  for (const [name, src] of Object.entries(data)) {
    const dest = path.join(SITE, 'admin', 'data', `${name}.json`);
    if (await exists(src)) await fs.copyFile(src, dest);
    else await fs.writeFile(dest, name === 'runs' || name === 'history' ? '[]' : 'null');
  }
  await fs.writeFile(path.join(SITE, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
  await fs.writeFile(path.join(SITE, '.nojekyll'), '');
  await fs.writeFile(
    path.join(SITE, 'index.html'),
    '<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><meta http-equiv="refresh" content="0; url=admin/"><title>Klaviyo Feed</title>'
  );
}

// ---------- main ----------

const run = { id: crypto.randomUUID(), trigger: process.env.GITHUB_EVENT_NAME || 'local', mode, startedAt: new Date().toISOString(), status: 'running' };
if (process.env.GITHUB_RUN_ID) {
  run.url = `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
}
await fs.mkdir(STATE, { recursive: true });

try {
  if (mode === 'rollback') await rollback(run);
  else await build(run, { force: mode === 'force' });
} catch (e) {
  run.status = 'failed';
  run.error = String(e.message || e);
} finally {
  run.finishedAt = new Date().toISOString();
  run.durationMs = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
  const runs = await readJSON(P.runs, []);
  runs.unshift(run);
  await writeJSON(P.runs, runs.slice(0, 300));
  await writeSite(); // always redeploy, so the dashboard shows failures too (the feed file stays the old one)
}

console.log(JSON.stringify(run, null, 2));
if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `status=${run.status}\n`);
