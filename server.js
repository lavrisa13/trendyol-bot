require('dotenv').config();
const axios = require('axios');
const http = require('http');

const {
  TRENDYOL_SUPPLIER_ID,
  TRENDYOL_API_KEY,
  TRENDYOL_API_SECRET,
  SHOPIFY_STORE_URL,
  SHOPIFY_ACCESS_TOKEN
} = process.env;

const SHOPIFY_LOCATION_ID = '114560139553';
const trendyolAuth = Buffer.from(`${TRENDYOL_API_KEY}:${TRENDYOL_API_SECRET}`).toString('base64');
const processedOrders = new Set();

const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Trendyol-Shopify Botu 7/24 Aktif!\n');
}).listen(port, () => {
  console.log(`🌐 Uyandırma sunucusu ${port} portunda başlatıldı.`);
});

console.log('🚀 Sistem başlatıldı. Her 30 saniyede bir Trendyol siparişleri kontrol edilecek...');

async function checkTrendyolOrders() {
  try {
    const endDate = Date.now();
    const startDate = endDate - (2 * 60 * 60 * 1000); 
    
    const url = `https://api.trendyol.com/sapigw/suppliers/${TRENDYOL_SUPPLIER_ID}/orders?startDate=${startDate}&endDate=${endDate}&orderByField=PackageLastModifiedDate&orderByDirection=DESC`;

    const response = await axios.get(url, {
      headers: { 'Authorization': `Basic ${trendyolAuth}` }
    });

    const packages = response.data.content;

    for (const pkg of packages) {
      const packageId = pkg.orderNumber;
      const status = pkg.status;
      const actionKey = `${packageId}_${status}`;

      if (processedOrders.has(actionKey)) continue;

      if (status === 'Created' || status === 'Picking') {
        console.log(`🎉 YENİ SİPARİŞ BULUNDU! Paket No: ${packageId}. Shopify'a aktarılıyor...`);
        await createShopifyOrder(pkg);
        processedOrders.add(actionKey);
      } else if (status === 'Cancelled') {
        console.log(`🚨 İPTAL BULUNDU! Paket No: ${packageId}. Stoklar geri yüklenip sipariş iptal ediliyor...`);
        await restoreShopifyStock(pkg.lines);
        await cancelShopifyOrder(pkg); 
        processedOrders.add(actionKey);
      } else if (status === 'Shipped') {
        console.log(`📦 KARGOLANDI! Paket No: ${packageId}. Shopify'da sessizce güncelleniyor...`);
        await fulfillShopifyOrder(pkg);
        processedOrders.add(actionKey);
      } else if (status === 'Delivered') {
        console.log(`🏠 TESLİM EDİLDİ! Paket No: ${packageId}. Shopify'a etiket ekleniyor...`);
        await markOrderAsDelivered(pkg); 
        processedOrders.add(actionKey);
      }
    }
  } catch (error) {
    console.error('❌ Trendyol kontrol edilirken hata oluştu:', error.response?.data || error.message);
  }
}

async function createShopifyOrder(pkg) {
  try {
    const url = `https://${SHOPIFY_STORE_URL}/admin/api/2024-01/orders.json`;
    
    const lineItems = pkg.lines.map(item => ({
      sku: item.barcode,
      title: item.productName || 'Trendyol Ürünü',
      quantity: item.quantity,
      price: item.price
    }));

    const shopifyOrderData = {
      order: {
        line_items: lineItems,
        customer: {
          first_name: pkg.invoiceAddress.firstName,
          last_name: pkg.invoiceAddress.lastName
        },
        financial_status: 'paid',
        tags: `Trendyol, ${pkg.orderNumber}`
      }
    };

    const response = await axios.post(url, shopifyOrderData, {
      headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN, 'Content-Type': 'application/json' }
    });
    console.log(`✅ Sipariş Shopify'a eklendi! Shopify ID: ${response.data.order.id}`);
  } catch (error) {
    console.error(`❌ Sipariş Shopify'a eklenemedi:`, JSON.stringify(error.response?.data || error.message, null, 2));
  }
}

async function restoreShopifyStock(canceledItems) {
  for (const item of canceledItems) {
    try {
      const searchUrl = `https://${SHOPIFY_STORE_URL}/admin/api/2024-01/products.json?sku=${item.barcode}`;
      const searchRes = await axios.get(searchUrl, { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } });

      if (searchRes.data.products.length > 0) {
        const inventoryItemId = searchRes.data.products[0].variants[0].inventory_item_id;
        const adjustUrl = `https://${SHOPIFY_STORE_URL}/admin/api/2024-01/inventory_levels/adjust.json`;
        
        await axios.post(adjustUrl, {
          inventory_item_id: inventoryItemId,
          location_id: SHOPIFY_LOCATION_ID,
          available_adjustment: item.quantity
        }, { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN, 'Content-Type': 'application/json' } });
        
        console.log(`✅ İptal edilen ${item.barcode} barkodlu üründen ${item.quantity} adet stoğa geri eklendi.`);
      }
    } catch (error) {
      console.error(`❌ Stok hatası:`, error.response?.data || error.message);
    }
  }
}

