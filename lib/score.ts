import { Dataset, Kind, radianceAt } from "./data";
import { LngLat, M_PER_DEG_LAT, M_PER_DEG_LON, axis, axisDiff, resample, simplify } from "./geo";
import { HoursSource, OpenState, openAt } from "./hours";
import { Candidate, Mode } from "./routing";

/**
 * The night score.
 *
 * Every route is sampled at short, even intervals. At each sample we look at what is actually
 * around it at the moment you would pass (open places, road type, light, cameras, help) and then
 * aggregate those into seven components in [0, 1]. The score is their weighted sum, x100.
 * All thresholds and weights live in PARAMS so they can be argued with.
 */

export type Component = "activity" | "gaps" | "light" | "roads" | "help" | "cameras" | "transit";

interface ModeParams {
  step: number;               // sampling interval, m
  eyesRadius: number;         // a place this close counts as "eyes on the street", m
  cameraRadius: number;
  lampRadius: number;
  transitRadius: number;
  helpRadius: number;         // an open hospital/police station this close counts as reachable help
  gapCap: number;             // an (effective) quiet stretch this long zeroes the gaps component, m
  minReportedGap: number;     // shortest quiet stretch worth drawing on the map, m
  camerasPerKmFull: number;
  transitPerKmFull: number;
  weights: Record<Component, number>;
  roadValue: Record<string, number>;
}

/** Contribution of one open place to "eyes on the street". Default (assumed) hours count x0.75. */
const EYES_WEIGHT: Partial<Record<Kind, number>> = {
  hospital: 1, police: 1, fuel: 1, pharmacy: 1, food: 1, grocery: 1, mall: 1, metro: 1,
  hotel: 0.8, shop: 0.6, atm: 0.4,
};
const ASSUMED_DISCOUNT = 0.75;
/** A sample is "watched" when the open places around it add up to at least this. */
const WATCHED = 0.7;

/**
 * Radiance (nW/cm^2/sr) mapped to [0, 1]. <=8 is the Aravalli ridge or the Yamuna floodplain at
 * night; >=36 is a lit urban sector. NASA's visualised product saturates at 38.2, so the top end
 * cannot separate a bright sector from a very bright one -- darkness is what it resolves well.
 */
const RAD_DARK = 8;
const RAD_BRIGHT = 36;

export const PARAMS: Record<Mode, ModeParams> = {
  walk: {
    step: 15, eyesRadius: 45, cameraRadius: 35, lampRadius: 30, transitRadius: 120, helpRadius: 500,
    gapCap: 600, minReportedGap: 200, camerasPerKmFull: 4, transitPerKmFull: 3,
    weights: { activity: 0.28, gaps: 0.2, light: 0.15, roads: 0.15, help: 0.08, cameras: 0.07, transit: 0.07 },
    roadValue: {
      motorway: 0.2, trunk: 0.9, primary: 1, secondary: 1, tertiary: 0.8, unclassified: 0.45,
      residential: 0.5, living_street: 0.5, service: 0.3, track: 0.1, pedestrian: 0.7,
      footway: 0.35, path: 0.15, cycleway: 0.3,
    },
  },
  drive: {
    step: 25, eyesRadius: 70, cameraRadius: 50, lampRadius: 40, transitRadius: 0, helpRadius: 1000,
    gapCap: 4000, minReportedGap: 800, camerasPerKmFull: 3, transitPerKmFull: 1,
    weights: { activity: 0.2, gaps: 0.17, light: 0.15, roads: 0.3, help: 0.1, cameras: 0.08, transit: 0 },
    roadValue: {
      motorway: 1, trunk: 1, primary: 1, secondary: 0.85, tertiary: 0.65, unclassified: 0.4,
      residential: 0.35, living_street: 0.3, service: 0.25, track: 0.05, pedestrian: 0.3,
      footway: 0.3, path: 0.1, cycleway: 0.3,
    },
  },
};

