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
import { buildShopifyFeeds } from './shopify.mjs';

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
  categories: path.join(STATE, cfg.categoriesFile),
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

// ---------- backup products ----------

// Products kept on our side (extra-products.json) for the Klaviyo feed only, e.g. gift cards that are turned
// off on the live site but must render in transactional emails. A product is added only when the source does not
// contain its SKU - when Myka sends it, Myka's row is used. Rows are re-keyed to the source's exact column order.
export function addBackupProducts(items, extras) {
  const schema = Object.keys(items[0]);
  const have = new Set(items.map((it) => it.SKU));
  const report = [];
  for (const extra of extras) {
    const unknown = Object.keys(extra).filter((k) => !schema.includes(k));
    if (unknown.length) throw new Error(`extra product ${extra.SKU}: unknown fields ${unknown.join(', ')}`);
    if (have.has(extra.SKU)) { report.push({ sku: extra.SKU, title: extra.Title, status: 'from-source' }); continue; }
    const row = {};
    for (const k of schema) row[k] = k in extra ? extra[k] : Array.isArray(items[0][k]) ? [] : '';
    items.push(row);
    report.push({ sku: extra.SKU, title: extra.Title, status: 'added-from-backup' });
  }
  return report;
}

// ---------- category assignments ----------

// Adds a category to specific SKUs (feed.config.json -> categoryAssignments) before filtering, so items the
// source leaves uncategorized can still be published. Only the Categories / CategoriesIDs values change;
// the rest of the row is untouched. Returns one status line per configured SKU for the dashboard.
export function applyCategoryAssignments(items, assignments = []) {
  const bySku = new Map(items.map((it) => [it.SKU, it]));
  const report = [];
  for (const { category, categoryId, skus } of assignments) {
    for (const sku of skus) {
      const it = bySku.get(sku);
      if (!it) { report.push({ sku, category, status: 'not-in-source' }); continue; }
      const ids = String(it.CategoriesIDs || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (ids.includes(categoryId)) { report.push({ sku, category, title: it.Title, status: 'already-assigned' }); continue; }
      const hasNames = hasCategory(it);
      it.Categories = hasNames ? `${it.Categories},${category}` : category;
      it.CategoriesIDs = ids.length ? `${it.CategoriesIDs},${categoryId}` : categoryId;
      report.push({ sku, category, title: it.Title, status: 'assigned' });
    }
  }
  return report;
}

// ---------- categories ----------

// Categories (names) and CategoriesIDs are parallel comma-separated lists, but some names contain commas
// ("Celestial Jewelry: Sun, Moon & Stars"). IDs never do, so IDs are the source of truth: split names
// into pieces and re-join adjacent pieces until there is exactly one name per ID.
function splitCategories(item, knownNames) {
  const ids = String(item.CategoriesIDs || '').split(',').map((s) => s.trim()).filter(Boolean);
  const pieces = String(item.Categories || '').split(',');
  if (!ids.length) return [];
  if (pieces.length === ids.length) return ids.map((id, i) => ({ id, name: pieces[i].trim() }));
  const names = [];
  let extra = pieces.length - ids.length; // how many joins we still need
  for (let i = 0; i < pieces.length; i++) {
    let name = pieces[i];
    // Join with following pieces while we still have surplus pieces and the join looks like one name:
    // a name already seen on other products, or a continuation that starts with a space.
    while (extra > 0 && i + 1 < pieces.length) {
      const joined = name + ',' + pieces[i + 1];
      if (knownNames.has(joined.trim()) || (pieces[i + 1].startsWith(' ') && !knownNames.has(pieces[i + 1].trim()))) {
        name = joined; i++; extra--;
      } else break;
    }
    names.push(name.trim());
  }
  if (names.length !== ids.length) return null; // could not align - caller falls back to ID-only matching
  return ids.map((id, i) => ({ id, name: names[i] }));
}

// One entry per category that has at least one product in the published feed.
export function buildCategories(items) {
  const knownNames = new Set();
  for (const it of items) {
    const ids = String(it.CategoriesIDs || '').split(',');
    const pieces = String(it.Categories || '').split(',');
    if (ids.length === pieces.length) pieces.forEach((p) => knownNames.add(p.trim()));
  }
  const byId = new Map();
  for (const it of items) {
    const cats = splitCategories(it, knownNames)
      ?? String(it.CategoriesIDs || '').split(',').map((s) => s.trim()).filter(Boolean).map((id) => ({ id, name: null }));
    for (const { id, name } of cats) {
      if (!byId.has(id)) byId.set(id, { id, name: null, product_count: 0, in_stock_count: 0 });
      const c = byId.get(id);
      if (!c.name && name) c.name = name;
      c.product_count++;
      if (inStock(it)) c.in_stock_count++;
    }
  }
  return [...byId.values()]
    .filter((c) => c.product_count > 0)
    .map((c) => ({ ...c, name: c.name ?? c.id }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Ready to Ship feeds for Shopify (products + inventory CSV), written into state/ under the configured paths.
async function writeShopify(items) {
  if (!cfg.shopify) return null;
  const { productsCsv, inventoryCsv, summary } = buildShopifyFeeds(items, cfg.shopify);
  for (const [file, body] of [[cfg.shopify.productsFile, productsCsv], [cfg.shopify.inventoryFile, inventoryCsv]]) {
    await fs.mkdir(path.dirname(path.join(STATE, file)), { recursive: true });
    await fs.writeFile(path.join(STATE, file), body);
  }
  return summary;
}

async function writeCategories(items) {
  const categories = buildCategories(items);
  await fs.writeFile(P.categories, JSON.stringify(categories));
  return categories;
}

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
  // Rows without a SKU can't be catalog items (no ID) - drop them. A large share means a broken export: abort.
  const noSku = items.filter((x) => !x || !x.SKU).length;
  if (noSku > items.length * 0.05) throw new Error(`${noSku} of ${items.length} source items have no SKU (> 5%)`);
  if (noSku) items = items.filter((x) => x && x.SKU);
  run.noSkuDropped = noSku;

  // 3. Backup products, category assignments, then filter
  const extras = cfg.extraProductsFile ? JSON.parse(await fs.readFile(path.join(ROOT, cfg.extraProductsFile), 'utf8')) : [];
  const backup = addBackupProducts(items, extras);
  run.backupAdded = backup.filter((b) => b.status === 'added-from-backup').length;
  const assignments = applyCategoryAssignments(items, cfg.categoryAssignments);
  run.assigned = assignments.filter((a) => a.status === 'assigned').length;
  run.assignmentsMissing = assignments.filter((a) => a.status === 'not-in-source').map((a) => a.sku);
  const kept = [];
  const excluded = [];
  for (const it of items) (hasCategory(it) ? kept : excluded).push(it);
  run.sourceCount = items.length + (run.noSkuDropped || 0); // as received, incl. dropped rows
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
  if (!force && prevCount && cfg.maxGrowthPct != null && kept.length > prevCount * (1 + cfg.maxGrowthPct / 100)) {
    throw new Error(
      `Guard: feed would grow from ${prevCount} to ${kept.length} items (> ${cfg.maxGrowthPct}%). ` +
      'Not published - check the source for products that should not be live. Run with mode "force" if this is intended.'
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

  // 7. Categories feed (only categories that have products in the published feed)
  const categories = await writeCategories(kept);
  run.categoryCount = categories.length;
  const klaviyoOnly = new Set(extras.map((x) => x.SKU));
  const shopify = await writeShopify(kept.filter((it) => !klaviyoOnly.has(it.SKU)));
  run.shopifyProducts = shopify?.products;

  // 8. Snapshots, history and dashboard stats
  await writeState({ kept, excluded, run, categories, assignments, shopify, backup });
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
  n: String(it.CategoriesIDs || '').split(',').filter((s) => s.trim()).length,
  l: it.ProductLink,
  i: it.ImageUrl,
});

async function writeState({ kept, excluded, run, categories, assignments, shopify, backup }) {
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
    source: { count: run.sourceCount, noSkuDropped: run.noSkuDropped || 0, bytes: run.sourceBytes, lastModified: run.sourceLastModified },
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
    categories: {
      file: cfg.categoriesFile,
      count: categories.length,
      allOutOfStock: categories.filter((c) => c.in_stock_count === 0).length,
      items: categories,
    },
    assignments,
    backup,
    shopify,
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
  const categories = await writeCategories(items);
  stats.categories = { ...stats.categories, file: cfg.categoriesFile, count: categories.length, allOutOfStock: categories.filter((c) => c.in_stock_count === 0).length, items: categories };
  stats.shopify = await writeShopify(items);
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
  if (await exists(P.categories)) await fs.copyFile(P.categories, path.join(SITE, cfg.categoriesFile));
  for (const file of cfg.shopify ? [cfg.shopify.productsFile, cfg.shopify.inventoryFile] : []) {
    if (!(await exists(path.join(STATE, file)))) continue;
    await fs.mkdir(path.dirname(path.join(SITE, file)), { recursive: true });
    await fs.copyFile(path.join(STATE, file), path.join(SITE, file));
  }
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
