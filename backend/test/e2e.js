/* End-to-end test of the real server (no mocks). Starts server.js against a
   throw-away DATA_DIR, drives the HTTP API, and RESTARTS the process to prove
   data survives. Run:  npm test   (from the backend folder) */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'eg-test-'));
const PORT = 3100 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
let child;
let passed = 0;

function start() {
  return new Promise((resolve, reject) => {
    child = spawn('node', ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, PORT, DATA_DIR, JWT_SECRET: 'test-secret-test-secret', NODE_ENV: 'development' }
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; if (out.includes('is running')) resolve(); });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (c) => reject(new Error('server exited early: ' + out)));
    setTimeout(() => reject(new Error('server start timeout: ' + out)), 8000);
  });
}
function stop() {
  return new Promise((r) => { child.removeAllListeners('exit'); child.on('exit', r); child.kill('SIGKILL'); });
}

class Client {
  constructor() { this.cookie = ''; }
  async call(method, url, body) {
    const res = await fetch(BASE + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(this.cookie ? { Cookie: this.cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const sc = res.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* svg etc */ }
    return { status: res.status, json, text };
  }
}
async function ok(p) { const r = await p; assert(r.status < 300, `expected success, got ${r.status}: ${r.text}`); return r.json.data; }
function test(name) { passed++; console.log('  ✓ ' + name); }

(async () => {
  await start();
  const admin = new Client(), seller = new Client(), cust = new Client();

  console.log('\nTEST 1 — Admin persistence');
  assert.strictEqual((await ok(admin.call('GET', '/api/auth/setup-status'))).completed, false);
  await ok(admin.call('POST', '/api/auth/setup', { fullName: 'Kofi Owner', username: 'owner@eg.com', password: 'supersecret1', confirmPassword: 'supersecret1' }));
  await ok(admin.call('POST', '/api/auth/logout'));
  await ok(admin.call('POST', '/api/auth/admin-login', { username: 'owner@eg.com', password: 'supersecret1' }));
  test('admin registers, logs out, logs in again');

  console.log('\nTEST 2 — Seller persistence');
  const s = await ok(admin.call('POST', '/api/admin/sellers', { fullName: 'Ama', phone: '0241234567', pin: '1234' }));
  await ok(seller.call('POST', '/api/auth/seller-login', { sellerId: s.id, pin: '1234' }));
  await ok(seller.call('POST', '/api/auth/logout'));
  const me = await ok(seller.call('POST', '/api/auth/seller-login', { sellerId: s.id, pin: '1234' }));
  assert.strictEqual(me.fullName, 'Ama');
  assert((await ok(admin.call('GET', '/api/admin/sellers'))).some((x) => x.fullName === 'Ama'));
  test(`seller ${s.id} (Ama) logs in twice; admin still sees her`);

  console.log('\nTEST 3 — Menu persistence + per-unit pricing');
  const banku = await ok(admin.call('POST', '/api/admin/menu', { type: 'food', name: 'Banku (unit)', price: 5, pricingType: 'unit', unitName: 'ball' }));
  assert.strictEqual(banku.pricingType, 'unit'); assert.strictEqual(banku.unitName, 'ball');
  let bad = await admin.call('POST', '/api/admin/menu', { type: 'food', name: 'X', price: 5, pricingType: 'unit', unitName: '' });
  assert.strictEqual(bad.status, 400);
  test('per-unit food saved; unit name required');

  console.log('\nTEST 4 — Flexible quantity (6 balls x GHS 5)');
  const menu = await ok(seller.call('GET', '/api/menu'));
  const by = (n) => menu.find((m) => m.name === n);
  const fufu = by('Fufu'), palm = by('Palmnut Soup'), goat = by('Goat'), beef = by('Beef'), fish = by('Fish');
  const sale6 = await ok(seller.call('POST', '/api/sales', { paymentMethod: 'cash', items: [{ foodId: banku.id, quantity: 6 }] }));
  assert.strictEqual(sale6.total, 30);
  const sale6b = await ok(seller.call('POST', '/api/sales', { paymentMethod: 'momo', items: [{ foodId: banku.id, soupId: palm.id, proteinId: beef.id, quantity: 6 }] }));
  assert.strictEqual(sale6b.total, 40); // 30 + beef 10 once; soup free
  const fufuSale = await ok(seller.call('POST', '/api/sales', { paymentMethod: 'cash', items: [{ foodId: fufu.id, soupId: palm.id, proteinId: goat.id, quantity: 1 }] }));
  assert.strictEqual(fufuSale.total, 40);
  test('6 balls = GHS 30; +Beef = 40; Fufu+Palmnut+Goat = 40 (soup adds 0)');

  console.log('\nMultiple proteins (shared goat, mixed proteins)');
  const chicken = by('Chicken');
  const shared = await ok(seller.call('POST', '/api/sales', { paymentMethod: 'cash', items: [{ foodId: fufu.id, soupId: palm.id, quantity: 2, proteins: [{ proteinId: goat.id, quantity: 1 }] }] }));
  assert.strictEqual(shared.total, 65);   // 2 x 25 + one goat 15 (two people share one goat)
  const mixed = await ok(seller.call('POST', '/api/sales', { paymentMethod: 'cash', items: [{ foodId: banku.id, quantity: 2, proteins: [{ proteinId: beef.id, quantity: 1 }, { proteinId: chicken.id, quantity: 1 }] }] }));
  assert.strictEqual(mixed.total, 30);    // 2 balls x 5 + beef 10 + chicken 10
  assert.strictEqual(mixed.items[0].proteins.length, 2);
  const two = await ok(seller.call('POST', '/api/sales', { paymentMethod: 'cash', items: [{ foodId: fufu.id, quantity: 2, proteins: [{ proteinId: goat.id, quantity: 2 }] }] }));
  assert.strictEqual(two.total, 80);      // 2 plates, each with its own goat
  assert.strictEqual((await seller.call('POST', '/api/sales', { paymentMethod: 'cash', items: [{ foodId: fufu.id, quantity: 1, proteins: [{ proteinId: goat.id, quantity: 0 }] }] })).status, 400);
  assert.strictEqual((await seller.call('POST', '/api/sales', { paymentMethod: 'cash', items: [{ foodId: fufu.id, quantity: 1, proteins: [{ proteinId: palm.id, quantity: 1 }] }] })).status, 400); // a soup is not a protein
  test('2 Fufu + 1 shared Goat = 65; Banku x2 + Beef + Chicken = 30; 2 Fufu + 2 Goat = 80; bad quantities/types rejected');

  console.log('\nMultiple soups on one dish');
  const groundnut = by('Groundnut Soup');
  const twoSoups = await ok(seller.call('POST', '/api/sales', { paymentMethod: 'cash', items: [{ foodId: fufu.id, quantity: 2, soups: [{ soupId: palm.id, quantity: 1 }, { soupId: groundnut.id, quantity: 1 }] }] }));
  assert.strictEqual(twoSoups.total, 50);            // soups are free
  assert.strictEqual(twoSoups.items[0].soups.length, 2);
  assert.strictEqual((await seller.call('POST', '/api/sales', { paymentMethod: 'cash', items: [{ foodId: fufu.id, quantity: 1, soups: [{ soupId: palm.id, quantity: 1 }, { soupId: groundnut.id, quantity: 1 }] }] })).status, 400); // 2 soups for 1 plate
  assert.strictEqual((await seller.call('POST', '/api/sales', { paymentMethod: 'cash', items: [{ foodId: banku.id, quantity: 6, soups: [{ soupId: palm.id, quantity: 2 }] }] })).status, 201); // per-unit food: no plate limit
  test('2 Fufu with Palmnut x1 + Groundnut x1 = 50 (soups free); 2 soups on 1 plate rejected');

  console.log('\nTEST 5/6 — Customer QR + order');
  const t = await ok(admin.call('POST', '/api/admin/tables', { count: 5 }));
  assert.strictEqual(t.length, 5);
  const table5 = t[4];
  assert(table5.url.endsWith('/t/' + table5.qrId));
  const svg = await admin.call('GET', `/api/admin/tables/${table5.id}/qr.svg`);
  assert(svg.text.startsWith('<svg'));
  const noAuthQr = await cust.call('GET', `/api/admin/tables/${table5.id}/qr.svg`);
  assert.strictEqual(noAuthQr.status, 401);
  const redirect = await fetch(`${BASE}/t/${table5.qrId}`, { redirect: 'manual' });
  assert.strictEqual(redirect.headers.get('location'), `/customer.html?t=${table5.qrId}`);
  const tInfo = await ok(cust.call('GET', `/api/public/table/${table5.qrId}`));
  assert.strictEqual(tInfo.name, 'Table 5');
  assert.strictEqual((await cust.call('GET', '/api/public/table/nonsense')).status, 404);
  const placed = await ok(cust.call('POST', '/api/public/orders', { table: table5.qrId, items: [{ foodId: fufu.id, soupId: palm.id, proteinId: goat.id, quantity: 1 }] }));
  assert.strictEqual(placed.tableName, 'Table 5'); assert.strictEqual(placed.total, 40); assert.strictEqual(placed.status, 'new');
  const unpaid = await cust.call('POST', '/api/public/orders', { table: 'bogus', items: [{ foodId: fufu.id, quantity: 1 }] });
  assert.strictEqual(unpaid.status, 404);
  const cheat = await cust.call('POST', '/api/public/orders', { table: table5.qrId, items: [{ foodId: fufu.id, quantity: 1, unitPrice: 1, total: 1 }] });
  assert.strictEqual(cheat.json.data.total, 25); // client-sent prices ignored
  test('QR opens Table 5; order saved; server-priced; bad QR rejected; QR image is admin-only');

  console.log('\nTEST 7 — Seller receives customer order');
  const active = await ok(seller.call('GET', '/api/seller/orders'));
  const o = active.find((x) => x.orderId === placed.orderId);
  assert(o && o.tableName === 'Table 5' && o.total === 40 && o.items[0].soups[0].name === 'Palmnut Soup' && o.items[0].proteins[0].name === 'Goat');
  assert(!('trackKey' in o), 'staff view must not leak trackKey');
  test('seller sees NEW order: Table 5, Fufu + Palmnut + Goat, GHS 40');

  console.log('\nTEST 8 — Admin turns Fish OFF / sees real menu');
  await ok(admin.call('PATCH', `/api/admin/menu/${fish.id}`, { available: true }));
  assert((await ok(cust.call('GET', '/api/public/menu'))).items.find((i) => i.name === 'Fish').status === 'available');
  await ok(admin.call('PATCH', `/api/admin/menu/${fish.id}`, { available: false }));
  const pub = await ok(cust.call('GET', '/api/public/menu'));
  assert(!pub.items.some((i) => i.name === 'Fish'));
  const fishOrder = await cust.call('POST', '/api/public/orders', { table: table5.qrId, items: [{ foodId: fufu.id, proteinId: fish.id, quantity: 1 }] });
  assert.strictEqual(fishOrder.status, 400);
  test('Fish OFF: hidden from customers and rejected by the server');

  console.log('\nTEST 9 — Seller marks Goat finished');
  await ok(seller.call('PATCH', `/api/seller/menu/${goat.id}/finish`));
  const g = (await ok(cust.call('GET', '/api/public/menu'))).items.find((i) => i.name === 'Goat');
  assert.strictEqual(g.status, 'finished'); assert(!('finishedBy' in g));
  const goatOrder = await cust.call('POST', '/api/public/orders', { table: table5.qrId, items: [{ foodId: fufu.id, proteinId: goat.id, quantity: 1 }] });
  assert.strictEqual(goatOrder.status, 400);
  const seller2 = new Client();
  const s2 = await ok(admin.call('POST', '/api/admin/sellers', { fullName: 'Yaw', phone: '0200000000', pin: '4321' }));
  await ok(seller2.call('POST', '/api/auth/seller-login', { sellerId: s2.id, pin: '4321' }));
  assert.strictEqual((await ok(seller2.call('GET', '/api/menu'))).find((m) => m.name === 'Goat').status, 'finished');
  const adm = (await ok(admin.call('GET', '/api/menu'))).find((m) => m.name === 'Goat');
  assert.strictEqual(adm.status, 'finished'); assert.strictEqual(adm.finishedBy, 'Ama');
  // finished flag is date-bound: pretend it was yesterday -> available again
  const d = await ok(admin.call('GET', '/api/admin/dashboard'));
  assert(d.menuStatus.find((m) => m.name === 'Goat').status === 'finished');
  test('Goat finished: customers blocked, other seller + admin see it (finished by Ama), item not deleted');

  console.log('\nOrder processing -> becomes a sale');
  await ok(seller.call('PATCH', `/api/seller/orders/${placed.orderId}/status`, { status: 'preparing' }));
  assert.strictEqual((await seller2.call('PATCH', `/api/seller/orders/${placed.orderId}/status`, { status: 'preparing' })).status, 409);
  assert.strictEqual((await seller.call('PATCH', `/api/seller/orders/${placed.orderId}/status`, { status: 'completed', paymentMethod: 'cash' })).status, 409); // must be ready first
  await ok(seller.call('PATCH', `/api/seller/orders/${placed.orderId}/status`, { status: 'ready' }));
  assert.strictEqual((await seller.call('PATCH', `/api/seller/orders/${placed.orderId}/status`, { status: 'completed' })).status, 400); // payment required
  const done = await ok(seller.call('PATCH', `/api/seller/orders/${placed.orderId}/status`, { status: 'completed', paymentMethod: 'momo' }));
  assert.strictEqual(done.paymentStatus, 'paid'); assert(done.transactionId);
  const trk = await ok(cust.call('GET', `/api/public/orders/${placed.orderId}?key=${placed.trackKey}`));
  assert.strictEqual(trk.status, 'completed');
  assert.strictEqual((await cust.call('GET', `/api/public/orders/${placed.orderId}?key=wrong`)).status, 404);
  test('new→preparing→ready→completed; payment required; sale recorded; customer can track only their own order');

  console.log('\nTEST 10 — Sales history (GHS 350)');
  const big = await ok(seller.call('POST', '/api/sales', { paymentMethod: 'cash', items: [{ foodId: banku.id, quantity: 70 }] }));
  assert.strictEqual(big.total, 350);
  test('GHS 350 sale recorded');

  // ---- snapshot before restart
  const salesBefore = await ok(admin.call('GET', '/api/admin/sales'));
  const menuBefore = (await ok(admin.call('GET', '/api/menu'))).length;
  const ordersBefore = (await ok(admin.call('GET', '/api/admin/orders'))).length;
  const withTable = salesBefore.find((x) => x.orderId === placed.orderId);
  assert(withTable && withTable.tableName === 'Table 5');

  console.log('\nTEST 11 — HARD RESTART (kill -9) — nothing may be lost');
  await stop();
  await start();
  const admin2 = new Client(), sel3 = new Client();
  assert.strictEqual((await ok(admin2.call('GET', '/api/auth/setup-status'))).completed, true);
  await ok(admin2.call('POST', '/api/auth/admin-login', { username: 'owner@eg.com', password: 'supersecret1' }));
  await ok(sel3.call('POST', '/api/auth/seller-login', { sellerId: s.id, pin: '1234' }));
  const salesAfter = await ok(admin2.call('GET', '/api/admin/sales'));
  assert.strictEqual(salesAfter.length, salesBefore.length);
  assert(salesAfter.some((x) => x.total === 350));
  assert.strictEqual((await ok(admin2.call('GET', '/api/menu'))).length, menuBefore);
  const bankuAfter = (await ok(admin2.call('GET', '/api/menu'))).find((m) => m.id === banku.id);
  assert(bankuAfter.pricingType === 'unit' && bankuAfter.unitName === 'ball' && bankuAfter.price === 5);
  assert.strictEqual((await ok(admin2.call('GET', '/api/admin/orders'))).length, ordersBefore);
  assert.strictEqual((await ok(admin2.call('GET', '/api/admin/tables'))).tables.length, 5);
  assert.strictEqual((await ok(admin2.call('GET', '/api/menu'))).find((m) => m.name === 'Goat').status, 'finished');
  const dash = await ok(admin2.call('GET', '/api/admin/dashboard'));
  assert(dash.today.revenue >= 350);
  assert(dash.customerOrders.total === ordersBefore);
  test('admin, sellers, menu (incl. per-unit), tables, orders, sales (incl. GHS 350), finished flag all survive kill -9');

  console.log('\nData-file safety');
  const file = path.join(DATA_DIR, 'data.json');
  assert(fs.existsSync(file + '.bak'), 'backup should exist');
  await stop();
  fs.writeFileSync(file, '{ this is not json');           // simulate corruption
  await start();
  const admin3 = new Client();
  await ok(admin3.call('POST', '/api/auth/admin-login', { username: 'owner@eg.com', password: 'supersecret1' }));
  assert(fs.readdirSync(DATA_DIR).some((f) => f.startsWith('data.json.corrupt-')), 'corrupt file must be kept, not overwritten');
  test('corrupt data.json → recovered from backup; corrupt copy kept aside (never silently wiped)');

  console.log('\nOther checks');
  assert.strictEqual((await fetch(`${BASE}/backend/data.json`)).status, 404);
  assert.strictEqual((await fetch(`${BASE}/data.json`)).status, 404);
  assert.strictEqual((await fetch(`${BASE}/backend/server.js`)).status, 404);
  test('data.json and server source are NOT downloadable over HTTP');
  assert.strictEqual((await cust.call('GET', '/api/admin/dashboard')).status, 401);
  assert.strictEqual((await cust.call('GET', '/api/seller/orders')).status, 401);
  assert.strictEqual((await cust.call('GET', '/api/menu')).status, 401);
  test('customers cannot reach admin/seller/staff APIs');
  const dSearch = await ok(admin3.call('GET', '/api/admin/sales?date=today&search=banku'));
  assert(dSearch.length >= 2);
  test('Admin "Today" filter and search now work server-side');

  await stop();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  console.log(`\nALL ${passed} CHECK GROUPS PASSED\n`);
  process.exit(0);
})().catch(async (e) => {
  console.error('\nFAILED:', e.message);
  try { await stop(); } catch (x) {}
  process.exit(1);
});
