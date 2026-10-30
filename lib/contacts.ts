/**
 * Trusted contacts, kept only in this browser's localStorage and never sent to Ghar Tak's server.
 * Messages go out through the phone's own SMS app: websites cannot send messages by themselves,
 * and WhatsApp links take one number, so SMS is the one way to reach several people in one step.
 */
export interface Contact {
  name: string;
  phone: string;
}

const KEY = "ghartak-trusted-contacts";
export const MAX_CONTACTS = 10;

export function loadContacts(): Contact[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((c) => c && typeof c.phone === "string").slice(0, MAX_CONTACTS) : [];
  } catch {
    return [];
  }
}

export function saveContacts(list: Contact[]) {
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

export const isIos = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

export function currentLocation(): Promise<GeolocationPosition | null> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(resolve, () => resolve(null), {
      enableHighAccuracy: true, timeout: 8000, maximumAge: 60_000,
    });
  });
}

/**
 * Opens the SMS app with every contact filled in and `text` written, plus a map link to the current
 * location when the browser can get one. The person still presses send.
 */
export async function sendToContacts(list: Contact[], text: string): Promise<{ located: boolean }> {
  const pos = await currentLocation();
  const where = pos
    ? `\nI'm here now: https://maps.google.com/?q=${pos.coords.latitude.toFixed(5)},${pos.coords.longitude.toFixed(5)}`
    : "";
  const a = document.createElement("a");
  a.href = smsUrl(list.map((c) => c.phone), text + where, isIos());
  a.click();
  return { located: Boolean(pos) };
}
