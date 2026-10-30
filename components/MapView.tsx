"use client";

import maplibregl, { GeoJSONSource, LngLatLike, Map as MlMap, Marker } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef } from "react";
import type { LngLat } from "@/lib/geo";
import type { MetroOption } from "@/lib/metro";
import type { ScoredRoute } from "@/lib/score";
import type { Theme } from "@/lib/theme";
import { KIND_COLORS } from "./format";
const NCR_CENTER: LngLatLike = [77.2, 28.6];

interface Props {
  bbox: [number, number, number, number] | null;
  from: LngLat | null;
  to: LngLat | null;
  routes: ScoredRoute[];
  metro: MetroOption | null;
  selected: number;
  theme: Theme;
  onPick: (p: LngLat) => void;
  onMove: (which: "from" | "to", p: LngLat) => void;
  onSelect: (id: number) => void;
}

const empty: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

export default function MapView({ bbox, from, to, routes, metro, selected, theme, onPick, onMove, onSelect }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const ready = useRef(false);
  const markers = useRef<{ from?: Marker; to?: Marker }>({});
  const handlers = useRef({ onPick, onMove, onSelect });
  handlers.current = { onPick, onMove, onSelect };
  const latest = useRef({ routes, metro, selected, theme, bbox });
  latest.current = { routes, metro, selected, theme, bbox };
  const styleTheme = useRef<Theme | null>(null);

  useEffect(() => {
    if (!el.current || map.current) return;
    // The map only renders in the browser, where the boot script has already set the real theme.
    const initial: Theme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
    styleTheme.current = initial;
    latest.current.theme = initial;
    const m = new maplibregl.Map({
      container: el.current,
      style: STYLES[initial],
      center: NCR_CENTER,
      zoom: 9.3,
      attributionControl: { compact: true },
    });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    m.addControl(
      new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: false }),
      "top-right",
    );
    m.on("load", () => {
      addOverlays(m, latest.current.theme);
      applyCoverage(m, latest.current.bbox);

      m.on("click", "ride", () => handlers.current.onSelect(100));
      m.on("click", "routes-alt", (e) => {
        const id = e.features?.[0]?.properties?.id;
        if (id !== undefined) handlers.current.onSelect(Number(id));
      });
      m.on("mouseenter", "routes-alt", () => (m.getCanvas().style.cursor = "pointer"));
      m.on("mouseleave", "routes-alt", () => (m.getCanvas().style.cursor = ""));
      m.on("click", "places", (e) => {
        const f = e.features?.[0];
        if (!f) return;
        const p = f.properties as Record<string, string | boolean>;
        const status = p.open ? "Open" : "Closed";
        const basis =
          p.hours === "camera" ? "Mapped in OpenStreetMap (man_made=surveillance)"
          : p.hours === "tagged" ? `OSM hours: ${p.oh}`
          : "Hours not published; category default assumed";
        const line = p.hours === "camera" ? "CCTV camera" : `${p.label} · ${status} when you pass`;
        new maplibregl.Popup({ closeButton: false, offset: 8 })
          .setLngLat((f.geometry as GeoJSON.Point).coordinates as [number, number])
          .setDOMContent(popup(String(p.name || p.label), line, basis))
          .addTo(m);
      });
      m.on("mouseenter", "places", () => (m.getCanvas().style.cursor = "pointer"));
      m.on("mouseleave", "places", () => (m.getCanvas().style.cursor = ""));
      m.on("click", (e) => {
        const hits = m.queryRenderedFeatures(e.point, { layers: ["places", "routes-alt", "ride"] });
        if (!hits.length) handlers.current.onPick([e.lngLat.lng, e.lngLat.lat]);
      });

      ready.current = true;
      draw(m, latest.current.routes, latest.current.metro, latest.current.selected, latest.current.theme);
    });
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
      ready.current = false;
    };
  }, []);

  useEffect(() => {
    const m = map.current;
    if (m && ready.current) applyCoverage(m, bbox);
  }, [bbox]);

  // Theme change: swap the basemap, then put Rasta's layers back on top of it.
  useEffect(() => {
    const m = map.current;
    // <html data-theme> is updated before React state, so it is the reliable value on first mount.
    const actual: Theme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
    if (!m || styleTheme.current === actual) return;
    styleTheme.current = actual;
    ready.current = false;
    m.setStyle(STYLES[actual]);
    m.once("style.load", () => {
      const l = latest.current;
      addOverlays(m, l.theme);
      applyCoverage(m, l.bbox);
      draw(m, l.routes, l.metro, l.selected, l.theme);
      ready.current = true;
    });
  }, [theme]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    for (const which of ["from", "to"] as const) {
      const p = which === "from" ? from : to;
      const existing = markers.current[which];
      if (!p) {
        existing?.remove();
        markers.current[which] = undefined;
        continue;
      }
      if (existing) {
        existing.setLngLat(p);
      } else {
        const node = document.createElement("div");
        node.className = `pin pin-${which}`;
        node.textContent = which === "from" ? "A" : "B";
        const mk = new maplibregl.Marker({ element: node, draggable: true }).setLngLat(p).addTo(m);
        mk.on("dragend", () => {
          const ll = mk.getLngLat();
          handlers.current.onMove(which, [ll.lng, ll.lat]);
        });
        markers.current[which] = mk;
      }
    }
    if (from && to && !routes.length) {
      m.fitBounds(new maplibregl.LngLatBounds(from, from).extend(to), { padding: 80, maxZoom: 15, duration: 600 });
    } else if (from && !to) {
      m.easeTo({ center: from, zoom: Math.max(m.getZoom(), 13) });
    }
  }, [from, to, routes.length]);

  useEffect(() => {
    const m = map.current;
    if (!m || !ready.current) return;
    draw(m, routes, metro, selected, theme);
  }, [routes, metro, selected, theme]);

  useEffect(() => {
    const m = map.current;
    if (!m || !routes.length) return;
    const b = new maplibregl.LngLatBounds();
    for (const r of routes) for (const c of r.coords) b.extend(c);
    for (const l of metro?.legs ?? []) for (const c of l.coords) b.extend(c);
    for (const sg of metro?.ride.segments ?? []) for (const c of sg.coords) b.extend(c);
    m.fitBounds(b, { padding: { top: 60, bottom: 60, left: 60, right: 60 }, maxZoom: 16, duration: 700 });
  }, [routes, metro]);

  return <div ref={el} className="map" />;
}

