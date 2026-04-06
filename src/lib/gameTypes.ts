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
      type: "game_end";
      roomId: string;
      winnerPlayerId: string;
      loserPlayerId: string;
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
