"""Тести збирача на підроблених відповідях OLX (формат як у справжньому API).

    python -m unittest discover -s scraper
"""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import olx_scraper as S  # noqa: E402

NOW = 1_762_700_000  # фіксований «зараз»


def offer(oid, leaf, price, lat=50.45, lon=30.52, created=NOW - 600, cur="UAH", params=None, prev=None):
    p = [{"key": "price", "name": "Ціна", "type": "price",
          "value": {"value": price, "type": "price", "currency": cur, "negotiable": False,
                    "previous_value": prev, "label": f"{price} грн."}},
         {"key": "state", "name": "Стан", "type": "select", "value": {"key": "used", "label": "Вживане"}}]
    p += params or []
    iso = S.datetime.fromtimestamp(created, S.KYIV_TZ).isoformat()
    return {"id": oid, "url": f"https://www.olx.ua/d/uk/obyavlenie/x-{oid}.html", "title": f"Товар {oid}",
            "created_time": iso, "last_refresh_time": iso, "valid_to_time": iso, "description": "Опис",
            "params": p, "business": False, "status": "active",
            "map": {"lat": lat, "lon": lon, "radius": 1}, "category": {"id": leaf, "type": "electronics"},
            "location": {"city": {"id": 1, "name": "Київ"}, "region": {"id": 25, "name": "Київ"}},
            "photos": [{"link": "https://img/x;s={width}x{height}"}]}


class FakeHttp:
    def __init__(self, listings, details=None):
        self.listings = listings  # category_id → list of offers (newest first)
        self.details = details or {}
        self.requests = 0
        self.errors = 0
        self.calls = []

    def get_json(self, url, params=None, retries=4):
        self.requests += 1
        self.calls.append((url, params))
        if "bank.gov.ua" in url:
            return 200, [{"cc": "USD", "rate": 40.0}, {"cc": "EUR", "rate": 45.0}]
        if "/friendly-links/" in url:
            return 404, None
        if url.rstrip("/").endswith("/offers"):
            cid = params["category_id"]
            if params.get("limit") == 1:  # метадані листової категорії
                chains = {501: "37|38|501", 601: "37|39|601", 701: "37|40|701"}
                ch = chains.get(cid, f"37|{cid}")
                parts = ch.split("|")
                slugs = {"38": "kompyutery-i-komplektuyuschie", "39": "tv-videotehnika", "40": "audiotehnika"}
                tg = {"cat_id": ch, "cat_l0": "elektronika", "cat_l1": slugs.get(parts[1], "x"),
                      "cat_l2": "leaf", "cat_l2_name": f"Підкатегорія {cid}", "cat_l0_name": "Електроніка"}
                return 200, {"data": [], "metadata": {"adverts": {"config": {"targeting": tg}}}}
            items = []
            for c, lst in self.listings.items():
                ch = {501: [37, 38], 601: [37, 39], 701: [37, 40]}
                for o in lst:
                    if cid == c or cid in ch.get(o["category"]["id"], []):
                        items.append(o)
            off = params["offset"]
            page = items[off:off + params["limit"]]
            nxt = {"href": "x"} if off + params["limit"] < len(items) else None
            return 200, {"data": page, "metadata": {"promoted": []}, "links": {"next": nxt} if nxt else {}}
        if "/offers/" in url:
            oid = url.rstrip("/").split("/")[-1]
            d = self.details.get(oid)
            if d is None:
                return 404, None
            return 200, {"data": d}
        return 404, None


CFG = {
    "area": {"type": "circle", "lat": 50.45, "lon": 30.52, "radius_km": 30},
    "categories": [
        {"key": "computers", "name": "Комп'ютери", "paths": ["elektronika/kompyutery-i-komplektuyuschie"]},
        {"key": "electronics", "name": "Інша електроніка", "paths": ["elektronika"]},
    ],
    "check_budget_per_run": 100, "check_workers": 2, "max_pages_per_query": 5,
    "fallback_rates": {"UAH": 1, "USD": 41, "EUR": 48},
}


class ScraperTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def run_once(self, http, now=NOW):
        return S.Scraper(json.loads(json.dumps(CFG)), self.tmp, http=http, now=now).run()

    def load(self, key):
        with open(os.path.join(self.tmp, f"cat-{key}.json"), encoding="utf-8") as f:
            return json.load(f)

    def test_full_cycle(self):
        diag = [{"key": "diagonal", "name": "Діагональ", "type": "input", "value": {"key": "55", "label": "55\""}}]
        listings = {37: [
            offer(1, 501, 20000, params=[{"key": "ram", "name": "ОЗП", "type": "select",
                                          "value": {"key": "16gb", "label": "16 ГБ"}}]),
            offer(2, 601, 300, cur="USD", params=diag),
            offer(3, 701, 1000, lat=49.0, lon=24.0),  # Львів — поза зоною
            offer(4, 701, 5000, prev=6000),
        ]}
        http = FakeHttp(listings)
        c = self.run_once(http)
        comp = self.load("computers")
        el = self.load("electronics")
        self.assertEqual([o["id"] for o in comp["offers"]], [1])
        self.assertEqual(sorted(o["id"] for o in el["offers"]), [2, 4])  # 3 відфільтровано зоною
        self.assertEqual(comp["dict"]["ram"]["o"]["16gb"], "16 ГБ")
        self.assertEqual(el["dict"]["diagonal"]["t"], "num")
        o2 = next(o for o in el["offers"] if o["id"] == 2)
        self.assertEqual(o2["pu"], 12000)  # 300 USD × 40 (курс НБУ)
        o4 = next(o for o in el["offers"] if o["id"] == 4)
        self.assertEqual([p for _, p in o4["ph"]], [6000, 5000])  # попередня ціна з OLX
        self.assertEqual(c["new"], 3)

        # Другий запуск через 2 год: №1 подешевшав, №2 знято з продажу, №4 без змін
        d1 = offer(1, 501, 18000)
        d4 = offer(4, 701, 5000)
        http2 = FakeHttp({37: []}, details={"1": d1, "4": d4})
        c2 = self.run_once(http2, now=NOW + 7200)
        comp = self.load("computers")
        el = self.load("electronics")
        o1 = comp["offers"][0]
        self.assertEqual([p for _, p in o1["ph"]], [20000, 18000])
        o2 = next(o for o in el["offers"] if o["id"] == 2)
        self.assertEqual(o2["a"], 0)
        self.assertEqual(c2["removed"], 1)
        self.assertEqual(c2["price_changes"], 1)
        with open(os.path.join(self.tmp, "stats.json"), encoding="utf-8") as f:
            stats = json.load(f)
        day = list(stats["computers"].values())[-1]
        self.assertEqual(day["act"], 1)
        self.assertEqual(day["drop"], 1)
        with open(os.path.join(self.tmp, "meta.json"), encoding="utf-8") as f:
            meta = json.load(f)
        self.assertEqual(len(meta["runs"]), 2)
        self.assertEqual(meta["warnings"], [])

    def test_prune_old_inactive(self):
        http = FakeHttp({37: [offer(9, 701, 100)]})
        self.run_once(http)
        self.run_once(FakeHttp({37: []}), now=NOW + 3600)  # 404 → неактивне
        self.assertEqual(self.load("electronics")["offers"][0]["a"], 0)
        self.run_once(FakeHttp({37: []}), now=NOW + 40 * 86400)
        self.assertEqual(self.load("electronics")["offers"], [])

    def test_blocked_stops_quickly(self):
        class Blocked(FakeHttp):
            def get_json(self, url, params=None, retries=4):
                if "bank.gov.ua" in url:
                    return 200, []
                self.requests += 1
                return 403, None
        h = Blocked({})
        self.run_once(h)
        self.assertLessEqual(h.requests, 3)
        with open(os.path.join(self.tmp, "state.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f).get("failed_paths", {}), {})
        with open(os.path.join(self.tmp, "meta.json"), encoding="utf-8") as f:
            self.assertIn("403", " ".join(json.load(f)["warnings"]))

    def test_area_shapes(self):
        self.assertTrue(S.in_area({"type": "bbox", "south": 50, "north": 51, "west": 30, "east": 31}, 50.5, 30.5))
        poly = {"type": "polygon", "points": [[50, 30], [51, 30], [51, 31], [50, 31]]}
        self.assertTrue(S.in_area(poly, 50.5, 30.5))
        self.assertFalse(S.in_area(poly, 52, 30.5))


if __name__ == "__main__":
    unittest.main()