/** Basemaps from OpenFreeMap: a dark one, and Positron, a quiet light one that keeps overlays readable. */
const STYLES: Record<Theme, string> = {
  dark: "https://tiles.openfreemap.org/styles/dark",
  light: "https://tiles.openfreemap.org/styles/positron",
};

const OVERLAY: Record<Theme, Record<string, string>> = {
  dark: { coverage: "#f5b942", alt: "#6b7480", casing: "#0b0d10", selected: "#e8eaed", hole: "#0e1116", label: "#e8eaed", gap: "#ff4d40" },
  light: { coverage: "#a85b06", alt: "#a3abb6", casing: "#ffffff", selected: "#1f2a37", hole: "#ffffff", label: "#121821", gap: "#e0362b" },
};

/** Sources and layers Rasta draws on top of the basemap. setStyle() drops them, so this re-runs per style. */
function addOverlays(m: MlMap, theme: Theme) {
  if (m.getSource("routes")) return; // already on this style (initial load and style.load can both fire)
  const c = OVERLAY[theme];
    m.addSource("routes", { type: "geojson", data: empty });
    m.addSource("gaps", { type: "geojson", data: empty });
    m.addSource("places", { type: "geojson", data: empty });
    m.addSource("coverage", { type: "geojson", data: empty });
    m.addSource("ride", { type: "geojson", data: empty });

    m.addLayer({
      id: "coverage", type: "line", source: "coverage",
      paint: { "line-color": c.coverage, "line-opacity": 0.5, "line-width": 1, "line-dasharray": [4, 4] },
    });
    m.addLayer({
      id: "routes-alt", type: "line", source: "routes", filter: ["!=", ["get", "selected"], true],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": c.alt, "line-width": 5, "line-opacity": 0.8 },
    });
    m.addLayer({
      id: "routes-casing", type: "line", source: "routes", filter: ["==", ["get", "selected"], true],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": c.casing, "line-width": 9 },
    });
    m.addLayer({
      id: "routes-sel", type: "line", source: "routes", filter: ["==", ["get", "selected"], true],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": c.selected, "line-width": 5 },
    });
    m.addLayer({
      id: "ride", type: "line", source: "ride", filter: ["==", ["geometry-type"], "LineString"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["get", "colour"],
        "line-width": ["case", ["get", "selected"], 5, 3],
        "line-opacity": ["case", ["get", "selected"], 1, 0.4],
      },
    });
    m.addLayer({
      id: "ride-stations", type: "circle", source: "ride", filter: ["==", ["geometry-type"], "Point"],
      paint: {
        "circle-radius": 5, "circle-color": c.hole,
        "circle-stroke-color": ["get", "colour"], "circle-stroke-width": 2.5,
        "circle-opacity": ["case", ["get", "selected"], 1, 0.4],
        "circle-stroke-opacity": ["case", ["get", "selected"], 1, 0.4],
      },
    });
    m.addLayer({
      id: "ride-labels", type: "symbol", source: "ride", minzoom: 11,
      filter: ["all", ["==", ["geometry-type"], "Point"], ["==", ["get", "selected"], true]],
      layout: {
        "text-field": ["get", "name"], "text-font": ["Noto Sans Regular"], "text-size": 12,
        "text-offset": [0, 1.1], "text-anchor": "top",
      },
      paint: { "text-color": c.label, "text-halo-color": c.hole, "text-halo-width": 1.5 },
    });
    m.addLayer({
      id: "gaps", type: "line", source: "gaps",
      layout: { "line-cap": "butt", "line-join": "round" },
      paint: { "line-color": c.gap, "line-width": 5, "line-dasharray": [1, 1] },
    });
    m.addLayer({
      id: "places", type: "circle", source: "places", minzoom: 11,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 2.5, 15, 6],
        "circle-color": ["case", ["get", "open"], ["get", "color"], c.hole],
        "circle-stroke-color": ["get", "color"],
        "circle-stroke-width": ["case", ["get", "open"], 0.5, 1.5],
        "circle-opacity": ["case", ["get", "open"], 1, 0.8],
      },
    });
}

