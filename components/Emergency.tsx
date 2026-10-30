"use client";

import { useRef, useState } from "react";
import { loadContacts, sendToContacts } from "@/lib/contacts";
import type { HelpPoint } from "@/lib/score";
import { fmtDistance } from "./format";

/** National and NCR helplines. All are free to call from any phone. */
export const HELPLINES: { number: string; label: string; detail: string; primary?: boolean }[] = [
  { number: "112", label: "Emergency", detail: "Police, fire and ambulance, all of India", primary: true },
  { number: "1091", label: "Women helpline", detail: "Delhi Police, women in distress" },
  { number: "181", label: "Women helpline", detail: "National, 24×7" },
  { number: "1098", label: "Childline", detail: "Children and teens in need of help, 24×7" },
  { number: "102", label: "Ambulance", detail: "Delhi; 108 in Haryana and Uttar Pradesh" },
  { number: "1090", label: "UP Women Power Line", detail: "Noida, Greater Noida, Ghaziabad" },
];

export function HelplineList({ compact = false }: { compact?: boolean }) {
  const list = compact ? HELPLINES.filter((h) => ["112", "1091", "1098"].includes(h.number)) : HELPLINES;
  return (
    <ul className={compact ? "helplines-list compact" : "helplines-list"}>
      {list.map((h) => (
        <li key={h.number} className={h.primary ? "primary" : ""}>
          <a href={`tel:${h.number}`} aria-label={`Call ${h.label}, ${h.number}`}>
            <b>{h.number}</b>
            <span>
              {h.label}
              {!compact && <small>{h.detail}</small>}
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

/** Floating SOS button on every screen: call 112 and the helplines, or alert trusted contacts. */
export function SosButton() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [status, setStatus] = useState<string | null>(null);

  const alertContacts = async () => {
    const list = loadContacts();
    if (!list.length) {
      setStatus("No trusted contacts saved yet. Add them from any route's “Add trusted contacts”.");
      return;
    }
    setStatus("Getting your location…");
    const { located } = await sendToContacts(list, "I need help. Please call me.");
    setStatus(
      `Opening your messages app for ${list.length} contact${list.length === 1 ? "" : "s"}` +
        (located ? " with your location" : " (location not available)") + ". Press send there.",
    );
  };

  return (
    <>
      <button type="button" className="sos" onClick={() => { setStatus(null); dialog.current?.showModal(); }} aria-haspopup="dialog">
        SOS
      </button>
      <dialog ref={dialog} className="sos-sheet" aria-labelledby="sos-title">
        <form method="dialog" className="contacts-head">
          <h2 id="sos-title">Emergency</h2>
          <button className="link">Close</button>
        </form>
        <a className="sos-call" href="tel:112">Call 112</a>
        <button type="button" className="btn sos-alert" onClick={alertContacts}>
          Message my trusted contacts with my location
        </button>
        {status && <p className="share-status" aria-live="polite">{status}</p>}
        <HelplineList />
        <p className="note">Calls go through your phone. On a computer, use your phone to call.</p>
      </dialog>
    </>
  );
}

/**
 * "Help along this route": the nearest hospitals and police stations, each with a bar showing where
 * along the trip it is, and its phone number where OSM or Overture lists one.
 */
export function RouteHelp({ points, total }: { points: HelpPoint[]; total: number }) {
  if (!points.length) {
    return (
      <section className="route-help">
        <h3>Help along this route</h3>
        <p className="note">No hospital or police station mapped close to this route. Use 112 in an emergency.</p>
        <HelplineList compact />
      </section>
    );
  }
  return (
    <section className="route-help" aria-label="Help along this route">
      <h3>Help along this route</h3>
      <ul className="help-points">
        {points.map((p, i) => (
          <li key={i}>
            <div className="hp-top">
              <span className={`hp-kind ${p.kind}`}>{p.kind === "police" ? "Police" : "Hospital"}</span>
              <span className="hp-name">{p.name}</span>
              {p.phone ? (
                <a className="hp-call" href={`tel:${p.phone}`}>Call</a>
              ) : (
                <span className="hp-nophone muted">no number listed</span>
              )}
            </div>
            <div className="hp-bar" role="img" aria-label={`${fmtDistance(p.at)} into the trip, ${fmtDistance(p.off)} off the route`}>
              <span className="hp-track" />
              <span className={`hp-mark ${p.kind}`} style={{ left: `${Math.min(100, (p.at / Math.max(1, total)) * 100)}%` }} />
            </div>
            <div className="hp-meta muted">
              {fmtDistance(p.at)} into the trip · {fmtDistance(p.off)} off the route{p.open ? "" : " · may be closed now"}
              {p.phone && <> · {p.phone}</>}
            </div>
          </li>
        ))}
      </ul>
      <HelplineList compact />
    </section>
  );
}
