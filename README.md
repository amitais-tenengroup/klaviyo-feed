# Klaviyo product feed (self-hosted)

Rebuilds the Klaviyo product feed from the upstream Myka export 3× per day, filters it, and publishes it
at a public URL you control. Also publishes a backoffice dashboard. Runs on GitHub Actions and GitHub
Pages, with no servers and no cost.

```
Myka source JSON ──(GitHub Actions, 04:00/12:00/20:00 UTC)──> scripts/build.mjs ──> GitHub Pages
                                                                  │                   ├─ /KlaviyoUS.json   → Klaviyo
                                                  feed-state branch (history)         └─ /admin/           dashboard
```

- **Product feed:** `https://<owner>.github.io/klaviyo-feed/KlaviyoUS.json`
- **Categories feed:** `https://<owner>.github.io/klaviyo-feed/KlaviyoUS-categories.json`
- **Ready to Ship → Shopify, products:** `https://<owner>.github.io/klaviyo-feed/shopify/ready-to-ship-products.csv`
- **Ready to Ship → Shopify, inventory:** `https://<owner>.github.io/klaviyo-feed/shopify/ready-to-ship-inventory.csv`
- **Dashboard:** `https://<owner>.github.io/klaviyo-feed/admin/`. It is public but hidden from search
  engines. It only shows catalog data that is already public in the feed.

## Rules applied

1. **Drop items with no category**: `Categories` is empty or blank (`""`, `" , "`, `[]`, missing).

Every kept row is written byte-for-byte as it appears in the source: same keys, key order, compact
JSON, and UTF-8 BOM. The output is the source with rows removed and nothing else changed. Add
future rules in `scripts/build.mjs`, where `hasCategory()` defines the current one.

## Ready to Ship feeds for Shopify

