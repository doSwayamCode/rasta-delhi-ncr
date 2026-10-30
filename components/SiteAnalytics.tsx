"use client";

import { Analytics, type BeforeSendEvent } from "@vercel/analytics/next";

/**
 * Vercel Web Analytics (cookieless page views). A shared route's URL holds the whole trip, so only the
 * path is sent, never the query string or hash, and /admin is not tracked.
 */
function redact(event: BeforeSendEvent): BeforeSendEvent | null {
  const url = new URL(event.url);
  if (url.pathname.startsWith("/admin")) return null;
  return { ...event, url: url.origin + url.pathname };
}

export default function SiteAnalytics() {
  return <Analytics beforeSend={redact} />;
}
