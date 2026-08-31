// Parse the `state` parameter Google Drive appends to an app's "Open with" URL.
// For opening existing files it looks like: {"ids":["<id>"],"action":"open","userId":"<n>"}
// Kept as a pure function so it can be unit-tested without Drive/OAuth.

export interface OpenWithState {
  ids: string[];
  action: string;
  userId?: string;
  // Link-shared Drive files can require an additional resource key. Drive
  // supplies this as a file-id-to-key dictionary in the launch state.
  resourceKeys?: Record<string, string>;
}

export function parseOpenState(search: string): OpenWithState | null {
  try {
    const raw = new URLSearchParams(search).get("state");
    if (!raw) return null;
    const s = JSON.parse(raw) as unknown;
    if (!s || typeof s !== "object") return null;
    const obj = s as Record<string, unknown>;
    if (typeof obj.action !== "string") return null;
    const ids = Array.isArray(obj.ids) ? obj.ids.filter((x): x is string => typeof x === "string") : [];
    let resourceKeys: Record<string, string> | undefined;
    if (obj.resourceKeys && typeof obj.resourceKeys === "object" && !Array.isArray(obj.resourceKeys)) {
      const validEntries: Array<[string, string]> = [];
      for (const [id, key] of Object.entries(obj.resourceKeys as Record<string, unknown>)) {
        if (id && typeof key === "string" && key) validEntries.push([id, key]);
      }
      if (validEntries.length) resourceKeys = Object.fromEntries(validEntries);
    }
    return {
      ids,
      action: obj.action,
      userId: typeof obj.userId === "string" ? obj.userId : undefined,
      resourceKeys,
    };
  } catch {
    return null;
  }
}
