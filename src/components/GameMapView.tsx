"use client";

import type { MutableRefObject } from "react";
import { useEffect, useMemo, useRef } from "react";
import {
  CircleMarker,
  MapContainer,
  TileLayer,
  Tooltip,
  useMap,
} from "react-leaflet";
import type { LatLngExpression, Map as LeafletMap } from "leaflet";
import "leaflet/dist/leaflet.css";

type PlayerPos = { playerId: string; lat: number; lng: number };

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

export function GameMapView({
  myPlayerId,
  myPos,
  others,
}: {
  myPlayerId: string;
  myPos: { lat: number; lng: number } | null;
  others: PlayerPos[];
}) {
  const mapRef = useRef<LeafletMap | null>(null);

  const defaultCenter: LatLngExpression = useMemo(
    () => myPos ?? [51.1657, 10.4515],
    [myPos],
  );

  const flyToMe = () => {
    if (!myPos || !mapRef.current) return;
    const map = mapRef.current;
    map.flyTo([myPos.lat, myPos.lng], Math.max(16, map.getZoom()), { duration: 0.75 });
  };

  return (
    <div className="relative h-full w-full min-h-[280px]">
      <MapContainer
        center={defaultCenter}
        zoom={16}
        className="h-full w-full min-h-[280px] rounded-xl z-0"
        scrollWheelZoom
      >
        <MapAccessor mapRef={mapRef} />
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
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
                Gegner
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
        Zu meiner Position
      </button>
    </div>
  );
}
