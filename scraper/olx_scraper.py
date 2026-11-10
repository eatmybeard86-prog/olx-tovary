#!/usr/bin/env python3
"""Збирач оголошень OLX.ua для сайту «Пошук товарів OLX».

Запускається щогодини (GitHub Actions) або вручну:
    python scraper/olx_scraper.py --config config.json --data data

Що робить за один запуск:
  1. Визначає номери категорій OLX за шляхами з config.json (один раз, далі кеш).
  2. Забирає найновіші оголошення кожної категорії (по областях, якщо відомі),
     залишає лише ті, що в зоні збору, додає нові та оновлює ціни.
  3. Перевіряє частину вже відомих оголошень: якщо оголошення зняте/неактивне,
     воно зникає з сайту; якщо змінилась ціна — записується в історію цін.
  4. Рахує щоденну статистику (кількість, медіанна ціна) для графіків динаміки.
  5. Записує JSON-файли, які читає сайт.

Лише стандартна бібліотека Python 3.9+.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import random
import statistics
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta

API = "https://www.olx.ua/api/v1"
PAGE_LIMIT = 50
MAX_OFFSET = 1000  # OLX віддає не більше 1000 оголошень на один запит-пошук
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130.0 Safari/537.36")
# Відомі номери категорій (перевірено через API OLX 09.11.2026); інші шукаються автоматично
KNOWN_PATHS = {
    "elektronika": 37, "transport": 1532, "zapchasti-dlya-transporta": 3, "dom-i-sad": 899,
    "elektronika/kompyutery-i-komplektuyuschie": 38, "elektronika/noutbuki-i-aksesuary": 1502,
    "elektronika/tv-videotehnika": 420, "elektronika/tehnika-dlya-doma": 383,
    "elektronika/tehnika-dlya-kuhni": 369, "elektronika/klimaticheskoe-oborudovanie": 395,
    "zapchasti-dlya-transporta/shiny-diski-i-kolesa": 270, "dom-i-sad/mebel": 57,
}
KYIV_TZ = timezone(timedelta(hours=2))


def log(*a):
    print(*a, file=sys.stderr, flush=True)


# --------------------------------------------------------------------------- HTTP
class Http:
    """Простий HTTP-клієнт з повторами. Можна підмінити в тестах."""

    def __init__(self, delay=0.35):
        self.delay = delay
        self.requests = 0
        self.errors = 0

    def get_json(self, url, params=None, retries=4):
        """Повертає (status, json|None). 404/410 повертає без повторів."""
        if params:
            url = url + ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
        last = None
        for attempt in range(retries):
            if self.delay:
                time.sleep(self.delay * (0.7 + random.random() * 0.6))
            self.requests += 1
            req = urllib.request.Request(url, headers={
                "User-Agent": UA, "Accept": "application/json",
                "Accept-Language": "uk-UA,uk;q=0.9"})
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    return r.status, json.loads(r.read().decode("utf-8"))
            except urllib.error.HTTPError as e:
                last = e.code
                if e.code in (400, 404, 410):
                    return e.code, None
                if e.code == 403 and attempt >= 1:
                    return e.code, None
                if e.code in (403, 429, 500, 502, 503, 504):
                    time.sleep(2 ** attempt * 2)
                    continue
                return e.code, None
            except Exception as e:  # мережа
                last = str(e)
                time.sleep(2 ** attempt)
        self.errors += 1
        return (last if isinstance(last, int) else 0), None


# --------------------------------------------------------------------------- гео
def haversine_km(lat1, lon1, lat2, lon2):
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def point_in_polygon(lat, lon, poly):
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        yi, xi = poly[i]
        yj, xj = poly[j]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi + 1e-12) + xi:
            inside = not inside
        j = i
    return inside


def in_area(area, lat, lon):
    t = (area or {}).get("type", "all")
    if t == "all":
        return True
    if lat is None or lon is None:
        return False
    if t == "circle":
        return haversine_km(area["lat"], area["lon"], lat, lon) <= float(area["radius_km"])
    if t == "bbox":
        return area["south"] <= lat <= area["north"] and area["west"] <= lon <= area["east"]
    if t == "polygon":
        return point_in_polygon(lat, lon, area["points"])
    return True


# --------------------------------------------------------------------------- розбір
def _num(s):
    if isinstance(s, (int, float)):
        return s
    if not isinstance(s, str):
        return None
    t = s.replace(" ", "").replace(" ", "").replace(",", ".")
    try:
        v = float(t)
        return int(v) if v.is_integer() else v
    except ValueError:
        return None


def parse_time(s):
    if not s:
        return None
    try:
        return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp())
    except ValueError:
        return None


def parse_offer(o):
    """Перетворює оголошення OLX на компактний запис + словник параметрів."""
    rec = {
        "id": o["id"],
        "t": (o.get("title") or "").strip(),
        "u": o.get("url"),
        "cr": parse_time(o.get("created_time")),
        "rf": parse_time(o.get("last_refresh_time")),
        "vt": parse_time(o.get("valid_to_time")),
        "lf": (o.get("category") or {}).get("id"),
        "biz": 1 if o.get("business") else 0,
        "pr": {},
    }
    m = o.get("map") or {}
    if m.get("lat") is not None:
        rec["la"], rec["lo"] = round(m["lat"], 4), round(m["lon"], 4)
        if m.get("radius"):
            rec["rad"] = m["radius"]
    loc = o.get("location") or {}
    city = (loc.get("city") or {}).get("name")
    dist = (loc.get("district") or {}).get("name")
    rec["city"] = city + (", " + dist if dist else "") if city else ""
    rec["reg"] = (loc.get("region") or {}).get("id")
    photos = o.get("photos") or []
    if photos and photos[0].get("link"):
        rec["img"] = photos[0]["link"].replace("{width}", "400").replace("{height}", "300")
    rec["np"] = len(photos)
    desc = (o.get("description") or "").replace("<br />", " ").replace("\n", " ")
    rec["d"] = " ".join(desc.split())[:160]

    pdict = {}
    for p in o.get("params") or []:
        key, val = p.get("key"), p.get("value")
        if not key or val is None:
            continue
        if key == "price" or p.get("type") == "price":
            rec["p"] = _num(val.get("value"))
            rec["c"] = val.get("currency") or "UAH"
            rec["pt"] = val.get("type")  # price / arranged / exchange / free
            if val.get("negotiable") or val.get("arranged"):
                rec["neg"] = 1
            prev = _num(val.get("previous_value"))
            if prev and prev != rec.get("p"):
                rec["prev"] = prev
            continue
        name = p.get("name") or key
        if isinstance(val, list):
            keys = [str(v.get("key")) for v in val if isinstance(v, dict) and v.get("key") is not None]
            labels = {str(v.get("key")): v.get("label") for v in val if isinstance(v, dict)}
            if keys:
                rec["pr"][key] = keys
                pdict[key] = {"n": name, "t": "sel", "o": labels}
            continue
        if not isinstance(val, dict):
            continue
        vkey, label = val.get("key"), val.get("label")
        n = _num(vkey) if vkey is not None else None
        if n is not None and not (isinstance(vkey, str) and vkey.startswith("0") and len(vkey) > 1):
            rec["pr"][key] = n
            pdict[key] = {"n": name, "t": "num"}
        elif vkey is not None:
            rec["pr"][key] = str(vkey)
            pdict[key] = {"n": name, "t": "sel", "o": {str(vkey): label or str(vkey)}}
    if not rec["pr"]:
        del rec["pr"]
    return rec, pdict


def merge_dict(target, pdict):
    for k, d in pdict.items():
        cur = target.get(k)
        if cur is None:
            target[k] = {"n": d["n"], "t": d["t"], **({"o": dict(d["o"])} if "o" in d else {})}
            continue
        if d["t"] == "sel":
            if cur["t"] == "num":  # значення бувають і числові, і текстові → вибір
                cur["t"], cur["o"] = "sel", {}
            cur.setdefault("o", {}).update(d.get("o", {}))


def to_uah(price, cur, rates):
    if price is None:
        return None
    r = rates.get(cur or "UAH")
    return round(price * r) if r else None


# --------------------------------------------------------------------------- сховище
def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


class Scraper:
    def __init__(self, cfg, data_dir, http=None, now=None):
        self.cfg = cfg
        self.dir = data_dir
        self.http = http or Http()
        self.now = int(now or time.time())
        os.makedirs(data_dir, exist_ok=True)
        self.state = load_json(os.path.join(data_dir, "state.json"), {})
        self.state.setdefault("leaves", {})       # id листової категорії → ланцюг, назва
        self.state.setdefault("paths", {})        # шлях → номер категорії
        self.state.setdefault("region_counts", {})
        # Збираються лише увімкнені категорії ("enabled": true у config.json)
        self.groups = [g for g in cfg["categories"] if g.get("enabled", True)]
        self.cats = {}
        for g in self.groups:
            d = load_json(os.path.join(data_dir, f"cat-{g['key']}.json"), {})
            self.cats[g["key"]] = {
                "offers": {str(o["id"]): o for o in d.get("offers", [])},
                "dict": d.get("dict", {}),
                "subs": d.get("subs", {}),
            }
        self.stats = load_json(os.path.join(data_dir, "stats.json"), {})
        self.rates = dict(cfg.get("fallback_rates") or {"UAH": 1})
        self.warnings = []
        self.blocked = False  # OLX відповідає 403 — далі не стукаємо
        self.counters = {"new": 0, "updated": 0, "price_changes": 0, "removed": 0,
                         "checked": 0, "listing_requests": 0}

    # ---------------------------------------------------------------- курси
    def load_rates(self):
        st, js = self.http.get_json(
            "https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?json", retries=2)
        if js:
            for row in js:
                if row.get("cc") in ("USD", "EUR"):
                    self.rates[row["cc"]] = row["rate"]
        self.rates["UAH"] = 1

    # ---------------------------------------------------------------- категорії
    def leaf_info(self, leaf_id):
        """Ланцюг категорій для листової категорії (через метадані пошуку OLX)."""
        key = str(leaf_id)
        if key in self.state["leaves"]:
            return self.state["leaves"][key]
        st, js = self.http.get_json(f"{API}/offers/", {"category_id": leaf_id, "limit": 1, "offset": 0})
        if not js:
            return None
        tg = (((js.get("metadata") or {}).get("adverts") or {}).get("config") or {}).get("targeting") or {}
        chain = [int(x) for x in str(tg.get("cat_id", "")).split("|") if x.isdigit()]
        if not chain:
            return None
        slugs = [tg.get(f"cat_l{i}") or "" for i in range(len(chain))]
        depth = len(chain)
        # У метаданих OLX назви рівнів 0 і 1 переставлені місцями.
        name = tg.get("cat_l2_name") if depth >= 3 else tg.get("cat_l0_name") if depth == 2 else tg.get("cat_l1_name") or tg.get("cat_l0_name")
        info = {"chain": chain, "slugs": slugs, "name": name or slugs[-1]}
        self.state["leaves"][key] = info
        return info

    def resolve_path(self, path):
        path = path.strip("/")
        if path in self.state["paths"]:
            return self.state["paths"][path]
        failed = self.state.setdefault("failed_paths", {})
        if failed.get(path, 0) > self.now - 86400:
            return None  # не повторюємо невдалий пошук частіше ніж раз на добу
        segs = path.split("/")
        cid = KNOWN_PATHS.get(path)
        if cid is None:
            if self.blocked:
                return None
            st, js = self.http.get_json(f"{API}/friendly-links/query-params/{path}/")
            if st == 403:
                self.blocked = True
                self.warnings.append("OLX відхилив запити збирача (403 Forbidden), оголошення не оновлено.")
                return None
            cid = ((js or {}).get("data") or {}).get("category_id")
        if cid is None and len(segs) >= 2:
            parent = self.resolve_path("/".join(segs[:-1]))
            if parent:
                cid = self._find_child(parent, len(segs) - 1, segs[-1])
        if cid:
            self.state["paths"][path] = int(cid)
            failed.pop(path, None)
            log(f"  категорія {path} → {cid}")
        elif not self.blocked:
            failed[path] = self.now
        return int(cid) if cid else None

    def _find_child(self, parent_id, level, slug):
        seen = set()
        for page in range(10):
            st, js = self.http.get_json(f"{API}/offers/", {
                "category_id": parent_id, "limit": PAGE_LIMIT, "offset": page * PAGE_LIMIT,
                "sort_by": "created_at:desc"})
            if st == 403:
                self.blocked = True
            if not js or not js.get("data"):
                break
            for o in js["data"]:
                lf = (o.get("category") or {}).get("id")
                if not lf or lf in seen:
                    continue
                seen.add(lf)
                info = self.leaf_info(lf)
                if info and len(info["chain"]) > level and info["slugs"][level] == slug:
                    return info["chain"][level]
        return None

    def resolve_groups(self):
        for g in self.groups:
            ids = list(g.get("ids") or [])
            for p in g.get("paths", []):
                cid = self.resolve_path(p)
                if cid:
                    ids.append(cid)
                elif not self.blocked:
                    self.warnings.append(f"Не вдалося визначити категорію OLX «{p}» ({g['name']}). "
                                         f"Вкажіть її номер у config.json (\"ids\").")
            g["_ids"] = list(dict.fromkeys(ids))

    def group_for(self, leaf_id, fallback_key):
        info = self.leaf_info(leaf_id) if leaf_id else None
        if not info:
            return fallback_key
        chain = set(info["chain"])
        for g in self.groups:
            if chain & set(g["_ids"]):
                return g["key"]
        return fallback_key

    # ---------------------------------------------------------------- оголошення
    def owner_of(self, oid):
        for k, c in self.cats.items():
            if oid in c["offers"]:
                return k
        return None

    def upsert(self, gkey, raw, seen_in_listing=True):
        rec, pdict = parse_offer(raw)
        oid = str(rec["id"])
        owner = self.owner_of(oid)
        if owner and owner != gkey:
            gkey = owner  # оголошення вже належить іншій категорії
        cat = self.cats[gkey]
        merge_dict(cat["dict"], pdict)
        lf = rec.get("lf")
        if lf:
            info = self.state["leaves"].get(str(lf))
            if info:
                cat["subs"][str(lf)] = info["name"]
        rec["pu"] = to_uah(rec.get("p"), rec.get("c"), self.rates)
        old = cat["offers"].get(oid)
        if old is None:
            hist = []
            if rec.get("prev") and rec.get("p") is not None:
                hist.append([rec.get("cr") or self.now, rec["prev"]])
            if rec.get("p") is not None:
                hist.append([self.now, rec["p"]])
            rec.update({"ph": hist, "fs": self.now, "ls": self.now, "lc": self.now, "a": 1})
            rec.pop("prev", None)
            cat["offers"][oid] = rec
            self.counters["new"] += 1
            return "new"
        hist = old.get("ph") or []
        if rec.get("p") is not None and (not hist or hist[-1][1] != rec["p"]):
            if hist and hist[-1][1] != rec["p"]:
                self.counters["price_changes"] += 1
            hist.append([self.now, rec["p"]])
        rec.pop("prev", None)
        rec.update({"ph": hist, "fs": old.get("fs", self.now), "ls": self.now,
                    "lc": self.now, "a": 1})
        if old.get("a") == 0:
            rec["fs"] = old.get("fs", self.now)
        cat["offers"][oid] = rec
        self.counters["updated"] += 1
        return "updated"

    def region_ids(self):
        if self.cfg.get("region_ids"):
            return [int(x) for x in self.cfg["region_ids"]]
        if (self.cfg.get("area") or {}).get("type", "all") == "all":
            return [None]
        rc = self.state["region_counts"]
        total = sum(rc.values())
        if total < 20:
            return [None]  # ще не знаємо областей — шукаємо по всій Україні
        regs = [int(r) for r, n in sorted(rc.items(), key=lambda x: -x[1]) if n / total >= 0.02]
        return regs or [None]

    def collect(self):
        area = self.cfg.get("area") or {"type": "all"}
        last_run = self.state.get("last_run") or 0
        cutoff = last_run - 3 * 3600 if last_run else 0
        max_pages = min(int(self.cfg.get("max_pages_per_query", 20)), MAX_OFFSET // PAGE_LIMIT)
        regions = self.region_ids()
        log(f"Області для пошуку: {regions}")
        done_queries = set()
        for g in self.groups:
            for cid in g["_ids"]:
                for reg in regions:
                    if (cid, reg) in done_queries:
                        continue
                    done_queries.add((cid, reg))
                    self._collect_query(g["key"], cid, reg, area, cutoff, max_pages)

    def _collect_query(self, gkey, cid, reg, area, cutoff, max_pages):
        kept = 0
        for page in range(max_pages):
            params = {"category_id": cid, "limit": PAGE_LIMIT, "offset": page * PAGE_LIMIT,
                      "sort_by": "created_at:desc"}
            if reg:
                params["region_id"] = reg
            if self.blocked:
                return
            st, js = self.http.get_json(f"{API}/offers/", params)
            self.counters["listing_requests"] += 1
            if st == 403:
                self.blocked = True
                self.warnings.append("OLX відхилив запити збирача (403 Forbidden), оголошення не оновлено.")
                return
            if not js or not js.get("data"):
                if st and st not in (200, 400, 404):
                    self.warnings.append(f"OLX відповів {st} на пошук у категорії {cid}")
                break
            promoted = set((js.get("metadata") or {}).get("promoted") or [])
            oldest = None
            for i, o in enumerate(js["data"]):
                m = o.get("map") or {}
                lat, lon = m.get("lat"), m.get("lon")
                if not in_area(area, lat, lon):
                    continue
                r = (o.get("location") or {}).get("region", {}).get("id")
                if r:
                    rc = self.state["region_counts"]
                    rc[str(r)] = rc.get(str(r), 0) + 1
                if (o.get("status") or "active") != "active":
                    continue
                target = self.group_for((o.get("category") or {}).get("id"), gkey)
                self.upsert(target, o)
                kept += 1
            for i, o in enumerate(js["data"]):
                if i in promoted:
                    continue
                t = parse_time(o.get("created_time"))
                if t and (oldest is None or t < oldest):
                    oldest = t
            if oldest is not None and oldest < cutoff:
                break
            if not (js.get("links") or {}).get("next"):
                break
        log(f"  {gkey}: категорія {cid}, область {reg or 'вся Україна'} → {kept} у зоні")

    # ---------------------------------------------------------------- перевірка
    def check_existing(self):
        if self.blocked:
            return
        budget = int(self.cfg.get("check_budget_per_run", 1500))
        workers = int(self.cfg.get("check_workers", 4))
        cands = []
        for k, c in self.cats.items():
            for oid, o in c["offers"].items():
                if o.get("a") == 1 and o.get("lc", 0) < self.now - 1800:
                    expired = 1 if (o.get("vt") and o["vt"] < self.now) else 0
                    cands.append((-expired, o.get("lc", 0), k, oid))
        cands.sort()
        cands = cands[:budget]
        if not cands:
            return
        log(f"Перевіряю {len(cands)} оголошень…")
        blocked = {"n": 0}

        def one(item):
            _, _, k, oid = item
            if blocked["n"] >= 25:
                return item, "skip", None
            st, js = self.http.get_json(f"{API}/offers/{oid}/", retries=2)
            if st in (404, 410):
                return item, "gone", None
            if js and js.get("data"):
                blocked["n"] = 0
                return item, "ok", js["data"]
            blocked["n"] += 1
            return item, "err", None

        with ThreadPoolExecutor(max_workers=workers) as ex:
            results = list(ex.map(one, cands))
        for (_, _, k, oid), res, data in results:
            o = self.cats[k]["offers"].get(oid)
            if o is None:
                continue
            if res == "gone" or (res == "ok" and (data.get("status") or "active") != "active"):
                self.deactivate(o)
            elif res == "ok":
                self.upsert(k, data, seen_in_listing=False)
                self.counters["updated"] -= 1
            if res in ("ok", "gone"):
                self.counters["checked"] += 1
        if blocked["n"] >= 25:
            self.warnings.append("OLX тимчасово блокує перевірку оголошень — частину перевірено, решта наступного разу.")

    def deactivate(self, o):
        if o.get("a") == 1:
            o["a"] = 0
            o["rm"] = self.now
            self.counters["removed"] += 1

    def prune(self):
        keep = int(self.cfg.get("keep_inactive_days", 21)) * 86400
        area = self.cfg.get("area") or {"type": "all"}
        for c in self.cats.values():
            for oid in list(c["offers"]):
                o = c["offers"][oid]
                if o.get("a") == 0 and o.get("rm", 0) < self.now - keep:
                    del c["offers"][oid]
                elif o.get("la") is not None and not in_area(area, o["la"], o["lo"]):
                    del c["offers"][oid]  # зону збору змінили

    # ---------------------------------------------------------------- статистика
    def compute_stats(self):
        day = datetime.fromtimestamp(self.now, KYIV_TZ).strftime("%Y-%m-%d")
        start = int(datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=KYIV_TZ).timestamp())
        for k, c in self.cats.items():
            offers = c["offers"].values()
            active = [o for o in offers if o.get("a") == 1]
            prices = [o["pu"] for o in active if o.get("pu")]
            s = self.stats.setdefault(k, {})
            s[day] = {
                "act": len(active),
                "new": sum(1 for o in offers if o.get("fs", 0) >= start),
                "rm": sum(1 for o in offers if o.get("rm", 0) >= start),
                "med": round(statistics.median(prices)) if prices else None,
                "drop": sum(1 for o in active if len(o.get("ph") or []) > 1 and o["ph"][-1][1] < o["ph"][-2][1]),
            }
            for d in sorted(s)[:-120]:
                del s[d]

    # ---------------------------------------------------------------- запис
    def save(self, started):
        self.state["last_run"] = self.now
        save_json(os.path.join(self.dir, "state.json"), self.state)
        save_json(os.path.join(self.dir, "stats.json"), self.stats)
        cats_meta = []
        for g in self.groups:
            c = self.cats[g["key"]]
            offers = sorted(c["offers"].values(), key=lambda o: -(o.get("cr") or o.get("fs") or 0))
            save_json(os.path.join(self.dir, f"cat-{g['key']}.json"),
                      {"dict": c["dict"], "subs": c["subs"], "offers": offers})
            cats_meta.append({"key": g["key"], "name": g["name"], "icon": g.get("icon", ""),
                              "active": sum(1 for o in offers if o.get("a") == 1),
                              "total": len(offers)})
        meta = load_json(os.path.join(self.dir, "meta.json"), {})
        runs = (meta.get("runs") or [])[-47:]
        runs.append({"at": self.now, "sec": int(time.time() - started),
                     "req": self.http.requests, **self.counters})
        save_json(os.path.join(self.dir, "meta.json"), {
            "updated": self.now, "area": self.cfg.get("area"), "rates": self.rates,
            "categories": cats_meta, "warnings": self.warnings, "runs": runs,
        })

    def run(self):
        started = time.time()
        self.load_rates()
        self.resolve_groups()
        self.collect()
        self.check_existing()
        self.prune()
        self.compute_stats()
        self.save(started)
        log(f"Готово: {self.counters}, запитів {self.http.requests}, "
            f"{int(time.time() - started)} с. Попередження: {self.warnings}")
        return self.counters


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="config.json")
    ap.add_argument("--data", default="data")
    a = ap.parse_args()
    cfg = load_json(a.config, None)
    if cfg is None:
        sys.exit(f"Не можу прочитати {a.config}")
    Scraper(cfg, a.data).run()


if __name__ == "__main__":
    main()
