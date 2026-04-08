/**
 * Kurze Waffen-Schüsse per Web Audio API (keine externen Samples, geringe Latenz).
 * Sniper: tieferer Knall, längerer Nachhall; Halbauto: knapper, heller Crack.
 */

type WeaponSfx = "sniper" | "semi";

let sharedCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const w = window as Window &
    typeof globalThis & { webkitAudioContext?: typeof AudioContext };
  const Ctor = window.AudioContext ?? w.webkitAudioContext;
  if (!Ctor) return null;
  if (!sharedCtx || sharedCtx.state === "closed") {
    sharedCtx = new Ctor();
  }
  return sharedCtx;
}

function noiseBuffer(ctx: AudioContext, durationSec: number): AudioBuffer {
  const n = Math.max(1, Math.ceil(ctx.sampleRate * durationSec));
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) {
    d[i] = Math.random() * 2 - 1;
  }
  return buf;
}

function connectToDestination(
  ctx: AudioContext,
  t0: number,
  node: AudioNode,
  peak: number,
  attackSec: number,
  holdSec: number,
  decaySec: number,
  dest: AudioNode,
): void {
  const g = ctx.createGain();
  const end = t0 + attackSec + holdSec + decaySec;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.02), t0 + attackSec);
  g.gain.setValueAtTime(Math.max(peak * 0.85, 0.02), t0 + attackSec + holdSec);
  g.gain.exponentialRampToValueAtTime(0.0001, end);
  node.connect(g);
  g.connect(dest);
}

function playNoiseCrack(
  ctx: AudioContext,
  t0: number,
  dest: AudioNode,
  opts: {
    duration: number;
    highPassHz: number;
    bandHz: number;
    bandQ: number;
    peak: number;
    attackMs: number;
    holdMs: number;
    decayMs: number;
  },
): void {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, opts.duration);
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = opts.highPassHz;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = opts.bandHz;
  bp.Q.value = opts.bandQ;
  src.connect(hp);
  hp.connect(bp);
  connectToDestination(
    ctx,
    t0,
    bp,
    opts.peak,
    opts.attackMs / 1000,
    opts.holdMs / 1000,
    opts.decayMs / 1000,
    dest,
  );
  src.start(t0);
  src.stop(t0 + opts.duration + 0.02);
}

function playLowThump(
  ctx: AudioContext,
  t0: number,
  dest: AudioNode,
  freqHz: number,
  peak: number,
  durSec: number,
): void {
  const o = ctx.createOscillator();
  o.type = "sine";
  o.frequency.setValueAtTime(freqHz, t0);
  o.frequency.exponentialRampToValueAtTime(freqHz * 0.55, t0 + durSec * 0.7);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + durSec);
  o.connect(g);
  g.connect(dest);
  o.start(t0);
  o.stop(t0 + durSec + 0.03);
}

function playCritShine(
  ctx: AudioContext,
  t0: number,
  dest: AudioNode,
  weapon: WeaponSfx,
): void {
  const o = ctx.createOscillator();
  o.type = "sine";
  o.frequency.value = weapon === "sniper" ? 990 : 1320;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(weapon === "sniper" ? 0.07 : 0.055, t0 + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.09);
  o.connect(g);
  g.connect(dest);
  o.start(t0);
  o.stop(t0 + 0.1);
}

/**
 * Spielt einen Schuss für den lokalen Spieler (nur nach User-Gesture zuverlässig).
 */
export function playWeaponFireSound(
  weapon: WeaponSfx,
  isCrit: boolean,
): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  void ctx.resume().catch(() => {});

  const t0 = ctx.currentTime;

  const bus = ctx.createGain();
  bus.gain.value = isCrit ? 1.12 : 1;

  const pan = ctx.createStereoPanner();
  pan.pan.value = (Math.random() - 0.5) * 0.22;
  bus.connect(pan);

  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.knee.value = 6;
  comp.ratio.value = 3;
  comp.attack.value = 0.002;
  comp.release.value = 0.08;
  pan.connect(comp);
  comp.connect(ctx.destination);

  if (weapon === "sniper") {
    playNoiseCrack(ctx, t0, bus, {
      duration: 0.16,
      highPassHz: 450,
      bandHz: 2400,
      bandQ: 3.2,
      peak: isCrit ? 0.95 : 0.78,
      attackMs: 0.35,
      holdMs: 6,
      decayMs: isCrit ? 155 : 125,
    });
    playNoiseCrack(ctx, t0 + 0.0008, bus, {
      duration: 0.1,
      highPassHz: 1200,
      bandHz: 6200,
      bandQ: 4,
      peak: isCrit ? 0.22 : 0.16,
      attackMs: 0.2,
      holdMs: 2,
      decayMs: 28,
    });
    playLowThump(ctx, t0, bus, isCrit ? 118 : 108, isCrit ? 0.42 : 0.34, 0.1);
    if (isCrit) playCritShine(ctx, t0 + 0.012, bus, "sniper");
  } else {
    playNoiseCrack(ctx, t0, bus, {
      duration: 0.07,
      highPassHz: 900,
      bandHz: 4800,
      bandQ: 2.8,
      peak: isCrit ? 0.82 : 0.68,
      attackMs: 0.25,
      holdMs: 3,
      decayMs: isCrit ? 48 : 38,
    });
    playNoiseCrack(ctx, t0 + 0.0005, bus, {
      duration: 0.045,
      highPassHz: 2000,
      bandHz: 7800,
      bandQ: 3.5,
      peak: isCrit ? 0.2 : 0.14,
      attackMs: 0.15,
      holdMs: 1,
      decayMs: 22,
    });
    playLowThump(ctx, t0, bus, isCrit ? 195 : 205, isCrit ? 0.2 : 0.14, 0.045);
    if (isCrit) playCritShine(ctx, t0 + 0.008, bus, "semi");
  }
}
