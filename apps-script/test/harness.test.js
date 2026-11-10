// Перевірка Code.gs у Node з підробленими сервісами Google (node apps-script/test/harness.test.js)
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const code = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');

function makeEnv(net, files, sheets) {
  const props = sheets.__props || (sheets.__props = {});
  const triggers = sheets.__triggers || (sheets.__triggers = []);
  const mkFile = (name) => ({
    getBlob: () => ({ getDataAsString: () => files[name] }),
    setContent: (t) => { files[name] = t; },
  });
  const folder = {
    getId: () => 'F',
    getFilesByName: (n) => { let done = !(n in files); return { hasNext: () => !done, next: () => { done = true; return mkFile(n); } }; },
    createFile: (n, t) => { files[n] = t; },
  };
  const sheet = (rows) => ({
    getDataRange: () => ({ getValues: () => rows.map((r) => r.slice()) }), insertRowAfter() {},
    getRange: (r, c) => ({ setValues() {}, setValue(v) { (rows[r - 1] = rows[r - 1] || [])[c - 1] = v; } }),
    appendRow: (r) => rows.push(r), getLastRow: () => rows.length, deleteRows() {},
  });
  const ss = { getId: () => 'S', getSheetByName: (n) => sheets[n] ? sheet(sheets[n]) : null };
  const resp = (code, body) => ({ getResponseCode: () => code, getContentText: () => JSON.stringify(body) });
  const ctx = {
    console, Logger: { log() {} }, Date, JSON, Math,
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] || (k === 'folder_id' ? 'F' : null), setProperty: (k, v) => { props[k] = v; } }) },
    SpreadsheetApp: { openById: () => ss, getActive: () => ss, getUi: () => { throw new Error('no ui'); } },
    DriveApp: { getFolderById: () => folder, createFolder: () => folder },
    ScriptApp: {
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: (t) => triggers.splice(triggers.indexOf(t), 1),
      newTrigger: (fn) => ({ timeBased: () => ({ after: () => ({ create: () => triggers.push({ getHandlerFunction: () => fn }) }) }) }),
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    Utilities: {
      sleep() {},
      formatDate: (d, tz, f) => { const k = new Date(d.getTime() + 2 * 3600e3); return f === 'yyyy-MM-dd' ? k.toISOString().slice(0, 10) : f === 'H' ? String(k.getUTCHours()) : String(k.getUTCMinutes()); },
    },
    ContentService: { createTextOutput: (t) => ({ setMimeType: () => t }), MimeType: { JSON: 'json' } },
    UrlFetchApp: {
      fetch: (url) => { const [c, b] = net(url); return resp(c, b); },
      fetchAll: (reqs) => reqs.map((r) => { const [c, b] = net(r.url); return resp(c, b); }),
    },
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx;
}

const NOW = Math.floor(Date.now() / 1000);
const iso = (t) => new Date(t * 1000).toISOString();
const offer = (id, leaf, price, extra = {}) => ({
  id, url: 'https://olx/' + id, title: 'Товар ' + id, created_time: iso(NOW - 600), last_refresh_time: iso(NOW - 600),
  valid_to_time: iso(NOW + 86400 * 20), status: 'active', business: false, description: 'Опис<br />рядок',
  map: { lat: 48.46, lon: 35.04 }, category: { id: leaf }, location: { city: { name: 'Дніпро' }, region: { id: 21 } },
  photos: [{ link: 'https://img/x;s={width}x{height}' }],
  params: [{ key: 'price', type: 'price', value: { value: price, currency: extra.cur || 'UAH', previous_value: extra.prev || null } },
    { key: 'state', name: 'Стан', type: 'select', value: { key: 'used', label: 'Вживане' } },
    ...(extra.params || [])],
});
const chains = { 501: '37|38|501', 701: '37|402|701' };

function net(listing, details) {
  return (url) => {
    if (url.includes('bank.gov.ua')) return [200, [{ cc: 'USD', rate: 40 }]];
    const u = new URL(url);
    if (u.pathname === '/api/v1/offers/') {
      const p = Object.fromEntries(u.searchParams);
      if (p.limit === '1') return [200, { data: [], metadata: { adverts: { config: { targeting: { cat_id: chains[p.category_id], cat_l2_name: 'Лист ' + p.category_id } } } } }];
      assert.strictEqual(p.city_id, '121'); assert.strictEqual(p.distance, '50');
      const cid = Number(p.category_id);
      const items = listing.filter((o) => chains[o.category.id].split('|').map(Number).includes(cid));
      const off = Number(p.offset);
      return [200, { data: items.slice(off, off + 50), metadata: { promoted: [] }, links: {} }];
    }
    const m = u.pathname.match(/offers\/(\d+)\/$/);
    if (m) return details[m[1]] ? [200, { data: details[m[1]] }] : [404, null];
    return [404, null];
  };
}

