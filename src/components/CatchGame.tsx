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
import { HpDamageFloaters } from "@/components/HpDamageFloaters";
import type { StormCircle, SuperBeamLine } from "@/components/GameMapView";
import type { GameMessage } from "@/lib/gameTypes";
import { parseGameMessage } from "@/lib/gameTypes";
import {
  beamGroundCorridor,
  compassHeadingFromEvent,
  destinationLatLng,
  isPointInBeamCorridor,
} from "@/lib/beamGeo";
import { haversineMeters } from "@/lib/geo";
import { getOrCreatePlayerId } from "@/lib/playerId";
import {
  playWeaponFireSound,
  unlockWeaponAudioFromUserGesture,
} from "@/lib/weaponFireSfx";

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
const STORM_HP_DAMAGE = 500;
const STORM_RADIUS_M = 5000;
const STORM_COOLDOWN_MS = 25_000;
const DRONE_JAM_DURATION_MS = 20_000;
const DRONE_JAM_COOLDOWN_MS = 35_000;

const MAX_HP = 1000;
const SNIPER_COOLDOWN_MS = 2000;
const SNIPER_DMG_MIN = 40;
const SNIPER_DMG_MAX = 90;
const SEMI_COOLDOWN_MS = 500;
const SEMI_DMG_MIN = 15;
const SEMI_DMG_MAX = 35;
/** Crit verdoppelt den pro Schuss gewürfelten Waffenschaden. */
const WEAPON_CRIT_MULT = 2;
const DEFAULT_CRIT_CHANCE = 0.1;
const DMG_CRIT_PCT_MIN = 10;
const DMG_CRIT_PCT_MAX = 100;
const HEAL_PER_SEC = 25;
const HEAL_FLOATER_CHUNK = 25;
const TAG_LOCK_TTL_MS = 450;
const TAG_LOCK_PUBLISH_INTERVAL_MS = 100;
/** Luftangriff (Superstrahl): 20 m Länge, 10 m Gesamtbreite (halbe Breite 5 m). */
const SUPER_BEAM_LENGTH_M = 20;
const SUPER_BEAM_HALF_WIDTH_M = 5;
const SUPER_BEAM_COUNTDOWN_MS = 3000;
const SUPER_BEAM_COOLDOWN_MS = 42_000;
const SUPER_BEAM_MAP_TTL_MS = 90_000;
const SUPER_BEAM_WARNING_LINES =
  "WARNING, WARNING WARNING STORM IS COMING" as const;

function combatRoleStorageKey(roomKey: string) {
  return `catch-game-combat-role:${roomKey}`;
}

function weaponStorageKey(roomKey: string) {
  return `catch-game-weapon:${roomKey}`;
}

function dmgCritPctStorageKey(roomKey: string) {
  return `catch-game-dmg-crit-pct:${roomKey}`;
}

type ViewMode = "map" | "camera";
type CombatRole = "dmg" | "heal";
type WeaponType = "sniper" | "semi";

function topicForRoom(roomKey: string) {
  return `catch-game/demo/${roomKey}`;
}

/** Kurzes Haptik-Feedback für das getroffene Gerät (Android u. a.; iOS Safari meist ohne API). */
function vibrateOnWeaponHit(isCrit: boolean) {
  if (typeof navigator === "undefined") return;
  if (typeof navigator.vibrate !== "function") return;
  const pattern: number[] = isCrit ? [55, 40, 65] : [42];
  try {
    navigator.vibrate(pattern);
  } catch {
    /* manche Browser/WebViews blocken ohne User-Gesture */
  }
}

