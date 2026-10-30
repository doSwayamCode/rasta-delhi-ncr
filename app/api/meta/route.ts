import { dataset } from "@/lib/data";

export const runtime = "nodejs";

export function GET() {
  return Response.json(dataset().meta, { headers: { "Cache-Control": "public, max-age=3600" } });
}
