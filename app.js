/* Пошук товарів OLX — клієнтська частина. Дані: ./data/*.json (оновлюються щогодини). */
(() => {
  'use strict';
  const DATA = 'data/';
  const PAGE = 60;
  const $ = (s) => document.querySelector(s);
  const LS = {
    get(k, d) { try { const v = localStorage.getItem('olxt:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('olxt:' + k, JSON.stringify(v)); } catch { /* приватний режим */ } },
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => n == null ? '' : Math.round(n).toLocaleString('uk-UA');
  const CUR = { UAH: 'грн', USD: '$', EUR: '€' };
  const money = (p, c) => p == null ? 'Ціну не вказано' : `${fmt(p)} ${CUR[c] || c || 'грн'}`;
  const ago = (ts) => {
    const s = Date.now() / 1000 - ts;
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))} хв тому`;
    if (s < 86400) return `${Math.round(s / 3600)} год тому`;
    const d = Math.round(s / 86400);
    return `${d} ${d === 1 ? 'день' : d < 5 ? 'дні' : 'днів'} тому`;
  };
  const dateStr = (ts) => new Date(ts * 1000).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const dayKey = (ts) => { const d = new Date(ts * 1000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

  // ------------------------------------------------------------------ стан
  let meta = null, rates = { UAH: 1 }, catKey = LS.get('cat', null), cat = null;
  let filtered = [], shown = 0, view = LS.get('view', 'list');
  let zones = LS.get('zones', []);
  const prevSeen = LS.get('seenUntil', 0);
  let filters = {};
  const cache = {};

  // ------------------------------------------------------------------ завантаження
  const DATA_URL = (window.CONFIG && window.CONFIG.DATA_URL || '').trim();
  async function getJSON(name) {
    const url = DATA_URL ? `${DATA_URL}?f=${encodeURIComponent(name)}&t=${Date.now()}` : `${DATA}${name}?t=${Date.now()}`;
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(name + ': ' + r.status);
    const js = await r.json();
    if (js && js.error) throw new Error(name + ': ' + js.error);
    return js;
  }

  async function init() {
    try { meta = await getJSON('meta.json'); }
    catch (e) {
      $('#list').innerHTML = `<div class="empty">Даних ще немає. Перевірте, що в config.js вказано адресу веб-застосунку Apps Script, вибрано категорії в Google-таблиці і пройшов перший збір.<br><small>${esc(e.message)}</small></div>`;
      bindUI(); return;
    }
    rates = meta.rates || rates;
    if (!meta.categories.some((c) => c.key === catKey)) catKey = meta.categories[0]?.key;
    renderMeta();
    bindUI();
    await selectCat(catKey);
    setView(view);
    setInterval(refresh, 5 * 60 * 1000);
    const saveSeen = () => LS.set('seenUntil', meta.updated);
    addEventListener('pagehide', saveSeen);
    document.addEventListener('visibilitychange', () => { if (document.hidden) saveSeen(); });
  }

  async function refresh() {
    try {
      const m = await getJSON('meta.json');
      if (m.updated !== meta.updated) {
        meta = m; rates = m.rates || rates;
        Object.keys(cache).forEach((k) => delete cache[k]);
        renderMeta();
        await selectCat(catKey, true);
      }
    } catch { /* спробуємо наступного разу */ }
  }

  function renderMeta() {
    $('#updated').textContent = `Оновлено ${dateStr(meta.updated)} · ${meta.area?.name || ''}`;
    $('#cats').innerHTML = meta.categories.map((c) =>
      `<button data-cat="${esc(c.key)}" class="${c.key === catKey ? 'active' : ''}">${esc(c.icon)} ${esc(c.name)}<small>${fmt(c.active)}</small></button>`).join('');
    $('#warnings').innerHTML = (meta.warnings || []).map((w) => `<div>⚠️ ${esc(w)}</div>`).join('');
  }

  async function selectCat(key, keepFilters) {
    catKey = key; LS.set('cat', key);
    document.querySelectorAll('#cats button').forEach((b) => b.classList.toggle('active', b.dataset.cat === key));
    $('#list').innerHTML = '<div class="empty">Завантаження…</div>';
    if (!cache[key]) cache[key] = await getJSON(`cat-${key}.json`).catch(() => ({ offers: [], dict: {}, subs: {} }));
    cat = cache[key];
    for (const o of cat.offers) o._pu = toUah(o.p, o.c);
    if (!keepFilters) filters = LS.get('f:' + key, {});
    buildParamFilters();
    writeBaseFilters();
    apply();
  }

  const toUah = (p, c) => p == null ? null : p * (rates[c || 'UAH'] || 1);

  // ------------------------------------------------------------------ фільтри
  function writeBaseFilters() {
    $('#fQ').value = filters.q || '';
    $('#fPmin').value = filters.pmin ?? '';
    $('#fPmax').value = filters.pmax ?? '';
    $('#fAge').value = filters.age || '0';
    $('#fDrop').checked = !!filters.drop;
    $('#fPhoto').checked = !!filters.photo;
    $('#fZone').checked = filters.zone !== false;
    $('#fInactive').checked = !!filters.inactive;
    $('#fBiz').value = filters.biz ?? '';
    $('#fSort').value = filters.sort || 'new';
  }

  function readBaseFilters() {
    const num = (v) => v === '' ? undefined : Number(v);
    Object.assign(filters, {
      q: $('#fQ').value.trim(), pmin: num($('#fPmin').value), pmax: num($('#fPmax').value),
      age: $('#fAge').value, drop: $('#fDrop').checked, photo: $('#fPhoto').checked,
      zone: $('#fZone').checked, inactive: $('#fInactive').checked, biz: $('#fBiz').value, sort: $('#fSort').value,
    });
  }

  function buildParamFilters() {
    const active = cat.offers.filter((o) => o.a === 1);
    // Підкатегорії
    const subCounts = {};
    active.forEach((o) => { if (o.lf) subCounts[o.lf] = (subCounts[o.lf] || 0) + 1; });
    const subKeys = Object.keys(subCounts).sort((a, b) => subCounts[b] - subCounts[a]);
    const selSubs = new Set(filters.subs || []);
    $('#fSubs').innerHTML = subKeys.length > 1 ? group('Підкатегорія', selSubs.size, true,
      `<div class="opts">${subKeys.map((k) => `<label><input type="checkbox" data-sub="${esc(k)}" ${selSubs.has(k) ? 'checked' : ''}>${esc(cat.subs?.[k] || 'Категорія ' + k)}<small>${subCounts[k]}</small></label>`).join('')}</div>`) : '';

    // Параметри категорії (з самих оголошень OLX)
    const stats = {};
    for (const o of active) {
      if (!o.pr) continue;
      for (const [k, v] of Object.entries(o.pr)) {
        const s = stats[k] || (stats[k] = { n: 0, vals: {}, min: Infinity, max: -Infinity });
        s.n++;
        const d = cat.dict[k];
        if (d?.t === 'num' && typeof v === 'number') { s.min = Math.min(s.min, v); s.max = Math.max(s.max, v); }
        else for (const x of [].concat(v)) s.vals[x] = (s.vals[x] || 0) + 1;
      }
    }
    const pf = filters.params || {};
    const keys = Object.keys(stats).filter((k) => cat.dict[k] && stats[k].n >= 2)
      .sort((a, b) => (a === 'state' ? -1 : b === 'state' ? 1 : stats[b].n - stats[a].n));
    $('#fParams').innerHTML = keys.map((k) => {
      const d = cat.dict[k], s = stats[k], f = pf[k];
      if (d.t === 'num') {
        if (!(s.max > s.min)) return '';
        const on = f && (f.min != null || f.max != null);
        return group(d.n, on ? 1 : 0, on || keys.indexOf(k) < 4,
          `<div class="range"><input type="number" data-pmin="${esc(k)}" placeholder="від ${fmt(s.min)}" value="${f?.min ?? ''}"><input type="number" data-pmax="${esc(k)}" placeholder="до ${fmt(s.max)}" value="${f?.max ?? ''}"></div>`);
      }
      const vals = Object.keys(s.vals).sort((a, b) => s.vals[b] - s.vals[a]);
      if (vals.length < 2) return '';
      const sel = new Set(Array.isArray(f) ? f : []);
      return group(d.n, sel.size, sel.size > 0 || keys.indexOf(k) < 4,
        `<div class="opts">${vals.map((v) => `<label><input type="checkbox" data-pk="${esc(k)}" data-pv="${esc(v)}" ${sel.has(v) ? 'checked' : ''}>${esc(d.o?.[v] || v)}<small>${s.vals[v]}</small></label>`).join('')}</div>`);
    }).join('');
  }

  function group(title, nSel, open, inner) {
    return `<details class="fgroup" ${open ? 'open' : ''}><summary><span>${esc(title)}${nSel ? `<span class="badge">${nSel}</span>` : ''}</span></summary>${inner}</details>`;
  }

  function readParamFilters() {
    const params = {};
    document.querySelectorAll('#fParams input[data-pk]:checked').forEach((i) => {
      (params[i.dataset.pk] || (params[i.dataset.pk] = [])).push(i.dataset.pv);
    });
    document.querySelectorAll('#fParams input[data-pmin], #fParams input[data-pmax]').forEach((i) => {
      if (i.value === '') return;
      const k = i.dataset.pmin || i.dataset.pmax;
      const o = params[k] || (params[k] = {});
      o[i.dataset.pmin ? 'min' : 'max'] = Number(i.value);
    });
    filters.params = params;
    filters.subs = [...document.querySelectorAll('#fSubs input:checked')].map((i) => i.dataset.sub);
  }

  // ------------------------------------------------------------------ зони
  function inZones(o) {
    if (!zones.length) return true;
    if (o.la == null) return false;
    return zones.some((z) => {
      if (z.type === 'rect') return o.la >= z.b[0][0] && o.la <= z.b[1][0] && o.lo >= z.b[0][1] && o.lo <= z.b[1][1];
      if (z.type === 'circle') return distM(z.c[0], z.c[1], o.la, o.lo) <= z.r;
      if (z.type === 'poly') return pip(o.la, o.lo, z.p);
      return true;
    });
  }
  function distM(a1, o1, a2, o2) {
    const R = 6371000, r = Math.PI / 180, dA = (a2 - a1) * r, dO = (o2 - o1) * r;
    const h = Math.sin(dA / 2) ** 2 + Math.cos(a1 * r) * Math.cos(a2 * r) * Math.sin(dO / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function pip(lat, lon, p) {
    let ins = false;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const [yi, xi] = p[i], [yj, xj] = p[j];
      if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) ins = !ins;
    }
    return ins;
  }
  function zoneText() {
    if (!zones.length) return 'Зона пошуку не задана — показано всю зону збору.';
    const parts = zones.map((z) => {
      if (z.type === 'circle') return `коло ${(z.r / 1000).toFixed(1)} км`;
      if (z.type === 'rect') return 'прямокутник';
      return 'багатокутник';
    });
    return `Зона пошуку: ${parts.join(', ')}.${filters.zone === false ? ' (вимкнено у фільтрах)' : ''}`;
  }

  // ------------------------------------------------------------------ відбір
  function matches(o, { ignoreZone = false, includeInactive = false } = {}) {
    const f = filters;
    if (!includeInactive && !f.inactive && o.a !== 1) return false;
    if (f.q) {
      const hay = (o.t + ' ' + (o.d || '')).toLowerCase();
      if (!f.q.toLowerCase().split(/\s+/).every((w) => hay.includes(w))) return false;
    }
    if (f.pmin != null && !(o._pu >= f.pmin)) return false;
    if (f.pmax != null && !(o._pu != null && o._pu <= f.pmax)) return false;
    if (f.age && f.age !== '0') {
      const t = o.cr || o.fs;
      if (f.age === 'new') { if (!(o.fs > prevSeen)) return false; }
      else if (t < Date.now() / 1000 - Number(f.age) * 3600) return false;
    }
    if (f.drop && !(o.ph?.length > 1 && o.ph[o.ph.length - 1][1] < Math.max(...o.ph.map((x) => x[1])))) return false;
    if (f.photo && !o.img) return false;
    if (f.biz !== '' && f.biz != null && String(o.biz || 0) !== f.biz) return false;
    if (f.subs?.length && !f.subs.includes(String(o.lf))) return false;
    if (f.params) {
      for (const [k, want] of Object.entries(f.params)) {
        const v = o.pr?.[k];
        if (Array.isArray(want)) {
          if (!want.length) continue;
          if (v == null || ![].concat(v).some((x) => want.includes(String(x)))) return false;
        } else {
          if (v == null || typeof v !== 'number') return false;
          if (want.min != null && v < want.min) return false;
          if (want.max != null && v > want.max) return false;
        }
      }
    }
    if (!ignoreZone && f.zone !== false && !inZones(o)) return false;
    return true;
  }

  const dropPct = (o) => {
    if (!o.ph || o.ph.length < 2) return 0;
    const first = Math.max(...o.ph.map((x) => x[1])), last = o.ph[o.ph.length - 1][1];
    return first ? (last - first) / first : 0;
  };

  function apply() {
    readParamFiltersSafe();
    LS.set('f:' + catKey, filters);
    filtered = cat.offers.filter((o) => matches(o));
    const s = filters.sort;
    const key = { new: (o) => -(o.cr || o.fs), cheap: (o) => o._pu ?? Infinity, exp: (o) => -(o._pu ?? -1), drop: (o) => dropPct(o) }[s] || ((o) => -(o.cr || o.fs));
    filtered.sort((a, b) => key(a) - key(b));
    const nNew = filtered.filter((o) => o.fs > prevSeen && prevSeen).length;
    $('#count').textContent = `Знайдено: ${fmt(filtered.length)}` + (nNew ? ` · нових з останнього візиту: ${nNew}` : '');
    $('#zoneInfo').textContent = zoneText();
    shown = 0; $('#list').innerHTML = '';
    renderMore();
    if (view === 'map') renderMap();
    if (view === 'dyn') renderDyn();
  }
  let paramsBuilt = true;
  function readParamFiltersSafe() { if (paramsBuilt) readParamFilters(); }

  // ------------------------------------------------------------------ список
  function cardHtml(o) {
    const ph = o.ph || [];
    const last = ph.length ? ph[ph.length - 1][1] : o.p;
    const prev = ph.length > 1 ? ph[ph.length - 2][1] : null;
    const chg = prev ? (last - prev) / prev : 0;
    const tags = [];
    if (prevSeen && o.fs > prevSeen) tags.push('<span class="tag new">НОВЕ</span>');
    if (chg < 0) tags.push(`<span class="tag down">↓ ${Math.round(-chg * 100)}%</span>`);
    if (chg > 0) tags.push(`<span class="tag up">↑ ${Math.round(chg * 100)}%</span>`);
    if (o.a !== 1) tags.push('<span class="tag off">знято</span>');
    return `<article class="card ${o.a !== 1 ? 'inactive' : ''}" data-id="${o.id}">
      <div class="img${o.img ? '' : ' noimg'}" style="${o.img ? `background-image:url('${esc(o.img)}')` : ''}"><div class="tags">${tags.join('')}</div></div>
      <div class="body">
        <div class="price">${money(o.p, o.c)}${prev && prev !== last ? `<s>${fmt(prev)}</s>` : ''}${o.c && o.c !== 'UAH' && o._pu ? ` <span class="muted">≈ ${fmt(o._pu)} грн</span>` : ''}</div>
        <div class="title">${esc(o.t)}</div>
        <div class="meta"><span>${esc(o.city || '')}</span><span>${ago(o.cr || o.fs)}</span></div>
      </div></article>`;
  }

  function renderMore() {
    if (!filtered.length) { $('#list').innerHTML = '<div class="empty">Нічого не знайдено. Спробуйте послабити фільтри або збільшити зону пошуку.</div>'; $('#btnMore').hidden = true; return; }
    const part = filtered.slice(shown, shown + PAGE);
    $('#list').insertAdjacentHTML('beforeend', part.map(cardHtml).join(''));
    shown += part.length;
    $('#btnMore').hidden = shown >= filtered.length;
    $('#btnMore').textContent = `Показати ще (${fmt(filtered.length - shown)})`;
  }

  // ------------------------------------------------------------------ картка оголошення
  let chOffer = null;
  function openOffer(id) {
    const o = cat.offers.find((x) => String(x.id) === String(id));
    if (!o) return;
    $('#dlgTitle').textContent = o.t;
    const params = Object.entries(o.pr || {}).map(([k, v]) => {
      const d = cat.dict[k] || { n: k };
      const val = [].concat(v).map((x) => d.o?.[x] || x).join(', ');
      return `<dt>${esc(d.n)}</dt><dd>${esc(val)}</dd>`;
    }).join('');
    const ph = o.ph || [];
    $('#dlgBody').innerHTML = `
      ${o.img ? `<img class="photo" src="${esc(o.img.replace('400x300', '1000x750'))}" alt="">` : ''}
      <p class="price">${money(o.p, o.c)} ${o.neg ? '<span class="muted">(торг)</span>' : ''} ${o.c !== 'UAH' && o._pu ? `<span class="muted">≈ ${fmt(o._pu)} грн</span>` : ''}</p>
      <p><a class="btn" href="${esc(o.u)}" target="_blank" rel="noopener">Відкрити на OLX ↗</a></p>
      <dl class="kv">
        <dt>Місто</dt><dd>${esc(o.city || '—')}</dd>
        <dt>Опубліковано</dt><dd>${o.cr ? dateStr(o.cr) : '—'}</dd>
        <dt>Знайдено нами</dt><dd>${dateStr(o.fs)}</dd>
        <dt>Статус</dt><dd>${o.a === 1 ? 'активне (перевірено ' + ago(o.lc) + ')' : 'знято з продажу ' + (o.rm ? dateStr(o.rm) : '')}</dd>
        <dt>Продавець</dt><dd>${o.biz ? 'бізнес' : 'приватна особа'}</dd>
        ${params}
      </dl>
      ${o.d ? `<p class="muted">${esc(o.d)}…</p>` : ''}
      <h3>Динаміка ціни</h3>
      ${ph.length > 1 ? '<canvas id="chOffer" height="160"></canvas>' : '<p class="muted">Ціна не змінювалась з моменту, як ми знайшли оголошення.</p>'}
      <table class="hist-table">${ph.slice().reverse().map(([t, p], i, arr) => {
        const before = arr[i + 1]?.[1];
        const d = before ? (p - before) / before : 0;
        return `<tr><td>${dateStr(t)}</td><td><b>${money(p, o.c)}</b></td><td class="chg ${d < 0 ? 'down' : d > 0 ? 'up' : ''}">${d ? (d > 0 ? '+' : '') + Math.round(d * 100) + '%' : ''}</td></tr>`;
      }).join('')}</table>`;
    $('#dlg').showModal();
    if (ph.length > 1 && window.Chart) {
      chOffer?.destroy();
      const pts = ph.map(([t, p]) => ({ x: t * 1000, y: p }));
      pts.push({ x: (o.a === 1 ? Date.now() : (o.rm || o.lc) * 1000), y: ph[ph.length - 1][1] });
      chOffer = new Chart($('#chOffer'), {
        type: 'line',
        data: { datasets: [{ data: pts, stepped: 'before', borderColor: cssVar('--accent'), backgroundColor: 'transparent', pointRadius: 3 }] },
        options: { plugins: { legend: { display: false } }, scales: { x: timeAxis(), y: { ticks: { callback: (v) => fmt(v) } } } },
      });
    }
  }

  // ------------------------------------------------------------------ карта
  let map, cluster, drawn, areaLayer;
  function initMap() {
    if (map || !window.L) return;
    const a = meta?.area || {};
    map = L.map('map').setView([a.lat || 49.0, a.lon || 31.3], a.type === 'circle' ? 10 : 6);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
    if (a.type === 'circle') areaLayer = L.circle([a.lat, a.lon], { radius: a.radius_km * 1000, color: '#888', dashArray: '6 6', fill: false, interactive: false }).addTo(map);
    if (a.type === 'bbox') areaLayer = L.rectangle([[a.south, a.west], [a.north, a.east]], { color: '#888', dashArray: '6 6', fill: false, interactive: false }).addTo(map);
    if (a.type === 'polygon') areaLayer = L.polygon(a.points, { color: '#888', dashArray: '6 6', fill: false, interactive: false }).addTo(map);
    if (areaLayer) map.fitBounds(areaLayer.getBounds());
    cluster = L.markerClusterGroup({ chunkedLoading: true, maxClusterRadius: 50 });
    map.addLayer(cluster);
    drawn = new L.FeatureGroup().addTo(map);
    zones.forEach((z) => drawn.addLayer(zoneToLayer(z)));
    if (L.Control.Draw) {
      L.drawLocal.draw.toolbar.buttons = { polygon: 'Намалювати багатокутник', rectangle: 'Намалювати прямокутник', circle: 'Намалювати коло', polyline: '', marker: '', circlemarker: '' };
      L.drawLocal.draw.toolbar.actions = { title: 'Скасувати', text: 'Скасувати' };
      L.drawLocal.draw.toolbar.finish = { title: 'Завершити', text: 'Завершити' };
      L.drawLocal.draw.toolbar.undo = { title: 'Видалити останню точку', text: 'Видалити останню точку' };
      L.drawLocal.draw.handlers.polygon.tooltip = { start: 'Клацніть, щоб почати', cont: 'Клацніть, щоб продовжити', end: 'Клацніть першу точку, щоб замкнути' };
      L.drawLocal.draw.handlers.rectangle.tooltip = { start: 'Затисніть і тягніть' };
      L.drawLocal.draw.handlers.circle.tooltip = { start: 'Затисніть і тягніть' };
      L.drawLocal.draw.handlers.circle.radius = 'Радіус';
      L.drawLocal.draw.handlers.simpleshape.tooltip = { end: 'Відпустіть кнопку миші' };
      L.drawLocal.edit.toolbar.buttons = { edit: 'Змінити зони', editDisabled: 'Немає зон', remove: 'Видалити зони', removeDisabled: 'Немає зон' };
      L.drawLocal.edit.toolbar.actions = { save: { title: 'Зберегти', text: 'Зберегти' }, cancel: { title: 'Скасувати', text: 'Скасувати' }, clearAll: { title: 'Видалити всі', text: 'Видалити всі' } };
      map.addControl(new L.Control.Draw({
        position: 'topleft',
        draw: { polyline: false, marker: false, circlemarker: false,
          polygon: { allowIntersection: false, shapeOptions: { color: '#0b7a75' } },
          rectangle: { shapeOptions: { color: '#0b7a75' } }, circle: { shapeOptions: { color: '#0b7a75' } } },
        edit: { featureGroup: drawn },
      }));
      map.on(L.Draw.Event.CREATED, (e) => { drawn.addLayer(e.layer); saveZones(); });
      map.on(L.Draw.Event.EDITED, saveZones);
      map.on(L.Draw.Event.DELETED, saveZones);
    }
  }
  function zoneToLayer(z) {
    const st = { color: '#0b7a75' };
    if (z.type === 'rect') return L.rectangle(z.b, st);
    if (z.type === 'circle') return L.circle(z.c, { ...st, radius: z.r });
    return L.polygon(z.p, st);
  }
  function saveZones() {
    zones = [];
    drawn.eachLayer((l) => {
      if (l instanceof L.Circle) zones.push({ type: 'circle', c: [l.getLatLng().lat, l.getLatLng().lng], r: l.getRadius() });
      else if (l instanceof L.Rectangle) { const b = l.getBounds(); zones.push({ type: 'rect', b: [[b.getSouth(), b.getWest()], [b.getNorth(), b.getEast()]] }); }
      else if (l instanceof L.Polygon) zones.push({ type: 'poly', p: l.getLatLngs()[0].map((p) => [p.lat, p.lng]) });
    });
    LS.set('zones', zones);
    apply();
  }
  function renderMap() {
    initMap();
    if (!map) return;
    setTimeout(() => map.invalidateSize(), 50);
    cluster.clearLayers();
    // На карті — всі оголошення за фільтрами; поза зоною — сірі.
    const all = cat.offers.filter((o) => o.la != null && matches(o, { ignoreZone: true }));
    const markers = all.map((o) => {
      const inZ = !zones.length || inZones(o);
      const icon = L.divIcon({ className: '', html: `<div style="background:${inZ ? '#0b7a75' : '#9ca3af'};color:#fff;border-radius:10px;padding:1px 6px;font:600 11px system-ui;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.4)">${o.p != null ? fmt(o.p) + (o.c && o.c !== 'UAH' ? (CUR[o.c] || '') : '') : '?'}</div>`, iconSize: null });
      const m = L.marker([o.la, o.lo], { icon });
      m.bindPopup(() => `<div class="popup">${o.img ? `<img src="${esc(o.img)}" alt="">` : ''}<b>${esc(o.t)}</b>${money(o.p, o.c)}<br><a href="#" data-open="${o.id}">Детальніше</a> · <a href="${esc(o.u)}" target="_blank" rel="noopener">OLX ↗</a></div>`);
      return m;
    });
    cluster.addLayers(markers);
  }

  // ------------------------------------------------------------------ динаміка
  let charts = [];
  function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim() || '#0b7a75'; }
  function timeAxis() {
    return { type: 'linear', ticks: { callback: (v) => new Date(v).toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' }), maxTicksLimit: 8 } };
  }
  function renderDyn() {
    if (!window.Chart) return;
    charts.forEach((c) => c.destroy()); charts = [];
    const set = cat.offers.filter((o) => matches(o, { includeInactive: true }));
    const now = Date.now() / 1000;
    const days = [];
    for (let i = 29; i >= 0; i--) {
      const end = new Date(); end.setHours(23, 59, 59, 0); end.setDate(end.getDate() - i);
      days.push(end.getTime() / 1000);
    }
    const labels = days.map((d) => dayKey(d).slice(5).split('-').reverse().join('.'));
    const med = [], q1 = [], q3 = [], nNew = [], nRm = [];
    for (const end of days) {
      const start = end - 86400;
      const prices = [];
      let n = 0, r = 0;
      for (const o of set) {
        if (o.fs > start && o.fs <= end) n++;
        if (o.rm && o.rm > start && o.rm <= end) r++;
        if (o.fs > end || (o.a !== 1 && o.rm && o.rm < start)) continue;
        let p = null;
        for (const [t, v] of o.ph || []) { if (t <= end) p = v; else break; }
        if (p == null && o.ph?.length) p = o.ph[0][1];
        if (p != null) prices.push(toUah(p, o.c));
      }
      prices.sort((a, b) => a - b);
      const q = (x) => prices.length ? prices[Math.min(prices.length - 1, Math.floor(x * prices.length))] : null;
      med.push(q(0.5)); q1.push(q(0.25)); q3.push(q(0.75)); nNew.push(n); nRm.push(r);
    }
    // прибираємо порожні дні на початку (коли даних ще не було)
    let first = med.findIndex((v, i) => v != null || nNew[i] || nRm[i]);
    if (first < 0) first = days.length - 1;
    first = Math.min(first, days.length - 2);
    [labels, med, q1, q3, nNew, nRm].forEach((a) => a.splice(0, first));
    const acc = cssVar('--accent');
    charts.push(new Chart($('#chMedian'), {
      type: 'line',
      data: { labels, datasets: [
        { label: 'Медіана', data: med, borderColor: acc, backgroundColor: acc, spanGaps: true, tension: .25 },
        { label: '25% дешевших', data: q1, borderColor: '#9ca3af', borderDash: [4, 4], pointRadius: 0, spanGaps: true },
        { label: '25% дорожчих', data: q3, borderColor: '#9ca3af', borderDash: [4, 4], pointRadius: 0, spanGaps: true }] },
      options: { interaction: { mode: 'index', intersect: false }, scales: { y: { ticks: { callback: (v) => fmt(v) } } },
        plugins: { tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmt(c.raw)} грн` } } } },
    }));
    charts.push(new Chart($('#chFlow'), {
      type: 'bar',
      data: { labels, datasets: [{ label: 'Нові', data: nNew, backgroundColor: acc }, { label: 'Зняті', data: nRm, backgroundColor: '#e07a5f' }] },
      options: { interaction: { mode: 'index', intersect: false } },
    }));
    const cur = set.filter((o) => o.a === 1 && o._pu).map((o) => o._pu).sort((a, b) => a - b);
    if (cur.length) {
      const lo = cur[Math.floor(cur.length * 0.02)], hi = cur[Math.floor(cur.length * 0.98)] || cur[cur.length - 1];
      const bins = 20, w = Math.max(1, (hi - lo) / bins), counts = new Array(bins).fill(0);
      cur.forEach((p) => { if (p >= lo && p <= hi) counts[Math.min(bins - 1, Math.floor((p - lo) / w))]++; });
      charts.push(new Chart($('#chHist'), {
        type: 'bar',
        data: { labels: counts.map((_, i) => `${fmt(lo + i * w)}–${fmt(lo + (i + 1) * w)}`), datasets: [{ label: 'Оголошень', data: counts, backgroundColor: acc }] },
        options: { plugins: { legend: { display: false } } },
      }));
    }
  }

  // ------------------------------------------------------------------ інтерфейс
  function setView(v) {
    view = v; LS.set('view', v);
    document.querySelectorAll('.view-switch button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
    $('#viewList').hidden = v !== 'list'; $('#viewMap').hidden = v !== 'map'; $('#viewDyn').hidden = v !== 'dyn';
    if (!cat) return;
    if (v === 'map') renderMap();
    if (v === 'dyn') renderDyn();
  }

  let tmr;
  const debounced = () => { clearTimeout(tmr); tmr = setTimeout(() => { readBaseFilters(); apply(); }, 250); };

  function bindUI() {
    $('#cats').addEventListener('click', (e) => { const b = e.target.closest('button[data-cat]'); if (b) selectCat(b.dataset.cat); });
    document.querySelectorAll('.view-switch button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
    $('#sidebar').addEventListener('input', debounced);
    $('#sidebar').addEventListener('change', debounced);
    $('#fSort').addEventListener('change', debounced);
    $('#btnMore').addEventListener('click', renderMore);
    $('#list').addEventListener('click', (e) => { const c = e.target.closest('.card'); if (c) openOffer(c.dataset.id); });
    document.addEventListener('click', (e) => {
      const a = e.target.closest('[data-open]');
      if (a) { e.preventDefault(); openOffer(a.dataset.open); }
      if (e.target.closest('[data-goto-map]')) setView('map');
    });
    $('#dlgClose').addEventListener('click', () => $('#dlg').close());
    $('#dlg').addEventListener('click', (e) => { if (e.target.id === 'dlg') $('#dlg').close(); });
    $('#btnReset').addEventListener('click', () => { filters = { sort: filters.sort }; writeBaseFilters(); buildParamFilters(); apply(); });
    $('#btnClearZones').addEventListener('click', () => { drawn?.clearLayers(); zones = []; LS.set('zones', zones); apply(); });
    $('#btnFilters').addEventListener('click', () => $('#sidebar').classList.add('open'));
    $('#btnCloseFilters').addEventListener('click', () => $('#sidebar').classList.remove('open'));
  }

  init();
})();
