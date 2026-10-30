"""Build Rasta's static datasets for the NCR coverage box.

Inputs (all open data, fetched by this script):
  * OpenStreetMap state extracts from download.openstreetmap.fr (Haryana, Delhi, Uttar Pradesh)
  * Overture Maps "places" theme (public S3 bucket, anonymous access)
  * NASA VIIRS Black Marble gap-filled, BRDF/moonlight-corrected night radiance (VNP46A2 / VJ146A2)
    through NASA GIBS WMS, converted back to radiance with GIBS's published colour map

Outputs in data/:
  pois.json   places that keep a street "watched" after dark, cameras, street lamps, transit
  roads.bin   every OSM road/footway in the box (class, lit tag, geometry) for snapping routes
  light.json  median night radiance grid (nW/cm^2/sr)
  meta.json   source versions, dates and counts, shown in the app

Usage:
  pip install osmium duckdb numpy pillow
  python scripts/build_data.py            # downloads into .cache/, writes data/
"""

from __future__ import annotations

import datetime as dt
import io
import json
import math
import os
import re
import struct
import sys
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
import osmium
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / ".cache"
OUT = ROOT / "data"

# Gurgaon (incl. Sohna Road, Golf Course Ext.) + South/East Delhi + Noida + Greater Noida West.
SOUTH, WEST, NORTH, EAST = 28.36, 76.93, 28.66, 77.56

OSM_EXTRACTS = ["haryana", "national_capital_territory_of_delhi", "uttar_pradesh"]
OSM_URL = "https://download.openstreetmap.fr/extracts/asia/india/{}-latest.osm.pbf"
OVERTURE_RELEASE = "2026-10-21.0"
UA = "rasta-data-build/1.0 (+https://github.com)"


def inside(lat: float, lon: float) -> bool:
    return SOUTH <= lat <= NORTH and WEST <= lon <= EAST


def fetch(url: str, dest: Path) -> Path:
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"  downloading {url}")
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=900) as r, open(dest, "wb") as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)
    return dest


# --------------------------------------------------------------------------------------------
# Place kinds. `hours` is the assumption used ONLY when a place has no opening_hours tag; the
# app labels such places "hours assumed" so nobody mistakes the default for real data.
# --------------------------------------------------------------------------------------------
KINDS = {
    "hospital": {"hours": "24/7"},
    "police": {"hours": "24/7"},
    "fuel": {"hours": "06:00-23:00"},
    "pharmacy": {"hours": "09:00-22:00"},
    "food": {"hours": "11:00-23:00"},
    "grocery": {"hours": "08:00-22:00"},
    "shop": {"hours": "10:30-21:00"},
    "mall": {"hours": "10:00-22:00"},
    "hotel": {"hours": "24/7"},
    "atm": {"hours": "24/7"},
    "metro": {"hours": "05:30-23:30"},
    "bus": {"hours": None},  # a stop, not a staffed place: counts as a transport point only
    "camera": {"hours": None},
    "lamp": {"hours": None},
}
KIND_LIST = list(KINDS)

OSM_SHOP_GROCERY = {"convenience", "supermarket", "kiosk", "general", "bakery", "dairy", "greengrocer",
                    "confectionery", "beverages", "butcher", "variety_store", "department_store"}


def osm_kind(tags) -> str | None:
    a = tags.get("amenity")
    hc = tags.get("healthcare")
    if a == "hospital" or hc == "hospital":
        return "hospital"
    if a == "police":
        return "police"
    if a == "fuel":
        return "fuel"
    if a == "pharmacy" or hc == "pharmacy" or tags.get("shop") == "chemist":
        return "pharmacy"
    if a in ("restaurant", "fast_food", "cafe", "food_court", "bar", "pub", "ice_cream"):
        return "food"
    if a == "atm" or (a == "bank" and tags.get("atm") == "yes"):
        return "atm"
    shop = tags.get("shop")
    if shop == "mall":
        return "mall"
    if shop in OSM_SHOP_GROCERY:
        return "grocery"
    if shop and shop not in ("vacant", "no"):
        return "shop"
    if tags.get("tourism") in ("hotel", "hostel", "guest_house", "motel"):
        return "hotel"
    rw = tags.get("railway")
    if rw == "subway_entrance" or (rw == "station" and tags.get("station") in ("subway", "light_rail", "monorail")):
        return "metro"
    if rw in ("station", "halt"):
        return "metro"  # suburban rail stations in the box (e.g. Gurgaon, Okhla) keep similar hours
    if tags.get("highway") == "bus_stop" or a == "bus_station":
        return "bus"
    if tags.get("man_made") == "surveillance":
        return "camera"
    if tags.get("highway") == "street_lamp":
        return "lamp"
    return None


