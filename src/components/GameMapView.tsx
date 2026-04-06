"use client";

import { useEffect, useMemo } from "react";
import {
  CircleMarker,
  MapContainer,
  TileLayer,
  Tooltip,
  useMap,
} from "react-leaflet";
import type { LatLngExpression } from "leaflet";
import "leaflet/dist/leaflet.css";

type PlayerPos = { playerId: string; lat: number; lng: number };

function Recenter({ center }: { center: LatLngExpression }) {
  const map = useMap();
  useEffect(() => {
    map.setView(center, map.getZoom(), { animate: true });
  }, [center, map]);
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
  const defaultCenter: LatLngExpression = useMemo(
    () => myPos ?? [51.1657, 10.4515],
    [myPos],
  );

  return (
    <MapContainer
      center={defaultCenter}
      zoom={16}
      className="h-full w-full min-h-[280px] rounded-xl z-0"
      scrollWheelZoom
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      {myPos && (
        <>
          <Recenter center={[myPos.lat, myPos.lng]} />
          <CircleMarker
            center={[myPos.lat, myPos.lng]}
            radius={10}
            pathOptions={{ color: "#2563eb", fillColor: "#3b82f6", fillOpacity: 0.85 }}
          >
            <Tooltip direction="top" permanent>
              Du
            </Tooltip>
          </CircleMarker>
        </>
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
  );
}
