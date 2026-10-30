import fs from "node:fs/promises";
import path from "node:path";

/**
 * Where feedback answers live.
 *
 * 1. Always: an append-only JSON-lines file on the server (FEEDBACK_FILE, default .data/feedback.jsonl).
 *    Works on any host with a persistent disk (a VM, Railway, Render, Fly with a volume).
 * 2. Optionally: a Google Sheet through the Apps Script web app (FEEDBACK_WEBHOOK_URL + FEEDBACK_SECRET).
 *    Use this on serverless hosts such as Vercel, whose filesystem is not persistent.
 *
 * The admin panel reads from the sheet when it is configured (it sees every instance's rows),
 * otherwise from the file.
 */
export type Row = Record<string, string | number | boolean | null>;

const FILE = process.env.FEEDBACK_FILE ?? path.join(process.cwd(), ".data", "feedback.jsonl");
const WEBHOOK = process.env.FEEDBACK_WEBHOOK_URL;
const SECRET = process.env.FEEDBACK_SECRET ?? "";

export const sheetConfigured = () => Boolean(WEBHOOK);

async function callSheet(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(WEBHOOK!, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: SECRET, ...body }),
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    // Apps Script answers with an HTML page when the deployment is wrong.
  }
  if (!res.ok || parsed.ok !== true) throw new Error(String(parsed.error ?? text.slice(0, 120) ?? res.status));
  return parsed;
}

/** Saves a row; succeeds if at least one store accepted it. */
export async function appendFeedback(row: Row): Promise<{ file: boolean; sheet: boolean | null }> {
  let file = false;
  try {
    await fs.mkdir(path.dirname(FILE), { recursive: true });
    await fs.appendFile(FILE, JSON.stringify(row) + "\n", "utf8");
    file = true;
  } catch {
    // read-only filesystem (serverless): rely on the sheet
  }
  let sheet: boolean | null = null;
  if (WEBHOOK) {
    try {
      await callSheet({ row });
      sheet = true;
    } catch {
      sheet = false;
    }
  }
  if (!file && !sheet) throw new Error("no feedback store accepted the answer");
  return { file, sheet };
}

export async function readFeedback(): Promise<{ rows: Row[]; source: "sheet" | "file" }> {
  if (WEBHOOK) {
    const res = await callSheet({ action: "list" });
    return { rows: (res.rows as Row[]) ?? [], source: "sheet" };
  }
  let text = "";
  try {
    text = await fs.readFile(FILE, "utf8");
  } catch {
    return { rows: [], source: "file" };
  }
  const rows: Row[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // skip a torn line from a crash mid-write
    }
  }
  return { rows, source: "file" };
}

/** RFC 4180 CSV with a UTF-8 BOM so Excel shows Hindi place names correctly. */
export function toCsv(rows: Row[]): string {
  const cols: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return "";
    let s = String(v);
    // Neutralise spreadsheet formula injection from any text value.
    if (/^[=+\-@\t\r]/.test(s) && typeof v === "string") s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))];
  return "﻿" + lines.join("\r\n") + "\r\n";
}
