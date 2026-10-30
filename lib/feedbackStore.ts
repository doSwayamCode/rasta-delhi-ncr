import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SHEET_WEBHOOK } from "./sheet";

/**
 * Where feedback answers live, in order of preference:
 *
 * 1. Redis over Upstash's REST API: KV_REST_API_URL + KV_REST_API_TOKEN (set automatically when you
 *    add Upstash Redis from Vercel's Storage tab) or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN.
 *    Works on serverless hosts and keeps every answer.
 * 2. A Google Sheet through the Apps Script web app (FEEDBACK_WEBHOOK_URL + FEEDBACK_SECRET).
 * 3. A JSON-lines file on the server (FEEDBACK_FILE, default .data/feedback.jsonl): fine on a VM or
 *    any host with a persistent disk.
 * 4. If that disk is read-only (Vercel, Netlify), the system temp folder, so the form never fails.
 *    That copy is temporary and per-instance; /admin says so.
 */
export type Row = Record<string, string | number | boolean | null>;
export type Source = "redis" | "sheet" | "file" | "temporary";

const REDIS_URL = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
const REDIS_KEY = "ghartak:feedback";
const WEBHOOK = SHEET_WEBHOOK;
const SECRET = process.env.FEEDBACK_SECRET ?? "";
const FILE = process.env.FEEDBACK_FILE ?? path.join(process.cwd(), ".data", "feedback.jsonl");
const TMP_FILE = path.join(os.tmpdir(), "ghartak-feedback.jsonl");

async function redis(command: (string | number)[]): Promise<unknown> {
  const res = await fetch(REDIS_URL!, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json().catch(() => ({}))) as { result?: unknown; error?: string };
  if (!res.ok || body.error) throw new Error(body.error ?? `redis ${res.status}`);
  return body.result;
}

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

async function appendLine(file: string, row: Row): Promise<boolean> {
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, JSON.stringify(row) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

async function readLines(file: string): Promise<Row[] | null> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return null;
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
  return rows;
}

/** Saves a row to every configured store; succeeds if any of them accepted it. */
export async function appendFeedback(row: Row): Promise<Source[]> {
  const saved: Source[] = [];
  if (REDIS_URL && REDIS_TOKEN) {
    try {
      await redis(["RPUSH", REDIS_KEY, JSON.stringify(row)]);
      saved.push("redis");
    } catch {
      // fall through to the other stores
    }
  }
  if (WEBHOOK) {
    try {
      await callSheet({ row });
      saved.push("sheet");
    } catch {
      // fall through
    }
  }
  if (await appendLine(FILE, row)) saved.push("file");
  else if (!saved.length && (await appendLine(TMP_FILE, row))) saved.push("temporary");
  if (!saved.length) throw new Error("no feedback store accepted the answer");
  return saved;
}

export async function readFeedback(): Promise<{ rows: Row[]; source: Source }> {
  if (REDIS_URL && REDIS_TOKEN) {
    const list = (await redis(["LRANGE", REDIS_KEY, 0, -1])) as string[];
    return { rows: list.map((s) => JSON.parse(s)), source: "redis" };
  }
  if (WEBHOOK) {
    // Reading rows back needs the script's own SECRET; without it /admin shows the sheet itself.
    try {
      const res = await callSheet({ action: "list" });
      return { rows: (res.rows as Row[]) ?? [], source: "sheet" };
    } catch {
      // fall through to the local copy
    }
  }
  const file = await readLines(FILE);
  if (file) return { rows: file, source: "file" };
  return { rows: (await readLines(TMP_FILE)) ?? [], source: "temporary" };
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
