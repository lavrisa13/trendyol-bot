require('dotenv').config();
const axios = require('axios');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ---------- ENV KONTROL ----------
const required = [
  'TRENDYOL_SUPPLIER_ID', 'TRENDYOL_API_KEY', 'TRENDYOL_API_SECRET',
  'SHOPIFY_STORE_URL', 'SHOPIFY_ACCESS_TOKEN', 'SHOPIFY_LOCATION_ID'
];
for (const k of required) {
  if (!process.env[k]) { console.error(`❌ Eksik env değişkeni: ${k}`); process.exit(1); }
}

const {
  TRENDYOL_SUPPLIER_ID, TRENDYOL_API_KEY, TRENDYOL_API_SECRET,
  SHOPIFY_STORE_URL, SHOPIFY_ACCESS_TOKEN, SHOPIFY_LOCATION_ID,
  PORT = 3000
} = process.env;

const SHOPIFY_API_VERSION = '2024-10';
const SHOPIFY_API = `https://${SHOPIFY_STORE_URL}/admin/api/${SHOPIFY_API_VERSION}`;
const SHOPIFY_HEADERS = {
  'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
  'Content-Type': 'application/json'
};
const trendyolAuth = Buffer.from(`${TRENDYOL_API_KEY}:${TRENDYOL_API_SECRET}`).toString('base64');

// ---------- KALICI İŞLENMİŞ SİPARİŞ KAYDI ----------
const STORE_FILE = path.join(__dirname, 'processed-orders.json');
let processedOrders = new Map();
if (fs.existsSync(STORE_FILE)) {
  try {
    processedOrders = new Map(Object.entries(JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'))));
  } catch (e) { console.error('processed-orders.json okunamadı:', e.message); }
}
function saveProcessed() {
  fs.writeFileSync(STORE_FILE, JSON.stringify(Object.fromEntries(processedOrders)));
}
function markProcessed(key) {
  processedOrders.set(key, Date.now());
  saveProcessed();
}

// ---------- SHOPIFY RATE LIMIT RETRY ----------
axios.interceptors.response.use(null, async (error) => {
  const cfg = error.config;
  if (!cfg || cfg._retry >= 3) return Promise.reject(error);
  const status = error.response?.status;
  if (status === 429 || status >= 500) {
    cfg._retry = (cfg._retry || 0) + 1;
    const wait = error.response?.headers?.['retry-after']
      ? parseInt(error.response.headers['retry-after']) * 1000
      : 1500 * cfg._retry;
    await new Promise(r => setTimeout(r, wait));
    return axios(cfg);
  }
  return Promise.reject(error);
});

// ---------- UYANDIRMA SUNUCUSU ----------
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Trendyol-Shopify Botu 7/24 Aktif!\n');
}).listen(PORT, () => console.log(`🌐 Sunucu ${PORT} portunda çalışıyor.`));

// ---------- SHOPIFY YARDIMCILAR ----------
async function shopifyGraphQL(query, variables = {}) {
  const res = await axios.post(`${SHOPIFY_API}/graphql.json`, { query, variables }, { headers: SHOPIFY_HEADERS });
  if (res.data.errors) throw new Error(JSON.stringify(res.data.errors));
  return res.data.data;
}

async function getVariantBySku(sku) {
  const query = `
    query($q: String!) {
      productVariants(first: 1, query: $q) {
        edges { node { id sku inventoryItem { id } } }
      }
    }`;
  const data = await shopifyGraphQL(query, { q: `sku:${sku}` });
  const edges = data?.productVariants?.edges || [];
  if (!edges.length) return null;
  const node = edges[0].node;
  return {
    variantId: node.id.split('/').pop(),
    inventoryItemId: node.inventoryItem.id.split('/').pop()
  };
}

async function findShopifyOrder(orderNumber) {
  const url = `${SHOPIFY_API}/orders.json?status=any&tag=${encodeURIComponent(orderNumber)}&limit=1`;
  const res = await axios.get(url, { headers: SHOPIFY_HEADERS });
  return res.data.orders?.[0] || null;
}

