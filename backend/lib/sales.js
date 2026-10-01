/* =========================================================================
   Eastern Gate — sale record builder

   One place that creates a transaction, used both when a seller rings up a
   walk-up sale (routes/seller.js) and when a seller completes a customer's
   QR order (lib/orders.js). Whatever the source, a sale is stored the same
   way — with its own price snapshot — so Sales, Reports, Dashboard and CSV
   export all keep working unchanged.
   ========================================================================= */

const { nextTransactionId } = require('./ids');

function recordSale(data, { seller, priced, paymentMethod, order }) {
  const now = new Date();
  const sale = {
    transactionId: nextTransactionId(data, now),
    sellerId: seller.id,
    sellerName: seller.fullName,
    items: priced.items,
    subtotal: priced.subtotal,
    total: priced.total,
    paymentMethod,
    status: 'completed',
    date: now.toISOString().slice(0, 10),
    time: now.toISOString().slice(11, 16),
    createdAt: now.toISOString(),
    cancelledAt: null
  };
  if (order) {
    sale.source = 'customer';
    sale.orderId = order.orderId;
    sale.tableNumber = order.tableNumber;
    sale.tableName = order.tableName;
  }
  data.sales.push(sale);
  return sale;
}

module.exports = { recordSale };
