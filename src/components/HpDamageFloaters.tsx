"use client";

export type HpFloaterItem = {
  id: string;
  text: string;
  variant?: "damage" | "heal" | "crit";
};

type Props = {
  items: HpFloaterItem[];
};

/**
 * Schadenstexte, die von der Bildschirmmitte nach oben springen (fixed overlay).
 */
export function HpDamageFloaters({ items }: Props) {
  if (items.length === 0) return null;
  return (
    <div
      className="pointer-events-none fixed inset-0 z-[400]"
      aria-hidden
    >
      {items.map((f, i) => {
        const jitter = ((f.id.charCodeAt(0) + i * 7) % 17) * 5 - 40;
        const delay = Math.min(i, 10) * 0.032;
        const animClass =
          f.variant === "heal"
            ? "hp-float hp-float--heal text-3xl sm:text-4xl text-emerald-300"
            : f.variant === "crit"
              ? "hp-float hp-float--crit text-5xl sm:text-7xl font-black tracking-tighter text-amber-100"
              : "hp-float hp-float--dmg text-3xl sm:text-5xl text-rose-400";
        return (
          <div
            key={f.id}
            className="absolute top-[40%]"
            style={{ left: `calc(50% + ${jitter}px)` }}
          >
            <span
              className={`inline-block font-black tracking-tight ${animClass}`}
              style={{
                animationDelay: `${delay}s`,
              }}
            >
              {f.text}
            </span>
          </div>
        );
      })}
    </div>
  );
}
