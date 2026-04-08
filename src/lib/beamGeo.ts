/** Halbe Breite des Strahl-Korridors auf dem Boden (Gesamt ~5 m). */
export const BEAM_CORRIDOR_HALF_WIDTH_M = 2.5;
/** Rote „Kiste“ am Zielpunkt: Tiefe entlang der Schussrichtung (zurück zum Abschuss). */
export const BEAM_END_BOX_DEPTH_M = 18;
export const BEAM_END_BOX_WIDTH_M = 12;

const M_PER_DEG_LAT = 111_320;

function toLocalM(lat0: number, lng0: number, lat: number, lng: number) {
  const cos = Math.cos((lat0 * Math.PI) / 180);
  const x = (lng - lng0) * M_PER_DEG_LAT * cos;
  const y = (lat - lat0) * M_PER_DEG_LAT;
  return { x, y };
}

function fromLocalM(lat0: number, lng0: number, x: number, y: number) {
  const cos = Math.cos((lat0 * Math.PI) / 180);
  const lat = lat0 + y / M_PER_DEG_LAT;
  const lng = lng0 + x / (M_PER_DEG_LAT * cos);
  return { lat, lng };
}

/**
 * Bodenfläche: Streifen von Start bis Ende (wirkt wie liegender 3D-Strahl in der Kartenansicht).
 */
export function beamGroundCorridor(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
  halfWidthM: number,
): [number, number][] {
  const { x: bx, y: by } = toLocalM(lat1, lng1, lat2, lng2);
  const len = Math.hypot(bx, by) || 1;
  const ux = bx / len;
  const uy = by / len;
  const rx = uy;
  const ry = -ux;
  const hw = halfWidthM;
  const c1 = fromLocalM(lat1, lng1, rx * hw, ry * hw);
  const c2 = fromLocalM(lat1, lng1, -rx * hw, -ry * hw);
  const c3 = fromLocalM(lat1, lng1, bx - rx * hw, by - ry * hw);
  const c4 = fromLocalM(lat1, lng1, bx + rx * hw, by + ry * hw);
  return [
    [c1.lat, c1.lng],
    [c4.lat, c4.lng],
    [c3.lat, c3.lng],
    [c2.lat, c2.lng],
  ];
}

/**
 * Liegt der Punkt im Boden-Korridor zwischen Start und Ende (halbe Breite = Abstand zur Mittellinie)?
 */
export function isPointInBeamCorridor(
  lat: number,
  lng: number,
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
  halfWidthM: number,
): boolean {
  const { x: bx, y: by } = toLocalM(lat1, lng1, lat2, lng2);
  const len = Math.hypot(bx, by);
  if (len < 0.05) return false;
  const ux = bx / len;
  const uy = by / len;
  const { x: px, y: py } = toLocalM(lat1, lng1, lat, lng);
  const along = px * ux + py * uy;
  if (along < 0 || along > len) return false;
  const perp = Math.abs(px * uy - py * ux);
  return perp <= halfWidthM;
}

/**
 * Rechteckige rote „Kiste“ am Zielpunkt, flach auf dem Boden, längs zur Schussrichtung.
 */
export function beamEndGroundBox(
  latA: number,
  lngA: number,
  latB: number,
  lngB: number,
  depthM: number,
  widthM: number,
): [number, number][] {
  const { x: dx, y: dy } = toLocalM(latA, lngA, latB, lngB);
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const rx = uy;
  const ry = -ux;
  const hw = widthM / 2;
  const d = depthM;
  const corners = [
    { x: -ux * d - rx * hw, y: -uy * d - ry * hw },
    { x: -ux * d + rx * hw, y: -uy * d + ry * hw },
    { x: -rx * hw, y: -ry * hw },
    { x: rx * hw, y: ry * hw },
  ];
  return corners.map((c) => {
    const p = fromLocalM(latB, lngB, c.x, c.y);
    return [p.lat, p.lng] as [number, number];
  });
}

export function buildBeamGroundShapes(
  originLat: number,
  originLng: number,
  endLat: number,
  endLng: number,
): {
  corridor: [number, number][];
  endBox: [number, number][];
} {
  return {
    corridor: beamGroundCorridor(
      originLat,
      originLng,
      endLat,
      endLng,
      BEAM_CORRIDOR_HALF_WIDTH_M,
    ),
    endBox: beamEndGroundBox(
      originLat,
      originLng,
      endLat,
      endLng,
      BEAM_END_BOX_DEPTH_M,
      BEAM_END_BOX_WIDTH_M,
    ),
  };
}

/**
 * Zielpunkt auf der Erdoberfläche: von (lat,lng) aus bearingDeg (0=Nord, im Uhrzeigersinn)
 * über distanceM Meter (horizontal, Kugel-Approximation).
 */
export function destinationLatLng(
  lat: number,
  lng: number,
  bearingDeg: number,
  distanceM: number,
): { lat: number; lng: number } {
  const R = 6371000;
  const br = (bearingDeg * Math.PI) / 180;
  const φ1 = (lat * Math.PI) / 180;
  const λ1 = (lng * Math.PI) / 180;
  const angular = distanceM / R;
  const φ2 = Math.asin(
    Math.sin(φ1) * Math.cos(angular) +
      Math.cos(φ1) * Math.sin(angular) * Math.cos(br),
  );
  const λ2 =
    λ1 +
    Math.atan2(
      Math.sin(br) * Math.sin(angular) * Math.cos(φ1),
      Math.cos(angular) - Math.sin(φ1) * Math.sin(φ2),
    );
  return { lat: (φ2 * 180) / Math.PI, lng: (λ2 * 180) / Math.PI };
}

type DeviceOrientationWithCompass = DeviceOrientationEvent & {
  webkitCompassHeading?: number;
};

/** Kompassrichtung in Grad (0–360, Nord=0, im Uhrzeigersinn). */
export function compassHeadingFromEvent(ev: DeviceOrientationEvent): number | null {
  const w = ev as DeviceOrientationWithCompass;
  if (typeof w.webkitCompassHeading === "number" && Number.isFinite(w.webkitCompassHeading)) {
    return ((w.webkitCompassHeading % 360) + 360) % 360;
  }
  if (ev.absolute && typeof ev.alpha === "number" && Number.isFinite(ev.alpha)) {
    return ((360 - ev.alpha) % 360 + 360) % 360;
  }
  if (typeof ev.alpha === "number" && Number.isFinite(ev.alpha)) {
    return ((360 - ev.alpha) % 360 + 360) % 360;
  }
  return null;
}
