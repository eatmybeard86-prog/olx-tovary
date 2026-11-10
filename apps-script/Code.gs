/**
 * Пошук товарів OLX — збирач оголошень на Google Apps Script.
 *
 * Збір щогодини (тригер collectAll), дані — JSON-файли в папці на Google Диску,
 * налаштування — аркуші «Налаштування» і «Категорії» цієї Google-таблиці.
 * Сайт (GitHub Pages) читає дані через веб-застосунок: doGet(?f=meta.json).
 *
 * Перший запуск: виконайте функцію setup(), позначте категорії «так» на аркуші «Категорії».
 */

const SHEETS = { SETTINGS: 'Налаштування', CATEGORIES: 'Категорії', LOG: 'Лог' };

const DEFAULT_SETTINGS = [
  ['CITY_NAME', 'Дніпро', 'Назва для сайту'],
  ['OLX_CITY_ID', 121, 'Місто на OLX (121 = Дніпро, 268 = Київ, 280 = Харків, 62 = Одеса, 176 = Львів, 194 = Запоріжжя; поміняйте й CENTER_LAT/LNG)'],
  ['RADIUS_KM', 50, 'Радіус пошуку від міста, км (OLX шукає в цьому радіусі)'],
  ['CENTER_LAT', 48.4647, 'Центр карти на сайті'],
  ['CENTER_LNG', 35.0462, ''],
  ['PAGES', 10, 'Скільки сторінок по 50 найновіших оголошень перевіряти в кожній категорії за один збір'],
  ['CHECK_PER_RUN', 400, 'Скільки вже відомих оголошень перевіряти на актуальність і зміну ціни за один збір'],
  ['KEEP_INACTIVE_DAYS', 21, 'Скільки днів пам\'ятати зняті оголошення (для графіків динаміки)'],
];

// Збирати | Ключ | Назва | Іконка | Номери категорій OLX (перевірені 09.11.2026)
const DEFAULT_CATEGORIES = [
  ['ні', 'computers', 'Комп\'ютери та ноутбуки', '💻', '38, 1502'],
  ['ні', 'tv', 'Телевізори та відео', '📺', '420'],
  ['ні', 'appliances', 'Побутова техніка', '🧺', '383, 369, 395'],
  ['ні', 'electronics', 'Інша електроніка', '📱', '37'],
  ['ні', 'wheels', 'Шини, диски, колеса', '🛞', '270'],
  ['ні', 'parts', 'Запчастини', '🔧', '3'],
  ['ні', 'transport', 'Транспорт', '🚗', '1532'],
  ['ні', 'furniture', 'Меблі', '🛋️', '57'],
];

const API = 'https://www.olx.ua/api/v1';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept': 'application/json', 'Accept-Language': 'uk-UA,uk;q=0.9' };
const MAX_RUN_MS = 5 * 60 * 1000;
const RUN_START = Date.now();
const timeLeft_ = () => MAX_RUN_MS - (Date.now() - RUN_START);

// ───────────────────────── Меню і налаштування ─────────────────────────

function onOpen() {
  SpreadsheetApp.getUi().createMenu('🔎 OLX')
    .addItem('Налаштувати (перший запуск)', 'setup')
    .addItem('Зібрати оголошення зараз', 'collectAll')
    .addToUi();
}