const files = {};
const sheets = {
  'Налаштування': [['Ключ', 'Значення'], ['OLX_CITY_ID', 121], ['RADIUS_KM', 50]],
  'Категорії': [['Збирати', 'Ключ', 'Назва', 'Іконка', 'Ids'],
    ['так', 'computers', 'Комп\'ютери', '💻', '38, 1502'], ['ні', 'tv', 'ТВ', '📺', '420'], ['так', 'electronics', 'Інша', '📱', '37']],
  'Лог': [['Час', 'Повідомлення']],
};
let env = makeEnv(net([offer(1, 501, 20000, { params: [{ key: 'ram', name: 'ОЗП', type: 'select', value: { key: '16gb', label: '16 ГБ' } },
  { key: 'brand', name: 'Марка', type: 'select', value: { key: '2526', label: 'Samsung' } },
  { key: 'year', name: 'Рік', type: 'input', value: { key: '2015', label: '2015' } },
  { key: 'mileage', name: 'Пробіг', type: 'input', value: { key: '150000', label: '150 000 км' } }] }),
  offer(2, 701, 300, { cur: 'USD' }), offer(3, 701, 5000, { prev: 6000 })], {}), files, sheets);
env.collectAll();
const comp = JSON.parse(files['cat-computers.json']), el = JSON.parse(files['cat-electronics.json']);
assert.deepStrictEqual(comp.offers.map((o) => o.id), [1]);
assert.deepStrictEqual(el.offers.map((o) => o.id).sort(), [2, 3]);
assert.ok(!('cat-tv.json' in files), 'вимкнена категорія не збирається');
assert.strictEqual(comp.dict.ram.o['16gb'], '16 ГБ');
assert.strictEqual(comp.dict.brand.t, 'sel', 'марка з числовим ключем — список');
assert.strictEqual(comp.dict.brand.o['2526'], 'Samsung');
assert.strictEqual(comp.offers[0].pr.brand, '2526');
assert.strictEqual(comp.dict.year.t, 'num');
assert.strictEqual(comp.dict.mileage.t, 'num');
assert.strictEqual(el.offers.find((o) => o.id === 2).pu, 12000);
assert.deepStrictEqual(el.offers.find((o) => o.id === 3).ph.map((x) => x[1]), [6000, 5000]);
assert.strictEqual(comp.subs['501'], 'Лист 501');
const meta = JSON.parse(files['meta.json']);
assert.deepStrictEqual(meta.categories.map((c) => c.key), ['computers', 'electronics']);
assert.strictEqual(meta.area.radius_km, 50);

// Другий збір через годину: №1 подешевшав, №2 знято
const st = JSON.parse(files['state.json']); st.last_run -= 3600; files['state.json'] = JSON.stringify(st);
['cat-computers.json', 'cat-electronics.json'].forEach((f) => { const d = JSON.parse(files[f]); d.offers.forEach((o) => { o.lc -= 3600; }); files[f] = JSON.stringify(d); });
env = makeEnv(net([], { 1: offer(1, 501, 18000), 3: offer(3, 701, 5000) }), files, sheets);
env.collectAll();
const comp2 = JSON.parse(files['cat-computers.json']), el2 = JSON.parse(files['cat-electronics.json']);
assert.deepStrictEqual(comp2.offers[0].ph.map((x) => x[1]), [20000, 18000]);
assert.strictEqual(el2.offers.find((o) => o.id === 2).a, 0);
const meta2 = JSON.parse(files['meta.json']);
const run = meta2.runs[meta2.runs.length - 1];
assert.strictEqual(run.removed, 1); assert.strictEqual(run.price_changes, 1);
assert.strictEqual(JSON.parse(env.doGet({ parameter: { f: 'meta.json' } })).updated, meta2.updated);
assert.ok(JSON.parse(env.doGet({ parameter: { f: '../state.json' } })).hint);

// 403 → попередження і без змін
env = makeEnv(() => [403, null], files, sheets);
env.collectAll();
assert.match(JSON.parse(files['meta.json']).warnings.join(' '), /403/);
// Налаштування з сайту
const q = (p) => JSON.parse(env.doGet({ parameter: p }));
let st0 = q({ action: 'settings' });
assert.deepStrictEqual(st0.categories.filter((c) => c.on).map((c) => c.key), ['computers', 'electronics']);
assert.strictEqual(st0.hasPin, false);
assert.match(q({ action: 'save', cats: 'tv', city: 268, radius: 30 }).error, /PIN/);
const saved = q({ action: 'save', pin: '1234', cats: 'tv', city: 268, radius: 30 });
assert.ok(saved.ok && saved.pinCreated);
assert.deepStrictEqual(saved.categories.filter((c) => c.on).map((c) => c.key), ['tv']);
assert.strictEqual(saved.city, 268); assert.strictEqual(saved.radius, 30);
assert.match(q({ action: 'collect', pin: '9999' }).error, /Невірний/);
assert.ok(q({ action: 'collect', pin: '1234' }).collectQueued);
q({ action: 'collect', pin: '1234' });
assert.strictEqual(sheets.__triggers.length, 1, 'лише один запланований збір');
// збір у новому місті: старі оголошення очищено, нова категорія
env = makeEnv((url) => { if (url.includes('bank.gov.ua')) return [200, []]; const u = new URL(url); if (u.searchParams.get('limit') === '1') return [200, { data: [] }]; assert.strictEqual(u.searchParams.get('city_id'), '268'); return [200, { data: [], links: {} }]; }, files, sheets);
env.collectNow();
assert.strictEqual(sheets.__triggers.length, 0);
const meta3 = JSON.parse(files['meta.json']);
assert.deepStrictEqual(meta3.categories.map((c) => c.key), ['tv']);
assert.strictEqual(meta3.area.name, 'Київ + 30 км');
console.log('Усі перевірки Code.gs пройдено ✔');
