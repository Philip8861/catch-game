"use client";

import dynamic from "next/dynamic";
import mqtt, { MqttClient } from "mqtt";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Webcam from "react-webcam";
import { useAprilTagDetector } from "@/components/AprilTagDetector";
import { DroneJamOverlay } from "@/components/DroneJamOverlay";
import type { StormCircle } from "@/components/GameMapView";
import type { GameMessage } from "@/lib/gameTypes";
import { parseGameMessage } from "@/lib/gameTypes";
import { haversineMeters } from "@/lib/geo";
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
  "PoC: tag36h11 (WASM). Drucke Tags aus „apriltag-imgs“/tag36h11 – Spieler 1 = ID 1, Spieler 2 = ID 2, usw. (bis 16).";

type RosterInfo = {
  sorted: string[];
  tagToPlayer: Map<number, string>;
  playerToTag: Map<string, number>;
  myTagId: number;
};

const LOCATION_STORAGE_KEY = "catch-game-use-location";
const STORM_RADIUS_M = 5000;
const STORM_COOLDOWN_MS = 25_000;
const DRONE_JAM_DURATION_MS = 20_000;
const DRONE_JAM_COOLDOWN_MS = 35_000;

type ViewMode = "map" | "camera";

function topicForRoom(roomKey: string) {
  return `catch-game/demo/${roomKey}`;
}

