import { LngLat, haversine, simplify } from "./geo";

/** Google's encoded-polyline format (precision 5), readable by most mapping tools. */
export function encodePolyline(coords: LngLat[]): string {
  let out = "";
  let plat = 0, plon = 0;
  const enc = (v: number) => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    let s = "";
    while (n >= 0x20) {
      s += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
      n >>= 5;
    }
    return s + String.fromCharCode(n + 63);
  };
  for (const [lon, lat] of coords) {
    const la = Math.round(lat * 1e5), lo = Math.round(lon * 1e5);
    out += enc(la - plat) + enc(lo - plon);
    plat = la;
    plon = lo;
  }
  return out;
}

/**
 * The route's shape without its ends: every point within `trimM` metres of the start or end (along
 * the route or in a straight line) is dropped, so a row never shows where someone starts or ends. Simplified to ~25 m so it fits in a sheet cell.
 */
export function anonymisedPath(coords: LngLat[], trimM = 400): string {
  if (coords.length < 2) return "";
  const at: number[] = [0];
  for (let i = 1; i < coords.length; i++) at.push(at[i - 1] + haversine(coords[i - 1], coords[i]));
  const total = at[at.length - 1];
  if (total < trimM * 2 + 200) return "";
  // Both along the route and as the crow flies, so a winding start cannot leave a point near home.
  const start = coords[0], end = coords[coords.length - 1];
  const mid = coords.filter((p, i) =>
    at[i] >= trimM && at[i] <= total - trimM && haversine(p, start) >= trimM && haversine(p, end) >= trimM);
  return mid.length >= 2 ? encodePolyline(simplify(mid, 25)) : "";
}
