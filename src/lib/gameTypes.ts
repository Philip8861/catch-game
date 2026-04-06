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
