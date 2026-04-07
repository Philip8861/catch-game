"use client";

import * as Comlink from "comlink";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

type ApriltagApi = {
  detect: (
    grayscale: Uint8Array,
    w: number,
    h: number,
  ) => Promise<unknown>;
  set_tag_size: (tagid: number, size: number) => Promise<void>;
  set_camera_info: (fx: number, fy: number, cx: number, cy: number) => Promise<void>;
};

/** Anteil von min(Breite,Höhe): nur Tags, deren Mittelpunkt hier liegt, zählen (Fadenkreuz). */
const CROSSHAIR_RADIUS_FRAC = 0.16;

function detectionArray(detections: unknown): unknown[] {
  if (Array.isArray(detections)) return detections;
  if (detections && typeof detections === "object" && "tags" in detections) {
    const t = (detections as { tags: unknown }).tags;
    return Array.isArray(t) ? t : [];
  }
  return [];
}

function readCenter(det: Record<string, unknown>): { cx: number; cy: number } | null {
  const c = det.center;
  if (Array.isArray(c) && c.length >= 2) {
    const cx = Number(c[0]);
    const cy = Number(c[1]);
    if (Number.isFinite(cx) && Number.isFinite(cy)) return { cx, cy };
  }
  if (c && typeof c === "object") {
    const o = c as Record<string, unknown>;
    const cx = Number(o.x ?? o.X);
    const cy = Number(o.y ?? o.Y);
    if (Number.isFinite(cx) && Number.isFinite(cy)) return { cx, cy };
  }
  const corners = det.corners;
  if (Array.isArray(corners) && corners.length >= 2) {
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (const p of corners) {
      if (Array.isArray(p) && p.length >= 2) {
        sx += Number(p[0]);
        sy += Number(p[1]);
        n++;
      } else if (p && typeof p === "object") {
        const q = p as Record<string, unknown>;
        const x = Number(q.x ?? q[0]);
        const y = Number(q.y ?? q[1]);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          sx += x;
          sy += y;
          n++;
        }
      }
    }
    if (n > 0) return { cx: sx / n, cy: sy / n };
  }
  return null;
}

function parseDetectionsInCrosshair(
  detections: unknown,
  imgW: number,
  imgH: number,
): { ids: number[]; outsideIds: number[] } {
  const arr = detectionArray(detections);
  const midX = imgW / 2;
  const midY = imgH / 2;
  const r = Math.min(imgW, imgH) * CROSSHAIR_RADIUS_FRAC;
  const r2 = r * r;

  const inside: number[] = [];
  const outside: number[] = [];

  for (const det of arr) {
    if (!det || typeof det !== "object") continue;
    const d = det as Record<string, unknown>;
    const idRaw = d.id;
    const id = typeof idRaw === "number" ? idRaw : Number(idRaw);
    if (!Number.isFinite(id)) continue;
    const pos = readCenter(d);
    if (!pos) continue;
    const dx = pos.cx - midX;
    const dy = pos.cy - midY;
    if (dx * dx + dy * dy <= r2) inside.push(id);
    else outside.push(id);
  }

  return { ids: inside, outsideIds: outside };
}

function parseDetectionIds(detections: unknown): number[] {
  return detectionArray(detections)
    .map((det) => {
      if (det && typeof det === "object" && "id" in det) {
        const id = (det as { id: unknown }).id;
        return typeof id === "number" ? id : Number(id);
      }
      return NaN;
    })
    .filter((n) => Number.isFinite(n));
}

/** tag36h11: bekannte Größe für Erkennung (PoC), IDs 1 … MAX */
const MAX_APRILTAG_IDS = 16;