function setup() {
  const ss = SpreadsheetApp.getActive();
  PropertiesService.getScriptProperties().setProperty('ss_id', ss.getId());

  const st = ss.getSheetByName(SHEETS.SETTINGS) || ss.insertSheet(SHEETS.SETTINGS, 0);
  if (st.getLastRow() === 0) st.appendRow(['Ключ', 'Значення', 'Пояснення']);
  const have = st.getDataRange().getValues().map(r => r[0]);
  DEFAULT_SETTINGS.forEach(r => { if (have.indexOf(r[0]) < 0) st.appendRow(r); });
  st.getRange(1, 1, 1, 3).setFontWeight('bold');
  st.setFrozenRows(1);
  st.setColumnWidth(1, 200).setColumnWidth(2, 160).setColumnWidth(3, 520);

  let ct = ss.getSheetByName(SHEETS.CATEGORIES);
  if (!ct) {
    ct = ss.insertSheet(SHEETS.CATEGORIES, 1);
    ct.appendRow(['Збирати', 'Ключ', 'Назва', 'Іконка', 'Номери категорій OLX']);
    DEFAULT_CATEGORIES.forEach(r => ct.appendRow(r));
    ct.getRange(1, 1, 1, 5).setFontWeight('bold');
    ct.setFrozenRows(1);
    ct.setColumnWidth(1, 80).setColumnWidth(3, 220).setColumnWidth(5, 200);
    const rule = SpreadsheetApp.newDataValidation().requireValueInList(['так', 'ні'], true).build();
    ct.getRange(2, 1, 50, 1).setDataValidation(rule);
    ct.getRange(DEFAULT_CATEGORIES.length + 3, 1).setValue(
      'Порядок важливий: оголошення потрапляє в першу категорію зверху, до якої належить ' +
      '(тому «Комп\'ютери» вище «Іншої електроніки», а «Шини» вище «Запчастин»).');
  }

  const lg = ss.getSheetByName(SHEETS.LOG) || ss.insertSheet(SHEETS.LOG);
  if (lg.getLastRow() === 0) lg.appendRow(['Час', 'Повідомлення']);

  folder_();
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'collectAll') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('collectAll').timeBased().everyHours(1).create();

  alert_('Готово! На аркуші «Категорії» поставте «так» навпроти потрібних категорій, ' +
    'перевірте місто і радіус на аркуші «Налаштування», потім «🔎 OLX → Зібрати оголошення зараз». ' +
    'Далі збір запускатиметься щогодини автоматично.');
}

function ss_() {
  const id = PropertiesService.getScriptProperties().getProperty('ss_id');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActive();
}

function getSettings_() {
  const s = {};
  DEFAULT_SETTINGS.forEach(r => { s[r[0]] = r[1]; });
  const sh = ss_().getSheetByName(SHEETS.SETTINGS);
  if (sh) sh.getDataRange().getValues().slice(1).forEach(r => {
    if (r[0]) s[String(r[0]).trim()] = typeof r[1] === 'string' ? r[1].trim() : r[1];
  });
  return s;
}

function getGroups_() {
  const sh = ss_().getSheetByName(SHEETS.CATEGORIES);
  const rows = sh ? sh.getDataRange().getValues().slice(1) : DEFAULT_CATEGORIES;
  return rows.filter(r => r[1] && String(r[4]).trim()).map(r => ({
    on: /^(так|yes|true|1|\+)$/i.test(String(r[0]).trim()),
    key: String(r[1]).trim(), name: String(r[2]).trim(), icon: String(r[3]).trim(),
    ids: String(r[4]).split(/[,; ]+/).map(Number).filter(n => n > 0),
  }));
}

function alert_(msg) {
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { Logger.log(msg); }
}

function log_(msg) {
  try {
    const sh = ss_().getSheetByName(SHEETS.LOG);
    if (!sh) return;
    sh.insertRowAfter(1);
    sh.getRange(2, 1, 1, 2).setValues([[new Date(), msg]]);
    if (sh.getLastRow() > 300) sh.deleteRows(301, sh.getLastRow() - 300);
  } catch (e) { Logger.log(msg); }
}

// ───────────────────────── Сховище (Google Диск) ─────────────────────────

function folder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('folder_id');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* видалили — створимо нову */ } }
  const f = DriveApp.createFolder('OLX пошук товарів — дані');
  props.setProperty('folder_id', f.getId());
  return f;
}

function readFile_(name, def) {
  const it = folder_().getFilesByName(name);
  if (!it.hasNext()) return def;
  try { return JSON.parse(it.next().getBlob().getDataAsString('UTF-8')); } catch (e) { return def; }
}

function writeFile_(name, obj) {
  const txt = JSON.stringify(obj);
  const it = folder_().getFilesByName(name);
  if (it.hasNext()) it.next().setContent(txt);
  else folder_().createFile(name, txt, 'application/json');
}

