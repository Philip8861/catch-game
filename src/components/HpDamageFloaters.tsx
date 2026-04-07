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
        return (
          <div
            key={f.id}
            className="absolute top-[42%]"
            style={{ left: `calc(50% + ${jitter}px)` }}
          >
            <span
              className={`hp-damage-float inline-block font-black tracking-tight ${
                f.variant === "heal"
                  ? "text-3xl sm:text-4xl text-emerald-400 drop-shadow-[0_2px_12px_rgba(6,95,70,0.95)]"
                  : f.variant === "crit"
                    ? "hp-damage-crit text-5xl sm:text-6xl text-amber-200"
                    : "text-3xl sm:text-4xl text-red-400 drop-shadow-[0_2px_10px_rgba(0,0,0,0.95)]"
              }`}
            >
              {f.text}
            </span>
          </div>
        );
      })}
    </div>
  );
}