export function useAprilTagDetector(
  getVideo: () => HTMLVideoElement | null,
  onTagIds: (ids: number[]) => void,
  enabled: boolean,
  onDebug?: (message: string) => void,
) {
  const rafRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const onTagIdsRef = useRef(onTagIds);
  const onDebugRef = useRef(onDebug);
  useLayoutEffect(() => {
    onTagIdsRef.current = onTagIds;
    onDebugRef.current = onDebug;
  }, [onTagIds, onDebug]);

  const stopLoop = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      stopLoop();
      return;
    }

    let cancelled = false;
    let lastDbg = "";
    let lastDbgAt = 0;
    const dbg = (s: string) => {
      const t = Date.now();
      if (s === lastDbg && t - lastDbgAt < 400) return;
      lastDbg = s;
      lastDbgAt = t;
      onDebugRef.current?.(s);
    };
    const worker = new Worker("/apriltag/apriltag.js");
    const RemoteApriltag = Comlink.wrap<new (cb: () => void) => ApriltagApi>(worker);

    const startLoop = (api: ApriltagApi) => {
      if (!canvasRef.current) {
        canvasRef.current = document.createElement("canvas");
      }
      const canvas = canvasRef.current;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const tick = async () => {
        if (cancelled) return;
        const video = getVideo();
        if (!video || video.readyState < 2) {
          rafRef.current = requestAnimationFrame(tick);
          return;
        }

        const w = video.videoWidth;
        const h = video.videoHeight;
        if (w < 32 || h < 32) {
          rafRef.current = requestAnimationFrame(tick);
          return;
        }

        canvas.width = w;
        canvas.height = h;
        try {
          ctx.drawImage(video, 0, 0, w, h);
          const imageData = ctx.getImageData(0, 0, w, h);
          const gray = new Uint8Array(w * h);
          const d = imageData.data;
          for (let i = 0, j = 0; i < d.length; i += 4, j++) {
            gray[j] = Math.round((d[i]! + d[i + 1]! + d[i + 2]!) / 3);
          }
          const detections = await api.detect(gray, w, h);
          const { ids, outsideIds } = parseDetectionsInCrosshair(detections, w, h);
          const anyId = parseDetectionIds(detections);

          if (anyId.length && ids.length === 0 && outsideIds.length === 0) {
            const m = Math.min(w, h);
            const s = Math.max(96, Math.floor(m * 0.38));
            const ox = Math.floor((w - s) / 2);
            const oy = Math.floor((h - s) / 2);
            const sub = new Uint8Array(s * s);
            for (let j = 0; j < s; j++) {
              sub.set(gray.subarray(ox + (oy + j) * w, ox + s + (oy + j) * w), j * s);
            }
            const subDet = await api.detect(sub, s, s);
            const cropIds = parseDetectionIds(subDet);
            onTagIdsRef.current(cropIds);
            dbg(
              cropIds.length
                ? `Im Zentrum (Crop): ${cropIds.join(", ")}`
                : `Tag erkannt, aber nicht in der Bildmitte (${anyId.join(", ")})`,
            );
          } else {
            onTagIdsRef.current(ids);
            if (ids.length) {
              dbg(`Im Fadenkreuz: ${ids.join(", ")}`);
            } else if (outsideIds.length) {
              dbg(`Tag(s) außerhalb Mitte: ${outsideIds.join(", ")}`);
            } else {
              dbg("kein Tag");
            }
          }
        } catch (e) {
          dbg(`Fehler: ${e instanceof Error ? e.message : "Scan"}`);
        }
        rafRef.current = requestAnimationFrame(tick);
      };

      rafRef.current = requestAnimationFrame(tick);
    };

    void (async () => {
      try {
        const instance = await new RemoteApriltag(
          Comlink.proxy(() => {
            if (cancelled) return;
            void (async () => {
              const video = getVideo();
              for (let id = 1; id <= MAX_APRILTAG_IDS; id++) {
                await instance.set_tag_size(id, 0.15);
              }
              if (video && video.videoWidth > 0) {
                const fx = video.videoWidth;
                const fy = video.videoWidth;
                const cx = video.videoWidth / 2;
                const cy = video.videoHeight / 2;
                await instance.set_camera_info(fx, fy, cx, cy);
              }
              dbg("AprilTag bereit");
              startLoop(instance);
            })();
          }),
        );
        if (cancelled) return;
      } catch (e) {
        console.error("AprilTag-Worker Start fehlgeschlagen", e);
        dbg("Worker-Start fehlgeschlagen (Konsole)");
      }
    })();

    return () => {
      cancelled = true;
      stopLoop();
      worker.terminate();
    };
  }, [enabled, getVideo, stopLoop]);
}