// ───────────────────────── Веб-застосунок: дані для сайту ─────────────────────────

function doGet(e) {
  const f = (e && e.parameter && e.parameter.f) || '';
  let txt;
  if (/^(meta|stats|cat-[a-z0-9_-]+)\.json$/i.test(f)) {
    const it = folder_().getFilesByName(f);
    txt = it.hasNext() ? it.next().getBlob().getDataAsString('UTF-8') : JSON.stringify({ error: 'not found' });
  } else {
    txt = JSON.stringify({ ok: true, hint: 'Додайте ?f=meta.json' });
  }
  return ContentService.createTextOutput(txt).setMimeType(ContentService.MimeType.JSON);
}

// ───────────────────────── Запити до OLX ─────────────────────────

function qs_(p) {
  return Object.keys(p).filter(k => p[k] !== '' && p[k] != null)
    .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(p[k])).join('&');
}

function olx_(path, params) {
  const url = API + path + (params ? '?' + qs_(params) : '');
  for (let attempt = 0; attempt < 3; attempt++) {
    let r;
    try { r = UrlFetchApp.fetch(url, { headers: HEADERS, muteHttpExceptions: true }); }
    catch (e) { Utilities.sleep(1500); continue; }
    const code = r.getResponseCode();
    if (code === 200) {
      try { return { code, json: JSON.parse(r.getContentText()) }; } catch (e) { return { code: 0, json: null }; }
    }
    if (code === 429 || code >= 500) { Utilities.sleep(2000 * (attempt + 1)); continue; }
    return { code, json: null };
  }
  return { code: 0, json: null };
}

function getRates_() {
  const rates = { UAH: 1, USD: 41.5, EUR: 48 };
  try {
    const r = UrlFetchApp.fetch('https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?json', { muteHttpExceptions: true });
    JSON.parse(r.getContentText()).forEach(x => { if (x.cc === 'USD' || x.cc === 'EUR') rates[x.cc] = x.rate; });
  } catch (e) { /* залишаємо запасні курси */ }
  return rates;
}

// ───────────────────────── Розбір оголошення ─────────────────────────

function num_(v) {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return null;
  const t = v.replace(/[\s ]/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}

function ts_(s) {
  if (!s) return null;
  const t = Date.parse(s);
  return isNaN(t) ? null : Math.floor(t / 1000);
}

function parseOffer_(o) {
  const rec = {
    id: o.id, t: String(o.title || '').trim(), u: o.url,
    cr: ts_(o.created_time), rf: ts_(o.last_refresh_time), vt: ts_(o.valid_to_time),
    lf: (o.category || {}).id, biz: o.business ? 1 : 0, pr: {},
  };
  const m = o.map || {};
  if (m.lat != null) { rec.la = Math.round(m.lat * 1e4) / 1e4; rec.lo = Math.round(m.lon * 1e4) / 1e4; }
  const loc = o.location || {};
  const city = (loc.city || {}).name, dist = (loc.district || {}).name;
  rec.city = city ? city + (dist ? ', ' + dist : '') : '';
  rec.reg = (loc.region || {}).id;
  const photos = o.photos || [];
  if (photos.length && photos[0].link) rec.img = photos[0].link.replace('{width}', '400').replace('{height}', '300');
  rec.np = photos.length;
  rec.d = String(o.description || '').replace(/<br\s*\/?>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);

  const dict = {};
  (o.params || []).forEach(p => {
    const key = p.key, val = p.value;
    if (!key || val == null) return;
    if (key === 'price' || p.type === 'price') {
      rec.p = num_(val.value); rec.c = val.currency || 'UAH'; rec.pt = val.type;
      if (val.negotiable || val.arranged) rec.neg = 1;
      const prev = num_(val.previous_value);
      if (prev && prev !== rec.p) rec.prev = prev;
      return;
    }
    const name = p.name || key;
    if (Array.isArray(val)) {
      const keys = val.filter(v => v && v.key != null).map(v => String(v.key));
      if (keys.length) {
        rec.pr[key] = keys;
        const o2 = {}; val.forEach(v => { if (v && v.key != null) o2[String(v.key)] = v.label || String(v.key); });
        dict[key] = { n: name, t: 'sel', o: o2 };
      }
      return;
    }
    if (typeof val !== 'object') return;
    const vkey = val.key, label = val.label;
    const n = vkey != null ? num_(String(vkey)) : null;
    if (n != null && !(String(vkey).length > 1 && String(vkey)[0] === '0')) {
      rec.pr[key] = n; dict[key] = { n: name, t: 'num' };
    } else if (vkey != null) {
      rec.pr[key] = String(vkey);
      const o2 = {}; o2[String(vkey)] = label || String(vkey);
      dict[key] = { n: name, t: 'sel', o: o2 };
    }
  });
  if (!Object.keys(rec.pr).length) delete rec.pr;
  return { rec, dict };
}

function mergeDict_(target, d) {
  Object.keys(d).forEach(k => {
    const cur = target[k], x = d[k];
    if (!cur) { target[k] = JSON.parse(JSON.stringify(x)); return; }
    if (x.t === 'sel') {
      if (cur.t === 'num') { cur.t = 'sel'; cur.o = {}; }
      cur.o = Object.assign(cur.o || {}, x.o || {});
    }
  });
}

// ───────────────────────── Збір ─────────────────────────

function collectAll() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try { new Collector_().run(); }
  catch (e) { log_('Помилка: ' + e.message); throw e; }
  finally { lock.releaseLock(); }
}