// ---------- SİPARİŞ OLUŞTUR ----------
async function createShopifyOrder(pkg) {
  try {
    const existing = await findShopifyOrder(pkg.orderNumber);
    if (existing) {
      console.log(`⚠️ ${pkg.orderNumber} zaten Shopify'da. Atlanıyor.`);
      return;
    }
    const lineItems = [];
    for (const item of pkg.lines) {
      const v = await getVariantBySku(item.barcode);
      if (!v) { console.warn(`⚠️ SKU bulunamadı: ${item.barcode}`); continue; }
      lineItems.push({ variant_id: Number(v.variantId), quantity: item.quantity, price: item.price });
    }
    if (!lineItems.length) {
      console.warn(`❌ ${pkg.orderNumber} için geçerli ürün yok.`);
      return;
    }
    const addr = pkg.invoiceAddress || pkg.shipmentAddress || {};
    const body = {
      order: {
        line_items: lineItems,
        customer: { first_name: addr.firstName || 'Trendyol', last_name: addr.lastName || 'Müşteri' },
        financial_status: 'pending',
        inventory_behaviour: 'decrement_obeying_policy',
        tags: `Trendyol,${pkg.orderNumber}`,
        note: `Trendyol Paket No: ${pkg.orderNumber}`
      }
    };
    const res = await axios.post(`${SHOPIFY_API}/orders.json`, body, { headers: SHOPIFY_HEADERS });
    console.log(`✅ Sipariş oluşturuldu: ${pkg.orderNumber} → Shopify ID ${res.data.order.id}`);
  } catch (e) {
    console.error(`❌ Sipariş oluşturma hatası (${pkg.orderNumber}):`, e.response?.data || e.message);
  }
}

// ---------- STOK İADE ----------
async function restoreShopifyStock(lines) {
  for (const item of lines) {
    try {
      const v = await getVariantBySku(item.barcode);
      if (!v) continue;
      await axios.post(`${SHOPIFY_API}/inventory_levels/adjust.json`, {
        inventory_item_id: Number(v.inventoryItemId),
        location_id: Number(SHOPIFY_LOCATION_ID),
        available_adjustment: item.quantity
      }, { headers: SHOPIFY_HEADERS });
      console.log(`✅ Stok geri eklendi: ${item.barcode} +${item.quantity}`);
    } catch (e) {
      console.error(`❌ Stok iade hatası (${item.barcode}):`, e.response?.data || e.message);
    }
  }
}

// ---------- KARGO ----------
async function fulfillShopifyOrder(pkg) {
  try {
    const order = await findShopifyOrder(pkg.orderNumber);
    if (!order) return;
    const foRes = await axios.get(`${SHOPIFY_API}/orders/${order.id}/fulfillment_orders.json`, { headers: SHOPIFY_HEADERS });
    const fo = foRes.data.fulfillment_orders.find(x => x.status === 'open' || x.status === 'in_progress');
    if (!fo) return;
    await axios.post(`${SHOPIFY_API}/fulfillments.json`, {
      fulfillment: {
        message: 'Trendyol siparişi kargoya verildi.',
        notify_customer: false,
        tracking_info: {
          number: pkg.cargoTrackingNumber || pkg.cargoTrackingLink || 'Bilinmiyor',
          company: pkg.cargoProviderName || 'Kargo'
        },
        line_items_by_fulfillment_order: [{ fulfillment_order_id: fo.id }]
      }
    }, { headers: SHOPIFY_HEADERS });
    console.log(`✅ Kargolandı: ${pkg.orderNumber}`);
  } catch (e) {
    console.error(`❌ Kargo hatası:`, e.response?.data || e.message);
  }
}

// ---------- İPTAL ----------
async function cancelShopifyOrder(pkg, orderId) {
  try {
    await axios.post(`${SHOPIFY_API}/orders/${orderId}/cancel.json`, { email: false }, { headers: SHOPIFY_HEADERS });
    console.log(`✅ İptal edildi: ${pkg.orderNumber}`);
  } catch (e) {
    console.error(`❌ İptal hatası:`, e.response?.data || e.message);
  }
}

// ---------- TESLİM ETİKETİ ----------
async function markOrderAsDelivered(pkg) {
  try {
    const order = await findShopifyOrder(pkg.orderNumber);
    if (!order) return;
    if ((order.tags || '').includes('Teslim Edildi')) return;
    const newTags = order.tags ? `${order.tags},Teslim Edildi` : 'Teslim Edildi';
    await axios.put(`${SHOPIFY_API}/orders/${order.id}.json`, {
      order: { id: order.id, tags: newTags }
    }, { headers: SHOPIFY_HEADERS });
    console.log(`✅ Teslim etiketi: ${pkg.orderNumber}`);
  } catch (e) {
    console.error(`❌ Etiket hatası:`, e.response?.data || e.message);
  }
}

