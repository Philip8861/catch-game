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