function Collector_() {
  this.now = Math.floor(Date.now() / 1000);
  this.s = getSettings_();
  this.allGroups = getGroups_();
  this.groups = this.allGroups.filter(g => g.on);
  this.state = readFile_('state.json', {});
  this.state.leaves = this.state.leaves || {};
  this.cats = {};
  this.groups.forEach(g => {
    const d = readFile_('cat-' + g.key + '.json', {});
    const offers = {};
    (d.offers || []).forEach(o => { offers[String(o.id)] = o; });
    this.cats[g.key] = { offers, dict: d.dict || {}, subs: d.subs || {} };
  });
  this.stats = readFile_('stats.json', {});
  this.warnings = [];
  this.blocked = false;
  this.c = { new: 0, updated: 0, price_changes: 0, removed: 0, checked: 0, requests: 0 };
}

Collector_.prototype.run = function () {
  if (!this.groups.length) {
    this.warnings.push('Не вибрано жодної категорії: поставте «так» на аркуші «Категорії».');
  }
  this.rates = getRates_();
  this.collect();
  if (timeLeft_() > 40000) this.check();
  this.prune();
  this.computeStats();
  this.save();
  log_('Збір: ' + JSON.stringify(this.c) + (this.warnings.length ? ' ⚠ ' + this.warnings.join(' ') : ''));
};

Collector_.prototype.leafInfo = function (leaf) {
  const k = String(leaf);
  if (this.state.leaves[k]) return this.state.leaves[k];
  if (this.blocked || timeLeft_() < 60000) return null;
  const r = olx_('/offers/', { category_id: leaf, limit: 1, offset: 0 });
  this.c.requests++;
  const tg = (((((r.json || {}).metadata || {}).adverts || {}).config || {}).targeting) || {};
  const chain = String(tg.cat_id || '').split('|').map(Number).filter(n => n > 0);
  if (!chain.length) return null;
  const depth = chain.length;
  // У метаданих OLX назви рівнів 0 і 1 переставлені місцями.
  const name = depth >= 3 ? tg.cat_l2_name : depth === 2 ? tg.cat_l0_name : (tg.cat_l1_name || tg.cat_l0_name);
  const info = { chain, name: name || ('Категорія ' + leaf) };
  this.state.leaves[k] = info;
  return info;
};

Collector_.prototype.groupFor = function (leaf, fallback) {
  const info = leaf ? this.leafInfo(leaf) : null;
  if (!info) return fallback;
  for (const g of this.groups) if (g.ids.some(id => info.chain.indexOf(id) >= 0)) return g.key;
  return fallback;
};

Collector_.prototype.ownerOf = function (id) {
  for (const k in this.cats) if (this.cats[k].offers[id]) return k;
  return null;
};

