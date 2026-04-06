const STORAGE_KEY = "catch-game-player-id";

export function getOrCreatePlayerId(): string {
  if (typeof window === "undefined") {
    return "";
  }
  let id = window.sessionStorage.getItem(STORAGE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    window.sessionStorage.setItem(STORAGE_KEY, id);
  }
  return id;
}
