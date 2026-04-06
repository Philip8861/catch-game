"use client";

import { CatchGame } from "@/components/CatchGame";
import Link from "next/link";
import { useParams } from "next/navigation";

export default function PlayRoomPage() {
  const params = useParams();
  const roomId = typeof params.roomId === "string" ? params.roomId : "";

  if (!roomId) {
    return (
      <div className="flex min-h-[100dvh] flex-col items-center justify-center bg-zinc-950 p-6 text-white">
        <p>Ungültiger Raum.</p>
        <Link href="/" className="mt-4 text-blue-400 underline">
          Zur Startseite
        </Link>
      </div>
    );
  }

  return <CatchGame roomId={roomId} />;
}