export function CatchGame({ roomId }: { roomId: string }) {
  const roomKey = useMemo(() => roomId.trim().toUpperCase(), [roomId]);
  const playerId = useMemo(() => getOrCreatePlayerId(), []);
  const [view, setView] = useState<ViewMode>("map");
  const [mqttStatus, setMqttStatus] = useState<"connecting" | "live" | "error">("connecting");
  const [presence, setPresence] = useState<Record<string, number>>({});
  const [positions, setPositions] = useState<
    Record<string, { lat: number; lng: number; ts: number }>
  >({});
  const [myPos, setMyPos] = useState<{ lat: number; lng: number } | null>(null);
  const [caught, setCaught] = useState<Record<string, string>>({});
  const [winnerId, setWinnerId] = useState<string | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [scanDebug, setScanDebug] = useState<string>("AprilTag: starte…");
  const [locationHydrated, setLocationHydrated] = useState(false);
  const [locationConsent, setLocationConsent] = useState<boolean | null>(null);
  const [gpsOk, setGpsOk] = useState<boolean | null>(null);
  const [locationDenied, setLocationDenied] = useState(false);
  const [stormMode, setStormMode] = useState(false);
  const [stormCircles, setStormCircles] = useState<StormCircle[]>([]);
  const [stormCooldownUntil, setStormCooldownUntil] = useState(0);
  const [droneJamCooldownUntil, setDroneJamCooldownUntil] = useState(0);
  /** Ende der Störung (ms seit Epoch); 0 = keine aktive Störung. */
  const [jamEndsAt, setJamEndsAt] = useState(0);

  const webcamRef = useRef<Webcam>(null);
  const clientRef = useRef<MqttClient | null>(null);
  const lastCatchByVictim = useRef<Record<string, number>>({});
  const gameEndSentRef = useRef(false);
  const processedDroneJamIdsRef = useRef<string[]>([]);

  const getVideo = useCallback(() => webcamRef.current?.video ?? null, []);

  useEffect(() => {
    const t = window.setTimeout(() => {
      const v = sessionStorage.getItem(LOCATION_STORAGE_KEY);
      if (v === "yes") setLocationConsent(true);
      else if (v === "no") {
        setLocationConsent(false);
        setGpsOk(false);
      } else setLocationConsent(null);
      setLocationHydrated(true);
    }, 0);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const activePlayers = useMemo(() => {
    return Object.entries(presence)
      .filter(([, ts]) => nowTick - ts < PRESENCE_TTL_MS)
      .map(([id]) => id);
  }, [presence, nowTick]);

  const roster = useMemo((): RosterInfo | null => {
    if (activePlayers.length < 2 || !playerId) return null;
    const sorted = [...activePlayers].sort();
    const tagToPlayer = new Map<number, string>();
    const playerToTag = new Map<string, number>();
    sorted.forEach((id, i) => {
      const tag = i + 1;
      tagToPlayer.set(tag, id);
      playerToTag.set(id, tag);
    });
    const myTagId = playerToTag.get(playerId);
    if (myTagId === undefined) return null;
    return { sorted, tagToPlayer, playerToTag, myTagId };
  }, [activePlayers, playerId]);

  const publish = useCallback(
    (msg: GameMessage) => {
      clientRef.current?.publish(topicForRoom(roomKey), JSON.stringify(msg), {
        qos: 0,
        retain: false,
      });
    },
    [roomKey],
  );

  const handleStormPlace = useCallback(
    (lat: number, lng: number) => {
      setStormMode(false);
      if (Date.now() < stormCooldownUntil) return;
      if (!roster) return;

      const center = { lat, lng };
      const hitPlayerIds: string[] = [];
      for (const pid of roster.sorted) {
        if (caught[pid]) continue;
        let pos: { lat: number; lng: number } | null = null;
        if (pid === playerId) pos = myPos;
        else {
          const p = positions[pid];
          if (p && nowTick - p.ts < 45000) pos = { lat: p.lat, lng: p.lng };
        }
        if (!pos) continue;
        if (haversineMeters(center, pos) <= STORM_RADIUS_M) hitPlayerIds.push(pid);
      }

      const ts = Date.now();
      const stormEventId = `${playerId}-${ts}`;
      setStormCooldownUntil(ts + STORM_COOLDOWN_MS);

      publish({
        type: "storm",
        roomId: roomKey,
        stormEventId,
        lat,
        lng,
        radiusM: STORM_RADIUS_M,
        casterPlayerId: playerId,
        hitPlayerIds,
        ts,
      });

      setStormCircles((prev) => {
        if (prev.some((s) => s.id === stormEventId)) return prev;
        return [...prev, { id: stormEventId, lat, lng, radiusM: STORM_RADIUS_M }].slice(-12);
      });

      setCaught((prev) => {
        let next = prev;
        for (const vid of hitPlayerIds) {
          if (next[vid]) continue;
          if (next === prev) next = { ...prev };
          next[vid] = playerId;
        }
        return next;
      });
    },
    [
      stormCooldownUntil,
      roster,
      caught,
      playerId,
      myPos,
      positions,
      nowTick,
      roomKey,
      publish,
    ],
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
          await client.subscribeAsync(topicForRoom(roomKey), { qos: 0 });
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
      if (!msg || msg.roomId !== roomKey) return;

      if (msg.type === "presence") {
        setPresence((p) => ({ ...p, [msg.playerId]: msg.ts }));
      }
      if (msg.type === "position") {
        setPositions((p) => ({
          ...p,
          [msg.playerId]: { lat: msg.lat, lng: msg.lng, ts: msg.ts },
        }));
      }
      if (msg.type === "player_caught") {
        setCaught((p) => {
          if (p[msg.caughtPlayerId]) return p;
          return { ...p, [msg.caughtPlayerId]: msg.catcherPlayerId };
        });
      }
      if (msg.type === "game_end") {
        setWinnerId(msg.winnerPlayerId);
      }
      if (msg.type === "storm") {
        setStormCircles((prev) => {
          if (prev.some((s) => s.id === msg.stormEventId)) return prev;
          return [
            ...prev,
            {
              id: msg.stormEventId,
              lat: msg.lat,
              lng: msg.lng,
              radiusM: msg.radiusM,
            },
          ].slice(-12);
        });
        setCaught((prev) => {
          let next = prev;
          for (const pid of msg.hitPlayerIds) {
            if (next[pid]) continue;
            if (next === prev) next = { ...prev };
            next[pid] = msg.casterPlayerId;
          }
          return next;
        });
      }
      if (msg.type === "drone_jam") {
        if (msg.casterPlayerId === playerId) return;
        const seen = processedDroneJamIdsRef.current;
        if (seen.includes(msg.jamEventId)) return;
        seen.push(msg.jamEventId);
        if (seen.length > 48) seen.splice(0, seen.length - 48);
        setJamEndsAt((prev) => Math.max(prev, msg.endsAt));
      }
    });

    return () => {
      client.end(true);
      clientRef.current = null;
    };
  }, [playerId, roomKey]);

  const canPlay = activePlayers.length >= 2 && !winnerId;
  const iAmCaught = Boolean(playerId && caught[playerId]);
  const stormOnCooldown = nowTick < stormCooldownUntil;

  const startStormMode = useCallback(() => {
    if (!canPlay || iAmCaught || winnerId) return;
    if (Date.now() < stormCooldownUntil) return;
    setView("map");
    setStormMode(true);
  }, [canPlay, iAmCaught, winnerId, stormCooldownUntil]);

  const sendDroneJam = useCallback(() => {
    if (!canPlay || iAmCaught || winnerId) return;
    if (nowTick < droneJamCooldownUntil) return;
    const ts = Date.now();
    const jamEventId = `${playerId}-${ts}`;
    const endsAt = ts + DRONE_JAM_DURATION_MS;
    setDroneJamCooldownUntil(ts + DRONE_JAM_COOLDOWN_MS);
    publish({
      type: "drone_jam",
      roomId: roomKey,
      jamEventId,
      casterPlayerId: playerId,
      endsAt,
      ts,
    });
  }, [
    canPlay,
    iAmCaught,
    winnerId,
    nowTick,
    droneJamCooldownUntil,
    playerId,
    roomKey,
    publish,
  ]);

  const droneJamOnCooldown = nowTick < droneJamCooldownUntil;
  const jamActive = jamEndsAt > nowTick;
  const jamSecondsLeft = jamActive ? Math.max(0, Math.ceil((jamEndsAt - nowTick) / 1000)) : 0;

  const huntTagIds = useMemo(() => {
    if (!roster) return [];
    return roster.sorted
      .filter((pid) => pid !== playerId && !caught[pid])
      .map((pid) => roster.playerToTag.get(pid)!)
      .filter((n) => Number.isFinite(n));
  }, [roster, playerId, caught]);

  useEffect(() => {
    if (!roster || winnerId) return;
    if (roster.sorted.length < 2) return;
    const survivors = roster.sorted.filter((p) => !caught[p]);
    if (survivors.length !== 1) return;
    const w = survivors[0]!;
    if (!gameEndSentRef.current) {
      gameEndSentRef.current = true;
      publish({
        type: "game_end",
        roomId: roomKey,
        winnerPlayerId: w,
        ts: Date.now(),
      });
    }
    window.queueMicrotask(() => setWinnerId(w));
  }, [roster, caught, winnerId, publish, roomKey]);

  useEffect(() => {
    if (mqttStatus !== "live") return;
    const id = window.setInterval(() => {
      publish({
        type: "presence",
        roomId: roomKey,
        playerId,
        ts: Date.now(),
      });
    }, PRESENCE_MS);
    return () => clearInterval(id);
  }, [mqttStatus, playerId, publish, roomKey]);

  useEffect(() => {
    if (mqttStatus !== "live") return;
    const id = window.setInterval(() => {
      if (!myPos) return;
      publish({
        type: "position",
        roomId: roomKey,
        playerId,
        lat: myPos.lat,
        lng: myPos.lng,
        ts: Date.now(),
      });
    }, POS_MS);
    return () => clearInterval(id);
  }, [mqttStatus, myPos, playerId, publish, roomKey]);

  const requestLocationNow = useCallback(() => {
    if (!navigator.geolocation) {
      window.setTimeout(() => setGpsOk(false), 0);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocationDenied(false);
        setGpsOk(true);
        setMyPos({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      },
      (err) => {
        setGpsOk(false);
        if (err.code === 1) setLocationDenied(true);
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 25000 },
    );
  }, []);

  const handleEnableLocation = useCallback(() => {
    try {
      sessionStorage.setItem(LOCATION_STORAGE_KEY, "yes");
    } catch {
      /* private mode */
    }
    setLocationConsent(true);
    setLocationDenied(false);
    requestLocationNow();
  }, [requestLocationNow]);

  const handleDeclineLocation = useCallback(() => {
    try {
      sessionStorage.setItem(LOCATION_STORAGE_KEY, "no");
    } catch {
      /* private mode */
    }
    setLocationConsent(false);
    setLocationDenied(false);
    setGpsOk(false);
    setMyPos(null);
  }, []);

  const handleReopenLocationChoice = useCallback(() => {
    try {
      sessionStorage.removeItem(LOCATION_STORAGE_KEY);
    } catch {
      /* */
    }
    setLocationConsent(null);
    setLocationDenied(false);
  }, []);

  useEffect(() => {
    if (!locationConsent) return;
    if (!navigator.geolocation) {
      const t = window.setTimeout(() => setGpsOk(false), 0);
      return () => clearTimeout(t);
    }
    const onOk = (pos: GeolocationPosition) => {
      setGpsOk(true);
      setMyPos({ lat: pos.coords.latitude, lng: pos.coords.longitude });
    };
    const onErr = (err: GeolocationPositionError) => {
      setGpsOk(false);
      if (err.code === 1) setLocationDenied(true);
      navigator.geolocation.getCurrentPosition(onOk, () => setGpsOk(false), {
        enableHighAccuracy: false,
        maximumAge: 60000,
        timeout: 20000,
      });
    };
    const watch = navigator.geolocation.watchPosition(onOk, onErr, {
      enableHighAccuracy: true,
      maximumAge: 2000,
      timeout: 20000,
    });
    return () => navigator.geolocation.clearWatch(watch);
  }, [locationConsent]);

  const canPlayRef = useRef(canPlay);
  const winnerIdRef = useRef(winnerId);
  const rosterRef = useRef(roster);
  const caughtRef = useRef(caught);
  useLayoutEffect(() => {
    canPlayRef.current = canPlay;
    winnerIdRef.current = winnerId;
    rosterRef.current = roster;
    caughtRef.current = caught;
  }, [canPlay, winnerId, roster, caught]);

  const onTagIds = useCallback(
    (ids: number[]) => {
      if (!canPlayRef.current || winnerIdRef.current || caughtRef.current[playerId]) return;
      const r = rosterRef.current;
      if (!r) return;
      const now = Date.now();
      for (const tid of ids) {
        const victimId = r.tagToPlayer.get(tid);
        if (!victimId || victimId === playerId) continue;
        if (caughtRef.current[victimId]) continue;
        if (tid === r.myTagId) continue;
        const last = lastCatchByVictim.current[victimId] ?? 0;
        if (now - last < 2500) continue;
        lastCatchByVictim.current[victimId] = now;
        publish({
          type: "player_caught",
          roomId: roomKey,
          caughtPlayerId: victimId,
          catcherPlayerId: playerId,
          ts: now,
        });
        setCaught((prev) => {
          if (prev[victimId]) return prev;
          return { ...prev, [victimId]: playerId };
        });
      }
    },
    [playerId, publish, roomKey],
  );

  const aprilEnabled = mqttStatus === "live" && !winnerId && !caught[playerId];
  const onScanDebug = useCallback((s: string) => {
    setScanDebug(s);
  }, []);

  useAprilTagDetector(getVideo, onTagIds, aprilEnabled, onScanDebug);

  const othersOnMap = useMemo(() => {
    return Object.entries(positions)
      .filter(([, v]) => nowTick - v.ts < 45000)
      .map(([pid, v]) => ({ playerId: pid, lat: v.lat, lng: v.lng }));
  }, [positions, nowTick]);

  const playerOneId = roster?.sorted[0];
  const playerOnePos = useMemo(() => {
    if (!playerOneId) return null;
    const p = positions[playerOneId];
    if (p && nowTick - p.ts < 45000) return { lat: p.lat, lng: p.lng };
    if (playerOneId === playerId && myPos) return { lat: myPos.lat, lng: myPos.lng };
    return null;
  }, [playerOneId, positions, nowTick, playerId, myPos]);

  const iWon = winnerId === playerId;

  const showLocationModal = locationHydrated && locationConsent === null;

  return (
    <div className="relative flex min-h-[100dvh] flex-col bg-zinc-950 text-zinc-100">
      {showLocationModal && (
        <div
          className="fixed inset-0 z-[3000] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="location-dialog-title"
        >
          <div className="max-w-md rounded-2xl border border-zinc-700 bg-zinc-900 p-6 shadow-2xl">
            <h2 id="location-dialog-title" className="text-lg font-semibold text-white">
              Standort für die Karte
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-zinc-300">
              Soll diese Seite deinen <strong className="text-zinc-100">Standort</strong> nutzen? So
              sehen du und deine Mitspieler euch auf der Karte. Ohne Standort bist du dort nicht
              sichtbar.
            </p>
            <p className="mt-2 text-xs text-zinc-500">
              <strong className="text-zinc-400">iPhone:</strong> Wenn nichts passiert oder es
              fehlschlägt: Einstellungen → Datenschutz und Sicherheit →{" "}
              <span className="text-zinc-400">Ortungsdienste</span> →{" "}
              <span className="text-zinc-400">Safari-Websites</span> → „Beim Verwenden“ oder
              „Genau“. Seite danach neu laden und erneut „Aktivieren“ tippen.
            </p>
            <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              <button
                type="button"
                onClick={handleEnableLocation}
                className="flex-1 rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-blue-500"
              >
                Standort aktivieren
              </button>
              <button
                type="button"
                onClick={handleDeclineLocation}
                className="flex-1 rounded-xl border border-zinc-600 bg-zinc-800 px-4 py-3 text-sm font-medium text-zinc-200 transition hover:bg-zinc-700"
              >
                Ohne Standort fortfahren
              </button>
            </div>
          </div>
        </div>
      )}

      {locationConsent === false && (
        <div className="border-b border-amber-800/60 bg-amber-950/90 px-4 py-2.5 text-center text-sm text-amber-100">
          <span className="text-amber-200/90">Standort ist aus</span> – Mitspieler sehen dich nicht
          auf der Karte.{" "}
          <button
            type="button"
            onClick={handleReopenLocationChoice}
            className="font-semibold text-amber-300 underline decoration-amber-500/60 underline-offset-2 hover:text-amber-200"
          >
            Standort-Frage erneut anzeigen
          </button>
        </div>
      )}

      {locationConsent === true && locationDenied && (
        <div className="border-b border-red-900/50 bg-red-950/80 px-4 py-2.5 text-center text-xs leading-snug text-red-100">
          <strong className="text-red-200">Standortzugriff verweigert.</strong> Erlaube Ortung für
          diese Website (Safari: Adressleiste → „aa“ → Website-Einstellungen → Standort). Oder
          iPhone: Einstellungen → Datenschutz → Ortungsdienste → Safari-Websites.{" "}
          <button
            type="button"
            onClick={requestLocationNow}
            className="ml-1 font-semibold text-red-200 underline underline-offset-2 hover:text-white"
          >
            Erneut versuchen
          </button>
        </div>
      )}

      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 px-4 py-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-zinc-500">Raum</p>
          <p className="font-mono text-lg font-semibold text-white">{roomKey}</p>
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

      {iAmCaught && !winnerId && (
        <div className="border-b border-orange-900/60 bg-orange-950/90 px-4 py-3 text-center text-sm text-orange-100">
          <strong className="text-orange-200">Du wurdest gefangen</strong> – du kannst noch die
          Karte ansehen, nimmst aber nicht mehr am Jagen teil.
        </div>
      )}

      {winnerId && (
        <div className="border-b border-zinc-800 bg-zinc-900 px-4 py-6 text-center">
          <h2 className="text-2xl font-bold text-white">
            {iWon ? "Du hast gewonnen!" : "Spiel beendet"}
          </h2>
          <p className="mt-2 text-sm text-zinc-400">
            {iWon
              ? "Du bist der letzte aktive Spieler."
              : `Gewonnen hat ein Mitspieler (Session ${winnerId.slice(0, 8)}…).`}
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
          <div className="relative min-h-[50vh] w-full flex-1 overflow-hidden bg-black">
            <Webcam
              ref={webcamRef}
              audio={false}
              mirrored={false}
              videoConstraints={{
                width: { ideal: 1280 },
                height: { ideal: 720 },
                facingMode: { ideal: "environment" },
              }}
              className="h-full min-h-[50vh] w-full object-cover"
            />
            <div
              className="pointer-events-none absolute inset-0 z-[15] flex items-center justify-center"
              aria-hidden
            >
              <div className="absolute left-1/2 top-0 bottom-0 w-[2px] -translate-x-1/2 bg-white/75 shadow-[0_0_6px_rgba(0,0,0,0.85)]" />
              <div className="absolute top-1/2 left-0 right-0 h-[2px] -translate-y-1/2 bg-white/75 shadow-[0_0_6px_rgba(0,0,0,0.85)]" />
              <div className="absolute left-1/2 top-1/2 size-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white/80 shadow-[0_0_6px_rgba(0,0,0,0.85)]" />
            </div>
            <DroneJamOverlay active={jamActive} secondsLeft={jamSecondsLeft} />
            {canPlay && !winnerId && roster && (
              <div className="pointer-events-none absolute bottom-4 left-4 right-4 z-[20] rounded-lg bg-black/70 px-3 py-2 text-sm text-white backdrop-blur">
                <p>
                  Dein AprilTag: <strong>ID {roster.myTagId}</strong> – zeige ihn den anderen. Du
                  darfst <strong>jeden anderen</strong> Spieler jagen (AprilTag seiner Nummer
                  scannen).
                </p>
                <p className="mt-1 text-xs text-zinc-300">
                  Jagbare Tag-IDs jetzt:{" "}
                  <strong>{huntTagIds.length ? huntTagIds.join(", ") : "—"}</strong>
                  {roster.sorted.length > 2 && ` · ${roster.sorted.length} Spieler im Raum`}
                </p>
              </div>
            )}
          </div>
        </div>

        <div
          className={
            view === "map"
              ? "relative z-20 flex flex-1 flex-col gap-3 p-4"
              : "pointer-events-none absolute inset-0 z-10 opacity-0"
          }
          aria-hidden={view !== "map"}
        >
          {stormMode && (
            <div className="rounded-lg border border-violet-700/60 bg-violet-950/90 px-3 py-2 text-sm text-violet-100">
              <strong>Sturm-Modus:</strong> Tippe auf die Karte, um einen Kreis mit 5&nbsp;km Radius zu
              setzen. Alle Spieler darin gelten als gefangen.{" "}
              <button
                type="button"
                className="ml-1 underline decoration-violet-400 hover:text-white"
                onClick={() => setStormMode(false)}
              >
                Abbrechen
              </button>
            </div>
          )}
          <div className="min-h-[320px] flex-1 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 shadow-inner">
            <GameMapView
              myPlayerId={playerId}
              myPos={myPos}
              others={othersOnMap}
              playerOnePos={playerOnePos}
              stormMode={stormMode}
              onStormPlace={handleStormPlace}
              stormCircles={stormCircles}
            />
          </div>
          <p className="text-xs text-zinc-500">
            GPS:{" "}
            {!locationHydrated
              ? "…"
              : locationConsent === null
                ? "Bitte Entscheidung im Dialog treffen."
                : locationConsent === false
                  ? "aus – du wirst auf der Karte nicht geteilt."
                  : gpsOk === null
                    ? "Suche Standort…"
                    : gpsOk
                      ? "aktiv – Position wird ~alle 4s gesendet."
                      : "kein Fix – siehe Hinweis oben oder „Erneut versuchen“."}
          </p>
          <p className="text-xs text-zinc-600">
            Karte: beim ersten GPS-Fix ~<strong className="text-zinc-400">10 km</strong> um dich; Zoom
            und Verschieben bleiben erhalten („Zu mir (10 km)“ setzt die Ansicht zurück).{" "}
            <strong className="text-zinc-400">Spieler 1</strong> hat einen sichtbaren Kreis mit{" "}
            <strong className="text-zinc-400">40 km</strong> Radius.
          </p>
        </div>
      </div>

      <div className="border-t border-zinc-800 bg-zinc-900 px-4 py-3">
        <p className="mb-2 text-center text-xs text-zinc-500">
          Spezialaktionen <span className="text-zinc-400">(ganz unten, über Karte/Kamera)</span>
        </p>
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={startStormMode}
            disabled={!canPlay || iAmCaught || !!winnerId || stormOnCooldown}
            title={
              !canPlay && !winnerId
                ? "Ab zwei Spielern im Raum nutzbar."
                : stormOnCooldown
                  ? `Sturm abklingend (${Math.ceil((stormCooldownUntil - nowTick) / 1000)} s)`
                  : undefined
            }
            className="w-full rounded-lg border border-transparent px-4 py-3 text-sm font-medium transition enabled:border-violet-500/40 enabled:bg-violet-700 enabled:text-white enabled:hover:bg-violet-600 disabled:cursor-not-allowed disabled:border-violet-900/50 disabled:bg-violet-950/50 disabled:text-violet-200/70"
          >
            {stormOnCooldown
              ? `Sturm (${Math.max(0, Math.ceil((stormCooldownUntil - nowTick) / 1000))} s)`
              : "Sturm"}
          </button>
          <button
            type="button"
            onClick={sendDroneJam}
            disabled={!canPlay || iAmCaught || !!winnerId || droneJamOnCooldown}
            title={
              !canPlay && !winnerId
                ? "Ab zwei Spielern im Raum nutzbar."
                : droneJamOnCooldown
                  ? `Drohnen-Störung abklingend (${Math.ceil((droneJamCooldownUntil - nowTick) / 1000)} s)`
                  : "Andere sehen 20 s nur Rauschen über dem Kamerabild (Karte & Steuerung bleiben normal)."
            }
            className="w-full rounded-lg border border-transparent px-4 py-3 text-sm font-medium transition enabled:border-amber-500/40 enabled:bg-amber-700 enabled:text-white enabled:hover:bg-amber-600 disabled:cursor-not-allowed disabled:border-amber-900/60 disabled:bg-amber-950/50 disabled:text-amber-100/75"
          >
            {droneJamOnCooldown
              ? `Drohnen-Störung (${Math.max(0, Math.ceil((droneJamCooldownUntil - nowTick) / 1000))} s)`
              : "Drohnen-Störung"}
          </button>
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
              onClick={() => {
                setStormMode(false);
                setView("camera");
              }}
              className={`flex-1 rounded-lg px-4 py-3 text-sm font-medium transition ${
                view === "camera"
                  ? "bg-blue-600 text-white"
                  : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
              }`}
            >
              Kamera
            </button>
          </div>
        </div>
        <div className="mt-3 space-y-1 text-xs text-zinc-500">
          {!canPlay && !winnerId && (
            <p className="text-amber-200/80">
              <strong className="text-amber-100">Drohnen-Störung &amp; Sturm:</strong> sichtbar als
              violette und orangefarbene Buttons oben in dieser Leiste – sie werden erst{" "}
              <strong className="text-amber-50">klickbar</strong>, wenn mindestens{" "}
              <strong className="text-amber-50">zwei Spieler</strong> online sind (gleicher Raumcode).
            </p>
          )}
          <p>
            Spieler online (TTL): <strong className="text-zinc-300">{activePlayers.length}</strong>
            {activePlayers.length < 2 && " – mindestens zwei Spieler für die Jagd."}
          </p>
          {roster && !winnerId && (
            <p>
              Dein Tag: <strong>{roster.myTagId}</strong> · Jagen: beliebige andere Tag-IDs (
              {huntTagIds.length ? huntTagIds.join(", ") : "—"}) · Gefangen:{" "}
              <strong className="text-zinc-300">{Object.keys(caught).length}</strong>
            </p>
          )}
          <p>{TAG_FAMILY_NOTE}</p>
          <p className="font-mono text-[11px] text-zinc-400">
            Scan: {scanDebug}
          </p>
        </div>
      </div>
    </div>
  );
}
