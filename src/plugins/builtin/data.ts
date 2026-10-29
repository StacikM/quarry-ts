import type { PluginApi } from "../types";

export interface SavedPosition { x: number; y: number; z: number }

export function isPosition(value: unknown): value is SavedPosition {
  if (!value || typeof value !== "object") return false;
  const p = value as SavedPosition;
  return Number.isFinite(p.x) && Math.abs(p.x) < 30_000_000
    && Number.isFinite(p.z) && Math.abs(p.z) < 30_000_000
    && Number.isFinite(p.y) && p.y >= 1 && p.y <= 254;
}

/** Disk JSON is untrusted even when the TypeScript caller supplies a type. */
export function loadPositions(api: PluginApi): Record<string, SavedPosition> {
  const saved = api.loadData<unknown>({});
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
  return Object.fromEntries(Object.entries(saved).filter(([, point]) => isPosition(point)));
}

export function copyPosition(point: SavedPosition): SavedPosition {
  return { x: point.x, y: point.y, z: point.z };
}
