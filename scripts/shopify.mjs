// Ready to Ship feeds for Shopify, built from the published Klaviyo feed items.
//
//   products CSV  - Shopify product import template (create / update products, one product per SKU)
//   inventory CSV - Shopify inventory import format (set on-hand quantity per SKU at one location)

// Shopify product import template columns, in template order (Downloads/product_template.csv).
export const PRODUCT_COLUMNS = [
  'Title', 'URL handle', 'Description', 'Vendor', 'Product category', 'Type', 'Tags', 'Published on online store',
  'Status', 'SKU', 'Variant Barcodes', 'Option1 name', 'Option1 value', 'Option1 Linked To', 'Option2 name',
  'Option2 value', 'Option2 Linked To', 'Option3 name', 'Option3 value', 'Option3 Linked To', 'Price',
  'Compare-at price', 'Cost per item', 'Charge tax', 'Tax code', 'Unit price total measure',
  'Unit price total measure unit', 'Unit price base measure', 'Unit price base measure unit', 'Inventory tracker',
  'Inventory quantity', 'Continue selling when out of stock', 'Weight value (grams)', 'Weight unit for display',
  'Requires shipping', 'Fulfillment service', 'Product image URL', 'Image position', 'Image alt text',
  'Variant image URL', 'Gift card', 'SEO title', 'SEO description', 'Color (product.metafields.shopify.color-pattern)',
  'Google Shopping / Google product category', 'Google Shopping / Gender', 'Google Shopping / Age group',
  'Google Shopping / Manufacturer part number (MPN)', 'Google Shopping / Ad group name', 'Google Shopping / Ads labels',
  'Google Shopping / Condition', 'Google Shopping / Custom product', 'Google Shopping / Custom label 0',
  'Google Shopping / Custom label 1', 'Google Shopping / Custom label 2', 'Google Shopping / Custom label 3',
  'Google Shopping / Custom label 4', 'Packed product length', 'Packed product width', 'Packed product height',
  'Packed product dimension unit',
];

// Shopify inventory import format (Products → Inventory → Import).
export const INVENTORY_COLUMNS = [
  'Handle', 'Title', 'Option1 Name', 'Option1 Value', 'Option2 Name', 'Option2 Value', 'Option3 Name', 'Option3 Value',
  'SKU', 'HS Code', 'COO', 'Location', 'Bin name', 'Incoming (not editable)', 'Unavailable (not editable)',
  'Committed (not editable)', 'Available (not editable)', 'On hand (current)', 'On hand (new)',
];

// Shopify Standard Product Taxonomy paths by source product_type.
const TAXONOMY = {
  Earrings: 'Apparel & Accessories > Jewelry > Earrings',
  Necklaces: 'Apparel & Accessories > Jewelry > Necklaces',
  Chains: 'Apparel & Accessories > Jewelry > Necklaces',
  Bracelets: 'Apparel & Accessories > Jewelry > Bracelets',
  Rings: 'Apparel & Accessories > Jewelry > Rings',
  Anklets: 'Apparel & Accessories > Jewelry > Anklets',
};
const DEFAULT_TAXONOMY = 'Apparel & Accessories > Jewelry';

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (columns, rows) =>
  [columns, ...rows.map((r) => columns.map((c) => r[c]))].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

const handleOf = (it) => {
  const fromLink = String(it.ProductLink || '').split('?')[0].split('/').filter(Boolean).pop();
  return (fromLink || it.Title || it.SKU).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
};
const seoDescription = (text, max = 320) => {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  return cut.slice(0, cut.lastIndexOf(' ') > 200 ? cut.lastIndexOf(' ') : cut.length) + '…';
};

export function buildShopifyFeeds(items, sc) {
  const ready = items.filter((it) =>
    String(it.CategoriesIDs || '').split(',').map((s) => s.trim()).includes(sc.readyToShipCategoryId));
  const quantity = (it) => {
    const inStock = it.availability === 'In Stock';
    if (!inStock) return 0;
    return sc.inStockQuantity ?? (Number(it.$inventory_quantity) || 1);
  };

  const productRows = [];
  const inventoryRows = [];
  const seen = new Set();
  for (const it of ready) {
    let handle = handleOf(it);
    if (seen.has(handle)) handle = `${handle}-${it.SKU.toLowerCase()}`; // keep handles unique
    seen.add(handle);
    const price = Number(it.Price);
    const compare = Number(it.crossed_price);
    const tags = [sc.tag, it.Family, it.Material, it.product_type, ...(Array.isArray(it.ShopFor) ? it.ShopFor : [])]
      .map((t) => String(t || '').trim()).filter(Boolean);

    productRows.push({
      'Title': it.Title,
      'URL handle': handle,
      'Description': it.description,
      'Vendor': sc.vendor,
      'Product category': TAXONOMY[it.product_type] || DEFAULT_TAXONOMY,
      'Type': it.product_type,
      'Tags': [...new Set(tags)].join(', '),
      'Published on online store': sc.published ? 'TRUE' : 'FALSE',
      'Status': sc.status,
      'SKU': it.SKU,
      'Option1 name': 'Title',
      'Option1 value': 'Default Title',
      'Price': price.toFixed(2),
      'Compare-at price': compare > price ? compare.toFixed(2) : '',
      'Charge tax': 'TRUE',
      'Inventory tracker': 'shopify',
      'Inventory quantity': quantity(it),
      'Continue selling when out of stock': 'DENY',
      'Requires shipping': 'TRUE',
      'Fulfillment service': 'manual',
      'Product image URL': it.ImageUrl,
      'Image position': it.ImageUrl ? 1 : '',
      'Image alt text': it.ImageUrl ? it.Title : '',
      'Gift card': 'FALSE',
      'SEO title': it.Title,
      'SEO description': seoDescription(it.description),
      'Google Shopping / Manufacturer part number (MPN)': it.SKU,
      'Google Shopping / Condition': 'New',
    });
    // Extra image: a row with only the handle and image fields (Shopify's format for additional images)
    if (it.AdditionalImageUrl && it.AdditionalImageUrl !== it.ImageUrl) {
      productRows.push({
        'URL handle': handle,
        'Product image URL': it.AdditionalImageUrl,
        'Image position': 2,
        'Image alt text': it.Title,
      });
    }

    inventoryRows.push({
      'Handle': handle,
      'Title': it.Title,
      'Option1 Name': 'Title',
      'Option1 Value': 'Default Title',
      'SKU': it.SKU,
      'Location': sc.location,
      'On hand (new)': quantity(it),
    });
  }

  return {
    productsCsv: toCsv(PRODUCT_COLUMNS, productRows),
    inventoryCsv: toCsv(INVENTORY_COLUMNS, inventoryRows),
    summary: {
      categoryId: sc.readyToShipCategoryId,
      categoryName: sc.readyToShipCategoryName,
      categoryPage: sc.categoryPage,
      productsFile: sc.productsFile,
      inventoryFile: sc.inventoryFile,
      location: sc.location,
      products: ready.length,
      inStock: ready.filter((it) => it.availability === 'In Stock').length,
      outOfStock: ready.filter((it) => it.availability !== 'In Stock').length,
      items: ready.map((it) => ({ sku: it.SKU, t: it.Title, a: it.availability === 'In Stock' ? 1 : 0, q: quantity(it), p: it.Price, l: it.ProductLink })),
    },
  };
}