// ---------- ANA SİPARİŞ KONTROL ----------
async function checkTrendyolOrders() {
  try {
    const endDate = Date.now();
    const startDate = endDate - (24 * 60 * 60 * 1000);
    const url = `https://api.trendyol.com/sapigw/suppliers/${TRENDYOL_SUPPLIER_ID}/orders?startDate=${startDate}&endDate=${endDate}&orderByField=PackageLastModifiedDate&orderByDirection=DESC&size=200`;
    const res = await axios.get(url, { headers: { Authorization: `Basic ${trendyolAuth}` } });
    const packages = res.data.content || [];

    for (const pkg of packages) {
      const pkgNo = String(pkg.orderNumber);
      const status = pkg.status;
      const actionKey = `${pkgNo}_${status}`;
      if (processedOrders.has(actionKey)) continue;
      try {
        if (status === 'Created' || status === 'Picking' || status === 'Invoiced') {
          const createKey = `${pkgNo}_created_in_shopify`;
          if (!processedOrders.has(createKey)) {
            await createShopifyOrder(pkg);
            markProcessed(createKey);
          }
          markProcessed(actionKey);
        } else if (status === 'Cancelled' || status === 'Returned') {
          const order = await findShopifyOrder(pkgNo);
          if (order) {
            await restoreShopifyStock(pkg.lines || []);
            await cancelShopifyOrder(pkg, order.id);
          }
          markProcessed(actionKey);
        } else if (status === 'Shipped') {
          await fulfillShopifyOrder(pkg);
          markProcessed(actionKey);
        } else if (status === 'Delivered') {
          await markOrderAsDelivered(pkg);
          markProcessed(actionKey);
        }
      } catch (innerErr) {
        console.error(`❌ Paket ${pkgNo}:`, innerErr.response?.data || innerErr.message);
      }
    }
  } catch (e) {
    console.error('❌ Trendyol sipariş kontrolü hatası:', e.response?.data || e.message);
  }
}

// ---------- STOK EŞİTLEME ----------
async function syncTrendyolStockToShopify() {
  try {
    console.log('🔄 Stok eşitleme başladı...');
    let page = 0, totalPages = 1;
    while (page < totalPages) {
      const url = `https://api.trendyol.com/sapigw/suppliers/${TRENDYOL_SUPPLIER_ID}/products?page=${page}&size=50`;
      const res = await axios.get(url, { headers: { Authorization: `Basic ${trendyolAuth}` } });
      const products = res.data.content || [];
      totalPages = res.data.totalPages || 1;
      for (const product of products) {
        try {
          const v = await getVariantBySku(product.barcode);
          if (!v) continue;
          await axios.post(`${SHOPIFY_API}/inventory_levels/set.json`, {
            inventory_item_id: Number(v.inventoryItemId),
            location_id: Number(SHOPIFY_LOCATION_ID),
            available: product.quantity
          }, { headers: SHOPIFY_HEADERS });
        } catch (e) {
          console.error(`❌ Stok sync (${product.barcode}):`, e.response?.data || e.message);
        }
        await new Promise(r => setTimeout(r, 300));
      }
      page++;
    }
    console.log('✅ Stok eşitleme tamamlandı.');
  } catch (e) {
    console.error('❌ Stok sync hatası:', e.response?.data || e.message);
  }
}

// ---------- HAFIZA TEMİZLİĞİ ----------
setInterval(() => {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  let changed = false;
  for (const [k, t] of processedOrders) {
    if (t < cutoff) { processedOrders.delete(k); changed = true; }
  }
  if (changed) saveProcessed();
}, 60 * 60 * 1000);

// ---------- BAŞLAT ----------
console.log('🚀 Sistem başlatıldı.');
checkTrendyolOrders();
setInterval(checkTrendyolOrders, 60000);       // her 1 dakika sipariş kontrolü

setTimeout(() => {
  syncTrendyolStockToShopify();
  setInterval(syncTrendyolStockToShopify, 10 * 60 * 1000);  // her 10 dk stok
}, 10000);