Collector_.prototype.upsert = function (gkey, raw) {
  const { rec, dict } = parseOffer_(raw);
  const id = String(rec.id);
  const owner = this.ownerOf(id);
  if (owner) gkey = owner;
  const cat = this.cats[gkey];
  mergeDict_(cat.dict, dict);
  if (rec.lf && this.state.leaves[String(rec.lf)]) cat.subs[String(rec.lf)] = this.state.leaves[String(rec.lf)].name;
  rec.pu = rec.p == null ? null : Math.round(rec.p * (this.rates[rec.c || 'UAH'] || 1));
  const old = cat.offers[id];
  const prev = rec.prev; delete rec.prev;
  if (!old) {
    const ph = [];
    if (prev && rec.p != null) ph.push([rec.cr || this.now, prev]);
    if (rec.p != null) ph.push([this.now, rec.p]);
    Object.assign(rec, { ph, fs: this.now, ls: this.now, lc: this.now, a: 1 });
    cat.offers[id] = rec;
    this.c.new++;
    return;
  }
  const ph = old.ph || [];
  if (rec.p != null && (!ph.length || ph[ph.length - 1][1] !== rec.p)) {
    if (ph.length) this.c.price_changes++;
    ph.push([this.now, rec.p]);
  }
  Object.assign(rec, { ph, fs: old.fs || this.now, ls: this.now, lc: this.now, a: 1 });
  cat.offers[id] = rec;
  this.c.updated++;
};

Collector_.prototype.collect = function () {
  const last = this.state.last_run || 0;
  const cutoff = last ? last - 3 * 3600 : 0;
  const pages = Math.min(Number(this.s.PAGES) || 10, 20);
  const done = {};
  for (const g of this.groups) {
    for (const cid of g.ids) {
      if (done[cid]) continue;
      done[cid] = true;
      let kept = 0;
      for (let page = 0; page < pages; page++) {
        if (this.blocked || timeLeft_() < 90000) break;
        const r = olx_('/offers/', {
          offset: page * 50, limit: 50, category_id: cid,
          city_id: this.s.OLX_CITY_ID, distance: this.s.RADIUS_KM, sort_by: 'created_at:desc',
        });
        this.c.requests++;
        if (r.code === 403) {
          this.blocked = true;
          this.warnings.push('OLX відхилив запити збирача (403 Forbidden), оголошення не оновлено.');
          break;
        }
        const data = (r.json || {}).data || [];
        if (!data.length) break;
        const promoted = ((r.json.metadata || {}).promoted) || [];
        let oldest = null;
        data.forEach((o, i) => {
          if ((o.status || 'active') === 'active') {
            this.upsert(this.groupFor((o.category || {}).id, g.key), o);
            kept++;
          }
          if (promoted.indexOf(i) < 0) {
            const t = ts_(o.created_time);
            if (t && (oldest == null || t < oldest)) oldest = t;
          }
        });
        if (oldest != null && oldest < cutoff) break;
        if (!((r.json.links || {}).next)) break;
      }
      Logger.log(g.key + ' / ' + cid + ': ' + kept);
    }
  }
};

Collector_.prototype.check = function () {
  if (this.blocked) return;
  const budget = Number(this.s.CHECK_PER_RUN) || 400;
  const cands = [];
  for (const k in this.cats) {
    const offers = this.cats[k].offers;
    for (const id in offers) {
      const o = offers[id];
      if (o.a === 1 && (o.lc || 0) < this.now - 1800) {
        cands.push({ k, id, exp: o.vt && o.vt < this.now ? 1 : 0, lc: o.lc || 0 });
      }
    }
  }
  cands.sort((a, b) => (b.exp - a.exp) || (a.lc - b.lc));
  const list = cands.slice(0, budget);
  for (let i = 0; i < list.length && timeLeft_() > 30000; i += 20) {
    const batch = list.slice(i, i + 20);
    let resps;
    try {
      resps = UrlFetchApp.fetchAll(batch.map(x => ({
        url: API + '/offers/' + x.id + '/', headers: HEADERS, muteHttpExceptions: true,
      })));
    } catch (e) { break; }
    this.c.requests += batch.length;
    let forbidden = 0;
    resps.forEach((r, j) => {
      const x = batch[j], o = this.cats[x.k].offers[x.id];
      const code = r.getResponseCode();
      if (code === 404 || code === 410) { this.deactivate(o); this.c.checked++; return; }
      if (code === 403) { forbidden++; return; }
      if (code !== 200) return;
      let d = null;
      try { d = JSON.parse(r.getContentText()).data; } catch (e) { return; }
      if (!d) return;
      this.c.checked++;
      if ((d.status || 'active') !== 'active') this.deactivate(o);
      else { this.upsert(x.k, d); this.c.updated--; }
    });
    if (forbidden > batch.length / 2) {
      this.warnings.push('OLX тимчасово обмежив перевірку оголошень — решту перевіримо наступного разу.');
      break;
    }
    Utilities.sleep(300);
  }
};

