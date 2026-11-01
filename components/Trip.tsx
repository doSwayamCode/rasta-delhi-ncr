"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Contact, loadContacts, saveContacts, sendToContacts } from "@/lib/contacts";
import type { Mode } from "@/lib/routing";
import type { ScoredRoute } from "@/lib/score";
import { type Check, TripWatcher, ahead, makeTrack } from "@/lib/tripWatch";
import { HelplineList } from "./Emergency";
import Icon from "./Icon";
import { ContactsDialog } from "./TrustedContacts";
import { fmtDistance, fmtDuration } from "./format";

/**
 * Trip mode. The phone follows the person along the chosen route and checks in when something looks
 * off (see lib/tripWatch.ts). Trusted contacts can follow a live link. Everything that decides
 * anything runs on the phone; the server only relays the live link.
 *
 * Websites cannot send texts or run in the background, so: messages open the phone's SMS app ready
 * to send, and the person keeps Ghar Tak open (the screen is kept awake while a trip is on).
 */

export interface TripSession {
  route: ScoredRoute;
  mode: Mode;
  from: string;
  to: string;
  name: string;
  startedAt: number;
  live: { id: string; key: string; url: string } | null;
}

const STORE = "ghartak-trip";
const NAME_KEY = "ghartak-my-name";
const CHECK_SECONDS = 60;
const MAX_AGE_MS = 12 * 3600_000;

export function loadTrip(): TripSession | null {
  try {
    const s = JSON.parse(localStorage.getItem(STORE) ?? "null") as TripSession | null;
    return s && Date.now() - s.startedAt < MAX_AGE_MS ? s : null;
  } catch {
    return null;
  }
}

function saveTrip(s: TripSession | null) {
  try {
    if (s) localStorage.setItem(STORE, JSON.stringify(s));
    else localStorage.removeItem(STORE);
  } catch {
    // storage blocked: the trip still runs for this page
  }
}

const clock = (ms: number) =>
  new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" }).format(ms);

