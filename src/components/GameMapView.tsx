"use client";

import type { MutableRefObject } from "react";
import { useEffect, useMemo, useRef } from "react";
import {
  Circle,
  CircleMarker,
  MapContainer,
  TileLayer,
  Tooltip,
  useMap,
  useMapEvents,
} from "react-leaflet";
import L from "leaflet";
import type { LatLngExpression, Map as LeafletMap } from "leaflet";
import "leaflet/dist/leaflet.css";

type PlayerPos = { playerId: string; lat: number; lng: number };

export type StormCircle = { id: string; lat: number; lng: number; radiusM: number };

/** Rechteckige Bounds ~ radiusKm vom Zentrum (für fitBounds / „Kamerahöhe“) */
function latLngBoundsKm(centerLat: number, centerLng: number, radiusKm: number) {
  const dLat = radiusKm / 111.32;
  const cosLat = Math.cos((centerLat * Math.PI) / 180);
  const dLng = cosLat > 0.02 ? radiusKm / (111.32 * cosLat) : radiusKm / 111.32;
  return L.latLngBounds(
    [centerLat - dLat, centerLng - dLng],
    [centerLat + dLat, centerLng + dLng],
  );
}

const VIEW_RADIUS_KM_SELF = 10;
/** Karte nur in diesem Radius um Spieler 1 (weniger Kacheln, schneller). */
const PLAYER_ONE_CLIP_RADIUS_KM = 35;
const WORLD_BOUNDS = L.latLngBounds([-85, -180], [85, 180]);

function MapAccessor({ mapRef }: { mapRef: MutableRefObject<LeafletMap | null> }) {
  const map = useMap();
  useEffect(() => {
    mapRef.current = map;
    return () => {
      mapRef.current = null;
    };
  }, [map, mapRef]);
  return null;
}

