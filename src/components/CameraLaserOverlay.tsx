"use client";

/**
 * Pseudo-3D roter Strahl von der Bildmitte (Fadenkreuz) in die Tiefe.
 * betaDeg = DeviceOrientationEvent.beta (Gerät geneigt); nur optisch, nicht die MQTT-Geometrie.
 */
export function CameraLaserOverlay({
  active,
  betaDeg,
}: {
  active: boolean;
  betaDeg: number | null;
}) {
  if (!active) return null;
  const tilt =
    betaDeg != null && Number.isFinite(betaDeg)
      ? Math.min(72, Math.max(-28, 90 - betaDeg))
      : 14;

  return (
    <div
      className="pointer-events-none absolute inset-0 z-[16] overflow-hidden"
      style={{ perspective: "min(92vw, 720px)" }}
      aria-hidden
    >
      <div
        className="absolute left-1/2 top-1/2 h-[min(135vh,880px)] w-[9px] -translate-x-1/2 origin-top rounded-full bg-gradient-to-b from-red-500 from-12% via-red-500/50 to-transparent to-90%"
        style={{
          transform: `rotateX(${tilt}deg) translateZ(0)`,
          boxShadow:
            "0 0 20px rgba(239,68,68,0.98), 0 0 48px rgba(220,38,38,0.5), inset 0 0 12px rgba(254,202,202,0.35)",
        }}
      />
    </div>
  );
}
