import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { M_PER_DEG_LAT, M_PER_DEG_LON, pointSegDist } from "./geo";

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

/**
 * Road segments from roads.bin.gz. Vertices are shared Float32 arrays (~0.5 m precision here) and
 * every segment is registered in each grid cell its bounding box touches, so long expressway
 * segments need no splitting. This keeps all of NCR's ~5M road vertices in well under 100 MB.
 */
export class Roads {
  readonly lon: Float32Array;
  readonly lat: Float32Array;
  /** Segment i runs from vertex seg[i] to vertex seg[i] + 1. */
  readonly seg: Int32Array;
  readonly cls: Uint8Array;
  readonly lit: Uint8Array;
  private start: Int32Array;
  private ids: Int32Array;
  private cols: number;
  private rows: number;
  private stamp: Int32Array;
  private query = 0;
  private static CELL = 0.001;

  constructor(raw: Buffer, readonly bbox: [number, number, number, number], readonly classes: string[]) {
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const ways = dv.getUint32(0, true);
    let off = 4, verts = 0, segs = 0;
    for (let w = 0; w < ways; w++) {
      const n = dv.getUint16(off + 2, true);
      verts += n;
      segs += n - 1;
      off += 4 + n * 8;
    }
    this.lon = new Float32Array(verts);
    this.lat = new Float32Array(verts);
    this.seg = new Int32Array(segs);
    this.cls = new Uint8Array(segs);
    this.lit = new Uint8Array(segs);
    off = 4;
    let v = 0, s = 0;
    for (let w = 0; w < ways; w++) {
      const c = dv.getUint8(off), l = dv.getUint8(off + 1), n = dv.getUint16(off + 2, true);
      off += 4;
      for (let i = 0; i < n; i++, v++) {
        this.lat[v] = dv.getInt32(off + i * 8, true) / 1e5;
        this.lon[v] = dv.getInt32(off + i * 8 + 4, true) / 1e5;
        if (i > 0) {
          this.seg[s] = v - 1;
          this.cls[s] = c;
          this.lit[s] = l;
          s++;
        }
      }
      off += n * 8;
    }

    const C = Roads.CELL;
    this.cols = Math.ceil((bbox[2] - bbox[0]) / C) + 1;
    this.rows = Math.ceil((bbox[3] - bbox[1]) / C) + 1;
    const counts = new Int32Array(this.cols * this.rows + 1);
    const visit = (i: number, fn: (cell: number) => void) => {
      const a = this.seg[i];
      const x0 = this.cx(Math.min(this.lon[a], this.lon[a + 1])), x1 = this.cx(Math.max(this.lon[a], this.lon[a + 1]));
      const y0 = this.cy(Math.min(this.lat[a], this.lat[a + 1])), y1 = this.cy(Math.max(this.lat[a], this.lat[a + 1]));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) fn(y * this.cols + x);
    };
    for (let i = 0; i < segs; i++) visit(i, (c) => counts[c + 1]++);
    for (let c = 1; c < counts.length; c++) counts[c] += counts[c - 1];
    this.start = counts;
    this.ids = new Int32Array(counts[counts.length - 1]);
    const fill = counts.slice();
    for (let i = 0; i < segs; i++) visit(i, (c) => (this.ids[fill[c]++] = i));
    this.stamp = new Int32Array(segs);
  }

  private cx(lon: number) {
    return Math.max(0, Math.min(this.cols - 1, Math.floor((lon - this.bbox[0]) / Roads.CELL)));
  }

  private cy(lat: number) {
    return Math.max(0, Math.min(this.rows - 1, Math.floor((lat - this.bbox[1]) / Roads.CELL)));
  }

  get segments() {
    return this.seg.length;
  }

  /**
   * Calls fn(segment, distanceM, axM, ayM, bxM, byM) once for every segment within radiusM, with
   * endpoints in planar metres relative to (lon, lat).
   */
  near(
    lon: number, lat: number, radiusM: number,
    fn: (id: number, d: number, ax: number, ay: number, bx: number, by: number) => void,
  ) {
    const q = ++this.query;
    const dLon = radiusM / M_PER_DEG_LON, dLat = radiusM / M_PER_DEG_LAT;
    for (let y = this.cy(lat - dLat); y <= this.cy(lat + dLat); y++) {
      for (let x = this.cx(lon - dLon); x <= this.cx(lon + dLon); x++) {
        const c = y * this.cols + x;
        for (let k = this.start[c]; k < this.start[c + 1]; k++) {
          const id = this.ids[k];
          if (this.stamp[id] === q) continue;
          this.stamp[id] = q;
          const a = this.seg[id];
          const ax = (this.lon[a] - lon) * M_PER_DEG_LON, ay = (this.lat[a] - lat) * M_PER_DEG_LAT;
          const bx = (this.lon[a + 1] - lon) * M_PER_DEG_LON, by = (this.lat[a + 1] - lat) * M_PER_DEG_LAT;
          const d = pointSegDist(0, 0, ax, ay, bx, by);
          if (d <= radiusM) fn(id, d, ax, ay, bx, by);
        }
      }
    }
  }
}

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
  const pois: Pois = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, "pois.json.gz"))).toString("utf8"));
  const light: Light = JSON.parse(fs.readFileSync(path.join(dir, "light.json"), "utf8"));
  const poiGrid = new PointGrid(Float64Array.from(pois.lat), Float64Array.from(pois.lon), meta.bbox, 0.001);
  const roads = new Roads(zlib.gunzipSync(fs.readFileSync(path.join(dir, "roads.bin.gz"))), meta.bbox, meta.roadClasses);
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
  r.near(p[0], p[1], maxM, (id, _d, ax, ay, bx, by) => {
    if (r.cls[id] < minClass || r.cls[id] > maxClass) return;
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
