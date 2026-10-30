"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Meta } from "@/lib/data";
import type { LngLat } from "@/lib/geo";
import type { Mode } from "@/lib/routing";
import type { Component, ScoredRoute } from "@/lib/score";
import { COMPONENT_LABEL, KIND_COLOR, LEGEND, fmtDistance, fmtDuration, scoreColor, summary } from "./format";
import PlaceSearch, { Picked, reverseGeocode } from "./PlaceSearch";

const MapView = dynamic(() => import("./MapView"), { ssr: false, loading: () => <div className="map" /> });

interface ApiResult {
  mode: Mode;
  depart: string;
  routes: ScoredRoute[];
}

/** Wall-clock presets in IST; each resolves to its next occurrence. */
const PRESETS = [
  { id: "now", label: "Now" },
  { id: "21", label: "9 pm" },
  { id: "23", label: "11 pm" },
  { id: "1", label: "1 am" },
] as const;
type Preset = (typeof PRESETS)[number]["id"] | "custom";

const IST_MS = 330 * 60_000;

function nextIst(hour: number): Date {
  const now = Date.now();
  const ist = new Date(now + IST_MS);
  const target = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), hour) - IST_MS;
  return new Date(target > now ? target : target + 86_400_000);
}

function istInputValue(d: Date): string {
  return new Date(d.getTime() + IST_MS).toISOString().slice(0, 16);
}

function fmtIst(iso: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata", weekday: "short", hour: "numeric", minute: "2-digit",
  }).format(new Date(iso));
}