/** Haptik auf dem Schützen-Gerät beim Abgeben eines Schusses (Halbauto kurz, Sniper kräftiger). */
function vibrateOnWeaponFired(weapon: WeaponType, isCrit: boolean) {
  if (typeof navigator === "undefined") return;
  if (typeof navigator.vibrate !== "function") return;
  let pattern: number[];
  if (weapon === "sniper") {
    pattern = isCrit ? [38, 22, 52] : [32];
  } else {
    pattern = isCrit ? [18, 10, 24] : [12];
  }
  try {
    navigator.vibrate(pattern);
  } catch {
    /* oft nur nach vorheriger Nutzerinteraktion (z. B. Feuer-Knopf) */
  }
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
  const [stormCircles, setStormCircles] = useState<StormCircle[]>([]);
  const [stormMode, setStormMode] = useState(false);
  const [stormCooldownUntil, setStormCooldownUntil] = useState(0);
  const [droneJamCooldownUntil, setDroneJamCooldownUntil] = useState(0);
  /** Ende der Störung (ms seit Epoch); 0 = keine aktive Störung. */
  const [jamEndsAt, setJamEndsAt] = useState(0);
  const [hpDisplay, setHpDisplay] = useState(MAX_HP);
  const [tagBeamActive, setTagBeamActive] = useState(false);
  const [hpFloaters, setHpFloaters] = useState<
    Array<{ id: string; text: string; variant?: "damage" | "heal" | "crit" }>
  >([]);
  const [aimHuntTagId, setAimHuntTagId] = useState<number | null>(null);
  const [combatRoleHydrated, setCombatRoleHydrated] = useState(false);
  const [combatRole, setCombatRole] = useState<CombatRole | null>(null);
  const [tagHealActive, setTagHealActive] = useState(false);
  const [weaponChoice, setWeaponChoice] = useState<WeaponType>("sniper");
  const [dmgCritPercent, setDmgCritPercent] = useState(DMG_CRIT_PCT_MIN);
  const [firePressed, setFirePressed] = useState(false);
  const [superBeams, setSuperBeams] = useState<SuperBeamLine[]>([]);
  const [superBeamCooldownActive, setSuperBeamCooldownActive] = useState(false);
  const [superBeamWarnings, setSuperBeamWarnings] = useState<
    Array<{ id: string; impactAt: number }>
  >([]);

  const webcamRef = useRef<Webcam>(null);
  const clientRef = useRef<MqttClient | null>(null);
  const gameEndSentRef = useRef(false);
  const processedDroneJamIdsRef = useRef<string[]>([]);
  const processedStormDamageIdsRef = useRef<string[]>([]);
  const hpRef = useRef(MAX_HP);
  const tagDamageLockUntilRef = useRef(0);
  const tagHealLockUntilRef = useRef(0);
  const lastCombatFrameRef = useRef(0);
  const prevDamageLockedRef = useRef(false);
  const prevHealLockedRef = useRef(false);
  const prevTagBeamUiRef = useRef(false);
  const prevHealBeamUiRef = useRef(false);
  const lastTagLockScannerRef = useRef<string | null>(null);
  const zeroHpHandledRef = useRef(false);
  const lastTagLockPublishRef = useRef<Record<string, number>>({});
  const lastTagHealPublishRef = useRef<Record<string, number>>({});
  const tagHealVisualDebtRef = useRef(0);
  const processedWeaponHitIdsRef = useRef<string[]>([]);
  const processedSuperBeamMapIdsRef = useRef<string[]>([]);
  const processedSuperBeamDamageIdsRef = useRef<string[]>([]);
  const orientationHeadingRef = useRef<number | null>(null);
  const fireHeldRef = useRef(false);
  const aimVictimPlayerIdRef = useRef<string | null>(null);
  const weaponTypeRef = useRef<WeaponType>("sniper");
  const lastSniperShotAtRef = useRef(0);
  const lastSemiShotAtRef = useRef(0);
  const dmgCritChanceRef = useRef(DEFAULT_CRIT_CHANCE);
  const spawnCombatFloaterRef = useRef<
    (text: string, variant?: "damage" | "heal" | "crit") => void
  >(() => {});
  const prevAimHuntTagRef = useRef<number | null>(null);
  const combatRoleRef = useRef<CombatRole | null>(null);
  const superBeamCooldownUntilRef = useRef(0);

  const getVideo = useCallback(() => webcamRef.current?.video ?? null, []);

  useLayoutEffect(() => {
    spawnCombatFloaterRef.current = (
      text: string,
      variant: "damage" | "heal" | "crit" = "damage",
    ) => {
      const id = `f-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      setHpFloaters((prev) => [...prev.slice(-24), { id, text, variant }]);
      window.setTimeout(() => {
        setHpFloaters((prev) => prev.filter((x) => x.id !== id));
      }, 1200);
    };
  }, []);

  useLayoutEffect(() => {
    combatRoleRef.current = combatRole;
  }, [combatRole]);

  useLayoutEffect(() => {
    weaponTypeRef.current = weaponChoice;
  }, [weaponChoice]);

  useLayoutEffect(() => {
    dmgCritChanceRef.current = dmgCritPercent / 100;
  }, [dmgCritPercent]);

  useEffect(() => {
    const release = () => {
      fireHeldRef.current = false;
      setFirePressed(false);
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
    };
  }, []);

  const pickWeapon = useCallback(
    (w: WeaponType) => {
      unlockWeaponAudioFromUserGesture();
      setWeaponChoice(w);
      try {
        sessionStorage.setItem(weaponStorageKey(roomKey), w);
      } catch {
        /* */
      }
    },
    [roomKey],
  );

  const onDmgCritPercentChange = useCallback(
    (v: number) => {
      const c = Math.round(
        Math.min(DMG_CRIT_PCT_MAX, Math.max(DMG_CRIT_PCT_MIN, v)),
      );
      setDmgCritPercent(c);
      try {
        sessionStorage.setItem(dmgCritPctStorageKey(roomKey), String(c));
      } catch {
        /* */
      }
    },
    [roomKey],
  );

  useEffect(() => {
    const t = window.setTimeout(() => {
      try {
        const r = sessionStorage.getItem(combatRoleStorageKey(roomKey));
        if (r === "heal" || r === "dmg") setCombatRole(r);
        else setCombatRole(null);
      } catch {
        setCombatRole(null);
      }
      setCombatRoleHydrated(true);
    }, 0);
    return () => clearTimeout(t);
  }, [roomKey]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      try {
        const w = sessionStorage.getItem(weaponStorageKey(roomKey));
        if (w === "sniper" || w === "semi") setWeaponChoice(w);
      } catch {
        /* */
      }
    }, 0);
    return () => clearTimeout(t);
  }, [roomKey]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      try {
        const raw = sessionStorage.getItem(dmgCritPctStorageKey(roomKey));
        const n = raw !== null ? Number(raw) : NaN;
        if (Number.isFinite(n)) {
          setDmgCritPercent(
            Math.round(
              Math.min(DMG_CRIT_PCT_MAX, Math.max(DMG_CRIT_PCT_MIN, n)),
            ),
          );
        }
      } catch {
        /* */
      }
    }, 0);
    return () => clearTimeout(t);
  }, [roomKey]);

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

  useEffect(() => {
    const onOri = (ev: DeviceOrientationEvent) => {
      const h = compassHeadingFromEvent(ev);
      if (h !== null) orientationHeadingRef.current = h;
    };
    window.addEventListener("deviceorientation", onOri, true);
    return () => window.removeEventListener("deviceorientation", onOri, true);
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
      if (!combatRole) return;
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
    },
    [
      stormCooldownUntil,
      combatRole,
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
        if (msg.caughtPlayerId === playerId) {
          hpRef.current = 0;
          setHpDisplay(0);
          zeroHpHandledRef.current = true;
        }
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
        const dmgSeen = processedStormDamageIdsRef.current;
        if (!dmgSeen.includes(msg.stormEventId)) {
          dmgSeen.push(msg.stormEventId);
          if (dmgSeen.length > 80) dmgSeen.splice(0, 40);
          if (msg.hitPlayerIds.includes(playerId) && !zeroHpHandledRef.current) {
            const nextHp = Math.max(0, hpRef.current - STORM_HP_DAMAGE);
            hpRef.current = nextHp;
            window.queueMicrotask(() => {
              setHpDisplay(Math.round(nextHp));
            });
            const pops = STORM_HP_DAMAGE / 50;
            for (let i = 0; i < pops; i++) {
              window.setTimeout(() => {
                spawnCombatFloaterRef.current("-50 HP", "damage");
              }, i * 55);
            }
            if (nextHp <= 0 && !zeroHpHandledRef.current) {
              zeroHpHandledRef.current = true;
              const ts = Date.now();
              publish({
                type: "player_caught",
                roomId: roomKey,
                caughtPlayerId: playerId,
                catcherPlayerId: msg.casterPlayerId,
                ts,
              });
              setCaught((p) => (p[playerId] ? p : { ...p, [playerId]: msg.casterPlayerId }));
            }
          }
        }
      }
      if (msg.type === "drone_jam") {
        if (msg.casterPlayerId === playerId) return;
        const seen = processedDroneJamIdsRef.current;
        if (seen.includes(msg.jamEventId)) return;
        seen.push(msg.jamEventId);
        if (seen.length > 48) seen.splice(0, seen.length - 48);
        setJamEndsAt((prev) => Math.max(prev, msg.endsAt));
      }
      if (msg.type === "tag_lock") {
        if (msg.victimPlayerId !== playerId) return;
        const t = Date.now();
        tagDamageLockUntilRef.current = t + TAG_LOCK_TTL_MS;
        lastTagLockScannerRef.current = msg.scannerPlayerId;
      }
      if (msg.type === "weapon_hit") {
        if (msg.roomId !== roomKey) return;
        if (msg.victimPlayerId !== playerId) return;
        const seen = processedWeaponHitIdsRef.current;
        if (seen.includes(msg.hitId)) return;
        seen.push(msg.hitId);
        if (seen.length > 120) seen.splice(0, 60);
        let dmg = msg.damage;
        if (typeof dmg !== "number" || !Number.isFinite(dmg)) return;
        dmg = Math.max(1, Math.min(500, Math.round(dmg)));
        if (zeroHpHandledRef.current) return;
        const nextHp = Math.max(0, hpRef.current - dmg);
        hpRef.current = nextHp;
        const isCrit = msg.isCrit === true;
        vibrateOnWeaponHit(isCrit);
        window.queueMicrotask(() => {
          setHpDisplay(Math.round(nextHp));
        });
        const w = msg.weapon;
        const label = w === "sniper" ? "Sniper" : w === "semi" ? "Halbauto" : "";
        if (isCrit) {
          spawnCombatFloaterRef.current(
            label ? `-${dmg} CRIT! (${label})` : `-${dmg} CRIT!`,
            "crit",
          );
        } else {
          spawnCombatFloaterRef.current(
            label ? `-${dmg} (${label})` : `-${dmg} HP`,
            "damage",
          );
        }
        if (nextHp <= 0 && !zeroHpHandledRef.current) {
          zeroHpHandledRef.current = true;
          const catcher = lastTagLockScannerRef.current;
          const ts = Date.now();
          if (catcher && catcher !== playerId) {
            publish({
              type: "player_caught",
              roomId: roomKey,
              caughtPlayerId: playerId,
              catcherPlayerId: catcher,
              ts,
            });
            setCaught((p) => (p[playerId] ? p : { ...p, [playerId]: catcher }));
          } else {
            zeroHpHandledRef.current = false;
            hpRef.current = 1;
            setHpDisplay(1);
          }
        }
      }
      if (msg.type === "super_beam") {
        if (msg.roomId !== roomKey) return;
        const oLat = msg.originLat;
        const oLng = msg.originLng;
        const eLat = msg.endLat;
        const eLng = msg.endLng;
        const hw = msg.halfWidthM;
        if (
          [oLat, oLng, eLat, eLng, hw].some(
            (x) => typeof x !== "number" || !Number.isFinite(x),
          ) ||
          hw <= 0
        ) {
          return;
        }
        const mapSeen = processedSuperBeamMapIdsRef.current;
        if (!mapSeen.includes(msg.superBeamId)) {
          mapSeen.push(msg.superBeamId);
          if (mapSeen.length > 120) mapSeen.splice(0, 60);
          const corridor = beamGroundCorridor(oLat, oLng, eLat, eLng, hw);
          setSuperBeams((prev) =>
            [
              ...prev.filter((x) => x.id !== msg.superBeamId),
              {
                id: msg.superBeamId,
                casterId: msg.casterPlayerId,
                corridor,
                ts: msg.ts,
              },
            ].slice(-24),
          );
        }
        if (
          msg.hitPlayerIds.includes(playerId) &&
          !zeroHpHandledRef.current &&
          typeof msg.impactAt === "number" &&
          Number.isFinite(msg.impactAt)
        ) {
          setSuperBeamWarnings((prev) =>
            prev.some((w) => w.id === msg.superBeamId)
              ? prev
              : [...prev, { id: msg.superBeamId, impactAt: msg.impactAt }],
          );
          const delay = Math.max(0, msg.impactAt - Date.now());
          const superBeamId = msg.superBeamId;
          const casterPlayerId = msg.casterPlayerId;
          window.setTimeout(() => {
            const dmgSeen = processedSuperBeamDamageIdsRef.current;
            if (dmgSeen.includes(superBeamId)) return;
            if (zeroHpHandledRef.current) return;
            dmgSeen.push(superBeamId);
            if (dmgSeen.length > 120) dmgSeen.splice(0, 60);
            const nextHp = Math.max(0, hpRef.current - STORM_HP_DAMAGE);
            hpRef.current = nextHp;
            window.queueMicrotask(() => {
              setHpDisplay(Math.round(nextHp));
            });
            const pops = STORM_HP_DAMAGE / 50;
            for (let i = 0; i < pops; i++) {
              window.setTimeout(() => {
                spawnCombatFloaterRef.current("-50 HP", "damage");
              }, i * 55);
            }
            vibrateOnWeaponHit(false);
            if (nextHp <= 0 && !zeroHpHandledRef.current) {
              zeroHpHandledRef.current = true;
              const ts = Date.now();
              publish({
                type: "player_caught",
                roomId: roomKey,
                caughtPlayerId: playerId,
                catcherPlayerId: casterPlayerId,
                ts,
              });
              setCaught((p) =>
                p[playerId] ? p : { ...p, [playerId]: casterPlayerId },
              );
            }
            setSuperBeamWarnings((prev) =>
              prev.filter((w) => w.id !== superBeamId),
            );
          }, delay);
        }
      }
      if (msg.type === "tag_heal") {
        if (msg.victimPlayerId !== playerId) return;
        const t = Date.now();
        tagHealLockUntilRef.current = t + TAG_LOCK_TTL_MS;
      }
    });

    return () => {
      client.end(true);
      clientRef.current = null;
    };
  }, [playerId, roomKey, publish]);

  const visibleSuperBeams = useMemo(
    () => superBeams.filter((b) => nowTick - b.ts < SUPER_BEAM_MAP_TTL_MS),
    [superBeams, nowTick],
  );

  const superBeamHudSeconds = useMemo(() => {
    if (superBeamWarnings.length === 0) return null;
    const tMin = Math.min(...superBeamWarnings.map((w) => w.impactAt));
    return Math.max(0, Math.ceil((tMin - nowTick) / 1000));
  }, [superBeamWarnings, nowTick]);

  const canPlay = activePlayers.length >= 2 && !winnerId;
  const canPlayWithRole = canPlay && combatRole !== null;
  const iAmCaught = Boolean(playerId && caught[playerId]);
  const stormOnCooldown = nowTick < stormCooldownUntil;

  const startStormMode = useCallback(() => {
    if (!canPlayWithRole || iAmCaught || winnerId) return;
    if (Date.now() < stormCooldownUntil) return;
    setView("map");
    setStormMode(true);
  }, [canPlayWithRole, iAmCaught, winnerId, stormCooldownUntil]);

  const sendDroneJam = useCallback(() => {
    if (!canPlayWithRole || iAmCaught || winnerId) return;
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
    canPlayWithRole,
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

  const placeSuperBeam = useCallback(async () => {
    if (!roster || winnerId || caught[playerId] || !canPlay) {
      setScanDebug("Luftangriff: nur mit aktivem Raum / Spiel");
      return;
    }
    if (!myPos) {
      setScanDebug("Luftangriff: GPS nötig (Standort aktivieren)");
      return;
    }
    if (Date.now() < superBeamCooldownUntilRef.current) return;
    try {
      const DOE = DeviceOrientationEvent as unknown as {
        requestPermission?: () => Promise<PermissionState>;
      };
      if (typeof DOE.requestPermission === "function") {
        const p = await DOE.requestPermission();
        if (p !== "granted") {
          setScanDebug("Luftangriff: „Bewegung & Ausrichtung“ erlauben (iOS)");
          return;
        }
      }
    } catch {
      setScanDebug("Luftangriff: Sensoren nicht verfügbar");
      return;
    }
    const heading = orientationHeadingRef.current;
    if (heading === null || !Number.isFinite(heading)) {
      setScanDebug("Luftangriff: Kompass kalibrieren / Handy kurz drehen");
      return;
    }
    const end = destinationLatLng(
      myPos.lat,
      myPos.lng,
      heading,
      SUPER_BEAM_LENGTH_M,
    );
    const hitPlayerIds: string[] = [];
    for (const pid of roster.sorted) {
      if (pid === playerId) continue;
      if (caught[pid]) continue;
      let pos: { lat: number; lng: number } | null = null;
      const p = positions[pid];
      if (p && nowTick - p.ts < 45000) pos = { lat: p.lat, lng: p.lng };
      if (!pos) continue;
      if (
        isPointInBeamCorridor(
          pos.lat,
          pos.lng,
          myPos.lat,
          myPos.lng,
          end.lat,
          end.lng,
          SUPER_BEAM_HALF_WIDTH_M,
        )
      ) {
        hitPlayerIds.push(pid);
      }
    }
    const ts = Date.now();
    const impactAt = ts + SUPER_BEAM_COUNTDOWN_MS;
    const superBeamId = `sb-${playerId}-${ts}`;
    superBeamCooldownUntilRef.current = ts + SUPER_BEAM_COOLDOWN_MS;
    setSuperBeamCooldownActive(true);
    window.setTimeout(() => {
      superBeamCooldownUntilRef.current = 0;
      setSuperBeamCooldownActive(false);
    }, SUPER_BEAM_COOLDOWN_MS);

    const corridor = beamGroundCorridor(
      myPos.lat,
      myPos.lng,
      end.lat,
      end.lng,
      SUPER_BEAM_HALF_WIDTH_M,
    );

    publish({
      type: "super_beam",
      roomId: roomKey,
      superBeamId,
      casterPlayerId: playerId,
      originLat: myPos.lat,
      originLng: myPos.lng,
      endLat: end.lat,
      endLng: end.lng,
      lengthM: SUPER_BEAM_LENGTH_M,
      halfWidthM: SUPER_BEAM_HALF_WIDTH_M,
      hitPlayerIds,
      impactAt,
      ts,
    });

    setSuperBeams((prev) => {
      if (prev.some((b) => b.id === superBeamId)) return prev;
      return [
        ...prev,
        { id: superBeamId, casterId: playerId, corridor, ts },
      ].slice(-24);
    });

    setScanDebug(
      hitPlayerIds.length
        ? `Luftangriff: ${hitPlayerIds.length} im Korridor – ${SUPER_BEAM_COUNTDOWN_MS / 1000}s Warnung`
        : "Luftangriff auf Karte – niemand im Korridor",
    );
  }, [roster, winnerId, caught, playerId, canPlay, myPos, positions, nowTick, roomKey, publish]);

  useEffect(() => {
    if (roster) return;
    hpRef.current = MAX_HP;
    zeroHpHandledRef.current = false;
    tagDamageLockUntilRef.current = 0;
    tagHealLockUntilRef.current = 0;
    lastTagLockScannerRef.current = null;
    lastTagLockPublishRef.current = {};
    lastTagHealPublishRef.current = {};
    tagHealVisualDebtRef.current = 0;
    processedWeaponHitIdsRef.current = [];
    processedSuperBeamMapIdsRef.current = [];
    processedSuperBeamDamageIdsRef.current = [];
    fireHeldRef.current = false;
    aimVictimPlayerIdRef.current = null;
    window.queueMicrotask(() => setFirePressed(false));
    window.queueMicrotask(() => {
      setHpDisplay(MAX_HP);
      setHpFloaters([]);
      setAimHuntTagId(null);
      setSuperBeams([]);
      setSuperBeamWarnings([]);
      superBeamCooldownUntilRef.current = 0;
      setSuperBeamCooldownActive(false);
      prevAimHuntTagRef.current = null;
    });
  }, [roster]);

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

  useEffect(() => {
    lastCombatFrameRef.current = Date.now();
    let frame = 0;
    let alive = true;
    const step = () => {
      if (!alive) return;
      const now = Date.now();
      const dt = Math.min(0.2, (now - lastCombatFrameRef.current) / 1000);
      lastCombatFrameRef.current = now;

      const damageLocked =
        now < tagDamageLockUntilRef.current &&
        canPlayRef.current &&
        !caughtRef.current[playerId] &&
        !winnerIdRef.current;

      const healLocked =
        now < tagHealLockUntilRef.current &&
        canPlayRef.current &&
        !caughtRef.current[playerId] &&
        !winnerIdRef.current &&
        hpRef.current < MAX_HP;

      if (prevDamageLockedRef.current !== damageLocked) {
        prevDamageLockedRef.current = damageLocked;
      }
      if (prevHealLockedRef.current !== healLocked) {
        prevHealLockedRef.current = healLocked;
        tagHealVisualDebtRef.current = 0;
      }

      if (prevTagBeamUiRef.current !== damageLocked) {
        prevTagBeamUiRef.current = damageLocked;
        setTagBeamActive(damageLocked);
      }
      if (prevHealBeamUiRef.current !== healLocked) {
        prevHealBeamUiRef.current = healLocked;
        setTagHealActive(healLocked);
      }

      if (dt > 0) {
        let hp = hpRef.current;

        const shooterOk =
          canPlayRef.current &&
          !caughtRef.current[playerId] &&
          !winnerIdRef.current;
        /** Sound auch ohne zweiten Spieler / canPlay – nur Treffer brauchen shooterOk */
        const weaponSoundOk =
          !caughtRef.current[playerId] && !winnerIdRef.current;

        if (
          combatRoleRef.current === "dmg" &&
          fireHeldRef.current &&
          weaponSoundOk
        ) {
          const victim = aimVictimPlayerIdRef.current;
          const weapon = weaponTypeRef.current;
          if (weapon === "sniper") {
            if (now - lastSniperShotAtRef.current >= SNIPER_COOLDOWN_MS) {
              lastSniperShotAtRef.current = now;
              if (victim && shooterOk) {
                const base =
                  SNIPER_DMG_MIN +
                  Math.floor(
                    Math.random() * (SNIPER_DMG_MAX - SNIPER_DMG_MIN + 1),
                  );
                const crit = Math.random() < dmgCritChanceRef.current;
                const dmg = crit
                  ? Math.round(base * WEAPON_CRIT_MULT)
                  : base;
                const hitId = `${playerId}-${now}-${Math.random().toString(36).slice(2, 10)}`;
                publish({
                  type: "weapon_hit",
                  roomId: roomKey,
                  hitId,
                  shooterPlayerId: playerId,
                  victimPlayerId: victim,
                  damage: dmg,
                  weapon: "sniper",
                  isCrit: crit,
                  ts: now,
                });
                vibrateOnWeaponFired("sniper", crit);
                playWeaponFireSound("sniper", crit);
              } else {
                playWeaponFireSound("sniper", false);
              }
            }
          } else if (now - lastSemiShotAtRef.current >= SEMI_COOLDOWN_MS) {
            lastSemiShotAtRef.current = now;
            if (victim && shooterOk) {
              const base =
                SEMI_DMG_MIN +
                Math.floor(Math.random() * (SEMI_DMG_MAX - SEMI_DMG_MIN + 1));
              const crit = Math.random() < dmgCritChanceRef.current;
              const dmg = crit
                ? Math.round(base * WEAPON_CRIT_MULT)
                : base;
              const hitId = `${playerId}-${now}-${Math.random().toString(36).slice(2, 10)}`;
              publish({
                type: "weapon_hit",
                roomId: roomKey,
                hitId,
                shooterPlayerId: playerId,
                victimPlayerId: victim,
                damage: dmg,
                weapon: "semi",
                isCrit: crit,
                ts: now,
              });
              vibrateOnWeaponFired("semi", crit);
              playWeaponFireSound("semi", crit);
            } else {
              playWeaponFireSound("semi", false);
            }
          }
        }

        if (healLocked && hp < MAX_HP) {
          const gained = HEAL_PER_SEC * dt;
          hp = Math.min(MAX_HP, hp + gained);
          tagHealVisualDebtRef.current += gained;
          while (tagHealVisualDebtRef.current >= HEAL_FLOATER_CHUNK) {
            tagHealVisualDebtRef.current -= HEAL_FLOATER_CHUNK;
            spawnCombatFloaterRef.current(`+${HEAL_FLOATER_CHUNK} HP`, "heal");
          }
        }

        hpRef.current = hp;
        const rounded = Math.round(hp);
        setHpDisplay((prev) => (prev !== rounded ? rounded : prev));
      }

      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => {
      alive = false;
      cancelAnimationFrame(frame);
    };
  }, [playerId, publish, roomKey]);

  const onTagIds = useCallback(
    (ids: number[]) => {
      if (!canPlayRef.current || winnerIdRef.current || caughtRef.current[playerId]) return;
      const role = combatRoleRef.current;
      if (!role) return;
      const r = rosterRef.current;
      if (!r) return;
      const now = Date.now();
      for (const tid of ids) {
        const victimId = r.tagToPlayer.get(tid);
        if (!victimId || victimId === playerId) continue;
        if (caughtRef.current[victimId]) continue;
        if (tid === r.myTagId) continue;
        if (role === "dmg") {
          const lastPub = lastTagLockPublishRef.current[victimId] ?? 0;
          if (now - lastPub >= TAG_LOCK_PUBLISH_INTERVAL_MS) {
            lastTagLockPublishRef.current[victimId] = now;
            publish({
              type: "tag_lock",
              roomId: roomKey,
              scannerPlayerId: playerId,
              victimPlayerId: victimId,
              ts: now,
            });
          }
        } else {
          const lastPub = lastTagHealPublishRef.current[victimId] ?? 0;
          if (now - lastPub >= TAG_LOCK_PUBLISH_INTERVAL_MS) {
            lastTagHealPublishRef.current[victimId] = now;
            publish({
              type: "tag_heal",
              roomId: roomKey,
              healerPlayerId: playerId,
              victimPlayerId: victimId,
              ts: now,
            });
          }
        }
      }
      for (const pid of r.sorted) {
        if (pid === playerId) continue;
        const tagNum = r.playerToTag.get(pid);
        if (tagNum === undefined) continue;
        if (!ids.includes(tagNum)) {
          delete lastTagLockPublishRef.current[pid];
          delete lastTagHealPublishRef.current[pid];
        }
      }

      let aim: number | null = null;
      for (const tid of ids) {
        const victimId = r.tagToPlayer.get(tid);
        if (!victimId || victimId === playerId) continue;
        if (caughtRef.current[victimId]) continue;
        if (tid === r.myTagId) continue;
        aim = tid;
        break;
      }
      {
        const aimVictimPid =
          role === "dmg" && aim !== null ? (r.tagToPlayer.get(aim) ?? null) : null;
        aimVictimPlayerIdRef.current = aimVictimPid;
      }
      if (aim !== prevAimHuntTagRef.current) {
        prevAimHuntTagRef.current = aim;
        window.queueMicrotask(() => setAimHuntTagId(aim));
      }
    },
    [playerId, publish, roomKey],
  );

  const aprilEnabled =
    mqttStatus === "live" && combatRole !== null && !winnerId && !caught[playerId];
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

  const pickCombatRole = useCallback(
    (r: CombatRole) => {
      try {
        sessionStorage.setItem(combatRoleStorageKey(roomKey), r);
      } catch {
        /* private mode */
      }
      setCombatRole(r);
    },
    [roomKey],
  );

  const showLocationModal = locationHydrated && locationConsent === null;
  const showCombatRoleModal =
    combatRoleHydrated && combatRole === null && locationConsent !== null;

  return (
    <div className="relative flex min-h-[100dvh] flex-col bg-zinc-950 text-zinc-100">
      <HpDamageFloaters items={hpFloaters} />
      {superBeamHudSeconds !== null && (
        <div
          className="pointer-events-none fixed inset-0 z-[2500] flex items-start justify-center px-4 pt-10 sm:pt-16"
          role="alert"
          aria-live="assertive"
        >
          <div className="max-w-lg rounded-2xl border-2 border-amber-500 bg-black/90 px-5 py-4 text-center shadow-[0_0_48px_rgba(245,158,11,0.45)] sm:px-8 sm:py-6">
            <p className="text-base font-black uppercase leading-tight tracking-wide text-amber-400 sm:text-lg">
              {SUPER_BEAM_WARNING_LINES}
            </p>
            <p className="mt-4 text-6xl font-black tabular-nums text-red-500 sm:text-7xl">
              {superBeamHudSeconds}
            </p>
          </div>
        </div>
      )}
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

      {showCombatRoleModal && (
        <div
          className="fixed inset-0 z-[2950] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="combat-role-title"
        >
          <div className="max-w-md rounded-2xl border border-zinc-600 bg-zinc-900 p-6 shadow-2xl">
            <h2 id="combat-role-title" className="text-lg font-semibold text-white">
              Rolle im Raum
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-zinc-300">
              Mit dem AprilTag wirkt du auf andere Spieler.{" "}
              <strong className="text-zinc-100">Schaden</strong>: Ziel im Fadenkreuz (Sniper) bzw. Rotpunkt
              (Halbauto), dann{" "}
              <strong className="text-red-300">Feuer halten</strong> –{" "}
              <strong className="text-rose-300">Sniper</strong>{" "}
              {SNIPER_DMG_MIN}–{SNIPER_DMG_MAX} HP alle {SNIPER_COOLDOWN_MS / 1000}s,{" "}
              <strong className="text-rose-300">Halbautomatik</strong>{" "}
              {SEMI_DMG_MIN}–{SEMI_DMG_MAX} HP alle {SEMI_COOLDOWN_MS} ms. Crit mit einstellbarer
              Chance (Standard {DMG_CRIT_PCT_MIN}%, bis {DMG_CRIT_PCT_MAX}%) verdoppelt den
              jeweiligen Treffer.{" "}
              <strong className="text-zinc-100">Heilung</strong> stellt{" "}
              <strong className="text-emerald-300">{HEAL_PER_SEC} HP/s</strong> wieder her. Beides
              kann ein Ziel <strong className="text-zinc-100">gleichzeitig</strong> treffen.
            </p>
            <div className="mt-6 flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                onClick={() => pickCombatRole("dmg")}
                className="flex-1 rounded-xl bg-rose-700 px-4 py-3 text-sm font-semibold text-white transition hover:bg-rose-600"
              >
                Schaden (DMG)
              </button>
              <button
                type="button"
                onClick={() => pickCombatRole("heal")}
                className="flex-1 rounded-xl bg-emerald-700 px-4 py-3 text-sm font-semibold text-white transition hover:bg-emerald-600"
              >
                Heilung (Heal)
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
          {combatRole && (
            <p className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500">Rolle</p>
          )}
          {combatRole === "dmg" && (
            <p className="mb-1 text-xs font-semibold text-rose-300">Schaden</p>
          )}
          {combatRole === "heal" && (
            <p className="mb-1 text-xs font-semibold text-emerald-300">Heilung</p>
          )}
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

      {mqttStatus === "live" && roster && (
        <div
          className={`sticky top-0 z-[90] border-b px-4 py-2.5 ${
            tagBeamActive && tagHealActive
              ? "border-amber-800/80 bg-amber-950/95"
              : tagBeamActive
                ? "border-red-800/80 bg-red-950/95"
                : tagHealActive
                  ? "border-emerald-800/80 bg-emerald-950/95"
                  : "border-zinc-800 bg-zinc-900/95"
          } backdrop-blur-sm`}
        >
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">HP</span>
            <span className="font-mono text-sm tabular-nums text-zinc-100">
              {hpDisplay} / {MAX_HP}
            </span>
          </div>
          <div
            className="mt-2 h-2.5 overflow-hidden rounded-full bg-zinc-800"
            role="progressbar"
            aria-valuenow={hpDisplay}
            aria-valuemin={0}
            aria-valuemax={MAX_HP}
          >
            <div
              className={`h-full rounded-full transition-[width] duration-100 ${
                hpDisplay > 600
                  ? "bg-emerald-500"
                  : hpDisplay > 300
                    ? "bg-amber-500"
                    : "bg-red-500"
              } ${tagBeamActive || tagHealActive ? "animate-pulse" : ""}`}
              style={{ width: `${(hpDisplay / MAX_HP) * 100}%` }}
            />
          </div>
          {tagBeamActive && (
            <p className="mt-1.5 text-center text-[11px] font-medium text-red-200/90">
              Schaden: Ziel im Visier – unten <strong className="text-rose-100">Feuer halten</strong> zum
              Schießen
            </p>
          )}
          {combatRole === "dmg" && (
            <div className="mt-2 rounded-lg border border-rose-900/50 bg-rose-950/50 px-3 py-2">
              <label className="flex flex-col gap-1.5 text-left text-[11px] text-rose-100/95">
                <span className="flex items-center justify-between gap-2 font-medium">
                  <span>Crit-Chance (×{WEAPON_CRIT_MULT} auf Waffenschaden)</span>
                  <span className="tabular-nums text-rose-200">{dmgCritPercent}%</span>
                </span>
                <input
                  type="range"
                  min={DMG_CRIT_PCT_MIN}
                  max={DMG_CRIT_PCT_MAX}
                  step={1}
                  value={dmgCritPercent}
                  onChange={(e) => onDmgCritPercentChange(Number(e.target.value))}
                  className="h-2 w-full cursor-pointer accent-rose-400"
                  aria-valuemin={DMG_CRIT_PCT_MIN}
                  aria-valuemax={DMG_CRIT_PCT_MAX}
                  aria-valuenow={dmgCritPercent}
                  aria-label="Crit-Chance für Waffenschaden"
                />
                <span className="text-[10px] leading-snug text-rose-200/75">
                  Pro Schuss gewürfelt; Crit-Treffer nutzen die große goldene Anzeige.
                </span>
              </label>
            </div>
          )}
          {tagHealActive && (
            <p className="mt-1 text-center text-[11px] font-medium text-emerald-200/90">
              Heilung aktiv – +{HEAL_PER_SEC} HP/s
            </p>
          )}
        </div>
      )}

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
              {combatRole === "dmg" && weaponChoice === "semi" ? (
                <div
                  className="absolute left-1/2 top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-red-500 shadow-[0_0_4px_#fff,0_0_10px_rgba(239,68,68,1),0_0_22px_rgba(220,38,38,0.65)] ring-[2px] ring-red-950/50"
                  aria-label="Rotpunktvisier"
                />
              ) : combatRole === "dmg" ? (
                <>
                  <div className="absolute left-1/2 top-0 bottom-0 w-[2px] -translate-x-1/2 bg-white/75 shadow-[0_0_6px_rgba(0,0,0,0.85)]" />
                  <div className="absolute top-1/2 left-0 right-0 h-[2px] -translate-y-1/2 bg-white/75 shadow-[0_0_6px_rgba(0,0,0,0.85)]" />
                  <div className="absolute left-1/2 top-1/2 size-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white/80 shadow-[0_0_6px_rgba(0,0,0,0.85)]" />
                </>
              ) : null}
            </div>
            <DroneJamOverlay active={jamActive} secondsLeft={jamSecondsLeft} />
            {aimHuntTagId !== null && canPlayWithRole && !winnerId && roster && combatRole && (
              <div className="pointer-events-none absolute left-1/2 top-1/2 z-[32] -translate-x-1/2 -translate-y-[120%]">
                <div
                  className={`rounded-full border-2 px-4 py-2 text-center shadow-lg ${
                    combatRole === "heal"
                      ? "border-emerald-400/90 bg-emerald-950/95 shadow-emerald-900/40"
                      : "border-rose-400/90 bg-rose-950/95 shadow-rose-900/40"
                  }`}
                >
                  <p
                    className={`text-[11px] font-semibold uppercase tracking-wider ${
                      combatRole === "heal" ? "text-emerald-300/90" : "text-rose-300/90"
                    }`}
                  >
                    Code erkannt
                  </p>
                  <p
                    className={`mt-0.5 text-lg font-bold tabular-nums ${
                      combatRole === "heal" ? "text-emerald-50" : "text-rose-50"
                    }`}
                  >
                    AprilTag {aimHuntTagId}
                  </p>
                  <p
                    className={`text-[10px] ${
                      combatRole === "heal" ? "text-emerald-200/85" : "text-rose-200/85"
                    }`}
                  >
                    {combatRole === "dmg" && weaponChoice === "semi"
                      ? "Im Rotpunkt · "
                      : combatRole === "dmg"
                        ? "Im Fadenkreuz · "
                        : ""}
                    {combatRole === "heal"
                      ? `Heilung +${HEAL_PER_SEC} HP/s`
                      : weaponChoice === "sniper"
                        ? `Sniper ${SNIPER_DMG_MIN}–${SNIPER_DMG_MAX} / ${SNIPER_COOLDOWN_MS / 1000}s`
                        : `Halbauto ${SEMI_DMG_MIN}–${SEMI_DMG_MAX} / ${SEMI_COOLDOWN_MS}ms`}
                  </p>
                </div>
              </div>
            )}
            {canPlayWithRole && !winnerId && roster && (
              <div className="absolute bottom-0 left-0 right-0 z-[30] flex flex-col gap-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
                {locationConsent === true && gpsOk && myPos && (
                  <div className="pointer-events-auto mx-2 rounded-lg border border-amber-800/60 bg-zinc-950/90 p-2 shadow-lg backdrop-blur-md">
                    <button
                      type="button"
                      onClick={() => void placeSuperBeam()}
                      disabled={superBeamCooldownActive}
                      className="w-full rounded-md bg-gradient-to-b from-amber-600 to-orange-800 py-2 text-xs font-bold text-white shadow-md transition enabled:active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-45 sm:text-sm"
                    >
                      Luftangriff ({SUPER_BEAM_LENGTH_M} m × {SUPER_BEAM_HALF_WIDTH_M * 2} m)
                    </button>
                    <p className="mt-1 text-center text-[9px] leading-snug text-zinc-400 sm:text-[10px]">
                      Fadenkreuz = Blickachse · GPS + Kompass ·{" "}
                      <strong className="text-amber-200/90">{SUPER_BEAM_COUNTDOWN_MS / 1000} s</strong>{" "}
                      Warnung, dann <strong className="text-rose-300">{STORM_HP_DAMAGE} HP</strong>
                    </p>
                  </div>
                )}
                {combatRole === "dmg" && (
                  <div className="pointer-events-auto mx-2 flex flex-col gap-1.5 rounded-lg border border-rose-800/60 bg-zinc-950/88 p-2 shadow-lg backdrop-blur-sm">
                    <div className="flex gap-1.5">
                      <button
                        type="button"
                        onClick={() => pickWeapon("sniper")}
                        className={`flex-1 rounded-md border px-1.5 py-2 text-center text-[10px] font-semibold leading-tight transition sm:text-[11px] ${
                          weaponChoice === "sniper"
                            ? "border-rose-400 bg-rose-700 text-white shadow-[0_0_12px_rgba(225,29,72,0.3)]"
                            : "border-zinc-600 bg-zinc-800/90 text-zinc-300 hover:border-zinc-500"
                        }`}
                      >
                        Sniper
                      </button>
                      <button
                        type="button"
                        onClick={() => pickWeapon("semi")}
                        className={`flex-1 rounded-md border px-1.5 py-2 text-center text-[10px] font-semibold leading-tight transition sm:text-[11px] ${
                          weaponChoice === "semi"
                            ? "border-rose-400 bg-rose-700 text-white shadow-[0_0_12px_rgba(225,29,72,0.3)]"
                            : "border-zinc-600 bg-zinc-800/90 text-zinc-300 hover:border-zinc-500"
                        }`}
                      >
                        Halbauto
                      </button>
                    </div>
                    <button
                      type="button"
                      className={`min-h-12 touch-manipulation select-none rounded-lg border-2 border-rose-500/80 bg-gradient-to-b from-rose-600 to-rose-800 px-3 py-2.5 text-base font-black uppercase tracking-wide text-white shadow-md transition active:scale-[0.98] sm:min-h-14 sm:text-lg ${
                        firePressed ? "ring-2 ring-amber-300/90 ring-offset-1 ring-offset-zinc-950" : ""
                      }`}
                      style={{ WebkitUserSelect: "none" }}
                      onPointerDown={(e) => {
                        unlockWeaponAudioFromUserGesture();
                        e.preventDefault();
                        fireHeldRef.current = true;
                        setFirePressed(true);
                        try {
                          (e.currentTarget as HTMLButtonElement).setPointerCapture(e.pointerId);
                        } catch {
                          /* */
                        }
                      }}
                      onPointerUp={(e) => {
                        fireHeldRef.current = false;
                        setFirePressed(false);
                        try {
                          (e.currentTarget as HTMLButtonElement).releasePointerCapture(e.pointerId);
                        } catch {
                          /* */
                        }
                      }}
                      onPointerLeave={() => {
                        fireHeldRef.current = false;
                        setFirePressed(false);
                      }}
                    >
                      Feuer halten
                    </button>
                  </div>
                )}
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
            <div className="rounded-lg border border-orange-700/70 bg-orange-950/90 px-3 py-2 text-sm text-orange-100">
              <strong>Feuersturm:</strong> Tippe auf die Karte für einen Kreis mit 5&nbsp;km Radius.
              Getroffene Spieler verlieren <strong className="text-orange-200">{STORM_HP_DAMAGE} HP</strong>
              ; bei 0 HP sind sie gefangen.{" "}
              <button
                type="button"
                className="ml-1 underline decoration-orange-400 hover:text-white"
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
              superBeams={visibleSuperBeams}
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
            Karte: sichtbar und verschiebbar nur im Umkreis von{" "}
            <strong className="text-zinc-400">35 km</strong> um{" "}
            <strong className="text-zinc-400">Spieler 1</strong> (weniger Kacheln, schneller Laden).
            Ohne Spieler-1-Position startet die Ansicht mit ~<strong className="text-zinc-400">10 km</strong>{" "}
            um dich; „Zu mir (10 km)“ zentriert wieder auf dich.{" "}
            <strong className="text-zinc-400">Luftangriff</strong> in der{" "}
            <strong className="text-zinc-400">Kamera</strong> (
            {SUPER_BEAM_LENGTH_M}×{SUPER_BEAM_HALF_WIDTH_M * 2} m), auf der Karte ~{" "}
            {Math.round(SUPER_BEAM_MAP_TTL_MS / 1000)} s sichtbar.
          </p>
        </div>
      </div>

      <div className="bg-zinc-900 px-4 py-3">
        <p className="mb-2 text-center text-xs text-zinc-500">
          Spezialaktionen <span className="text-zinc-400">(ganz unten, über Karte/Kamera)</span>
        </p>
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={startStormMode}
            disabled={!canPlayWithRole || iAmCaught || !!winnerId || stormOnCooldown}
            title={
              !combatRole && !winnerId
                ? "Zuerst Rolle wählen (Dialog oben)."
                : !canPlay && !winnerId
                  ? "Ab zwei Spielern im Raum nutzbar."
                  : stormOnCooldown
                    ? `Feuersturm abklingend (${Math.ceil((stormCooldownUntil - nowTick) / 1000)} s)`
                    : "Karte öffnen und Kreis mit 5 km Radius setzen."
            }
            className="w-full rounded-lg border border-transparent px-4 py-3 text-sm font-medium transition enabled:border-orange-500/50 enabled:bg-gradient-to-b enabled:from-orange-600 enabled:to-red-900 enabled:text-white enabled:hover:from-orange-500 enabled:hover:to-red-800 disabled:cursor-not-allowed disabled:border-orange-950/60 disabled:bg-orange-950/40 disabled:text-orange-200/70"
          >
            {stormOnCooldown
              ? `Feuersturm (${Math.max(0, Math.ceil((stormCooldownUntil - nowTick) / 1000))} s)`
              : "Feuersturm"}
          </button>
          <button
            type="button"
            onClick={sendDroneJam}
            disabled={!canPlayWithRole || iAmCaught || !!winnerId || droneJamOnCooldown}
            title={
              !combatRole && !winnerId
                ? "Zuerst Rolle wählen (Dialog oben)."
                : !canPlay && !winnerId
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
          {canPlay && !combatRole && !winnerId && (
            <p className="text-sky-200/90">
              <strong className="text-sky-100">Rolle fehlt:</strong> Wähle im Dialog{" "}
              <strong className="text-sky-50">Schaden</strong> oder <strong className="text-sky-50">Heilung</strong>,
              um AprilTag und Spezialaktionen zu nutzen.
            </p>
          )}
          {!canPlay && !winnerId && (
            <p className="text-amber-200/80">
              <strong className="text-amber-100">Feuersturm, Drohnen-Störung:</strong> Buttons oben in
              dieser Leiste – sie werden erst <strong className="text-amber-50">klickbar</strong>, wenn
              mindestens <strong className="text-amber-50">zwei Spieler</strong> online sind (gleicher
              Raumcode).
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
