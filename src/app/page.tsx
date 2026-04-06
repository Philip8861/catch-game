"use client";

import { generateRoomCode, normalizeRoomCode } from "@/lib/roomCode";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

export default function Home() {
  const router = useRouter();
  const [joinCode, setJoinCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  function handleCreate() {
    const code = generateRoomCode(6);
    router.push(`/play/${code}`);
  }

  function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    const code = normalizeRoomCode(joinCode);
    if (code.length < 4) {
      setError("Bitte einen gültigen Raumcode eingeben (mind. 4 Zeichen).");
      return;
    }
    setError(null);
    router.push(`/play/${code}`);
  }

  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center bg-zinc-950 px-6 py-12 text-zinc-100">
      <div className="w-full max-w-md space-y-8">
        <div className="text-center">
          <h1 className="text-3xl font-bold tracking-tight text-white">Catch (PoC)</h1>
          <p className="mt-2 text-sm text-zinc-400">
            Mehrere Spieler, GPS-Karte, AprilTag (ID 1, 2, 3 …). Jeder jagt jeden – letzter
            Aktiver gewinnt. Echtzeit über MQTT (HiveMQ, kostenlos).
          </p>
        </div>

        <div className="space-y-4 rounded-2xl border border-zinc-800 bg-zinc-900/80 p-6 shadow-xl backdrop-blur">
          <button
            type="button"
            onClick={handleCreate}
            className="w-full rounded-xl bg-blue-600 px-4 py-4 text-base font-semibold text-white transition hover:bg-blue-500"
          >
            Raum erstellen
          </button>

          <form onSubmit={handleJoin} className="space-y-3">
            <label className="block text-sm font-medium text-zinc-300" htmlFor="code">
              Raum beitreten
            </label>
            <input
              id="code"
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              placeholder="z. B. ABC123"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-4 py-3 font-mono text-lg text-white placeholder:text-zinc-600 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              autoComplete="off"
              maxLength={12}
            />
            {error && <p className="text-sm text-red-400">{error}</p>}
            <button
              type="submit"
              className="w-full rounded-xl border border-zinc-600 bg-zinc-800 px-4 py-3 text-base font-medium text-white transition hover:bg-zinc-700"
            >
              Beitreten
            </button>
          </form>
        </div>

        <p className="text-center text-xs leading-relaxed text-zinc-500">
          HTTPS erforderlich für Kamera und GPS (lokal: localhost). AprilTag-Bibliothek: tag36h11
          (Browser-WASM). Vercel: Root-Verzeichnis <code className="text-zinc-400">catch-game</code>{" "}
          deployen.
        </p>

        <p className="text-center text-sm">
          <Link href="https://github.com/AprilRobotics/apriltag-imgs" className="text-blue-400 underline">
            AprilTag-Bilder (tag36h11)
          </Link>
        </p>
      </div>
    </div>
  );
}
