"use client";

import dynamic from "next/dynamic";
import mqtt, { MqttClient } from "mqtt";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Webcam from "react-webcam";
import { useAprilTagDetector } from "@/components/AprilTagDetector";
import type { GameMessage } from "@/lib/gameTypes";
import { parseGameMessage } from "@/lib/gameTypes";
import { getOrCreatePlayerId } from "@/lib/playerId";

const GameMapView = dynamic(
  () => import("@/components/GameMapView").then((m) => m.GameMapView),
  { ssr: false, loading: () => <div className="text-sm text-zinc-500">Karte lädt…</div> },
);

const MQTT_URL = "wss://broker.hivemq.com:8884/mqtt";
const PRESENCE_MS = 4000;
const POS_MS = 4000;
const PRESENCE_TTL_MS = 15000;
const TAG_FAMILY_NOTE =
  "PoC nutzt tag36h11 (WASM). Drucke z. B. Tags aus dem AprilRobotics-Repo „apriltag-imgs“ (Ordner tag36h11), IDs 1 und 2.";

type ViewMode = "map" | "camera";

function topicForRoom(roomId: string) {
  return `catch-game/demo/${roomId}`;
}

export function CatchGame({ roomId }: { roomId: string }) {
  const playerId = useMemo(() => getOrCreatePlayerId(), []);
  const [view, setView] = useState<ViewMode>("map");
  const [mqttStatus, setMqttStatus] = useState<"connecting" | "live" | "error">("connecting");
  const [presence, setPresence] = useState<Record<string, number>>({});
  const [positions, setPositions] = useState<
    Record<string, { lat: number; lng: number; ts: number }>
  >({});
  const [myPos, setMyPos] = useState<{ lat: number; lng: number } | null>(null);
  const [gameEnded, setGameEnded] = useState<{
    winnerId: string;
    loserId: string;
  } | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());

  const webcamRef = useRef<Webcam>(null);
  const clientRef = useRef<MqttClient | null>(null);
  const lastWinPublish = useRef<number>(0);

  const getVideo = useCallback(() => webcamRef.current?.video ?? null, []);

  useEffect(() => {
    const id = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const activePlayers = useMemo(() => {
    return Object.entries(presence)
      .filter(([, ts]) => nowTick - ts < PRESENCE_TTL_MS)
      .map(([id]) => id);
  }, [presence, nowTick]);

  const slotInfo = useMemo(() => {
    if (activePlayers.length < 2 || !playerId) return null;
    const sorted = [...activePlayers].sort();
    const mySlot = sorted.indexOf(playerId);
    if (mySlot < 0) return null;
    const opponentId = sorted.find((p) => p !== playerId) ?? "";
    return {
      slot: (mySlot === 0 ? 1 : 2) as 1 | 2,
      myTagId: mySlot === 0 ? 1 : 2,
      targetTagId: mySlot === 0 ? 2 : 1,
      opponentId,
    };
  }, [activePlayers, playerId]);

  const publish = useCallback(
    (msg: GameMessage) => {
      clientRef.current?.publish(topicForRoom(roomId), JSON.stringify(msg), {
        qos: 0,
        retain: false,
      });
    },
    [roomId],
  );

  useEffect(() => {
    const client = mqtt.connect(MQTT_URL, {
      clientId: `catch-${playerId.slice(0, 8)}-${Math.random().toString(36).slice(2, 8)}`,
      clean: true,
      reconnectPeriod: 3000,
    });
    clientRef.current = client;

    client.on("connect", () => {
      setMqttStatus("live");
      void (async () => {
        try {
          await client.subscribeAsync(topicForRoom(roomId), { qos: 0 });
        } catch {
          setMqttStatus("error");
        }
      })();
    });

    client.on("error", () => setMqttStatus("error"));
    client.on("close", () => {
      /* optional */
    });

    client.on("message", (_t, payload) => {
      const text = payload.toString();
      const msg = parseGameMessage(text);
      if (!msg || msg.roomId !== roomId) return;

      if (msg.type === "presence") {
        setPresence((p) => ({ ...p, [msg.playerId]: msg.ts }));
      }
      if (msg.type === "position") {
        setPositions((p) => ({
          ...p,
          [msg.playerId]: { lat: msg.lat, lng: msg.lng, ts: msg.ts },
        }));
      }
      if (msg.type === "game_end") {
        setGameEnded({ winnerId: msg.winnerPlayerId, loserId: msg.loserPlayerId });
      }
    });

    return () => {
      client.end(true);
      clientRef.current = null;
    };
  }, [playerId, roomId]);

  const canPlay = activePlayers.length >= 2 && !gameEnded;

  useEffect(() => {
    if (mqttStatus !== "live") return;
    const id = window.setInterval(() => {
      publish({
        type: "presence",
        roomId,
        playerId,
        ts: Date.now(),
      });
    }, PRESENCE_MS);
    return () => clearInterval(id);
  }, [mqttStatus, playerId, publish, roomId]);

  useEffect(() => {
    if (!canPlay || mqttStatus !== "live") return;
    const id = window.setInterval(() => {
      if (!myPos) return;
      publish({
        type: "position",
        roomId,
        playerId,
        lat: myPos.lat,
        lng: myPos.lng,
        ts: Date.now(),
      });
    }, POS_MS);
    return () => clearInterval(id);
  }, [canPlay, mqttStatus, myPos, playerId, publish, roomId]);

  useEffect(() => {
    if (!navigator.geolocation) return;
    const watch = navigator.geolocation.watchPosition(
      (pos) => {
        setMyPos({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      },
      () => {
        /* GPS optional für Desktop */
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 },
    );
    return () => navigator.geolocation.clearWatch(watch);
  }, []);

  const onTagIds = useCallback(
    (ids: number[]) => {
      if (!canPlay || gameEnded || !slotInfo) return;
      const target = slotInfo.targetTagId;
      if (!ids.includes(target)) return;
      const now = Date.now();
      if (now - lastWinPublish.current < 4000) return;
      lastWinPublish.current = now;
      publish({
        type: "game_end",
        roomId,
        winnerPlayerId: playerId,
        loserPlayerId: slotInfo.opponentId,
        ts: now,
      });
      setGameEnded({ winnerId: playerId, loserId: slotInfo.opponentId });
    },
    [canPlay, gameEnded, playerId, publish, roomId, slotInfo],
  );

  useAprilTagDetector(getVideo, onTagIds, canPlay);

  const othersOnMap = useMemo(() => {
    return Object.entries(positions)
      .filter(([, v]) => nowTick - v.ts < 20000)
      .map(([pid, v]) => ({ playerId: pid, lat: v.lat, lng: v.lng }));
  }, [positions, nowTick]);

  const iWon = gameEnded?.winnerId === playerId;
  const iLost = gameEnded?.loserId === playerId;

  return (
    <div className="flex min-h-[100dvh] flex-col bg-zinc-950 text-zinc-100">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 px-4 py-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-zinc-500">Raum</p>
          <p className="font-mono text-lg font-semibold text-white">{roomId}</p>
        </div>
        <div className="text-right text-sm">
          <p className="text-zinc-500">MQTT</p>
          <p
            className={
              mqttStatus === "live"
                ? "text-emerald-400"
                : mqttStatus === "error"
                  ? "text-red-400"
                  : "text-amber-300"
            }
          >
            {mqttStatus === "live"
              ? "verbunden"
              : mqttStatus === "connecting"
                ? "verbinde…"
                : "Fehler"}
          </p>
        </div>
      </header>

      {gameEnded && (
        <div className="border-b border-zinc-800 bg-zinc-900 px-4 py-6 text-center">
          <h2 className="text-2xl font-bold text-white">
            {iWon ? "Du hast gewonnen!" : iLost ? "Du wurdest gefangen!" : "Spiel beendet"}
          </h2>
          <p className="mt-2 text-sm text-zinc-400">
            {iWon
              ? "Du hast den AprilTag des Gegners erkannt."
              : iLost
                ? "Dein Gegner hat deinen AprilTag gescannt."
                : "Ein Spieler hat gewonnen."}
          </p>
        </div>
      )}

      <div className="relative flex flex-1 flex-col">
        <div
          className={
            view === "camera"
              ? "relative z-20 flex flex-1 flex-col"
              : "pointer-events-none absolute inset-0 z-10 opacity-0"
          }
          aria-hidden={view !== "camera"}
        >
          <Webcam
            ref={webcamRef}
            audio={false}
            mirrored={false}
            videoConstraints={{ facingMode: "environment" }}
            className="h-full min-h-[50vh] w-full flex-1 object-cover"
          />
          {canPlay && !gameEnded && slotInfo && (
            <div className="absolute bottom-4 left-4 right-4 rounded-lg bg-black/70 px-3 py-2 text-sm text-white backdrop-blur">
              <p>
                Halte die Kamera auf den <strong>AprilTag ID {slotInfo.targetTagId}</strong>{" "}
                (Gegner).
              </p>
              <p className="mt-1 text-xs text-zinc-300">
                Dein sichtbarer Tag für den Gegner: <strong>ID {slotInfo.myTagId}</strong>
              </p>
            </div>
          )}
        </div>

        <div
          className={
            view === "map"
              ? "relative z-20 flex flex-1 flex-col gap-3 p-4"
              : "pointer-events-none absolute inset-0 z-10 opacity-0"
          }
          aria-hidden={view !== "map"}
        >
          <div className="min-h-[320px] flex-1 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 shadow-inner">
            <GameMapView myPlayerId={playerId} myPos={myPos} others={othersOnMap} />
          </div>
          <p className="text-xs text-zinc-500">
            GPS wird lokal per <code className="text-zinc-400">watchPosition</code> gelesen und
            alle ~4s über MQTT geteilt.
          </p>
        </div>
      </div>

      <div className="border-t border-zinc-800 bg-zinc-900 px-4 py-3">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setView("map")}
            className={`flex-1 rounded-lg px-4 py-3 text-sm font-medium transition ${
              view === "map"
                ? "bg-blue-600 text-white"
                : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
            }`}
          >
            Karte
          </button>
          <button
            type="button"
            onClick={() => setView("camera")}
            className={`flex-1 rounded-lg px-4 py-3 text-sm font-medium transition ${
              view === "camera"
                ? "bg-blue-600 text-white"
                : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
            }`}
          >
            Kamera
          </button>
        </div>
        <div className="mt-3 space-y-1 text-xs text-zinc-500">
          <p>
            Spieler online (TTL): <strong className="text-zinc-300">{activePlayers.length}</strong>
            {activePlayers.length < 2 && " – warte auf zweiten Spieler im gleichen Raum."}
          </p>
          {slotInfo && !gameEnded && (
            <p>
              Rolle: Spieler {slotInfo.slot} · Zeige Tag <strong>{slotInfo.myTagId}</strong> · Suche
              Tag <strong>{slotInfo.targetTagId}</strong>
            </p>
          )}
          <p>{TAG_FAMILY_NOTE}</p>
        </div>
      </div>
    </div>
  );
}
