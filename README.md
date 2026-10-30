# Rasta

Night-time route comparison for **Gurgaon, Noida and the South/East Delhi stretch between them**.

Give it two places, say whether you're walking or in a cab, and pick when you're leaving. Rasta fetches up to three
genuinely different routes and scores each one for the hour you'll actually be on it:

- how much of it has an open shop, eatery, chemist, petrol pump, hospital or station right beside it,
- the longest stretch with nothing open, and whether that stretch is dark,
- how bright it is at night (from satellite data), and whether it uses main roads or internal lanes,
- whether an open hospital or police station is within reach, plus mapped CCTV and transit points.

It doesn't pick a route for you. It shows the trade-off ("+4 min, but 30 open places instead of 6 and no 2 km
dead stretch") and lets you decide.

Inspired by [this demo](https://x.com/achinamayya/status/2115794397489205740), rebuilt for NCR on open data only.

## Data

Every number in the app comes from one of these sources. Nothing is generated or invented.

| What | Source | Notes |
| --- | --- | --- |
| Roads, `lit` tags, street lamps, CCTV, opening hours | OpenStreetMap: Haryana, Delhi and Uttar Pradesh extracts from [download.openstreetmap.fr](https://download.openstreetmap.fr/extracts/asia/india/) | 2,545 mapped cameras and 1,143 street lamps in the box; 1,460 places carry `opening_hours`. |
| Shops, eateries, ATMs, hotels, hospitals, police, pumps | [Overture Maps](https://overturemaps.org) places, release `2026-10-21.0` | Much denser than OSM for Indian businesses. Only places with confidence ≥ 0.65 are kept; Overture duplicates of OSM places (same kind, within 40 m) are dropped. |
| Night light | NASA Black Marble VNP46A2 / VJ146A2 (gap-filled, BRDF- and moonlight-corrected radiance) via [NASA GIBS](https://nasa-gibs.github.io/gibs-api-docs/) | Per-pixel median of the last 15 nights from both Suomi-NPP and NOAA-20 (30 passes). GIBS greyscale is converted back to nW/cm²/sr with GIBS's published colour map. |
| Routes | [OSRM](https://project-osrm.org) car and foot profiles on FOSSGIS's public servers | Router alternatives plus detours via the nearest main road on either side of the direct line. |
| Search | [Photon](https://photon.komoot.io) (komoot), restricted to the coverage box | |
| Basemap | [OpenFreeMap](https://openfreemap.org) dark style | |

Counts in the current build (`data/meta.json`): 18,441 shops, 9,744 eateries, 3,265 grocery/convenience stores,
4,811 hotels, 3,304 ATMs, 2,407 hospitals, 1,464 pharmacies, 842 metro/rail stations, 669 malls, 639 petrol pumps,
336 police stations, 2,096 bus stops.

## How the night score works

Code: [`lib/score.ts`](lib/score.ts). Every threshold and weight lives in `PARAMS` there.

Each route is sampled every **15 m on foot / 25 m by car**. Each sample gets a timestamp from the departure time
plus the router's travel time to that point, so a 40-minute walk that starts at 10:40 pm is checked against shops
closing at 11.

| Component | What it measures | Walk weight | Drive weight |
| --- | --- | --- | --- |
| Open places | Share of samples "watched": open places within 45 m (walk) / 70 m (drive) whose weights sum to ≥ 0.7. Hospital, police, pump, chemist, eatery, grocery, mall, station = 1; hotel 0.8; other shop 0.6; ATM 0.4. Places whose hours are assumed (see below) count ×0.75. | 28% | 20% |
| No long empty stretch | 1 − (worst stretch with nothing open ÷ 600 m walk / 4 km drive). A stretch's effective length is scaled by darkness: fully dark counts in full, fully lit at half. | 20% | 17% |
| Light | Satellite radiance mapped linearly from 8 (dark) to 36 (bright) nW/cm²/sr. OSM `lit=yes` or a mapped street lamp within 30–40 m lifts a sample to ≥ 0.85; `lit=no` caps it at 0.25. | 15% | 15% |
| Road type | Each sample is snapped to the nearest OSM way within 20 m (preferring ways aligned with the route, so junctions don't snap to the cross street). Walking: primary/secondary 1.0, tertiary 0.8, residential 0.5, service 0.3, footpath 0.15–0.35, track 0.1. Driving: motorway/trunk/primary 1.0, secondary 0.85, tertiary 0.65, residential 0.35, track 0.05. | 15% | 30% |
| Help nearby | Share of samples with an open hospital or police station within 500 m (walk) / 1 km (drive). | 8% | 10% |
| CCTV | Mapped cameras within 35 m / 50 m per km, full marks at 4/km (walk) or 3/km (drive). | 7% | 8% |
| Transit points | Metro, rail and bus stops within 120 m per km, full marks at 3/km. Walking only. | 7% | 0% |

The score is the weighted sum × 100. If a component has **no data** for the route, its weight is shared among
the others instead of scoring it as zero. In practice this means CCTV: no camera mapped within 1.5 km of the route.
If less than 60% of a route lies inside the coverage box, it gets no score.

### Opening hours

Only about 1 in 30 places in the dataset (1,457 of 45,922) has hours in OpenStreetMap, and Overture carries none. When a place has a real
`opening_hours` tag it is evaluated exactly (with [opening_hours.js](https://github.com/opening-hours/opening_hours.js),
in IST). Otherwise Rasta uses a **category default** and labels the place "hours assumed" in the map popup:

| Category | Assumed hours |
| --- | --- |
| Hospital, police, hotel, ATM | 24/7 |
| Petrol pump | 06:00–23:00 |
| Pharmacy | 09:00–22:00 |
| Eatery | 11:00–23:00 |
| Grocery / convenience | 08:00–22:00 |
| Other shops | 10:30–21:00 |
| Mall | 10:00–22:00 |
| Metro / rail station | 05:30–23:30 |

These defaults are deliberately conservative for late night. If you know a stretch better, the fastest fix is to
add `opening_hours` to those places in OpenStreetMap, which will show up in the next data build.

## Known limits

- **Hours are mostly estimates.** See above. The route card says how many places on the route have real hours.
- **Satellite light is coarse.** About 500 m per pixel, and NASA's visualised product saturates at 38.2 nW/cm²/sr,
  so it separates dark belts (the Aravalli ridge, the Yamuna floodplain, unbuilt sectors on the city edge) from
  lit areas well, but can't see one dark lane inside a bright sector. OSM `lit` tags and lamps refine this where
  they exist.
- **CCTV mapping is uneven.** Dense around Connaught Place, Lodhi Road and South Delhi; sparse in Gurgaon and Noida.
  This is why "no data" is handled separately from zero.
- **Public holidays are not modelled.** opening_hours.js has no Indian holiday calendar, so `PH` rules are ignored.
- **Not live.** Rasta can't know about a closed road, a power cut or what's happening on a street tonight. It
  helps you weigh options; it isn't a safety guarantee.

## Running it

```bash
npm install
npm run dev            # http://localhost:3000
```

The built datasets are committed in `data/` (about 12 MB), so the app runs without rebuilding them.

### Rebuilding the data

```bash
pip install osmium duckdb numpy pillow
npm run data           # = python3 scripts/build_data.py
```

This downloads about 280 MB of OSM extracts into `.cache/`, queries Overture's public S3 bucket anonymously, pulls
30 nights of VIIRS imagery from GIBS, and rewrites `data/`. It takes about 5 minutes. The coverage box, categories,
assumed hours and the Overture confidence threshold are all at the top of
[`scripts/build_data.py`](scripts/build_data.py).

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OSRM_CAR_URL` | FOSSGIS `routed-car` | OSRM `/route/v1/driving` base URL |
| `OSRM_FOOT_URL` | FOSSGIS `routed-foot` | OSRM `/route/v1/foot` base URL |
| `ROUTER_USER_AGENT` | `rasta/0.1 …` | Sent to the router |

FOSSGIS's servers are fine for trying this out, but they're a shared, donated resource. Before sharing the app
widely, run your own OSRM (an NCR-sized graph fits comfortably on a small VM) and point the variables at it.

## Layout

```
scripts/build_data.py   data pipeline (OSM + Overture + VIIRS → data/)
data/                   built datasets, read by the API at runtime
lib/data.ts             loads data, spatial grid index, radiance lookup
lib/routing.ts          OSRM candidates, via-point detours, de-duplication
lib/score.ts            the night score
lib/hours.ts            opening_hours evaluation in IST
app/api/routes          POST {from, to, mode, depart} → scored routes
components/             UI (MapLibre map, search, route cards)
```

## Licences and attribution

- OpenStreetMap data © OpenStreetMap contributors, [ODbL 1.0](https://opendatacommons.org/licenses/odbl/). The
  files in `data/` are derived databases and are shared under the same licence.
- Overture Maps places: [CDLA Permissive 2.0](https://cdla.dev/permissive-2-0/) with source attribution as listed
  in the Overture release notes.
- NASA Black Marble imagery courtesy of NASA EOSDIS GIBS.
