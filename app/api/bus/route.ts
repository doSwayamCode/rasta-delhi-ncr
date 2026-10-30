import { dataset } from "@/lib/data";

export const runtime = "nodejs";

/** Major bus routes as GeoJSON for the map's optional "Bus routes" layer. */
export function GET() {
  const { buses } = dataset();
  const features = buses.ways.map((coords, i) => ({
    type: "Feature" as const,
    properties: { refs: [...new Set(buses.routesOfWay[i].map((r) => buses.routes[r].ref).filter(Boolean))].join(" · ") },
    geometry: { type: "LineString" as const, coordinates: coords },
  }));
  return Response.json(
    { type: "FeatureCollection", features },
    { headers: { "Cache-Control": "public, max-age=86400" } },
  );
}
