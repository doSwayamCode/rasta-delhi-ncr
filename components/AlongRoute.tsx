"use client";

import type { ScoredRoute } from "@/lib/score";

const SHOP_KINDS = new Set(["shop", "grocery", "food", "pharmacy", "mall", "fuel"]);

/**
 * "Rush" is an estimate, not live crowd data: open places per km beside the route, plus how many
 * major bus routes run along it. Thresholds are deliberately coarse (Quiet / Some / Busy).
 */
export function rushLevel(r: ScoredRoute): { label: string; detail: string } {
  const km = Math.max(0.3, r.distance / 1000);
  const openPerKm = r.stats.openPlaces / km;
  const buses = r.buses.length;
  const level = openPerKm >= 10 || (openPerKm >= 6 && buses >= 3) ? "Busy" : openPerKm >= 3 || buses >= 2 ? "Some people" : "Quiet";
  return { label: level, detail: `${openPerKm.toFixed(1)} open places per km · ${buses} bus route${buses === 1 ? "" : "s"}` };
}

function lightLabel(r: ScoredRoute) {
  const l = r.components.light ?? 0;
  return l >= 0.8 ? "Well lit" : l >= 0.5 ? "Partly lit" : "Dark";
}

/** One panel for the questions people ask about a route at night. */
export default function AlongRoute({ r }: { r: ScoredRoute }) {
  const s = r.stats;
  const openShops = r.places.filter((p) => p.open && SHOP_KINDS.has(p.kind)).length;
  const rush = rushLevel(r);
  return (
    <section className="along" aria-label="Along this route">
      <h3>Along this route</h3>
      <div className="along-tiles">
        <div className="along-tile">
          <span className="along-k">Street lights</span>
          <b>{lightLabel(r)}</b>
          <span className="along-d">
            {s.lamps} lamp{s.lamps === 1 ? "" : "s"} mapped · {Math.round(s.litTaggedShare * 100)}% of the way tagged lit · NASA
            night light: {s.meanRadiance >= 30 ? "bright" : s.meanRadiance >= 15 ? "moderate" : "dim"}
          </span>
        </div>
        <div className="along-tile" title="Estimate from open places and bus routes, not live crowd data">
          <span className="along-k">Rush (estimate)</span>
          <b>{rush.label}</b>
          <span className="along-d">{rush.detail}</span>
        </div>
        <div className="along-tile">
          <span className="along-k">CCTV</span>
          <b>{r.components.cameras === null ? "Not mapped" : s.cameras}</b>
          <span className="along-d">
            {r.components.cameras === null ? "No cameras mapped nearby in OpenStreetMap" : "cameras mapped beside the route"}
          </span>
        </div>
        <div className="along-tile">
          <span className="along-k">Open shops</span>
          <b>{openShops}</b>
          <span className="along-d">shops, eateries, chemists and pumps open when you pass</span>
        </div>
      </div>
      {r.buses.length > 0 && (
        <div className="along-buses">
          <span className="along-k">Buses along the way</span>
          <div className="bus-chips">
            {r.buses.map((b) => (
              <span key={b.ref} className="bus-chip" title={`${b.name} · runs along ${(b.along / 1000).toFixed(1)} km of this route`}>
                {b.ref}
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