Collector_.prototype.deactivate = function (o) {
  if (o && o.a === 1) { o.a = 0; o.rm = this.now; this.c.removed++; }
};

Collector_.prototype.prune = function () {
  const keep = (Number(this.s.KEEP_INACTIVE_DAYS) || 21) * 86400;
  for (const k in this.cats) {
    const offers = this.cats[k].offers;
    for (const id in offers) if (offers[id].a === 0 && (offers[id].rm || 0) < this.now - keep) delete offers[id];
  }
};

Collector_.prototype.computeStats = function () {
  const tz = 'Europe/Kyiv';
  const day = Utilities.formatDate(new Date(this.now * 1000), tz, 'yyyy-MM-dd');
  const start = this.now - (Number(Utilities.formatDate(new Date(this.now * 1000), tz, 'H')) * 3600 +
    Number(Utilities.formatDate(new Date(this.now * 1000), tz, 'm')) * 60);
  for (const k in this.cats) {
    const offers = Object.keys(this.cats[k].offers).map(id => this.cats[k].offers[id]);
    const active = offers.filter(o => o.a === 1);
    const prices = active.map(o => o.pu).filter(p => p).sort((a, b) => a - b);
    const s = this.stats[k] = this.stats[k] || {};
    s[day] = {
      act: active.length,
      new: offers.filter(o => (o.fs || 0) >= start).length,
      rm: offers.filter(o => (o.rm || 0) >= start).length,
      med: prices.length ? prices[Math.floor(prices.length / 2)] : null,
      drop: active.filter(o => o.ph && o.ph.length > 1 && o.ph[o.ph.length - 1][1] < o.ph[o.ph.length - 2][1]).length,
    };
    Object.keys(s).sort().slice(0, -120).forEach(d => delete s[d]);
  }
};

Collector_.prototype.save = function () {
  if (!this.blocked) this.state.last_run = this.now;
  writeFile_('state.json', this.state);
  writeFile_('stats.json', this.stats);
  const catsMeta = [];
  this.groups.forEach(g => {
    const c = this.cats[g.key];
    const offers = Object.keys(c.offers).map(id => c.offers[id])
      .sort((a, b) => (b.cr || b.fs || 0) - (a.cr || a.fs || 0));
    writeFile_('cat-' + g.key + '.json', { dict: c.dict, subs: c.subs, offers });
    catsMeta.push({ key: g.key, name: g.name, icon: g.icon, active: offers.filter(o => o.a === 1).length, total: offers.length });
  });
  const meta = readFile_('meta.json', {});
  const runs = (meta.runs || []).slice(-47);
  runs.push(Object.assign({ at: this.now, sec: Math.round((Date.now() - RUN_START) / 1000) }, this.c));
  writeFile_('meta.json', {
    updated: this.now,
    area: {
      type: 'circle', name: this.s.CITY_NAME + ' + ' + this.s.RADIUS_KM + ' км',
      lat: Number(this.s.CENTER_LAT), lon: Number(this.s.CENTER_LNG), radius_km: Number(this.s.RADIUS_KM),
    },
    rates: this.rates, categories: catsMeta, warnings: this.warnings, runs,
  });
};