# Road classes, ordered from busiest to quietest. Index is stored in roads.bin.
ROAD_CLASSES = ["motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential",
                "living_street", "service", "track", "pedestrian", "footway", "path", "cycleway"]
ROAD_ALIAS = {"motorway_link": "motorway", "trunk_link": "trunk", "primary_link": "primary",
              "secondary_link": "secondary", "tertiary_link": "tertiary", "road": "unclassified",
              "busway": "service", "bridleway": "path", "steps": "footway", "sidewalk": "footway"}


class OsmHandler(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.pois: dict[str, tuple] = {}
        self.roads: dict[int, tuple] = {}

    def _poi(self, key, lat, lon, tags):
        kind = osm_kind(tags)
        if not kind or not inside(lat, lon):
            return
        name = tags.get("name:en") or tags.get("name") or tags.get("brand") or tags.get("operator") or ""
        oh = tags.get("opening_hours", "")
        if kind == "camera":
            name = tags.get("surveillance:type", "camera")
            if tags.get("surveillance") == "indoor":
                return
        self.pois[key] = (round(lat, 6), round(lon, 6), kind, name[:80], oh[:200], "osm")

    def node(self, n):
        if n.tags:
            self._poi(f"n{n.id}", n.location.lat, n.location.lon, n.tags)

    def way(self, w):
        tags = w.tags
        hw = tags.get("highway")
        coords = []
        try:
            for nd in w.nodes:
                if nd.location.valid():
                    coords.append((nd.location.lat, nd.location.lon))
        except osmium.InvalidLocationError:
            return
        if len(coords) < 2:
            if coords and not hw:
                self._poi(f"w{w.id}", coords[0][0], coords[0][1], tags)
            return
        if not any(inside(la, lo) for la, lo in coords):
            return
        cls = ROAD_ALIAS.get(hw, hw)
        if cls in ROAD_CLASSES:
            if tags.get("access") in ("private", "no") and cls == "service":
                return
            lit = {"yes": 1, "24/7": 1, "automatic": 1, "sunset-sunrise": 1, "no": 2, "disused": 2}.get(tags.get("lit", ""), 0)
            self.roads[w.id] = (ROAD_CLASSES.index(cls), lit, coords)
        elif not hw:
            # Area features (malls, hospitals, fuel stations mapped as buildings): use the centroid.
            lat = sum(c[0] for c in coords) / len(coords)
            lon = sum(c[1] for c in coords) / len(coords)
            self._poi(f"w{w.id}", lat, lon, tags)


def build_osm():
    h = OsmHandler()
    meta = {}
    for name in OSM_EXTRACTS:
        path = fetch(OSM_URL.format(name), CACHE / f"{name}-latest.osm.pbf")
        print(f"  reading {path.name}")
        h.apply_file(str(path), locations=True)
        meta[name] = dt.datetime.fromtimestamp(path.stat().st_mtime, dt.timezone.utc).strftime("%Y-%m-%d")
    print(f"  OSM: {len(h.pois)} places, {len(h.roads)} roads")
    return list(h.pois.values()), list(h.roads.values()), meta


# --------------------------------------------------------------------------------------------
# Overture places: far denser than OSM for Indian shops and eateries, but no opening hours.
# --------------------------------------------------------------------------------------------
OVERTURE_KINDS = {
    "hospital": "hospital", "emergency_department": "hospital", "emergency_or_urgent_care_facility": "hospital",
    "police_station": "police",
    "gas_station": "fuel", "fueling_station": "fuel",
    "pharmacy_and_drug_store": "pharmacy",
    "restaurant": "food", "fast_food_restaurant": "food", "casual_eatery": "food", "cafe": "food",
    "coffee_shop": "food", "bar": "food", "food_court": "food", "food_truck_stand": "food", "food_service": "food",
    "food_and_beverage_store": "grocery", "convenience_store": "grocery", "grocery_store": "grocery",
    "supermarket": "grocery", "bakery": "grocery",
    "fashion_and_apparel_store": "shop", "electronics_store": "shop", "hardware_home_and_garden_store": "shop",
    "shopping": "shop", "flowers_and_gifts_store": "shop", "personal_or_beauty_service": "shop",
    "shopping_mall": "mall",
    "hotel": "hotel", "lodging": "hotel",
    "atm": "atm",
    "train_station": "metro",
}
OVERTURE_MIN_CONFIDENCE = 0.65


def build_overture():
    import duckdb

    cache = CACHE / f"overture-places-{OVERTURE_RELEASE}.parquet"
    con = duckdb.connect()
    if not cache.exists():
        print("  querying Overture places (anonymous S3)")
        for k in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"):
            os.environ.pop(k, None)
        con.sql("INSTALL httpfs; LOAD httpfs;")
        con.sql("CREATE SECRET ov (TYPE s3, PROVIDER config, KEY_ID '', SECRET '', REGION 'us-west-2')")
        con.sql(f"""COPY (
          SELECT id, names.primary AS name, taxonomy.primary AS cat, basic_category, confidence, operating_status,
                 (bbox.xmin + bbox.xmax) / 2 AS lon, (bbox.ymin + bbox.ymax) / 2 AS lat
          FROM read_parquet('s3://overturemaps-us-west-2/release/{OVERTURE_RELEASE}/theme=places/type=place/*',
                            hive_partitioning = 1)
          WHERE bbox.xmin BETWEEN {WEST} AND {EAST} AND bbox.ymin BETWEEN {SOUTH} AND {NORTH}
        ) TO '{cache}' (FORMAT parquet)""")
    rows = con.sql(f"""SELECT name, cat, basic_category, lat, lon FROM '{cache}'
                       WHERE confidence >= {OVERTURE_MIN_CONFIDENCE}
                         AND coalesce(operating_status, 'open') = 'open'""").fetchall()
    out = []
    for name, cat, basic, lat, lon in rows:
        kind = OVERTURE_KINDS.get(cat) or OVERTURE_KINDS.get(basic)
        if cat in ("metro_station", "bus_station"):
            kind = "metro" if cat == "metro_station" else "bus"
        if kind and inside(lat, lon):
            out.append((round(lat, 6), round(lon, 6), kind, (name or "")[:80], "", "ovt"))
    print(f"  Overture: {len(out)} places kept of {len(rows)} above confidence {OVERTURE_MIN_CONFIDENCE}")
    return out


def dedupe(osm_pois, ovt_pois, radius_m=40):
    """Drop Overture places that duplicate an OSM place of the same kind (OSM may carry hours)."""
    cell = 0.0005
    grid: dict[tuple, list] = {}
    for p in osm_pois:
        grid.setdefault((int(p[0] / cell), int(p[1] / cell), p[2]), []).append(p)
    kept = []
    for p in ovt_pois:
        ci, cj = int(p[0] / cell), int(p[1] / cell)
        dup = False
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                for q in grid.get((ci + di, cj + dj, p[2]), ()):
                    if haversine(p[0], p[1], q[0], q[1]) < radius_m:
                        dup = True
                        break
        if not dup:
            kept.append(p)
    print(f"  dedupe: {len(ovt_pois) - len(kept)} Overture duplicates of OSM places dropped")
    return kept


def haversine(la1, lo1, la2, lo2):
    r = 6371000.0
    p1, p2 = math.radians(la1), math.radians(la2)
    dp, dl = p2 - p1, math.radians(lo2 - lo1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


# --------------------------------------------------------------------------------------------
# Night radiance: per-pixel median of the last N nights from two satellites, so cloud gaps,
# fires and one-off events wash out. GIBS serves this as greyscale PNG; its colour map XML maps
# each grey level back to a radiance interval, and we take the interval midpoint.
# --------------------------------------------------------------------------------------------
LIGHT_LAYERS = ["VIIRS_SNPP_GapFilled_BRDF_Corrected_DayNightBand_Radiance",
                "VIIRS_NOAA20_GapFilled_BRDF_Corrected_DayNightBand_Radiance"]
LIGHT_COLORMAP = "https://gibs.earthdata.nasa.gov/colormaps/v1.3/VIIRS_DayNightBand_At_Sensor_Radiance.xml"
LIGHT_RES = 0.004  # degrees, just under the product's ~500 m (15 arc-second) cell
LIGHT_NIGHTS = 30


def colormap_lut():
    xml = fetch(LIGHT_COLORMAP, CACHE / "viirs-dnb-colormap.xml").read_text()
    root = ET.fromstring(re.sub(r'\sxmlns="[^"]+"', "", xml, count=1))
    lut = {}
    for e in root.iter("ColorMapEntry"):
        if e.get("nodata") == "true" or e.get("transparent") == "true":
            continue
        lo, hi = re.findall(r"-?[\d.]+|inf", e.get("value"))[:2]
        lo, hi = float(lo), float(hi) if hi != "inf" else math.inf
        r, g, b = map(int, e.get("rgb").split(","))
        # The visualisation saturates: its top bin is [38.2, 999999). Clamp to the bin floor, so
        # "38" reads as "38 or brighter". Darkness, which is what we score, keeps full resolution.
        lut[(r, g, b)] = lo if hi - lo > 100 else (lo + hi) / 2
    return lut


def build_light():
    lut = colormap_lut()
    w = round((EAST - WEST) / LIGHT_RES)
    h = round((NORTH - SOUTH) / LIGHT_RES)
    end = dt.date.today() - dt.timedelta(days=1)
    stack, used = [], []
    day = end
    while len(used) < LIGHT_NIGHTS and (end - day).days < LIGHT_NIGHTS * 3:
        for layer in LIGHT_LAYERS:
            url = ("https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap"
                   f"&VERSION=1.3.0&LAYERS={layer}&CRS=EPSG:4326&BBOX={SOUTH},{WEST},{NORTH},{EAST}"
                   f"&WIDTH={w}&HEIGHT={h}&FORMAT=image/png&TIME={day.isoformat()}")
            try:
                png = fetch(url, CACHE / "light" / f"{layer}-{day}.png").read_bytes()
                img = np.array(Image.open(io.BytesIO(png)).convert("RGBA"))
            except Exception as exc:  # missing day for one satellite is normal
                print(f"  skip {layer} {day}: {exc}")
                continue
            vals = np.full((h, w), np.nan, dtype=np.float32)
            rgb = img[..., :3]
            valid = img[..., 3] > 0
            for (r, g, b), v in lut.items():
                m = valid & (rgb[..., 0] == r) & (rgb[..., 1] == g) & (rgb[..., 2] == b)
                vals[m] = v
            if np.isfinite(vals).mean() > 0.8:
                stack.append(vals)
                used.append(f"{layer.split('_')[1]}:{day}")
        day -= dt.timedelta(days=1)
    grid = np.nanmedian(np.stack(stack), axis=0)
    grid = np.nan_to_num(grid, nan=0.0)
    print(f"  light: {len(stack)} images, radiance p10/p50/p90 = "
          f"{np.percentile(grid, 10):.1f}/{np.percentile(grid, 50):.1f}/{np.percentile(grid, 90):.1f}")
    return {
        "south": SOUTH, "west": WEST, "north": NORTH, "east": EAST, "width": w, "height": h,
        "units": "nW/cm^2/sr",
        "saturatesAt": max(lut.values()),
        # Row 0 is the northern edge (image order).
        "values": [round(float(v), 1) for v in grid.ravel()],
    }, used


def write_roads(roads, path: Path):
    """Binary: u32 count, then per way: u8 class, u8 lit, u16 n, n x (i32 lat*1e5, i32 lon*1e5)."""
    with open(path, "wb") as f:
        f.write(struct.pack("<I", len(roads)))
        for cls, lit, coords in roads:
            coords = coords[:65535]
            f.write(struct.pack("<BBH", cls, lit, len(coords)))
            f.write(struct.pack(f"<{2 * len(coords)}i",
                                *[v for la, lo in coords for v in (round(la * 1e5), round(lo * 1e5))]))


def main():
    OUT.mkdir(exist_ok=True)
    print("OpenStreetMap")
    osm_pois, roads, osm_dates = build_osm()
    print("Overture")
    ovt = dedupe(osm_pois, build_overture())
    pois = osm_pois + ovt
    pois.sort(key=lambda p: (p[0], p[1]))

    print("Night lights")
    light, nights = build_light()

    names, name_idx = [], {}

    def nid(n):
        if n not in name_idx:
            name_idx[n] = len(names)
            names.append(n)
        return name_idx[n]

    out = {
        "kinds": KIND_LIST,
        "defaultHours": {k: v["hours"] for k, v in KINDS.items()},
        "names": names,
        "lat": [p[0] for p in pois],
        "lon": [p[1] for p in pois],
        "kind": [KIND_LIST.index(p[2]) for p in pois],
        "name": [nid(p[3]) for p in pois],
        "hours": [p[4] for p in pois],
        "src": [0 if p[5] == "osm" else 1 for p in pois],
    }
    (OUT / "pois.json").write_text(json.dumps(out, separators=(",", ":"), ensure_ascii=False))
    write_roads(roads, OUT / "roads.bin")
    (OUT / "light.json").write_text(json.dumps(light, separators=(",", ":")))

    counts = {k: 0 for k in KIND_LIST}
    for p in pois:
        counts[p[2]] += 1
    meta = {
        "built": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "bbox": [WEST, SOUTH, EAST, NORTH],
        "osmExtracts": osm_dates,
        "overtureRelease": OVERTURE_RELEASE,
        "overtureMinConfidence": OVERTURE_MIN_CONFIDENCE,
        "lightNights": nights,
        "roadClasses": ROAD_CLASSES,
        "counts": counts,
        "withOpeningHours": sum(1 for p in pois if p[4]),
        "roads": len(roads),
    }
    (OUT / "meta.json").write_text(json.dumps(meta, indent=2))
    print(json.dumps(meta["counts"], indent=1), "\nwith hours:", meta["withOpeningHours"])


if __name__ == "__main__":
    sys.exit(main())