export interface PlaceOut {
  lon: number;
  lat: number;
  kind: Kind;
  name: string;
  open: boolean;
  hours: HoursSource;
  /** Raw OSM opening_hours, when present. */
  oh?: string;
}

export interface Gap {
  coords: LngLat[];
  length: number;
  /** Mean light component over the stretch, 0..1. */
  light: number;
  startAt: number;
}

export interface ScoredRoute {
  id: number;
  coords: LngLat[];
  distance: number;
  duration: number;
  via: string;
  score: number | null;
  /** null = no usable data for this component here; its weight is shared among the others. */
  components: Record<Component, number | null>;
  weights: Record<Component, number>;
  stats: {
    openPlaces: number;
    closedPlaces: number;
    assumedHours: number;
    watchedShare: number;
    longestGap: number;
    longestGapDark: boolean;
    mainRoadShare: number;
    smallRoadShare: number;
    unknownRoadShare: number;
    litTaggedShare: number;
    meanRadiance: number;
    cameras: number;
    transit: number;
    helpWithinReach: number;
    helpPoints: number;
    coverage: number;
  };
  places: PlaceOut[];
  cameras: LngLat[];
  help: PlaceOut[];
  gaps: Gap[];
}

const MAIN = new Set(["motorway", "trunk", "primary", "secondary"]);
const SMALL = new Set(["residential", "living_street", "service", "track", "footway", "path", "cycleway", "unclassified"]);

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

interface Snap {
  cls: string | null;
  lit: number; // 0 unknown, 1 lit, 2 unlit
}

function snapRoad(ds: Dataset, lon: number, lat: number, routeAxis: number): Snap {
  const r = ds.roads;
  let best = -1;
  let bestScore = Infinity;
  r.near(lon, lat, 20, (id, d, ax, ay, bx, by) => {
    // At junctions the nearest way is often the crossing street; prefer roads running our way.
    const s = d + (axisDiff(axis(bx - ax, by - ay), routeAxis) > 35 ? 15 : 0);
    if (s < bestScore) {
      bestScore = s;
      best = id;
    }
  });
  return best < 0 ? { cls: null, lit: 0 } : { cls: r.classes[r.cls[best]], lit: r.lit[best] };
}

const HELP_KINDS = new Set<Kind>(["hospital", "police"]);

/**
 * OSM camera mapping in NCR is concentrated in central and south Delhi; most sectors of Gurugram,
 * Noida, Faridabad and Ghaziabad have none mapped, which says nothing about whether cameras exist.
 * If no camera is mapped within 1.5 km of any point on the route we treat the component as
 * "no data", not as zero.
 */
function camerasMappedNearby(ds: Dataset, samples: { lon: number; lat: number }[]): boolean {
  const cam = ds.pois.kinds.indexOf("camera");
  const stride = Math.max(1, Math.floor(samples.length / 40));
  for (let i = 0; i < samples.length; i += stride) {
    let found = false;
    ds.poiGrid.near(samples[i].lon, samples[i].lat, 1500, (pid) => {
      if (ds.pois.kind[pid] === cam) found = true;
    });
    if (found) return true;
  }
  return false;
}

