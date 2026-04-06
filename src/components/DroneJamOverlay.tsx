"use client";

import { useId } from "react";

type Props = {
  active: boolean;
  secondsLeft: number;
};

/**
 * Vollbild-Overlay: grauer Schleier + SVG-Rauschen, Countdown in Sekunden.
 */
export function DroneJamOverlay({ active, secondsLeft }: Props) {
  const rawId = useId();
  const filterId = `drone-noise-${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}`;

  if (!active) return null;

  return (
    <div
      className="fixed inset-0 z-[300] flex flex-col items-center justify-center bg-zinc-500/75 text-white shadow-[inset_0_0_120px_rgba(0,0,0,0.5)]"
      role="alert"
      aria-live="assertive"
      aria-label={`Drohnen-Störung, noch ${secondsLeft} Sekunden`}
    >
      <svg className="pointer-events-none absolute inset-0 h-full w-full mix-blend-overlay" aria-hidden>
        <defs>
          <filter id={filterId} x="-20%" y="-20%" width="140%" height="140%">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.8"
              numOctaves="4"
              stitchTiles="stitch"
              result="t"
            >
              <animate
                attributeName="baseFrequency"
                dur="0.12s"
                values="0.75;1.05;0.75"
                repeatCount="indefinite"
              />
            </feTurbulence>
            <feColorMatrix in="t" type="saturate" values="0" result="gray" />
            <feComponentTransfer in="gray" result="contrast">
              <feFuncA type="linear" slope="1.4" intercept="-0.15" />
            </feComponentTransfer>
          </filter>
        </defs>
        <rect width="100%" height="100%" filter={`url(#${filterId})`} opacity={0.95} />
      </svg>
      <div className="pointer-events-none absolute inset-0 bg-zinc-800/55" aria-hidden />
      <div className="relative z-10 flex flex-col items-center px-6 text-center">
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-zinc-300">
          Drohnen-Störung
        </p>
        <p className="mt-4 text-7xl font-black tabular-nums tracking-tight text-white drop-shadow-lg">
          {secondsLeft}
        </p>
        <p className="mt-2 text-sm text-zinc-400">Kamera gesperrt</p>
      </div>
    </div>
  );
}