function StormClickLayer({
  enabled,
  onPlace,
}: {
  enabled: boolean;
  onPlace: (lat: number, lng: number) => void;
}) {
  useMapEvents({
    click(e) {
      if (!enabled) return;
      onPlace(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

/**
 * Begrenzt die Karte auf PLAYER_ONE_CLIP_RADIUS_KM um Spieler 1 (maxBounds).
 * Erster Kartenausschnitt: bevorzugt 35 km um Spieler 1, sonst 10 km um dich.
 */
function MapClipAndInitialFit({
  playerOnePos,
  myPos,
}: {
  playerOnePos: { lat: number; lng: number } | null;
  myPos: { lat: number; lng: number } | null;
}) {
  const map = useMap();
  const didFitP1Ref = useRef(false);
  const didFitSelfRef = useRef(false);

  useEffect(() => {
    if (playerOnePos && !didFitP1Ref.current) {
      didFitP1Ref.current = true;
      const b = latLngBoundsKm(
        playerOnePos.lat,
        playerOnePos.lng,
        PLAYER_ONE_CLIP_RADIUS_KM,
      );
      map.fitBounds(b, { padding: [32, 32], maxZoom: 11, animate: false });
      return;
    }
    if (
      !playerOnePos &&
      myPos &&
      !didFitSelfRef.current &&
      !didFitP1Ref.current
    ) {
      didFitSelfRef.current = true;
      const b = latLngBoundsKm(myPos.lat, myPos.lng, VIEW_RADIUS_KM_SELF);
      map.fitBounds(b, { padding: [28, 28], maxZoom: 13, animate: false });
    }
  }, [map, playerOnePos, myPos]);

  return null;
}

export function GameMapView({
  myPlayerId,
  myPos,
  others,
  playerOnePos,
  stormMode,
  onStormPlace,
  stormCircles,
}: {
  myPlayerId: string;
  myPos: { lat: number; lng: number } | null;
  others: PlayerPos[];
  playerOnePos: { lat: number; lng: number } | null;
  stormMode: boolean;
  onStormPlace: (lat: number, lng: number) => void;
  stormCircles: StormCircle[];
}) {
  const mapRef = useRef<LeafletMap | null>(null);

  const defaultCenter: LatLngExpression = useMemo(
    () => myPos ?? playerOnePos ?? [51.1657, 10.4515],
    [myPos, playerOnePos],
  );

  const p1ClipBounds = useMemo(() => {
    if (!playerOnePos) return null;
    return latLngBoundsKm(
      playerOnePos.lat,
      playerOnePos.lng,
      PLAYER_ONE_CLIP_RADIUS_KM,
    );
  }, [playerOnePos]);

  const flyToMe = () => {
    if (!myPos || !mapRef.current) return;
    const bounds = latLngBoundsKm(myPos.lat, myPos.lng, VIEW_RADIUS_KM_SELF);
    mapRef.current.fitBounds(bounds, { padding: [32, 32], maxZoom: 13, animate: true, duration: 0.75 });
  };

  return (
    <div
      className={`relative h-full w-full min-h-[280px] ${stormMode ? "[&_.leaflet-container]:cursor-crosshair" : ""}`}
    >
      <MapContainer
        center={defaultCenter}
        zoom={10}
        className="h-full w-full min-h-[280px] rounded-xl z-0"
        scrollWheelZoom
        maxBounds={p1ClipBounds ?? WORLD_BOUNDS}
        maxBoundsViscosity={p1ClipBounds ? 1 : 0}
      >
        <MapAccessor mapRef={mapRef} />
        <StormClickLayer enabled={stormMode} onPlace={onStormPlace} />
        <MapClipAndInitialFit playerOnePos={playerOnePos} myPos={myPos} />
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {playerOnePos && (
          <Circle
            center={[playerOnePos.lat, playerOnePos.lng]}
            radius={PLAYER_ONE_CLIP_RADIUS_KM * 1000}
            pathOptions={{
              color: "#1d4ed8",
              fillColor: "#2563eb",
              fillOpacity: 0.1,
              weight: 2,
              dashArray: "10 14",
            }}
          >
            <Tooltip direction="top">
              Spieler 1 · Spielfeld {PLAYER_ONE_CLIP_RADIUS_KM} km
            </Tooltip>
          </Circle>
        )}
        {stormCircles.map((s) => (
          <Circle
            key={s.id}
            center={[s.lat, s.lng]}
            radius={s.radiusM}
            pathOptions={{
              color: "#7c3aed",
              fillColor: "#a78bfa",
              fillOpacity: 0.35,
              weight: 3,
            }}
          >
            <Tooltip direction="top">
              Sturm · {s.radiusM >= 1000 ? `${s.radiusM / 1000} km` : `${s.radiusM} m`}
            </Tooltip>
          </Circle>
        ))}
        {myPos && (
          <CircleMarker
            center={[myPos.lat, myPos.lng]}
            radius={10}
            pathOptions={{ color: "#2563eb", fillColor: "#3b82f6", fillOpacity: 0.85 }}
          >
            <Tooltip direction="top" permanent>
              Du
            </Tooltip>
          </CircleMarker>
        )}
        {others
          .filter((o) => o.playerId !== myPlayerId)
          .map((o) => (
            <CircleMarker
              key={o.playerId}
              center={[o.lat, o.lng]}
              radius={10}
              pathOptions={{ color: "#dc2626", fillColor: "#ef4444", fillOpacity: 0.85 }}
            >
              <Tooltip direction="top" permanent>
                Mitspieler
              </Tooltip>
            </CircleMarker>
          ))}
      </MapContainer>
      <button
        type="button"
        onClick={flyToMe}
        disabled={!myPos}
        className="absolute bottom-3 right-3 z-[1000] rounded-lg border border-zinc-600 bg-zinc-900/95 px-3 py-2 text-sm font-medium text-white shadow-lg backdrop-blur-sm transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Zu mir (10 km)
      </button>
    </div>
  );
}
