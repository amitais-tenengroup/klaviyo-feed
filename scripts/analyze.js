// One-off analysis of the source feed: node scripts/analyze.js [url]
const url = process.argv[2] || 'https://static.myka.com/us-east-1/imported-feeds/51/KlaviyoUS.json';
const hasCategory = (it) => Array.isArray(it.Categories)
  ? it.Categories.some((s) => String(s).trim())
  : typeof it.Categories === 'string' && it.Categories.split(',').some((s) => s.trim());
const count = (arr, f) => arr.reduce((o, x) => ((o[f(x)] = (o[f(x)] || 0) + 1), o), {});

const items = await (await fetch(url)).json();
const kept = items.filter(hasCategory), removed = items.filter((x) => !hasCategory(x));
console.log({ source: items.length, kept: kept.length, removed: removed.length });
console.log('availability (all):', count(items, (x) => x.availability));
console.log('availability (kept):', count(kept, (x) => x.availability));
console.log('availability (removed):', count(removed, (x) => x.availability));
console.log('removed by product_type:', count(removed, (x) => x.product_type || '(none)'));
console.log('removed SKUs ending in -T:', removed.filter((x) => /-T$/.test(x.SKU)).length);
