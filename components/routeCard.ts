import type { Snapshot } from "./MapView";
import type { ScoredRoute } from "@/lib/score";
import type { Mode } from "@/lib/routing";
import { fmtDistance, fmtDuration } from "./format";

/**
 * A 1080 × 1350 picture of a route for WhatsApp and Instagram: the real map around the route on top,
 * then the trip, its night score and three facts from the route's own numbers.
 */
export const CARD_W = 1080;
export const CARD_H = 1350;
const MAP_H = 760;
export const MAP_ASPECT = CARD_W / MAP_H;

const SCORE_COLOUR = (s: number | null) => (s === null ? "#8e98a4" : s >= 65 ? "#5cc28a" : s >= 45 ? "#f5b942" : "#ff6b5a");

const load = (src: string) =>
  new Promise<HTMLImageElement>((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });

function fit(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

function pin(ctx: CanvasRenderingContext2D, x: number, y: number, label: string, fill: string, ink: string) {
  ctx.beginPath();
  ctx.arc(x, y, 26, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 5;
  ctx.strokeStyle = "#0e1116";
  ctx.stroke();
  ctx.fillStyle = ink;
  ctx.font = "800 26px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, x, y + 1);
}

export async function routeCard(opts: {
  snap: Snapshot;
  route: ScoredRoute;
  mode: Mode;
  from: string;
  to: string;
  when: string;
  teen: boolean;
  host: string;
}): Promise<Blob> {
  const { snap, route: r, mode } = opts;
  const c = document.createElement("canvas");
  c.width = CARD_W;
  c.height = CARD_H;
  const ctx = c.getContext("2d")!;
  const font = (w: number, size: number) => `${w} ${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;

  ctx.fillStyle = "#0e1116";
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  // Map, with a fade into the card at the bottom.
  const map = await load(snap.url);
  ctx.drawImage(map, snap.crop.x, snap.crop.y, snap.crop.w, snap.crop.h, 0, 0, CARD_W, MAP_H);
  const fade = ctx.createLinearGradient(0, MAP_H - 220, 0, MAP_H);
  fade.addColorStop(0, "rgba(14,17,22,0)");
  fade.addColorStop(1, "rgba(14,17,22,1)");
  ctx.fillStyle = fade;
  ctx.fillRect(0, MAP_H - 220, CARD_W, 220);
  pin(ctx, snap.start[0] * CARD_W, snap.start[1] * MAP_H, "A", "#e8eaed", "#0e1116");
  pin(ctx, snap.end[0] * CARD_W, snap.end[1] * MAP_H, "B", "#f5b942", "#0e1116");

  // Brand chip.
  const logo = await load("/icons/icon-192.png").catch(() => null);
  ctx.fillStyle = "rgba(14,17,22,0.82)";
  ctx.beginPath();
  ctx.roundRect(40, 40, 300, 84, 22);
  ctx.fill();
  if (logo) ctx.drawImage(logo, 56, 54, 56, 56);
  ctx.fillStyle = "#eef0f3";
  ctx.font = font(800, 36);
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText("Ghar Tak", 128, 83);

  // Trip.
  const x = 64;
  let y = MAP_H + 10;
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#eef0f3";
  ctx.font = font(750, 44);
  ctx.fillText(fit(ctx, opts.from, CARD_W - 2 * x), x, y + 20);
  ctx.fillStyle = "#f5b942";
  ctx.font = font(750, 44);
  ctx.fillText(fit(ctx, `→ ${opts.to}`, CARD_W - 2 * x), x, y + 78);
  ctx.fillStyle = "#8e98a4";
  ctx.font = font(500, 30);
  ctx.fillText(`${mode === "walk" ? "Walking" : "By cab"} · leaving ${opts.when}`, x, y + 128);

  // Score ring and time.
  y += 180;
  const cx = x + 78, cy = y + 78, rad = 72;
  ctx.lineWidth = 14;
  ctx.strokeStyle = "#262c35";
  ctx.beginPath();
  ctx.arc(cx, cy, rad, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = SCORE_COLOUR(r.score);
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(cx, cy, rad, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * (r.score ?? 0)) / 100);
  ctx.stroke();
  ctx.fillStyle = "#eef0f3";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = font(800, 54);
  ctx.fillText(String(r.score ?? "–"), cx, cy - 6);
  ctx.fillStyle = "#8e98a4";
  ctx.font = font(600, 18);
  ctx.fillText(opts.teen ? "TEEN SCORE" : "NIGHT SCORE", cx, cy + 34);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#eef0f3";
  ctx.font = font(800, 58);
  ctx.fillText(fmtDuration(r.duration), x + 190, y + 74);
  ctx.fillStyle = "#c3c9d1";
  ctx.font = font(500, 30);
  ctx.fillText(fit(ctx, `${fmtDistance(r.distance)}${r.via ? ` · via ${r.via}` : ""}`, CARD_W - x - (x + 190)), x + 190, y + 122);

  // Facts.
  y += 200;
  const s = r.stats;
  const facts: [string, string][] = [
    ["#5cc28a", `${s.openPlaces} places open when you pass`],
    [s.longestGap > (mode === "walk" ? 300 : 2500) ? "#f5b942" : "#5cc28a",
      s.longestGap >= 100 ? `Longest stretch with nothing open: ${fmtDistance(s.longestGap)}` : "No long empty stretch"],
    ["#5cc28a", r.components.cameras !== null ? `${s.cameras} CCTV cameras · ${s.lamps} street lamps mapped` : `${s.lamps} street lamps mapped`],
  ];
  ctx.font = font(550, 32);
  for (const [col, line] of facts) {
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(x + 10, y - 10, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#e8eaed";
    ctx.fillText(fit(ctx, line, CARD_W - 2 * x - 40), x + 36, y);
    y += 54;
  }

  ctx.fillStyle = "#6b7480";
  ctx.font = font(500, 24);
  ctx.fillText(fit(ctx, `Night routes for Delhi NCR · ${opts.host} · Emergency 112`, CARD_W - 2 * x), x, CARD_H - 44);

  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("no image"))), "image/png"));
}
