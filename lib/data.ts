import fs from "node:fs";
import path from "node:path";
import { M_PER_DEG_LAT, M_PER_DEG_LON } from "./geo";

/** Must match KINDS in scripts/build_data.py. */
export type Kind =
  | "hospital" | "police" | "fuel" | "pharmacy" | "food" | "grocery" | "shop" | "mall"
  | "hotel" | "atm" | "metro" | "bus" | "camera" | "lamp";

export interface Pois {
  kinds: Kind[];
  defaultHours: Record<Kind, string | null>;
  names: string[];
  lat: number[];
  lon: number[];
  kind: number[];
  name: number[];
  hours: string[];
  src: number[];
}

export interface Light {
  south: number;
  west: number;
  north: number;
  east: number;
  width: number;
  height: number;
  saturatesAt: number;
  values: number[];
}

export interface Meta {
  built: string;
  bbox: [number, number, number, number];
  osmExtracts: Record<string, string>;
  overtureRelease: string;
  overtureMinConfidence: number;
  lightNights: string[];
  roadClasses: string[];
  counts: Record<Kind, number>;
  withOpeningHours: number;
  roads: number;
}

/** Bucketed index over points: cell -> contiguous slice of point ids (CSR layout). */
export class PointGrid {
  readonly cell: number;
  private start: Int32Array;
  private ids: Int32Array;
  private cols: number;
  private rows: number;

  constructor(
    readonly lat: Float64Array, readonly lon: Float64Array,
    readonly bbox: [number, number, number, number], cellDeg: number,
  ) {
    this.cell = cellDeg;
    this.cols = Math.ceil((bbox[2] - bbox[0]) / cellDeg) + 1;
    this.rows = Math.ceil((bbox[3] - bbox[1]) / cellDeg) + 1;
    const n = lat.length;
    const cellOf = new Int32Array(n);
    const counts = new Int32Array(this.cols * this.rows + 1);
    for (let i = 0; i < n; i++) {
      const c = this.cellIndex(lon[i], lat[i]);
      cellOf[i] = c;
      if (c >= 0) counts[c + 1]++;
    }
    for (let c = 1; c < counts.length; c++) counts[c] += counts[c - 1];
    this.start = counts;
    this.ids = new Int32Array(n);
    const fill = counts.slice();
    for (let i = 0; i < n; i++) if (cellOf[i] >= 0) this.ids[fill[cellOf[i]]++] = i;
  }

  private cellIndex(lon: number, lat: number): number {
    const cx = Math.floor((lon - this.bbox[0]) / this.cell);
    const cy = Math.floor((lat - this.bbox[1]) / this.cell);
    if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) return -1;
    return cy * this.cols + cx;
  }

  /** Calls fn(id, distanceM) for every point within radiusM of (lon, lat). */
  near(lon: number, lat: number, radiusM: number, fn: (id: number, d: number) => void) {
    const rx = Math.ceil(radiusM / M_PER_DEG_LON / this.cell);
    const ry = Math.ceil(radiusM / M_PER_DEG_LAT / this.cell);
    const cx = Math.floor((lon - this.bbox[0]) / this.cell);
    const cy = Math.floor((lat - this.bbox[1]) / this.cell);
    for (let y = Math.max(0, cy - ry); y <= Math.min(this.rows - 1, cy + ry); y++) {
      for (let x = Math.max(0, cx - rx); x <= Math.min(this.cols - 1, cx + rx); x++) {
        const c = y * this.cols + x;
        for (let k = this.start[c]; k < this.start[c + 1]; k++) {
          const id = this.ids[k];
          const dx = (this.lon[id] - lon) * M_PER_DEG_LON;
          const dy = (this.lat[id] - lat) * M_PER_DEG_LAT;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d <= radiusM) fn(id, d);
        }
      }
    }
  }
}

/** Road segments from roads.bin, indexed by segment midpoint. */
export interface Roads {
  /** Segment endpoints in degrees. */
  ax: Float64Array; ay: Float64Array; bx: Float64Array; by: Float64Array;
  cls: Uint8Array;
  lit: Uint8Array;
  grid: PointGrid;
  classes: string[];
}

const SEG_MAX_M = 50;

/** Walks every segment in roads.bin, split into pieces of at most SEG_MAX_M metres. */
function eachPiece(
  dv: DataView,
  fn: (ax: number, ay: number, bx: number, by: number, cls: number, lit: number) => void,
) {
  const ways = dv.getUint32(0, true);
  let off = 4;
  for (let w = 0; w < ways; w++) {
    const c = dv.getUint8(off);
    const l = dv.getUint8(off + 1);
    const n = dv.getUint16(off + 2, true);
    off += 4;
    let plat = dv.getInt32(off, true) / 1e5;
    let plon = dv.getInt32(off + 4, true) / 1e5;
    for (let i = 1; i < n; i++) {
      const lat = dv.getInt32(off + i * 8, true) / 1e5;
      const lon = dv.getInt32(off + i * 8 + 4, true) / 1e5;
      const len = Math.hypot((lon - plon) * M_PER_DEG_LON, (lat - plat) * M_PER_DEG_LAT);
      const k = Math.max(1, Math.ceil(len / SEG_MAX_M));
      for (let j = 0; j < k; j++) {
        fn(
          plon + ((lon - plon) * j) / k, plat + ((lat - plat) * j) / k,
          plon + ((lon - plon) * (j + 1)) / k, plat + ((lat - plat) * (j + 1)) / k,
          c, l,
        );
      }
      plat = lat;
      plon = lon;
    }
    off += n * 8;
  }
}

