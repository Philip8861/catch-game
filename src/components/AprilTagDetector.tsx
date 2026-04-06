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

function parseDetectionIds(detections: unknown): number[] {
  if (Array.isArray(detections)) {
    return detections
      .map((det) => {
        if (det && typeof det === "object" && "id" in det) {
          const id = (det as { id: unknown }).id;
          return typeof id === "number" ? id : Number(id);
        }
        return NaN;
      })
      .filter((n) => Number.isFinite(n));
  }
  if (detections && typeof detections === "object" && "tags" in detections) {
    return parseDetectionIds((detections as { tags: unknown }).tags);
  }
  return [];
}

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
          const ids = parseDetectionIds(detections);
          onTagIdsRef.current(ids);
          dbg(ids.length ? `Tags: ${ids.join(", ")}` : "kein Tag");
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
              await instance.set_tag_size(1, 0.15);
              await instance.set_tag_size(2, 0.15);
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
