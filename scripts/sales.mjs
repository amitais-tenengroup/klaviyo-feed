// Top sellers from Klaviyo "Completed Order" events.
//
// Orders are stored as one small file per UTC day in state/sales/ (units, orders and revenue per SKU), so each
// build only fetches what is new: it re-reads from the start of the last day it has seen and overwrites those days.
// The first run backfills `backfillDays`. Rankings for 7 / 30 / 90 days are computed from the day files.

import fs from 'node:fs/promises';
import path from 'node:path';

const DAY = 86400000;
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
const startOfDay = (iso) => Date.parse(iso + 'T00:00:00Z');

async function readJSON(f, fallback) {
  try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return fallback; }
}

// Fetch Completed Order events with datetime >= since (ms), oldest first. Yields pages of events.
async function* fetchOrders(sc, apiKey, since) {
  const base = process.env.KLAVIYO_API_BASE || 'https://a.klaviyo.com';
  const filter = `and(equals(metric_id,"${sc.metricId}"),greater-or-equal(datetime,${new Date(since).toISOString()}))`;
  let url = `${base}/api/events?` + new URLSearchParams({
    filter,
    'fields[event]': 'datetime,event_properties.Items',
    'page[size]': '1000',
    sort: 'datetime',
  });
  for (let page = 0; url && page < 500; page++) {
    let res;
    for (let attempt = 0; attempt < 5; attempt++) {
      res = await fetch(url, {
        headers: { Authorization: `Klaviyo-API-Key ${apiKey}`, revision: sc.apiRevision || '2025-10-15', accept: 'application/vnd.api+json' },
        signal: AbortSignal.timeout(120_000),
      });
      if (res.status !== 429 && res.status < 500) break;
      const wait = Number(res.headers.get('retry-after')) || 5 * (attempt + 1);
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Klaviyo API returned HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const body = await res.json();
    yield body.data || [];
    url = body.links?.next || null;
  }
}

// Update state/sales/ with new orders. Returns { fetched, from, error }.
export async function updateSales(stateDir, sc, apiKey) {
  const dir = path.join(stateDir, 'sales');
  await fs.mkdir(dir, { recursive: true });
  const metaFile = path.join(dir, 'meta.json');
  const meta = await readJSON(metaFile, null);
  const today = dayOf(Date.now());
  const since = meta?.lastEventTime
    ? startOfDay(dayOf(Date.parse(meta.lastEventTime)))
    : startOfDay(today) - (sc.backfillDays || 90) * DAY;

  const days = new Map(); // day -> { orders, skus: { sku: [units, orders, revenue] } }
  let fetched = 0;
  let last = meta?.lastEventTime || null;
  for await (const events of fetchOrders(sc, apiKey, since)) {
    for (const e of events) {
      const t = e.attributes.datetime;
      const d = dayOf(Date.parse(t));
      if (!days.has(d)) days.set(d, { orders: 0, skus: {} });
      const bucket = days.get(d);
      bucket.orders++;
      const inOrder = new Set();
      for (const i of e.attributes.event_properties?.Items || []) {
        if (!i.Sku) continue;
        const q = Number(i.Quantity) || 1;
        const s = (bucket.skus[i.Sku] ||= [0, 0, 0]);
        s[0] += q;
        s[2] = Math.round((s[2] + (Number(i.Price) || 0) * q) * 100) / 100;
        if (!inOrder.has(i.Sku)) { s[1]++; inOrder.add(i.Sku); }
      }
      if (!last || t > last) last = t;
      fetched++;
    }
  }
  // Overwrite every day from `since` on (days with no orders get an empty file), so re-reads never double count
  for (let t = since; t <= startOfDay(today); t += DAY) {
    const d = dayOf(t);
    await fs.writeFile(path.join(dir, `${d}.json`), JSON.stringify(days.get(d) || { orders: 0, skus: {} }));
  }
  // Prune old days
  const keepFrom = dayOf(startOfDay(today) - (sc.keepDays || 100) * DAY);
  for (const f of await fs.readdir(dir)) if (/^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(0, 10) < keepFrom) await fs.rm(path.join(dir, f));
  await fs.writeFile(metaFile, JSON.stringify({ lastEventTime: last, updatedAt: new Date().toISOString(), firstDay: meta?.firstDay || dayOf(since) }));
  return { fetched, from: new Date(since).toISOString() };
}

// Top N per window from the stored day files, joined with the source feed for name / link / stock.
export async function computeTopSellers(stateDir, sc, sourceItems, feedSkus) {
  const dir = path.join(stateDir, 'sales');
  const meta = await readJSON(path.join(dir, 'meta.json'), null);
  if (!meta) return null;
  const files = (await fs.readdir(dir)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const today = dayOf(Date.now());
  const exclude = sc.excludeSkuPattern ? new RegExp(sc.excludeSkuPattern) : null;
  const bySku = new Map(sourceItems.map((x) => [x.SKU, x]));
  const windows = {};
  for (const n of sc.windows || [7, 30, 90]) {
    const from = dayOf(startOfDay(today) - (n - 1) * DAY);
    const agg = new Map();
    let orders = 0;
    for (const f of files.filter((f) => f.slice(0, 10) >= from)) {
      const day = await readJSON(path.join(dir, f), { orders: 0, skus: {} });
      orders += day.orders;
      for (const [sku, [u, o, r]] of Object.entries(day.skus)) {
        if (exclude?.test(sku)) continue;
        const a = agg.get(sku) || [0, 0, 0];
        a[0] += u; a[1] += o; a[2] += r;
        agg.set(sku, a);
      }
    }
    const top = [...agg.entries()]
      .sort((a, b) => b[1][0] - a[1][0] || b[1][1] - a[1][1] || b[1][2] - a[1][2])
      .slice(0, sc.top || 30)
      .map(([sku, [units, ord, revenue]], i) => {
        const x = bySku.get(sku);
        return {
          rank: i + 1, sku, units, orders: ord, revenue: Math.round(revenue * 100) / 100,
          t: x?.Title || null, l: x?.ProductLink || null,
          stock: x ? (x.availability === 'In Stock' ? 'in' : 'out') : 'missing',
          inFeed: feedSkus.has(sku),
        };
      });
    windows[n] = { from, to: today, complete: (meta.firstDay || from) <= from, orders, top };
  }
  return { updatedAt: meta.updatedAt, lastEventTime: meta.lastEventTime, windows };
}
