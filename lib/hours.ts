import OpeningHours from "opening_hours";

/**
 * Opening-hours evaluation in India Standard Time.
 *
 * opening_hours.js reads wall-clock fields (getHours, getDay) from the Date it is given, in the
 * server's local zone. We therefore build a Date whose *local* fields equal the IST wall clock,
 * which makes the result independent of the server's timezone. IST has no DST, so this is exact.
 */
export function istWallClock(instant: Date): Date {
  const ist = new Date(instant.getTime() + 330 * 60_000);
  return new Date(
    ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(),
    ist.getUTCHours(), ist.getUTCMinutes(), ist.getUTCSeconds(),
  );
}

export function istMinutes(instant: Date): number {
  const ist = new Date(instant.getTime() + 330 * 60_000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

const NOMINATIM = { lat: 28.5, lon: 77.2, address: { country_code: "in", state: "Delhi" } };

/**
 * The library ships no Indian public-holiday calendar and throws on any PH/SH rule. We drop those
 * rules, so holiday exceptions are ignored (documented in the README) rather than the whole tag.
 */
export function stripHolidayRules(value: string): string {
  return value
    .split(";")
    .map((rule) => rule.trim())
    .filter((rule) => rule && !/^(PH|SH)\b/.test(rule))
    .map((rule) => rule.replace(/\s*,\s*(PH|SH)\b/g, "").replace(/\b(PH|SH)\s*,\s*/g, ""))
    .filter((rule) => !/^(off|closed|open)$/i.test(rule))
    .join("; ");
}

const cache = new Map<string, OpeningHours | null>();

function compile(value: string): OpeningHours | null {
  let oh = cache.get(value);
  if (oh !== undefined) return oh;
  try {
    const cleaned = stripHolidayRules(value);
    oh = cleaned ? new OpeningHours(cleaned, NOMINATIM, 0) : null;
  } catch {
    oh = null;
  }
  cache.set(value, oh);
  return oh;
}

/** "HH:MM-HH:MM" (may wrap past midnight) or "24/7" -- the per-category defaults. */
function defaultOpen(range: string | null, minutes: number): boolean {
  if (!range) return false;
  if (range === "24/7") return true;
  const m = /^(\d\d):(\d\d)-(\d\d):(\d\d)$/.exec(range);
  if (!m) return false;
  const start = +m[1] * 60 + +m[2];
  const end = +m[3] * 60 + +m[4];
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

export type HoursSource = "tagged" | "assumed";

export interface OpenState {
  open: boolean;
  source: HoursSource;
}

/**
 * Is a place open at `instant`? Uses the place's own OSM opening_hours when it parses, otherwise
 * the category default. Results are memoised per (hours, 15-minute slot).
 */
export function openAt(
  hours: string,
  categoryDefault: string | null,
  instant: Date,
  memo: Map<string, OpenState>,
): OpenState {
  const slot = Math.floor(instant.getTime() / 900_000);
  const key = `${hours}|${categoryDefault}|${slot}`;
  const hit = memo.get(key);
  if (hit) return hit;
  let state: OpenState;
  const oh = hours ? compile(hours) : null;
  if (oh) {
    let open = false;
    try {
      open = oh.getState(istWallClock(instant));
    } catch {
      open = defaultOpen(categoryDefault, istMinutes(instant));
    }
    state = { open, source: "tagged" };
  } else {
    state = { open: defaultOpen(categoryDefault, istMinutes(instant)), source: "assumed" };
  }
  memo.set(key, state);
  return state;
}