export default function App() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [from, setFrom] = useState<Picked | null>(null);
  const [to, setTo] = useState<Picked | null>(null);
  const [mode, setMode] = useState<Mode>("walk");
  const [preset, setPreset] = useState<Preset>("now");
  const [custom, setCustom] = useState(() => istInputValue(nextIst(23)));
  const [result, setResult] = useState<ApiResult | null>(null);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [about, setAbout] = useState(false);

  useEffect(() => {
    fetch("/api/meta").then((r) => r.json()).then(setMeta).catch(() => setMeta(null));
  }, []);

  const depart = useMemo(() => {
    if (preset === "now") return null;
    if (preset === "custom") return `${custom}:00+05:30`;
    return nextIst(Number(preset)).toISOString();
  }, [preset, custom]);

  // Keep the custom picker showing the time actually being scored.
  useEffect(() => {
    if (preset !== "custom") setCustom(istInputValue(depart ? new Date(depart) : new Date()));
  }, [preset, depart]);

  useEffect(() => {
    if (!from || !to) {
      setResult(null);
      return;
    }
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    fetch("/api/routes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: from.point, to: to.point, mode, depart: depart ?? new Date().toISOString() }),
      signal: ac.signal,
    })
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error ?? `Request failed (${r.status})`);
        return body as ApiResult;
      })
      .then((body) => {
        setResult(body);
        const best = [...body.routes].sort((a, b) => (b.score ?? -1) - (a.score ?? -1))[0];
        setSelected(best?.id ?? 0);
        setLoading(false);
      })
      .catch((e: Error) => {
        if (e.name === "AbortError") return;
        setResult(null);
        setError(e.message);
        setLoading(false);
      });
    return () => ac.abort();
  }, [from, to, mode, depart]);

  const pickOnMap = useCallback(
    async (p: LngLat) => {
      const which = !from ? "from" : !to ? "to" : null;
      if (!which) return;
      const set = which === "from" ? setFrom : setTo;
      set({ label: "Locating…", point: p });
      set({ label: await reverseGeocode(p), point: p });
    },
    [from, to],
  );

  const moveMarker = useCallback(async (which: "from" | "to", p: LngLat) => {
    const set = which === "from" ? setFrom : setTo;
    set({ label: await reverseGeocode(p), point: p });
  }, []);

  const useMyLocation = () => {
    if (!navigator.geolocation) {
      setError("This browser does not share location.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const p: LngLat = [pos.coords.longitude, pos.coords.latitude];
        setFrom({ label: await reverseGeocode(p), point: p });
      },
      () => setError("Location permission was denied."),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  };

  const routes = result?.routes ?? [];
  const fastest = routes.length ? Math.min(...routes.map((r) => r.duration)) : 0;
  const bestScore = routes.length ? Math.max(...routes.map((r) => r.score ?? -1)) : 0;
  const sel = routes.find((r) => r.id === selected);

  return (
    <div className="app">
      <aside className="panel">
        <header className="brand">
          <h1>Rasta</h1>
          <p>
            Compare routes across Gurgaon and Noida by how open, lit and busy they are at the hour you travel. Not
            just the fastest way: the one with people around.
          </p>
        </header>

        <section className="controls" aria-label="Trip">
          <div className="places">
            <PlaceSearch
              label="From" marker="A" value={from} bbox={meta?.bbox ?? null}
              placeholder="From: office, metro station, sector…" onPick={setFrom}
            />
            <PlaceSearch
              label="To" marker="B" value={to} bbox={meta?.bbox ?? null}
              placeholder="To: home, PG, hotel…" onPick={setTo}
            />
            <div className="place-actions">
              <button type="button" className="link" onClick={useMyLocation}>Use my location as A</button>
              <button
                type="button" className="link" disabled={!from && !to}
                onClick={() => {
                  setFrom(to);
                  setTo(from);
                }}
              >
                Swap A and B
              </button>
            </div>
          </div>

          <div className="row">
            <div className="seg" role="radiogroup" aria-label="Travel mode">
              {(["walk", "drive"] as const).map((m) => (
                <button
                  key={m} type="button" role="radio" aria-checked={mode === m}
                  className={mode === m ? "on" : ""} onClick={() => setMode(m)}
                >
                  {m === "walk" ? "Walking" : "Cab / driving"}
                </button>
              ))}
            </div>
          </div>

          <div className="row time">
            <span className="row-label">Leaving</span>
            <div className="chips">
              {PRESETS.map((p) => (
                <button
                  key={p.id} type="button" className={preset === p.id ? "chip on" : "chip"}
                  onClick={() => setPreset(p.id)}
                >
                  {p.label}
                </button>
              ))}
              <input
                type="datetime-local" aria-label="Custom departure time (IST)"
                className={preset === "custom" ? "on" : ""} value={custom}
                onChange={(e) => {
                  setCustom(e.target.value);
                  setPreset("custom");
                }}
              />
            </div>
          </div>
        </section>

        <section className="results" aria-live="polite">
          {!from || !to ? (
            <div className="hint">
              <p>Search for two places, or tap the map to drop A, then B. Drag the pins to adjust.</p>
              <p className="muted">
                Covers Gurgaon, Noida, Greater Noida West and the South and East Delhi stretch between them (the
                dashed box on the map).
              </p>
            </div>
          ) : loading ? (
            <div className="hint">Finding routes and checking what is open along each…</div>
          ) : error ? (
            <div className="error">{error}</div>
          ) : result ? (
            <>
              <div className="results-head">
                <span>{routes.length} route{routes.length === 1 ? "" : "s"}</span>
                <span className="muted">scored for {fmtIst(result.depart)} IST</span>
              </div>
              <ol className="cards">
                {routes.map((r) => {
                  const isSel = r.id === selected;
                  const tags = [
                    r.duration === fastest && "Fastest",
                    r.score === bestScore && routes.length > 1 && "Highest night score",
                  ].filter(Boolean) as string[];
                  return (
                    <li key={r.id}>
                      <button
                        type="button" className={isSel ? "card sel" : "card"}
                        aria-pressed={isSel} onClick={() => setSelected(r.id)}
                      >
                        <div className="score" style={{ color: scoreColor(r.score), borderColor: scoreColor(r.score) }}>
                          <span>{r.score ?? "–"}</span>
                          <small>night score</small>
                        </div>
                        <div className="card-main">
                          <div className="card-top">
                            <strong>{fmtDuration(r.duration)}</strong>
                            <span className="muted">{fmtDistance(r.distance)}</span>
                            {r.duration > fastest + 30 && (
                              <span className="muted">+{Math.round((r.duration - fastest) / 60)} min</span>
                            )}
                          </div>
                          {r.via && <div className="via">via {r.via}</div>}
                          <div className="tags">
                            {tags.map((t) => <span key={t} className="tag">{t}</span>)}
                          </div>
                        </div>
                      </button>
                      {isSel && <Breakdown r={r} mode={result.mode} />}
                    </li>
                  );
                })}
              </ol>
              <p className="disclaimer">
                Rasta compares routes using public data; it cannot see what is happening on a street tonight. Use it
                to weigh options, not as a guarantee. In an emergency call <a href="tel:112">112</a>.
              </p>
            </>
          ) : null}
        </section>

        <footer className="foot">
          <button type="button" className="link" onClick={() => setAbout((a) => !a)}>
            {about ? "Hide" : "How the score works and where the data comes from"}
          </button>
          {about && <About meta={meta} />}
          <div className="helplines">
            Emergency <a href="tel:112">112</a> · Women helpline <a href="tel:181">181</a> · UP Women Power Line{" "}
            <a href="tel:1090">1090</a>
          </div>
        </footer>
      </aside>

      <main className="stage">
        <MapView
          bbox={meta?.bbox ?? null}
          from={from?.point ?? null}
          to={to?.point ?? null}
          routes={routes}
          selected={selected}
          onPick={pickOnMap}
          onMove={moveMarker}
          onSelect={setSelected}
        />
        {sel && (
          <div className="legend" aria-label="Map legend">
            {LEGEND.map((l) => (
              <span key={l.kind}>
                <i style={{ background: KIND_COLOR[l.kind] }} />
                {l.label}
              </span>
            ))}
            <span><i className="hollow" />Closed then</span>
            <span><i className="gap" />Nothing open</span>
          </div>
        )}
      </main>
    </div>
  );
}

