import type { Metadata } from "next";
import LiveView from "@/components/LiveView";

export const metadata: Metadata = {
  title: "Live trip · Ghar Tak",
  description: "Follow a trip home, live.",
  robots: { index: false, follow: false },
};

export default async function LiveTripPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <LiveView id={id} />;
}
