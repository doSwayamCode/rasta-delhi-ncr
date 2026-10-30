"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { LABELS } from "@/lib/feedback";

type Row = Record<string, string | number | boolean | null>;
type State =
  | { kind: "loading" }
  | { kind: "login"; error?: string }
  | { kind: "error"; message: string }
  | { kind: "ready"; rows: Row[]; source: string; at: Date };

const COLUMNS: [string, string][] = [
  ["submitted_at", "Submitted (IST)"], ["mode", "Mode"], ["depart_ist", "Departure (IST)"],
  ["from_area", "From (~1 km)"], ["to_area", "To (~1 km)"], ["routes_shown", "Routes"],
  ["chosen", "Chose"], ["chosen_score", "Score"], ["chosen_is_fastest", "Fastest?"],
  ["chosen_is_highest_score", "Highest score?"], ["priority", "Priority"], ["area_feel", "Area at night"],
];

const ist = (iso: unknown) => {
  const t = Date.parse(String(iso));
  return Number.isNaN(t)
    ? String(iso ?? "")
    : new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }).format(t);
};

const chosenLabel = (v: unknown) =>
  v === "metro" ? "Walk + metro" : v === "none" ? "None" : /^r\d$/.test(String(v)) ? `Route ${Number(String(v).slice(1)) + 1}` : String(v ?? "");

function count(rows: Row[], key: string) {
  const m = new Map<string, number>();
  for (const r of rows) {
    const v = r[key];
    if (v === null || v === undefined || v === "") continue;
    m.set(String(v), (m.get(String(v)) ?? 0) + 1);
  }
  return [...m].sort((a, b) => b[1] - a[1]);
}

function Bars({ title, data, total }: { title: string; data: [string, number][]; total: number }) {
  return (
    <section className="admin-card">
      <h3>{title}</h3>
      {data.length === 0 ? <p className="muted">No answers yet.</p> : (
        <table className="bars">
          <tbody>
            {data.map(([k, n]) => (
              <tr key={k}>
                <th scope="row">{LABELS[k] ?? k}</th>
                <td className="bar-cell"><span className="bar"><span style={{ width: `${(n / Math.max(1, total)) * 100}%` }} /></span></td>
                <td className="num">{n}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export default function AdminPanel() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [password, setPassword] = useState("");

  // The password lives only in this tab (sessionStorage) and goes with each admin request.
  const KEY = "ghartak-admin";
  const saved = () => {
    try {
      return sessionStorage.getItem(KEY);
    } catch {
      return null;
    }
  };

  const load = useCallback(async (pw: string | null = saved()) => {
    if (!pw) return setState({ kind: "login" });
    const res = await fetch("/api/admin/feedback", { cache: "no-store", headers: { "x-admin-password": pw } });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 429) {
      try {
        sessionStorage.removeItem(KEY);
      } catch {
        // ignore
      }
      return setState({ kind: "login", error: res.status === 429 ? body.error : undefined });
    }
    if (!res.ok) return setState({ kind: "error", message: body.error ?? `Failed (${res.status})` });
    setState({ kind: "ready", rows: body.rows, source: body.source, at: new Date() });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const login = async (e: React.FormEvent) => {
    e.preventDefault();
    const pw = password;
    const res = await fetch("/api/admin/login", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: pw }),
    });
    const body = await res.json().catch(() => ({}));
    setPassword("");
    if (!res.ok) return setState({ kind: "login", error: body.error ?? "Could not sign in." });
    try {
      sessionStorage.setItem(KEY, pw);
    } catch {
      // storage blocked: still works for this page view
    }
    load(pw);
  };

  const logout = () => {
    try {
      sessionStorage.removeItem(KEY);
    } catch {
      // ignore
    }
    setState({ kind: "login" });
  };

  const downloadCsv = async () => {
    const res = await fetch("/api/admin/export", { headers: { "x-admin-password": saved() ?? "" } });
    if (!res.ok) return load();
    const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "ghar-tak-feedback.csv";
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  const rows = state.kind === "ready" ? state.rows : [];
  const stats = useMemo(() => {
    const n = rows.length;
    const yes = (k: string) => rows.filter((r) => r[k] === true || r[k] === "TRUE" || r[k] === "true").length;
    return {
      n,
      highest: n ? Math.round((yes("chosen_is_highest_score") / n) * 100) : 0,
      fastest: n ? Math.round((yes("chosen_is_fastest") / n) * 100) : 0,
      metro: rows.filter((r) => r.chosen === "metro").length,
      none: rows.filter((r) => r.chosen === "none").length,
    };
  }, [rows]);

  return (
    <main className="admin">
      <header className="admin-head">
        <h1>Ghar Tak · Feedback</h1>
        {state.kind === "ready" && (
          <div className="admin-actions">
            <button type="button" className="btn primary" onClick={downloadCsv}>Download CSV</button>
            <button type="button" className="btn" onClick={() => load()}>Refresh</button>
            <button type="button" className="link" onClick={logout}>Sign out</button>
          </div>
        )}
      </header>

      {state.kind === "loading" && <p className="muted">Loading…</p>}
      {state.kind === "error" && <div className="error">{state.message}</div>}

      {state.kind === "login" && (
        <form className="admin-login" onSubmit={login}>
          <label htmlFor="admin-pw">Admin password</label>
          <input
            id="admin-pw" type="password" autoComplete="current-password" value={password}
            onChange={(e) => setPassword(e.target.value)} required autoFocus
          />
          <button className="btn primary">Sign in</button>
          {state.error && <p className="error-inline">{state.error}</p>}
        </form>
      )}

      {state.kind === "ready" && (
        <>
          <p className="muted">
            {stats.n} response{stats.n === 1 ? "" : "s"} · source: {state.source === "sheet" ? "Google Sheet" : "server store"} ·
            updated {state.at.toLocaleTimeString("en-IN")}
          </p>
          <div className="admin-tiles">
            <div className="admin-tile"><b>{stats.n}</b><span>responses</span></div>
            <div className="admin-tile"><b>{stats.highest}%</b><span>picked the highest-scoring route</span></div>
            <div className="admin-tile"><b>{stats.fastest}%</b><span>picked the fastest route</span></div>
            <div className="admin-tile"><b>{stats.metro}</b><span>picked walk + metro</span></div>
            <div className="admin-tile"><b>{stats.none}</b><span>picked none of the routes</span></div>
          </div>
          <div className="admin-grid">
            <Bars title="What matters most" data={count(rows, "priority")} total={stats.n} />
            <Bars title="Area at night" data={count(rows, "area_feel")} total={stats.n} />
            <Bars title="Mode" data={count(rows, "mode")} total={stats.n} />
          </div>
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>{COLUMNS.map(([, label]) => <th key={label}>{label}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    {COLUMNS.map(([k]) => (
                      <td key={k}>
                        {k === "submitted_at" ? ist(r[k]) : k === "chosen" ? chosenLabel(r[k]) : r[k] === true ? "yes" : r[k] === false ? "no" : LABELS[String(r[k])] ?? String(r[k] ?? "")}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 && <p className="muted">No responses yet.</p>}
          </div>
          <p className="note">The table shows the main columns; the CSV has every column, including each route component.</p>
        </>
      )}
    </main>
  );
}
