export type GameMessage =
  | {
      type: "presence";
      roomId: string;
      playerId: string;
      ts: number;
    }
  | {
      type: "position";
      roomId: string;
      playerId: string;
      lat: number;
      lng: number;
      ts: number;
    }
  | {
      type: "player_caught";
      roomId: string;
      caughtPlayerId: string;
      catcherPlayerId: string;
      ts: number;
    }
  | {
      type: "storm";
      roomId: string;
      stormEventId: string;
      lat: number;
      lng: number;
      radiusM: number;
      casterPlayerId: string;
      hitPlayerIds: string[];
      ts: number;
    }
  | {
      type: "game_end";
      roomId: string;
      winnerPlayerId: string;
      ts: number;
      /** @deprecated nur noch für alte Clients / Logs */
      loserPlayerId?: string;
    }
  | {
      type: "drone_jam";
      roomId: string;
      jamEventId: string;
      casterPlayerId: string;
      /** Zeitstempel (ms), zu dem die Störung endet (Sender-Uhr). */
      endsAt: number;
      ts: number;
    }
  | {
      type: "tag_lock";
      roomId: string;
      scannerPlayerId: string;
      victimPlayerId: string;
      ts: number;
    }
  | {
      type: "weapon_hit";
      roomId: string;
      hitId: string;
      shooterPlayerId: string;
      victimPlayerId: string;
      damage: number;
      weapon: "sniper" | "semi";
      ts: number;
      /** Crit = finaler Schaden bereits ×2 auf Basiswaffe */
      isCrit?: boolean;
    }
  | {
      type: "tag_heal";
      roomId: string;
      healerPlayerId: string;
      victimPlayerId: string;
      ts: number;
    }
  | {
      type: "super_beam";
      roomId: string;
      superBeamId: string;
      casterPlayerId: string;
      originLat: number;
      originLng: number;
      endLat: number;
      endLng: number;
      lengthM: number;
      halfWidthM: number;
      hitPlayerIds: string[];
      /** Zeitpunkt (ms), zu dem der Schaden ausgeführt wird (Absender-Uhr). */
      impactAt: number;
      ts: number;
    };

export function parseGameMessage(raw: string): GameMessage | null {
  try {
    const data = JSON.parse(raw) as GameMessage;
    if (!data || typeof data !== "object" || !("type" in data)) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}