function Breakdown({ r, mode }: { r: ScoredRoute; mode: Mode }) {
  const order: Component[] = ["activity", "gaps", "light", "roads", "help", "cameras", "transit"];
  const s = r.stats;
  return (
    <div className="breakdown">
      <ul className="facts">
        {summary(r).map((line) => <li key={line}>{line}</li>)}
      </ul>
      <table className="bars">
        <tbody>
          {order
            .filter((k) => !(k === "transit" && mode === "drive"))
            .map((k) => {
              const v = r.components[k];
              const w = r.weights[k];
              return (
                <tr key={k} title={COMPONENT_LABEL[k].help}>
                  <th scope="row">{COMPONENT_LABEL[k].label}</th>
                  <td className="bar-cell">
                    {v === null ? (
                      <span className="nodata">no data here</span>
                    ) : (
                      <span className="bar"><span style={{ width: `${Math.round(v * 100)}%` }} /></span>
                    )}
                  </td>
                  <td className="num">{v === null ? "" : Math.round(v * 100)}</td>
                  <td className="num muted">{w ? `×${Math.round(w * 100)}%` : ""}</td>
                </tr>
              );
            })}
        </tbody>
      </table>
      <p className="note">
        {s.openPlaces + s.closedPlaces - s.assumedHours} of {s.openPlaces + s.closedPlaces} places along this route
        publish opening hours in OpenStreetMap; the rest use category defaults (e.g. eateries 11 am–11 pm), so treat
        their open/closed state as an estimate. Tap any pin for details.
      </p>
    </div>
  );
}

function About({ meta }: { meta: Meta | null }) {
  return (
    <div className="about">
      <h2>What the night score measures</h2>
      <p>
        Each route is sampled every 15 m (walking) or 25 m (driving). At each point Rasta checks, for the time you
        would actually reach it:
      </p>
      <ul>
        <li><b>Open places</b> within 45 m (walking) or 70 m (driving): eateries, grocery stores, chemists, petrol pumps, hospitals, police, hotels, malls, stations.</li>
        <li><b>Empty stretches</b>: the longest run with nothing open, counted in full if dark and at half if well lit.</li>
        <li><b>Light</b> from NASA's VIIRS night-time radiance, plus OSM <code>lit</code> tags and mapped street lamps.</li>
        <li><b>Road type</b> from OpenStreetMap: main roads over internal lanes, service roads and tracks.</li>
        <li><b>Help nearby</b>: an open hospital or police station within 500 m (walking) or 1 km (driving).</li>
        <li><b>CCTV</b> mapped in OSM, and <b>transit points</b> for walking routes.</li>
      </ul>
      <p>
        Walking and driving use different weights; each route card shows them. Methodology and all thresholds are in
        the project README.
      </p>
      <h2>Data</h2>
      <ul>
        <li>
          Roads, hours, cameras, lamps: © OpenStreetMap contributors (ODbL), extracts of{" "}
          {meta ? Object.values(meta.osmExtracts)[0] : "…"}.
        </li>
        <li>Places: Overture Maps Foundation, release {meta?.overtureRelease ?? "…"} (confidence ≥ {meta?.overtureMinConfidence ?? 0.65}).</li>
        <li>
          Night light: NASA Black Marble VNP46A2/VJ146A2 via NASA GIBS, median of {meta?.lightNights.length ?? 30}{" "}
          satellite passes up to {meta?.lightNights[0]?.split(":")[1] ?? "…"}.
        </li>
        <li>Routing: OSRM on FOSSGIS servers. Search: Photon by komoot. Map: OpenFreeMap.</li>
      </ul>
      <h2>Known limits</h2>
      <ul>
        <li>Most places in NCR do not publish hours, so many open/closed states are category defaults.</li>
        <li>Satellite light is ~500 m per pixel and saturates in bright sectors: good at spotting dark belts (the Aravallis, the Yamuna floodplain), not single dark lanes.</li>
        <li>CCTV mapping is dense in central Delhi and sparse in Gurgaon and Noida; where none is mapped, that factor is left out rather than scored as zero.</li>
        <li>Public holidays are not modelled.</li>
      </ul>
    </div>
  );
}
