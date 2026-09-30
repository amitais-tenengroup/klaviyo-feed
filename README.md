# Klaviyo product feed (self-hosted)

Rebuilds the Klaviyo product feed from the upstream Myka export 3× per day, filters it, and publishes it
at a public URL you control. Also publishes a backoffice dashboard. Runs on GitHub Actions and GitHub
Pages, with no servers and no cost.

```
Myka source JSON ──(GitHub Actions, 04:00/12:00/20:00 UTC)──> scripts/build.mjs ──> GitHub Pages
                                                                  │                   ├─ /KlaviyoUS.json   → Klaviyo
                                                  feed-state branch (history)         └─ /admin/           dashboard
```

- **Feed URL:** `https://<owner>.github.io/klaviyo-feed/KlaviyoUS.json`
- **Dashboard:** `https://<owner>.github.io/klaviyo-feed/admin/`. It is public but hidden from search
  engines. It only shows catalog data that is already public in the feed.

## Rules applied

1. **Drop items with no category**: `Categories` is empty or blank (`""`, `" , "`, `[]`, missing).

Every kept row is written byte-for-byte as it appears in the source: same keys, key order, compact
JSON, and UTF-8 BOM. The output is the source with rows removed and nothing else changed. Add
future rules in `scripts/build.mjs`, where `hasCategory()` defines the current one.

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
| `feedFile` | `KlaviyoUS.json` | Public filename |
| `minItems` | 500 | Abort if the source has fewer items |
| `maxDropPct` | 25 | Abort if the feed shrinks more than this vs the last build |
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