async function fulfillShopifyOrder(pkg) {
  try {
    const headers = { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN, 'Content-Type': 'application/json' };
    const ordersUrl = `https://${SHOPIFY_STORE_URL}/admin/api/2024-01/orders.json?status=unfulfilled`;
    const ordersRes = await axios.get(ordersUrl, { headers });
    const shopifyOrder = ordersRes.data.orders.find(order => order.tags.includes(pkg.orderNumber.toString()));

    if (!shopifyOrder) return;

    const foUrl = `https://${SHOPIFY_STORE_URL}/admin/api/2024-01/orders/${shopifyOrder.id}/fulfillment_orders.json`;
    const foRes = await axios.get(foUrl, { headers });
    const fulfillmentOrder = foRes.data.fulfillment_orders.find(fo => fo.status === 'open' || fo.status === 'in_progress');

    if (!fulfillmentOrder) return;

    const fulfillData = {
      fulfillment: {
        message: "Trendyol siparişi kargoya verildi.",
        notify_customer: false,
        tracking_info: {
          number: pkg.cargoTrackingNumber || pkg.cargoTrackingLink || 'Bilinmiyor',
          company: pkg.cargoProviderName || 'Kargo Firması'
        },
        line_items_by_fulfillment_order: [{ fulfillment_order_id: fulfillmentOrder.id }]
      }
    };

    await axios.post(`https://${SHOPIFY_STORE_URL}/admin/api/2024-01/fulfillments.json`, fulfillData, { headers });
    console.log(`✅ Sipariş kargolandı olarak işaretlendi. Shopify ID: ${shopifyOrder.id}`);
  } catch (error) {
    console.error(`❌ Kargo güncellemesi başarısız oldu:`, JSON.stringify(error.response?.data || error.message, null, 2));
  }
}

async function cancelShopifyOrder(pkg) {
  try {
    const headers = { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN, 'Content-Type': 'application/json' };
    const ordersUrl = `https://${SHOPIFY_STORE_URL}/admin/api/2024-01/orders.json?status=any`;
    const ordersRes = await axios.get(ordersUrl, { headers });
    const shopifyOrder = ordersRes.data.orders.find(order => order.tags.includes(pkg.orderNumber.toString()));

    if (!shopifyOrder) return;

    await axios.post(`https://${SHOPIFY_STORE_URL}/admin/api/2024-01/orders/${shopifyOrder.id}/cancel.json`, { email: false }, { headers });
    console.log(`✅ Sipariş panelde İptal Edildi olarak güncellendi. Shopify ID: ${shopifyOrder.id}`);
  } catch (error) {
    console.error(`❌ Sipariş iptal işlemi başarısız:`, error.response?.data || error.message);
  }
}

async function markOrderAsDelivered(pkg) {
  try {
    const headers = { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN, 'Content-Type': 'application/json' };
    const ordersUrl = `https://${SHOPIFY_STORE_URL}/admin/api/2024-01/orders.json?status=any`;
    const ordersRes = await axios.get(ordersUrl, { headers });
    const shopifyOrder = ordersRes.data.orders.find(order => order.tags.includes(pkg.orderNumber.toString()));

    if (!shopifyOrder || shopifyOrder.tags.includes("Teslim Edildi")) return;

    await axios.put(`https://${SHOPIFY_STORE_URL}/admin/api/2024-01/orders/${shopifyOrder.id}.json`, {
      order: { id: shopifyOrder.id, tags: `${shopifyOrder.tags}, Teslim Edildi` }
    }, { headers });
    
    console.log(`✅ Siparişe 'Teslim Edildi' etiketi başarıyla eklendi! Shopify ID: ${shopifyOrder.id}`);
  } catch (error) {
    console.error(`❌ Teslim Edildi etiketi eklenemedi:`, error.response?.data || error.message);
  }
}

// 🔄 YENİ: TRENDYOL -> SHOPIFY STOK EŞİTLEME MODÜLÜ
async function syncTrendyolStockToShopify() {
  try {
    console.log('🔄 Trendyol genel stokları kontrol ediliyor ve Shopify ile eşitleniyor...');
    let page = 0;
    let totalPages = 1;
    
    while (page < totalPages) {
      const url = `https://api.trendyol.com/sapigw/suppliers/${TRENDYOL_SUPPLIER_ID}/products?page=${page}&size=50`;
      const response = await axios.get(url, {
        headers: { 'Authorization': `Basic ${trendyolAuth}` }
      });
      
      const products = response.data.content;
      totalPages = response.data.totalPages || 1;
      
      for (const product of products) {
        const barcode = product.barcode;
        const quantity = product.quantity;
        
        // Shopify'da barkod ile ürünü bul
        const searchUrl = `https://${SHOPIFY_STORE_URL}/admin/api/2024-01/products.json?sku=${barcode}`;
        const searchRes = await axios.get(searchUrl, { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } });
        
        if (searchRes.data.products.length > 0) {
          const inventoryItemId = searchRes.data.products[0].variants[0].inventory_item_id;
          
          // Shopify'a stok miktarını "SET" (Ayarla) komutuyla mutlak değer olarak gönder
          const setUrl = `https://${SHOPIFY_STORE_URL}/admin/api/2024-01/inventory_levels/set.json`;
          await axios.post(setUrl, {
            inventory_item_id: inventoryItemId,
            location_id: SHOPIFY_LOCATION_ID,
            available: quantity
          }, { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN, 'Content-Type': 'application/json' } });
        }
        
        // Shopify API sınırlarına takılmamak için her ürün sonrası 300 milisaniye bekle
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      page++;
    }
    console.log('✅ Stok eşitleme turu tamamlandı.');
  } catch (error) {
    console.error('❌ Stok eşitleme hatası:', error.response?.data || error.message);
  }
}

// BOTUN ZAMANLAYICILARI
checkTrendyolOrders(); 
setInterval(checkTrendyolOrders, 30000); // Her 30 saniyede bir siparişleri kontrol et

// Bot ilk açıldığında 5 saniye bekle, sonra ilk stok eşitlemesini yap ve her 5 dakikada bir tekrarla
setTimeout(() => {
  syncTrendyolStockToShopify();
  setInterval(syncTrendyolStockToShopify, 5 * 60 * 1000); // 5 dakika = 5 * 60 * 1000 ms
}, 5000);
