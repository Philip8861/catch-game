/**
 * Schussgeräusche per HTMLAudioElement + im Speicher erzeugtes WAV.
 * Läuft auf iOS/Android zuverlässiger als Web Audio aus requestAnimationFrame.
 * Mikrofon ist dafür nicht nötig – Ausgabe geht über die Medienlautstärke.
 */

type WeaponSfx = "sniper" | "semi";

function writeAscii(view: DataView, offset: number, s: string) {
  for (let i = 0; i < s.length; i++) {
    view.setUint8(offset + i, s.charCodeAt(i));
  }
}

/** 16-bit PCM mono WAV als Blob */
function pcmWavBlob(
  durationSec: number,
  sampleRate: number,
  sampleAt: (i: number, n: number) => number,
): Blob {
  const numSamples = Math.max(1, Math.floor(durationSec * sampleRate));
  const dataBytes = numSamples * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);
  const samples = new Int16Array(buffer, 44);
  for (let i = 0; i < numSamples; i++) {
    const x = Math.max(-1, Math.min(1, sampleAt(i, numSamples)));
    samples[i] = Math.round(x * 32767);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

const SAMPLE_RATE = 44100;

function gunshotBlob(weapon: WeaponSfx, isCrit: boolean): Blob {
  const duration =
    weapon === "sniper"
      ? isCrit
        ? 0.2
        : 0.16
      : isCrit
        ? 0.095
        : 0.07;
  const decayPerSample =
    weapon === "sniper"
      ? Math.pow(0.001, 1 / (SAMPLE_RATE * duration * 0.85))
      : Math.pow(0.001, 1 / (SAMPLE_RATE * duration * 0.75));
  const loudness =
    (isCrit ? 0.94 : 0.76) * (weapon === "sniper" ? 1 : 0.92);

  let env = 1;
  let lp = 0;

  return pcmWavBlob(duration, SAMPLE_RATE, () => {
    const white = Math.random() * 2 - 1;
    lp =
      weapon === "sniper"
        ? lp * 0.68 + white * 0.32
        : lp * 0.35 + white * 0.65;
    const out = lp * env * loudness;
    env *= decayPerSample;
    return out;
  });
}

const shotUrlCache = new Map<string, string>();

function shotObjectUrl(weapon: WeaponSfx, isCrit: boolean): string {
  const key = `${weapon}:${isCrit}`;
  let url = shotUrlCache.get(key);
  if (!url) {
    url = URL.createObjectURL(gunshotBlob(weapon, isCrit));
    shotUrlCache.set(key, url);
  }
  return url;
}

let silentObjectUrl: string | null = null;

function silentObjectUrlOnce(): string {
  if (!silentObjectUrl) {
    silentObjectUrl = URL.createObjectURL(
      pcmWavBlob(0.03, SAMPLE_RATE, () => 0),
    );
  }
  return silentObjectUrl;
}

/**
 * Einmalig beim Tap (Feuer / Waffenwahl) – entsperrt Audio auf iOS für dieselbe Seite.
 */
export function unlockWeaponAudioFromUserGesture(): void {
  if (typeof window === "undefined") return;
  const a = new Audio(silentObjectUrlOnce());
  a.volume = 0.0001;
  void a.play().catch(() => {});
}

/**
 * Spielt einen Schuss (laut, Medienlautstärke des Handys).
 */
export function playWeaponFireSound(weapon: WeaponSfx, isCrit: boolean): void {
  if (typeof window === "undefined") return;
  const a = new Audio(shotObjectUrl(weapon, isCrit));
  a.volume = 1;
  void a.play().catch(() => {});
}