async function liveUpdate(s: TripSession, body: Record<string, unknown>) {
  if (!s.live) return false;
  try {
    const r = await fetch(`/api/live/${s.live.id}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: s.live.key, ...body }),
      keepalive: true,
    });
    return r.ok;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ start */

export function TripStart({ route, mode, from, to, onStart, onCancel }: {
  route: ScoredRoute;
  mode: Mode;
  from: string;
  to: string;
  onStart: (s: TripSession) => void;
  onCancel: () => void;
}) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [name, setName] = useState("");
  const [liveOk, setLiveOk] = useState<boolean | null>(null);
  const [share, setShare] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    setContacts(loadContacts());
    try {
      setName(localStorage.getItem(NAME_KEY) ?? "");
    } catch {
      // ignore
    }
    fetch("/api/live").then((r) => r.json()).then((b) => setLiveOk(Boolean(b.enabled))).catch(() => setLiveOk(false));
  }, []);

  const start = async () => {
    setError(null);
    if (!navigator.geolocation) return setError("This browser can't share your location, so trip mode can't follow you.");
    setBusy("Getting your location…");
    const pos = await new Promise<GeolocationPosition | null>((res) =>
      navigator.geolocation.getCurrentPosition(res, () => res(null), { enableHighAccuracy: true, timeout: 15_000 }),
    );
    if (!pos) {
      setBusy(null);
      return setError("Location is off or blocked. Allow location for this site, then try again.");
    }
    try {
      localStorage.setItem(NAME_KEY, name.trim());
    } catch {
      // ignore
    }
    const startedAt = Date.now();
    const eta = startedAt + route.duration * 1000;
    let live: TripSession["live"] = null;
    if (share && liveOk) {
      setBusy("Creating your live link…");
      try {
        const r = await fetch("/api/live", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: name.trim(), mode, from, to, route: route.coords, distance: route.distance, eta: new Date(eta).toISOString(),
          }),
        });
        const b = await r.json();
        if (r.ok) live = { id: b.id, key: b.key, url: `${window.location.origin}/t/${b.id}` };
      } catch {
        // carry on without a live link
      }
    }
    const session: TripSession = { route, mode, from, to, name: name.trim(), startedAt, live };
    saveTrip(session);
    onStart(session);
    setBusy(null);
    if (share && contacts.length) {
      const who = name.trim() ? `${name.trim()} here. ` : "";
      const how = mode === "walk" ? "walking" : "by cab";
      const msg =
        `${who}I'm heading from ${from} to ${to} (${how}, about ${fmtDuration(route.duration)}, should reach around ${clock(eta)}).` +
        (live
          ? `\nFollow me live: ${live.url}\nIf I don't answer a check-in on the way, it will show there in red.`
          : "\nI'll message you when I reach.");
      await sendToContacts(contacts, msg);
    }
  };

  return (
    <div className="view trip-start">
      <div className="view-head">
        <button type="button" className="icon-btn" aria-label="Back" onClick={onCancel}><Icon name="left" /></button>
        <h2>Start trip</h2>
      </div>
      <p className="lead">
        Ghar Tak follows you along this route ({fmtDuration(route.duration)}, {fmtDistance(route.distance)}) and checks on you
        if something seems off.
      </p>
      <ul className="why trip-points">
        <li><span className="why-ic good"><Icon name="alert" size={15} /></span><span><b>Asks &ldquo;Are you OK?&rdquo;</b> if you leave the route, stop for long, run late, or start moving at vehicle speed on foot.</span></li>
        <li><span className="why-ic warn"><Icon name="phone" size={15} /></span><span><b>No answer in a minute?</b> An alarm sounds and a message to your contacts is ready to send.</span></li>
        <li><span className="why-ic good"><Icon name="check" size={15} /></span><span><b>Reached?</b> One tap tells everyone you&apos;re home.</span></li>
      </ul>

      <div className="trip-box">
        <label className="trip-row">
          <span>
            <b>Tell my trusted contacts</b>
            <small>
              {contacts.length
                ? `${contacts.map((c) => c.name).slice(0, 3).join(", ")}${contacts.length > 3 ? ` +${contacts.length - 3}` : ""}`
                : "No contacts saved yet"}
              {liveOk ? " · with a live link to follow you" : liveOk === false ? " · live link not available here" : ""}
            </small>
          </span>
          <input type="checkbox" className="toggle" checked={share} onChange={(e) => setShare(e.target.checked)} />
        </label>
        <button type="button" className="link" onClick={() => dialog.current?.showModal()}>
          {contacts.length ? "Edit contacts" : "Add contacts"}
        </button>
        <label className="trip-name">
          <span>Your name in the message (optional)</span>
          <input value={name} maxLength={40} placeholder="e.g. Riya" onChange={(e) => setName(e.target.value)} autoComplete="given-name" />
        </label>
      </div>

      <p className="note">
        Keep Ghar Tak open on screen during the trip: phones pause websites in the background. The screen stays on while a
        trip is running.{share && liveOk ? " Anyone with the link sees your location until the trip ends; it is deleted an hour later." : ""}
      </p>
      {error && <p className="error-inline">{error}</p>}
      <div className="actions">
        <button type="button" className="btn primary big" onClick={start} disabled={busy !== null}>
          <Icon name="walk" />
          {busy ?? "Start trip"}
        </button>
      </div>
      <ContactsDialog
        ref={dialog} list={contacts} canPick={typeof navigator !== "undefined" && "contacts" in navigator}
        onChange={(l) => {
          setContacts(l);
          saveContacts(l);
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ running */

/** A rising two-tone alarm through the speaker; returns a stop function. */
function siren(): () => void {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    gain.gain.value = 0.25;
    osc.connect(gain).connect(ctx.destination);
    const t = ctx.currentTime;
    for (let i = 0; i < 120; i++) {
      osc.frequency.setValueAtTime(i % 2 ? 960 : 1400, t + i * 0.45);
    }
    osc.start();
    return () => {
      osc.stop();
      ctx.close();
    };
  } catch {
    return () => undefined;
  }
}

function useWakeLock(on: boolean) {
  useEffect(() => {
    if (!on || !("wakeLock" in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    const get = () => navigator.wakeLock.request("screen").then((l) => (lock = l)).catch(() => undefined);
    get();
    const again = () => document.visibilityState === "visible" && get();
    document.addEventListener("visibilitychange", again);
    return () => {
      document.removeEventListener("visibilitychange", again);
      lock?.release().catch(() => undefined);
    };
  }, [on]);
}

export function TripPanel({ session, onPosition, onEnd }: {
  session: TripSession;
  onPosition: (p: { lon: number; lat: number; acc: number } | null) => void;
  onEnd: () => void;
}) {
  const { route } = session;
  const watcher = useMemo(
    () => new TripWatcher(makeTrack(route.coords), session.mode, route.duration, session.startedAt),
    [route, session.mode, session.startedAt],
  );
  const [now, setNow] = useState(Date.now());
  const [fix, setFix] = useState<{ along: number; off: number; remaining: number; acc: number; t: number } | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [check, setCheck] = useState<(Check & { since: number }) | null>(null);
  const [alarm, setAlarm] = useState<string | null>(null);
  const [arrived, setArrived] = useState(false);
  const [liveOk, setLiveOk] = useState(true);
  const [sent, setSent] = useState<string | null>(null);
  const checkDialog = useRef<HTMLDialogElement>(null);
  const stopSiren = useRef<(() => void) | null>(null);
  const lastSent = useRef(0);
  const lastEval = useRef(0);
  const lastBuzz = useRef(0);
  const latest = useRef<{ lon: number; lat: number; acc: number; t: number } | null>(null);

  useWakeLock(!arrived);

  const push = useCallback(
    async (extra: Record<string, unknown> = {}) => {
      const p = latest.current;
      lastSent.current = Date.now();
      const ok = await liveUpdate(session, {
        ...(p ? { pos: { lon: p.lon, lat: p.lat, acc: p.acc, at: new Date(p.t).toISOString() } } : {}),
        along: watcher.remaining() >= 0 ? route.distance - watcher.remaining() : 0,
        eta: new Date(watcher.eta(Date.now())).toISOString(),
        ...extra,
      });
      if (session.live) setLiveOk(ok);
    },
    [session, watcher, route.distance],
  );

  // GPS.
  useEffect(() => {
    if (!navigator.geolocation) {
      setGpsError("This browser can't share your location.");
      return;
    }
    const onFix = (pos: GeolocationPosition) => {
      const f = { lon: pos.coords.longitude, lat: pos.coords.latitude, acc: pos.coords.accuracy, t: Date.now() };
      latest.current = f;
      const r = watcher.add(f);
      setFix({ ...r, acc: f.acc, t: f.t });
      setGpsError(null);
      onPosition({ lon: f.lon, lat: f.lat, acc: f.acc });
      if (r.arrived) setArrived(true);
      if (Date.now() - lastSent.current > 20_000) push();
    };
    const onError = (e: GeolocationPositionError) =>
      setGpsError(e.code === e.PERMISSION_DENIED ? "Location permission was turned off." : "Can't get your location right now.");
    const opts = { enableHighAccuracy: true, maximumAge: 5000, timeout: 30_000 };
    const id = navigator.geolocation.watchPosition(onFix, onError, opts);
    // Phones often send nothing while you stand still, so also ask every 20 s: that is how a stop
    // shows up, and a failed request is how lost signal does.
    const poll = setInterval(() => navigator.geolocation.getCurrentPosition(onFix, onError, { ...opts, maximumAge: 0 }), 20_000);
    return () => {
      navigator.geolocation.clearWatch(id);
      clearInterval(poll);
      onPosition(null);
    };
  }, [watcher, push, onPosition]);

  // The clock: checks, countdowns, live heartbeats.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (arrived || alarm) return;
    if (check) {
      if (now - check.since >= CHECK_SECONDS * 1000) raiseAlarm(`Didn't answer a check-in: ${check.reason}`);
      else if (now - lastBuzz.current >= 5000) {
        lastBuzz.current = now;
        navigator.vibrate?.([300, 150, 300]);
      }
      return;
    }
    if (now - lastEval.current >= 5000) {
      lastEval.current = now;
      const c = watcher.evaluate(now);
      if (c) {
        setCheck({ ...c, since: now });
        navigator.vibrate?.([400, 150, 400]);
        push({ status: "check", reason: c.reason });
      }
    }
    if (now - lastSent.current > 45_000) push();
    // raiseAlarm is stable enough for this tick; adding it would re-run every render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now]);

  useEffect(() => {
    const d = checkDialog.current;
    if (!d) return;
    if ((check || alarm) && !d.open) d.showModal();
    if (!check && !alarm && d.open) d.close();
  }, [check, alarm]);

  useEffect(() => {
    if (!arrived) return;
    setCheck(null);
    push({ status: "arrived", reason: null });
    navigator.vibrate?.([200, 100, 200]);
  }, [arrived, push]);

  useEffect(() => () => stopSiren.current?.(), []);

  function raiseAlarm(reason: string) {
    setCheck(null);
    setAlarm(reason);
    stopSiren.current?.();
    stopSiren.current = siren();
    navigator.vibrate?.([800, 200, 800, 200, 800]);
    push({ status: "alert", reason });
  }

  const imOk = () => {
    if (check) watcher.snooze(check.kind, Date.now());
    stopSiren.current?.();
    stopSiren.current = null;
    setCheck(null);
    setAlarm(null);
    push({ status: "on_way", reason: null });
  };

  const messageContacts = async (kind: "help" | "reached") => {
    const list = loadContacts();
    if (!list.length) {
      setSent("No trusted contacts saved. Add them from Start trip.");
      return;
    }
    const who = session.name ? `${session.name} here. ` : "";
    const msg =
      kind === "help"
        ? `${who}I may need help. I'm on my way from ${session.from} to ${session.to}. Please call me.` +
          (session.live ? `\nLive: ${session.live.url}` : "")
        : `${who}Reached ${session.to} safely ✅`;
    await sendToContacts(list, msg);
    setSent(kind === "help" ? "Your messages app is open with the alert. Press send." : "Your messages app is open. Press send.");
  };

  const end = async () => {
    stopSiren.current?.();
    await push({ status: arrived ? "arrived" : "ended", reason: null });
    saveTrip(null);
    onEnd();
  };

  const remaining = fix ? fix.remaining : route.distance;
  const done = Math.min(1, Math.max(0, 1 - remaining / Math.max(1, route.distance)));
  const eta = watcher.eta(now);
  const stale = fix ? now - fix.t > 120_000 : now - session.startedAt > 60_000;
  const offRoute = fix ? fix.off > Math.max(watcher.rules.offRouteM, 1.5 * fix.acc) : false;
  const next = !fix ? null
    : offRoute ? { tone: "warn" as const, text: `You're about ${fmtDistance(fix.off)} from your route.`, phone: null }
    : ahead(route.distance - remaining, route.gaps, route.emergency);
  const status = gpsError || stale ? { tone: "warn", text: gpsError ?? "Waiting for GPS…" }
    : offRoute ? { tone: "warn", text: "Off your route" } : { tone: "good", text: "On your route" };

  if (arrived) {
    return (
      <div className="view trip arrived">
        <div className="trip-hero">
          <span className="why-ic good big"><Icon name="check" size={26} /></span>
          <div>
            <h2>You&apos;ve arrived</h2>
            <p className="muted">{session.to} · trip took {fmtDuration((Date.now() - session.startedAt) / 1000)}</p>
          </div>
        </div>
        <button type="button" className="btn primary big" onClick={() => messageContacts("reached")}>
          <Icon name="users" />
          Tell my people I reached
        </button>
        {sent && <p className="share-status">{sent}</p>}
        <button type="button" className="btn big" onClick={end}>End trip</button>
      </div>
    );
  }

  const left = Math.max(0, check ? CHECK_SECONDS - Math.floor((now - check.since) / 1000) : 0);

  return (
    <div className="view trip">
      <div className="trip-top">
        <span className={`pill ${status.tone}`}><i />{status.text}</span>
        {session.live ? (
          <span className={liveOk ? "pill live" : "pill warn"}><i />{liveOk ? "Live link on" : "Live link offline"}</span>
        ) : (
          <span className="pill"><i />Not shared live</span>
        )}
      </div>
      <div className="trip-eta">
        <div>
          <b>{fmtDuration(Math.max(0, (eta - now) / 1000))}</b>
          <span className="muted"> · {fmtDistance(remaining)} left</span>
        </div>
        <span className="muted">Arrive ~{clock(eta)}</span>
      </div>
      <div className="trip-progress" role="progressbar" aria-valuenow={Math.round(done * 100)} aria-valuemin={0} aria-valuemax={100}>
        <i style={{ width: `${done * 100}%` }} />
      </div>
      <p className="muted small trip-to">To {session.to}</p>

      {next && (
        <div className={`ahead ${next.tone}`}>
          <Icon name={next.tone === "warn" ? "alert" : "shield"} size={16} />
          <span>{next.text}</span>
          {next.phone && <a className="hp-call" href={`tel:${next.phone}`}><Icon name="phone" size={14} />Call</a>}
        </div>
      )}

      <div className="trip-actions">
        {session.live && (
          <button
            type="button" className="btn"
            onClick={() => {
              const text = `Follow my trip live: ${session.live!.url}`;
              if (navigator.share) navigator.share({ text }).catch(() => undefined);
              else navigator.clipboard?.writeText(text).then(() => setSent("Live link copied."));
            }}
          >
            <Icon name="share" />
            Share live link
          </button>
        )}
        <button type="button" className="btn" onClick={end}>End trip</button>
      </div>
      {sent && <p className="share-status">{sent}</p>}
      <p className="note">
        Keep Ghar Tak open. If you switch apps for long, your phone pauses it and check-ins stop.
        {fix && fix.acc > 60 ? ` GPS is rough right now (±${Math.round(fix.acc)} m).` : ""}
      </p>

      <dialog ref={checkDialog} className={alarm ? "trip-check alarm" : "trip-check"} onCancel={(e) => e.preventDefault()}>
        {alarm ? (
          <>
            <h2>Alert</h2>
            <p>{alarm}</p>
            {session.live && <p className="small">Your live link now shows this alert in red.</p>}
            <a className="sos-call" href="tel:112">Call 112</a>
            <button type="button" className="btn primary big" onClick={() => messageContacts("help")}>
              <Icon name="users" />
              Message my contacts
            </button>
            {sent && <p className="share-status">{sent}</p>}
            <HelplineList compact />
            <button type="button" className="btn big" onClick={imOk}>I&apos;m safe now</button>
          </>
        ) : check ? (
          <>
            <div className="count" style={{ "--p": (left / CHECK_SECONDS) * 100 } as React.CSSProperties}><b>{left}</b></div>
            <h2>Are you OK?</h2>
            <p>{check.reason}</p>
            <button type="button" className="btn ok big" onClick={imOk}>I&apos;m OK</button>
            <button type="button" className="btn danger big" onClick={() => raiseAlarm(`Asked for help: ${check.reason}`)}>I need help</button>
            <p className="small muted">If you don&apos;t answer, an alarm sounds{session.live ? " and your live link turns red" : ""}.</p>
          </>
        ) : null}
      </dialog>
    </div>
  );
}