export function scoreRoute(
  ds: Dataset, cand: Candidate, mode: Mode, depart: Date, id: number,
): ScoredRoute {
  const P = PARAMS[mode];
  const { pois, poiGrid, light, meta } = ds;
  const [W, S, E, N] = meta.bbox;
  const samples = resample(cand.coords, P.step);
  const total = samples[samples.length - 1]?.at || 1;
  const memo = new Map<string, OpenState>();

  const placeState = new Map<number, OpenState>();
  const cameraIds = new Set<number>();
  const transitIds = new Set<number>();
  const helpIds = new Map<number, OpenState>();

  let inside = 0;
  let watchedLen = 0, lightSum = 0, roadSum = 0, helpOk = 0;
  let mainN = 0, smallN = 0, unknownN = 0, litTagN = 0, radSum = 0;
  const watched: boolean[] = [];
  const lightAt: number[] = [];

  for (const s of samples) {
    const isIn = s.lon >= W && s.lon <= E && s.lat >= S && s.lat <= N;
    watched.push(true);
    lightAt.push(1);
    if (!isIn) continue;
    inside++;
    const when = new Date(depart.getTime() + (cand.duration * 1000 * s.at) / total);

    // Eyes on the street, cameras, lamps, transit.
    let eyes = 0;
    let lamp = false;
    poiGrid.near(s.lon, s.lat, Math.max(P.eyesRadius, P.transitRadius, P.cameraRadius, P.lampRadius), (pid, d) => {
      const kind = pois.kinds[pois.kind[pid]];
      if (kind === "camera") {
        if (d <= P.cameraRadius) cameraIds.add(pid);
        return;
      }
      if (kind === "lamp") {
        if (d <= P.lampRadius) lamp = true;
        return;
      }
      if (kind === "bus" || kind === "metro") {
        if (P.transitRadius && d <= P.transitRadius) transitIds.add(pid);
        if (kind === "bus") return;
      }
      if (d > P.eyesRadius) return;
      const w = EYES_WEIGHT[kind];
      if (!w) return;
      const st = openAt(pois.hours[pid], pois.defaultHours[kind], when, memo);
      if (!placeState.has(pid)) placeState.set(pid, st);
      if (st.open) eyes += w * (st.source === "assumed" ? ASSUMED_DISCOUNT : 1);
    });
    const isWatched = eyes >= WATCHED;
    watched[watched.length - 1] = isWatched;
    if (isWatched) watchedLen++;

    // Reachable help: any open hospital or police station within helpRadius.
    let help = false;
    poiGrid.near(s.lon, s.lat, P.helpRadius, (pid) => {
      const kind = pois.kinds[pois.kind[pid]];
      if (!HELP_KINDS.has(kind)) return;
      const st = openAt(pois.hours[pid], pois.defaultHours[kind], when, memo);
      if (st.open) {
        help = true;
        if (!helpIds.has(pid)) helpIds.set(pid, st);
      }
    });
    if (help) helpOk++;

    // Road class and tagged lighting.
    const snap = snapRoad(ds, s.lon, s.lat, s.axis);
    if (snap.cls) {
      roadSum += P.roadValue[snap.cls] ?? 0.3;
      if (MAIN.has(snap.cls)) mainN++;
      else if (SMALL.has(snap.cls)) smallN++;
    } else {
      roadSum += 0.3;
      unknownN++;
    }

    // Light: satellite radiance, overridden by explicit OSM evidence on this street.
    const rad = radianceAt(light, s.lon, s.lat) ?? 0;
    radSum += rad;
    let l = clamp01((rad - RAD_DARK) / (RAD_BRIGHT - RAD_DARK));
    if (snap.lit === 1 || lamp) {
      l = Math.max(l, 0.85);
      litTagN++;
    } else if (snap.lit === 2) {
      l = Math.min(l, 0.25);
    }
    lightAt[lightAt.length - 1] = l;
    lightSum += l;
  }

  // Quiet stretches: runs of samples with nobody open nearby. A dark run counts in full, a
  // brightly lit one at half its length.
  const gaps: Gap[] = [];
  let worstEff = 0, longest = 0, longestDark = false;
  for (let i = 0; i < samples.length; ) {
    if (watched[i]) {
      i++;
      continue;
    }
    let j = i;
    let lsum = 0;
    while (j < samples.length && !watched[j]) {
      lsum += lightAt[j];
      j++;
    }
    const len = samples[j - 1].at - samples[i].at + P.step;
    const meanLight = lsum / (j - i);
    const eff = len * (0.5 + 0.5 * (1 - meanLight));
    if (eff > worstEff) worstEff = eff;
    if (len > longest) {
      longest = len;
      longestDark = meanLight < 0.5;
    }
    if (len >= P.minReportedGap) {
      gaps.push({
        coords: samples.slice(i, j).map((s) => [s.lon, s.lat] as LngLat),
        length: Math.round(len),
        light: Math.round(meanLight * 100) / 100,
        startAt: Math.round(samples[i].at),
      });
    }
    i = j;
  }

  const n = Math.max(1, inside);
  const km = Math.max(0.2, (total * inside) / Math.max(1, samples.length) / 1000);
  const components: Record<Component, number | null> = {
    activity: watchedLen / n,
    gaps: 1 - clamp01(worstEff / P.gapCap),
    light: lightSum / n,
    roads: roadSum / n,
    help: helpOk / n,
    cameras: camerasMappedNearby(ds, samples)
      ? clamp01(cameraIds.size / km / P.camerasPerKmFull)
      : null,
    transit: P.transitRadius ? clamp01(transitIds.size / km / P.transitPerKmFull) : null,
  };
  // Renormalise over the components that have data.
  const keys = (Object.keys(components) as Component[]).filter((k) => components[k] !== null && P.weights[k] > 0);
  const wsum = keys.reduce((a, k) => a + P.weights[k], 0);
  const weights = Object.fromEntries(
    (Object.keys(components) as Component[]).map((k) => [k, keys.includes(k) ? P.weights[k] / wsum : 0]),
  ) as Record<Component, number>;
  const coverage = inside / Math.max(1, samples.length);
  let raw = 0;
  for (const k of keys) raw += (components[k] as number) * weights[k];
  const score = coverage >= 0.6 ? Math.round(raw * 100) : null;

  const toPlace = (pid: number, st: OpenState): PlaceOut => {
    const oh = pois.hours[pid];
    return {
      lon: pois.lon[pid], lat: pois.lat[pid], kind: pois.kinds[pois.kind[pid]],
      name: pois.names[pois.name[pid]], open: st.open, hours: st.source, ...(oh ? { oh } : {}),
    };
  };
  const places = [...placeState].map(([pid, st]) => toPlace(pid, st));
  let open = 0, assumed = 0;
  for (const p of places) {
    if (p.open) open++;
    if (p.hours === "assumed") assumed++;
  }

  // Only ship help points reasonably close to the route; the rest would clutter the map.
  const help = [...helpIds]
    .map(([pid, st]) => toPlace(pid, st))
    .filter((p) => samples.some((s) => Math.abs(s.lon - p.lon) * M_PER_DEG_LON < 400 && Math.abs(s.lat - p.lat) * M_PER_DEG_LAT < 400));

  for (const k of Object.keys(components) as Component[]) {
    const v = components[k];
    if (v !== null) components[k] = Math.round(v * 100) / 100;
    weights[k] = Math.round(weights[k] * 1000) / 1000;
  }

  return {
    id,
    coords: simplify(cand.coords, 3),
    distance: Math.round(cand.distance),
    duration: Math.round(cand.duration),
    via: cand.via,
    score,
    components,
    weights,
    stats: {
      openPlaces: open,
      closedPlaces: places.length - open,
      assumedHours: assumed,
      watchedShare: Math.round((watchedLen / n) * 100) / 100,
      longestGap: Math.round(longest),
      longestGapDark: longestDark,
      mainRoadShare: Math.round((mainN / n) * 100) / 100,
      smallRoadShare: Math.round((smallN / n) * 100) / 100,
      unknownRoadShare: Math.round((unknownN / n) * 100) / 100,
      litTaggedShare: Math.round((litTagN / n) * 100) / 100,
      meanRadiance: Math.round((radSum / n) * 10) / 10,
      cameras: cameraIds.size,
      transit: transitIds.size,
      helpWithinReach: Math.round((helpOk / n) * 100) / 100,
      helpPoints: helpIds.size,
      coverage: Math.round(coverage * 100) / 100,
    },
    places: places.slice(0, 600),
    cameras: [...cameraIds].map((pid) => [pois.lon[pid], pois.lat[pid]] as LngLat),
    help,
    gaps: gaps.sort((a, b) => b.length - a.length).slice(0, 5),
  };
}
