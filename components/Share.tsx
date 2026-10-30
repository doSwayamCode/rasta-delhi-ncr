"use client";

import { useState } from "react";
import type { Mode } from "@/lib/routing";
import type { ScoredRoute } from "@/lib/score";
import { fmtDistance, fmtDuration } from "./format";

interface Props {
  route: ScoredRoute;
  mode: Mode;
  fromLabel: string;
  toLabel: string;
  depart: string;
  url: string;
}

const time = (ms: number) =>
  new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" }).format(new Date(ms));

export function shareText({ route, mode, fromLabel, toLabel, depart, url }: Props): string {
  const start = new Date(depart).getTime();
  const eta = start + route.duration * 1000;
  const how = mode === "walk" ? "walking" : "taking a cab";
  const via = route.via ? ` via ${route.via}` : "";
  return (
    `I'm ${how} from ${fromLabel} to ${toLabel}. Leaving ${time(start)}, should reach around ${time(eta)} ` +
    `(${fmtDuration(route.duration)}, ${fmtDistance(route.distance)}${via}).\n` +
    `My route: ${url}`
  );
}

export default function Share(props: Props) {
  const [copied, setCopied] = useState(false);
  const text = shareText(props);
  const canNativeShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Copy this message:", text);
    }
  };

  return (
    <div className="share">
      <a className="btn primary" href={`https://wa.me/?text=${encodeURIComponent(text)}`} target="_blank" rel="noopener noreferrer">
        Send on WhatsApp
      </a>
      {canNativeShare ? (
        <button type="button" className="btn" onClick={() => navigator.share({ text }).catch(() => undefined)}>
          Share…
        </button>
      ) : null}
      <button type="button" className="btn" onClick={copy}>
        {copied ? "Copied" : "Copy message"}
      </button>
    </div>
  );
}