function loadRoads(file: string, bbox: [number, number, number, number], classes: string[]): Roads {
  const buf = fs.readFileSync(file);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let segs = 0;
  eachPiece(dv, () => segs++);
  const ax = new Float64Array(segs), ay = new Float64Array(segs);
  const bx = new Float64Array(segs), by = new Float64Array(segs);
  const mx = new Float64Array(segs), my = new Float64Array(segs);
  const cls = new Uint8Array(segs), lit = new Uint8Array(segs);
  let s = 0;
  eachPiece(dv, (x1, y1, x2, y2, c, l) => {
    ax[s] = x1; ay[s] = y1; bx[s] = x2; by[s] = y2;
    mx[s] = (x1 + x2) / 2; my[s] = (y1 + y2) / 2;
    cls[s] = c; lit[s] = l;
    s++;
  });
  return { ax, ay, bx, by, cls, lit, grid: new PointGrid(my, mx, bbox, 0.0008), classes };
}

/** Pieces are indexed by midpoint, so a query must widen its radius by half a piece. */
export const SEG_HALF_M = SEG_MAX_M / 2;

export interface Dataset {
  pois: Pois;
  poiGrid: PointGrid;
  roads: Roads;
  light: Light;
  meta: Meta;
}

let cached: Dataset | null = null;

export function dataset(): Dataset {
  if (cached) return cached;
  const dir = path.join(process.cwd(), "data");
  const meta: Meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
  const pois: Pois = JSON.parse(fs.readFileSync(path.join(dir, "pois.json"), "utf8"));
  const light: Light = JSON.parse(fs.readFileSync(path.join(dir, "light.json"), "utf8"));
  const poiGrid = new PointGrid(Float64Array.from(pois.lat), Float64Array.from(pois.lon), meta.bbox, 0.001);
  const roads = loadRoads(path.join(dir, "roads.bin"), meta.bbox, meta.roadClasses);
  cached = { pois, poiGrid, roads, light, meta };
  return cached;
}

/** Bilinear night radiance (nW/cm^2/sr) at a point; null outside the grid. */
export function radianceAt(light: Light, lon: number, lat: number): number | null {
  const fx = ((lon - light.west) / (light.east - light.west)) * light.width - 0.5;
  const fy = ((light.north - lat) / (light.north - light.south)) * light.height - 0.5;
  if (fx < -0.5 || fy < -0.5 || fx > light.width - 0.5 || fy > light.height - 0.5) return null;
  const x0 = Math.max(0, Math.min(light.width - 1, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(light.height - 1, Math.floor(fy)));
  const x1 = Math.min(light.width - 1, x0 + 1);
  const y1 = Math.min(light.height - 1, y0 + 1);
  const tx = Math.max(0, Math.min(1, fx - x0));
  const ty = Math.max(0, Math.min(1, fy - y0));
  const v = (x: number, y: number) => light.values[y * light.width + x];
  return (
    v(x0, y0) * (1 - tx) * (1 - ty) + v(x1, y0) * tx * (1 - ty) +
    v(x0, y1) * (1 - tx) * ty + v(x1, y1) * tx * ty
  );
}

/** Nearest point on a road whose class index (into meta.roadClasses) is in [minClass, maxClass], within maxM. */
export function nearestRoadPoint(
  ds: Dataset, p: [number, number], minClass: number, maxClass: number, maxM: number,
): [number, number] | null {
  const r = ds.roads;
  let best: [number, number] | null = null;
  let bestD = Infinity;
  r.grid.near(p[0], p[1], maxM + SEG_HALF_M, (id) => {
    if (r.cls[id] < minClass || r.cls[id] > maxClass) return;
    const ax = (r.ax[id] - p[0]) * M_PER_DEG_LON, ay = (r.ay[id] - p[1]) * M_PER_DEG_LAT;
    const bx = (r.bx[id] - p[0]) * M_PER_DEG_LON, by = (r.by[id] - p[1]) * M_PER_DEG_LAT;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const qx = ax + t * dx, qy = ay + t * dy;
    const d = Math.hypot(qx, qy);
    if (d < bestD && d <= maxM) {
      bestD = d;
      best = [p[0] + qx / M_PER_DEG_LON, p[1] + qy / M_PER_DEG_LAT];
    }
  });
  return best;
}
