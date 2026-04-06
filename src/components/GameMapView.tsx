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
const FIT_SELF_THROTTLE_MS = 5000;

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

/** Hält die Ansicht um die eigene Position auf ~10 km „Höhe“ (Sichtradius). */
function AutoFitViewAroundSelf({
  myPos,
}: {
  myPos: { lat: number; lng: number } | null;
}) {
  const map = useMap();
  const didInitial = useRef(false);
  const lastFitAt = useRef(0);

  useEffect(() => {
    if (!myPos) return;
    const now = Date.now();
    const bounds = latLngBoundsKm(myPos.lat, myPos.lng, VIEW_RADIUS_KM_SELF);

    if (!didInitial.current) {
      didInitial.current = true;
      lastFitAt.current = now;
      map.fitBounds(bounds, { padding: [28, 28], maxZoom: 13, animate: false });
      return;
    }

    if (now - lastFitAt.current < FIT_SELF_THROTTLE_MS) return;
    lastFitAt.current = now;
    map.fitBounds(bounds, { padding: [28, 28], maxZoom: 13, animate: true, duration: 0.4 });
  }, [myPos, map]);

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
      >
        <MapAccessor mapRef={mapRef} />
        <StormClickLayer enabled={stormMode} onPlace={onStormPlace} />
        <AutoFitViewAroundSelf myPos={myPos} />
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {playerOnePos && (
          <Circle
            center={[playerOnePos.lat, playerOnePos.lng]}
            radius={40_000}
            pathOptions={{
              color: "#1d4ed8",
              fillColor: "#2563eb",
              fillOpacity: 0.1,
              weight: 2,
              dashArray: "10 14",
            }}
          >
            <Tooltip direction="top">Spieler 1 · 40 km Radius</Tooltip>
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
            <Tooltip direction="top">Sturm · {s.radiusM} m</Tooltip>
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
