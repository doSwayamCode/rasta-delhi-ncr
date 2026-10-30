"use client";

import { useEffect, useRef, useState } from "react";

/**
 * "Send to all": one tap opens the phone's SMS app with every trusted contact filled in and the
 * message (route, ETA, current location) written. Websites cannot send messages on their own, and
 * WhatsApp links take one number, so SMS is the only way to reach several people in one step;
 * the person still presses send in their messaging app.
 *
 * Contacts live only in this browser's localStorage. They are never sent to Rasta's server.
 */
export interface Contact {
  name: string;
  phone: string;
}

const KEY = "rasta-trusted-contacts";
const MAX = 10;

function load(): Contact[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((c) => c && typeof c.phone === "string").slice(0, MAX) : [];
  } catch {
    return [];
  }
}

function save(list: Contact[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // storage blocked: the list lasts for this page only
  }
}

/** Normalises Indian mobile numbers to +91XXXXXXXXXX; keeps other international numbers as typed. */
export function normalisePhone(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, "");
  const bare = digits.replace(/^\+/, "");
  if (/^[6-9]\d{9}$/.test(bare)) return `+91${bare}`;
  if (/^0[6-9]\d{9}$/.test(bare)) return `+91${bare.slice(1)}`;
  if (/^91[6-9]\d{9}$/.test(bare)) return `+${bare}`;
  if (digits.startsWith("+") && bare.length >= 8 && bare.length <= 15) return `+${bare}`;
  return null;
}

/** sms: URL for several recipients. iOS wants sms:/open?addresses=…; Android takes a comma list. */
export function smsUrl(phones: string[], body: string, ios: boolean): string {
  const text = encodeURIComponent(body);
  return ios ? `sms:/open?addresses=${phones.join(",")}&body=${text}` : `sms:${phones.join(",")}?body=${text}`;
}

const isIos = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

function currentLocation(): Promise<GeolocationPosition | null> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(resolve, () => resolve(null), {
      enableHighAccuracy: true, timeout: 8000, maximumAge: 60_000,
    });
  });
}

interface ContactsApi {
  select(props: string[], opts: { multiple: boolean }): Promise<{ name?: string[]; tel?: string[] }[]>;
}

export default function TrustedContacts({ text }: { text: string }) {
  const [list, setList] = useState<Contact[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => setList(load()), []);

  const update = (next: Contact[]) => {
    setList(next);
    save(next);
  };

  const sendAll = async () => {
    if (!list.length) {
      dialog.current?.showModal();
      return;
    }
    setBusy(true);
    setStatus("Getting your location…");
    const pos = await currentLocation();
    const where = pos
      ? `\nI'm here now: https://maps.google.com/?q=${pos.coords.latitude.toFixed(5)},${pos.coords.longitude.toFixed(5)}`
      : "";
    const url = smsUrl(list.map((c) => c.phone), text + where, isIos());
    setBusy(false);
    setStatus(
      `Opening your messages app for ${list.length} contact${list.length === 1 ? "" : "s"}` +
        (pos ? " with your current location" : " (location not shared)") +
        ". Press send there.",
    );
    const a = document.createElement("a");
    a.href = url;
    a.click();
  };

  const canPick = typeof navigator !== "undefined" && "contacts" in navigator;

  return (
    <>
      <button type="button" className="btn primary" onClick={sendAll} disabled={busy}>
        {list.length ? `Send to my ${list.length} contact${list.length === 1 ? "" : "s"}` : "Add trusted contacts"}
      </button>
      {list.length > 0 && (
        <button type="button" className="link" onClick={() => dialog.current?.showModal()}>
          Edit contacts
        </button>
      )}
      {status && <p className="share-status" aria-live="polite">{status}</p>}
      <ContactsDialog
        ref={dialog}
        list={list}
        canPick={canPick}
        onChange={update}
      />
    </>
  );
}

function ContactsDialog({
  ref, list, canPick, onChange,
}: {
  ref: React.RefObject<HTMLDialogElement | null>;
  list: Contact[];
  canPick: boolean;
  onChange: (l: Contact[]) => void;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);

  const add = (entries: Contact[]) => {
    const merged = [...list];
    for (const e of entries) {
      if (merged.length >= MAX) break;
      if (!merged.some((m) => m.phone === e.phone)) merged.push(e);
    }
    onChange(merged);
  };

  const addManual = (ev: React.FormEvent) => {
    ev.preventDefault();
    const p = normalisePhone(phone);
    if (!p) {
      setError("Enter a 10-digit Indian mobile number, or a full number with country code.");
      return;
    }
    add([{ name: name.trim() || p, phone: p }]);
    setName("");
    setPhone("");
    setError(null);
  };

  const pick = async () => {
    try {
      const picked = await (navigator as Navigator & { contacts: ContactsApi }).contacts.select(["name", "tel"], { multiple: true });
      const entries: Contact[] = [];
      for (const c of picked) {
        const p = c.tel?.map(normalisePhone).find(Boolean);
        if (p) entries.push({ name: c.name?.[0] ?? p, phone: p });
      }
      add(entries);
    } catch {
      // the person closed the picker
    }
  };

  return (
    <dialog ref={ref} className="contacts" aria-labelledby="contacts-title">
      <form method="dialog" className="contacts-head">
        <h2 id="contacts-title">Trusted contacts</h2>
        <button className="link">Done</button>
      </form>
      <p className="note">
        Saved only on this device; Rasta never receives them. &ldquo;Send to all&rdquo; opens your SMS app with
        everyone filled in, plus your route, arrival time and current location. You press send.
      </p>
      {list.length > 0 ? (
        <ul className="contact-list">
          {list.map((c) => (
            <li key={c.phone}>
              <span>
                {c.name}
                <span className="muted"> {c.phone}</span>
              </span>
              <button type="button" className="link" onClick={() => onChange(list.filter((x) => x.phone !== c.phone))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No contacts yet.</p>
      )}
      {canPick && list.length < MAX && (
        <button type="button" className="btn" onClick={pick}>Pick from phone contacts</button>
      )}
      {list.length < MAX && (
        <form className="contact-form" onSubmit={addManual}>
          <input aria-label="Name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
          <input
            aria-label="Phone number" placeholder="Phone, e.g. 98xxxxxx10" inputMode="tel" value={phone}
            onChange={(e) => setPhone(e.target.value)} maxLength={20} required
          />
          <button className="btn">Add</button>
        </form>
      )}
      {error && <p className="error-inline">{error}</p>}
    </dialog>
  );
}