function applyCoverage(m: MlMap, bbox: [number, number, number, number] | null) {
  if (!bbox) return;
  const [w, s, e, n] = bbox;
  (m.getSource("coverage") as GeoJSONSource | undefined)?.setData({
    type: "Feature", properties: {},
    geometry: { type: "LineString", coordinates: [[w, s], [e, s], [e, n], [w, n], [w, s]] },
  });
}

function popup(title: string, line: string, note: string): HTMLElement {
  const root = document.createElement("div");
  root.className = "popup";
  const t = document.createElement("strong");
  t.textContent = title;
  const l = document.createElement("div");
  l.textContent = line;
  const n = document.createElement("div");
  n.className = "popup-note";
  n.textContent = note;
  root.append(t, l, n);
  return root;
}

const KIND_LABEL: Record<string, string> = {
  hospital: "Hospital", police: "Police", fuel: "Petrol pump", pharmacy: "Pharmacy", food: "Food",
  grocery: "Grocery", shop: "Shop", mall: "Mall", hotel: "Hotel", atm: "ATM", metro: "Station",
};

function draw(m: MlMap, routes: ScoredRoute[], metro: MetroOption | null, selected: number, theme: Theme) {
  const kindColor = KIND_COLORS[theme];
  const metroSel = metro !== null && selected === metro.id;
  // The metro option's walking legs are drawn like routes, all under the metro option's id.
  const lines = [...routes, ...(metro?.legs.map((l) => ({ ...l, id: metro.id })) ?? [])];
  const focus = lines.filter((r) => r.id === selected);
  // Draw the selected route last so it sits on top of the alternatives.
  const ordered = [...lines].sort((a, b) => Number(a.id === selected) - Number(b.id === selected));
  (m.getSource("routes") as GeoJSONSource).setData({
    type: "FeatureCollection",
    features: ordered.map((r) => ({
      type: "Feature",
      properties: { id: r.id, selected: r.id === selected },
      geometry: { type: "LineString", coordinates: r.coords },
    })),
  });
  (m.getSource("ride") as GeoJSONSource).setData({
    type: "FeatureCollection",
    features: (metro?.ride.segments ?? []).flatMap((sg) => [
      {
        type: "Feature" as const,
        properties: { colour: sg.colour, selected: metroSel },
        geometry: { type: "LineString" as const, coordinates: sg.coords },
      },
      ...[
        { name: sg.from, at: sg.coords[0] },
        { name: sg.to, at: sg.coords[sg.coords.length - 1] },
      ].map((st) => ({
        type: "Feature" as const,
        properties: { colour: sg.colour, selected: metroSel, name: st.name },
        geometry: { type: "Point" as const, coordinates: st.at },
      })),
    ]),
  });
  (m.getSource("gaps") as GeoJSONSource).setData({
    type: "FeatureCollection",
    features: focus.flatMap((sel) => sel.gaps).map((g) => ({
      type: "Feature", properties: { length: g.length },
      geometry: { type: "LineString", coordinates: g.coords },
    })),
  });
  const places = focus.flatMap((sel) => [
    ...sel.places,
    ...sel.help.filter((h) => !sel.places.some((p) => p.lon === h.lon && p.lat === h.lat)),
  ]);
  (m.getSource("places") as GeoJSONSource).setData({
    type: "FeatureCollection",
    features: [
      ...places.map((p) => ({
        type: "Feature" as const,
        properties: {
          name: p.name, label: KIND_LABEL[p.kind] ?? p.kind, open: p.open, hours: p.hours, oh: p.oh ?? "",
          color: kindColor[p.kind] ?? kindColor.atm,
        },
        geometry: { type: "Point" as const, coordinates: [p.lon, p.lat] },
      })),
      ...focus.flatMap((sel) => sel.cameras).map((c) => ({
        type: "Feature" as const,
        properties: { name: "CCTV camera", label: "Camera", open: true, hours: "camera", oh: "", color: kindColor.camera },
        geometry: { type: "Point" as const, coordinates: c },
      })),
    ],
  });
}