Built in every run from the published feed. They contain **only** products in the *Ready-to-ship jewelry*
category (`7c55c3a1-…`), which is the category behind
[theograce.com/categories/instantly-giftable-jewelry](https://www.theograce.com/categories/instantly-giftable-jewelry).

| File | Format | Use |
|---|---|---|
| `shopify/ready-to-ship-products.csv` | Shopify product import template (same 61 columns) | Create / update the products in Shopify |
| `shopify/ready-to-ship-inventory.csv` | Shopify inventory import | Set on-hand stock per SKU |

How the product file is filled in:
- **One product per SKU.** It has a single "Default Title" variant, and the handle comes from the theograce.com URL.
- **Copied from the source:** title, description, price, and compare-at price (only when higher than the price).
- **Product category:** mapped from `product_type` to Shopify's jewelry taxonomy.
- **Tags:** "Ready to Ship", family, material, type and Shop For.
- **Images:** the main image, plus the additional image as a second image row.
- **Stock:** the on-hand quantity is 1 when the item is in stock and 0 when it is out of stock. The source only says in or out of stock, not how many are available.

Settings are under `shopify` in `feed.config.json`:
- `location`: must match your Shopify location name exactly.
- `inStockQuantity`: a number to use for in-stock items instead of 1.
- `status` / `published`: e.g. `Draft` / `false` to import products unpublished.
- `vendor` and `tag`.

## Backup products (Klaviyo feed only)

`extra-products.json` holds full product rows in the feed's exact format. Today it holds the 5 digital gift
cards, which are turned off on the live site but must render in transactional emails. If the Myka source
is missing one of these SKUs, the row is added to the **Klaviyo feed** from this file. If Myka sends the SKU,
Myka's row is used instead. These SKUs are always kept out of the Shopify feeds. The dashboard shows which
version is live under "Manual additions".

## Temporary SKU allowlist

Since 2026-10-26 the Myka export also contains turned-off and legacy products (about 4,500 more rows,
some with no SKU or duplicate SKUs). While `skuAllowlistFile` is set in `feed.config.json`, only the SKUs in
`sku-allowlist.json` (the feed as of 2026-10-25) plus the backup products can be published. Prices, stock
and the other fields for those SKUs still update on every build. The dashboard shows a banner while the
allowlist is on.

**To turn it off** once Myka exports active products only: remove the `skuAllowlistFile` line from
`feed.config.json` and push.

Also handled on every build:
- Rows without a SKU are dropped. The build aborts if more than 5% of rows have no SKU.
- If a SKU appears more than once, the row matching the last published version is kept.

## Manual category assignments

`categoryAssignments` in `feed.config.json` gives specific SKUs a category on our side. It runs before the
"no category" filter, so a SKU the source leaves uncategorized still ends up in the feed. Only the
`Categories` and `CategoriesIDs` values change; the rest of the row stays exactly as the source sends it.
If the SKU already has that category ID, nothing changes.

| SKUs | Category |
|---|---|
| 555-26-5000-04, 555-26-5000-09, 55-26-5607-04, 55-26-5608-09, 555-26-5673-09 | Back Office Gift card (`9e1f503e-…`) |

A SKU can only be published if it is in the Myka source. If it isn't, the dashboard lists it as
"Not in source feed yet", and it is added automatically on the first build after Myka includes it.

## Categories feed

`KlaviyoUS-categories.json` lists every category that has **at least one product in the published
feed**, sorted by name. It is rebuilt in the same run as the product feed and from the same data.

```json
[{"id":"9bece262-a6ee-49e8-969a-dedb2abc998f","name":"14k White Gold","product_count":41,"in_stock_count":31}, ...]
```

- `id` comes from `CategoriesIDs`. `name` is the matching entry in `Categories`.
- Some category names contain commas, e.g. "Celestial Jewelry: Sun, Moon & Stars". IDs never contain
  commas, so the IDs decide how many categories a product has, and the name pieces are re-joined to match.
- Categories whose products are all out of stock are still listed, with `in_stock_count: 0`.

## How an update works

1. The schedule fires. GitHub Actions restores the previous state from the `feed-state` branch.
2. `build.mjs` downloads the source (with 3 retries) and validates it. The build aborts if any of these is true:
   - the HTTP status is not 200
   - the body is not valid JSON, or not an array
   - there are fewer than `minItems` items
   - any item has no SKU
3. It filters the items. It then checks the **drop guard**: if the feed would shrink by more than
   `maxDropPct` compared with the last build, the build is not published.
4. It writes the new feed, keeps the old one as `previous.json`, saves a daily snapshot, and computes
   dashboard stats, including changes vs 7/30/90 days ago.
5. The whole site is deployed to Pages as one unit. **Klaviyo sees either the complete old file or the
   complete new one, never a partial file.**
6. State is saved back to `feed-state` as a single force-pushed commit, so the branch doesn't grow.

If the build fails, the old feed stays live and the dashboard shows the error. The GitHub run is also
marked failed, which sends you an email.

## Manual runs and rollback

Go to **Actions → Build Klaviyo feed → Run workflow** and pick a mode:

- `build`: rebuild now
- `force`: rebuild and skip the drop guard (use when a big catalog drop is intended)
- `rollback`: swap the live feed with the previous version. Running it again undoes the rollback.

The dashboard's **Rebuild or roll back** button links to this page.

## Settings (`feed.config.json`)

| Key | Default | Meaning |
|---|---|---|
| `sourceUrl` | Myka KlaviyoUS.json | Upstream feed |
| `feedFile` | `KlaviyoUS.json` | Public filename of the product feed |
| `categoriesFile` | `KlaviyoUS-categories.json` | Public filename of the categories feed |
| `categoryAssignments` | gift cards → Back Office Gift card | SKUs to add a category to (see above) |
| `minItems` | 500 | Abort if the source has fewer items |
| `maxDropPct` | 25 | Abort if the feed shrinks more than this vs the last build |
| `maxGrowthPct` | 10 | Abort if the feed grows more than this vs the last build (e.g. the source suddenly includes turned-off products) |
| `extraProductsFile` | `extra-products.json` | Backup products for the Klaviyo feed (see above) |
| `historyDays` | 100 | Days of daily snapshots to keep |

Change the schedule in `.github/workflows/feed.yml` (cron, UTC). GitHub can start scheduled runs 5–30
minutes late when it is busy. The workflow re-enables itself on every run, so GitHub's "disable
schedules after 60 days of inactivity" rule never applies.

## Local run

```bash
node scripts/build.mjs
```

```bash
node scripts/serve.mjs
```

- The first command builds into `./state` and `./_site`.
- The second serves `_site` at http://localhost:8787/admin/.

## Source analysis (2026-09-30)

`node scripts/analyze.js` re-runs this analysis.

| | Count |
|---|---|
| Items in source | 3,818 |
| Removed (empty `Categories`) | **837**: 667 in stock, 170 out of stock |
| Kept | 2,981: 2,628 in stock, 353 out of stock |

Most of the removed rows are duplicates or legacy entries:
- 781 of the 837 have SKUs ending in `-T`.
- 477 are `-T` twins of a kept SKU with the same product page, e.g. `110-01-1405-09-T` vs `110-01-1405-09`.
- The rest include old `/Product.aspx?p=` links, gift boxes, warranties and NFT items.

`$inventory_quantity` is only ever `"0"` or `"1"`. It is an in/out-of-stock flag, not a real stock count.
