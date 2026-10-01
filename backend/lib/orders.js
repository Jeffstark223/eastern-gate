/* =========================================================================
   Eastern Gate — customer (QR table) orders

   A customer order is saved in data.orders the moment it is placed. It is
   priced on the server from the live menu (same priceCart() the Seller
   screen uses), so a customer can never order something that is off or
   finished, and can never set their own price.

   Life of an order:   new -> preparing -> ready -> completed
                       (cancelled is possible until it is completed)

   Payment: the customer does NOT pay in the app (there is no payment
   gateway). The order stays "unpaid" until the seller completes it and
   picks Cash or Mobile Money after actually receiving the money; only then
   is a normal sale (transaction) recorded — with the prices as they were
   when the customer ordered.
   ========================================================================= */

const crypto = require('crypto');
const { priceCart } = require('./pricing');
const { recordSale } = require('./sales');

const ACTIVE = ['new', 'preparing', 'ready'];
const NEXT = {
  new: ['preparing', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  ready: ['completed', 'cancelled']
};

function nextOrderId(data) {
  data.meta.orderSeq += 1;
  return `ORD-${data.meta.orderSeq}`;
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function createCustomerOrder(data, table, items) {
  const priced = priceCart(data, items); // throws 400 for off/finished/invalid items
  const now = new Date();
  const order = {
    orderId: nextOrderId(data),
    source: 'customer',
    tableId: table.id,
    tableNumber: table.number,
    tableName: table.name,
    items: priced.items,
    subtotal: priced.subtotal,
    total: priced.total,
    status: 'new',
    paymentStatus: 'unpaid',
    handledBy: null,
    handledByName: null,
    trackKey: crypto.randomBytes(9).toString('hex'), // lets the customer's phone follow its own order
    date: now.toISOString().slice(0, 10),
    time: now.toISOString().slice(11, 16),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    completedAt: null,
    cancelledAt: null,
    cancelledBy: null,
    transactionId: null
  };
  data.orders.push(order);
  return order;
}

// Moves an order along its life. `actor` is { role, id, fullName }.
// For "completed", paymentMethod ('cash' | 'momo') is required and a sale is
// recorded. Everything is checked before anything is changed.
function changeOrderStatus(data, order, nextStatus, actor, paymentMethod) {
  const allowed = NEXT[order.status] || [];
  if (!allowed.includes(nextStatus)) {
    throw httpError(409, `This order is already ${order.status} — it can't be changed to ${nextStatus}.`);
  }
  if (nextStatus === 'completed' && paymentMethod !== 'cash' && paymentMethod !== 'momo') {
    throw httpError(400, 'Choose Cash or Mobile Money to complete this order.');
  }

  const now = new Date().toISOString();
  order.status = nextStatus;
  order.updatedAt = now;

  if (nextStatus === 'preparing' && actor.role === 'seller') {
    order.handledBy = actor.id;
    order.handledByName = actor.fullName;
  }
  if (nextStatus === 'cancelled') {
    order.cancelledAt = now;
    order.cancelledBy = actor.fullName || actor.role;
  }
  if (nextStatus === 'completed') {
    if (!order.handledBy) {
      order.handledBy = actor.id;
      order.handledByName = actor.fullName;
    }
    const sale = recordSale(data, {
      seller: { id: actor.id, fullName: actor.fullName },
      priced: { items: order.items, subtotal: order.subtotal, total: order.total },
      paymentMethod,
      order
    });
    order.completedAt = now;
    order.paymentStatus = 'paid';
    order.paymentMethod = paymentMethod;
    order.transactionId = sale.transactionId;
  }
  return order;
}

// Never send the customer's tracking key to staff screens.
function staffView(order) {
  const { trackKey, ...rest } = order;
  return rest;
}

module.exports = { ACTIVE, createCustomerOrder, changeOrderStatus, staffView };
