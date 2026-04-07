"use client";

export type HpFloaterItem = {
  id: string;
  text: string;
  variant?: "damage" | "heal";
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
              className={`hp-damage-float inline-block text-3xl font-black tracking-tight sm:text-4xl ${
                f.variant === "heal"
                  ? "text-emerald-400 drop-shadow-[0_2px_12px_rgba(6,95,70,0.95)]"
                  : "text-red-400 drop-shadow-[0_2px_10px_rgba(0,0,0,0.95)]"
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
