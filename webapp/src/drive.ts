// Google Drive adapter: sign-in (GIS token flow), file Picker, download, upload.
// Kept separate from the .notebook engine so the engine stays transport-agnostic.
import {
  GOOGLE_CLIENT_ID, GOOGLE_API_KEY, GOOGLE_APP_ID, DRIVE_SCOPE, assertGoogleConfig,
} from "./config";

// GIS + gapi are loaded from Google at runtime; no types available.
declare const google: any;
declare const gapi: any;

let accessToken: string | null = null;
let tokenExpiresAt = 0;
let tokenClient: any = null;
let pickerReady: Promise<void> | null = null;

const TOKEN_EXPIRY_SKEW_MS = 30_000;

function hasValidToken(): boolean {
  return !!accessToken && Date.now() < tokenExpiresAt - TOKEN_EXPIRY_SKEW_MS;
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

async function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("Google APIs did not load in time");
    await new Promise((r) => setTimeout(r, 50));
  }
}

export function isConnected(): boolean {
  return hasValidToken();
}

export async function connect(): Promise<void> {
  assertGoogleConfig();
  await loadScript("https://accounts.google.com/gsi/client");
  await waitFor(() => !!(window as any).google?.accounts?.oauth2);
  if (!tokenClient) {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: DRIVE_SCOPE,
      callback: () => {},
    });
  }
  await new Promise<void>((resolve, reject) => {
    tokenClient.callback = (resp: any) => {
      if (resp.error) return reject(new Error(resp.error));
      accessToken = resp.access_token;
      tokenExpiresAt = Date.now() + Number(resp.expires_in ?? 3600) * 1000;
      resolve();
    };
    // Always "" (never "consent"): forcing consent re-prompts the full grant
    // screen on every page load, and Drive "Open with" is always a fresh load.
    // Google still shows consent the first time, or when scopes actually change.
    tokenClient.requestAccessToken({ prompt: "" });
  });
}

// Retry once after a 401 so an expired GIS token does not make Drive save/open
// fail until the user manually reloads the app.
async function authorizedFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const request = async () => {
    if (!hasValidToken()) await connect();
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${accessToken}`);
    return fetch(input, { ...init, headers });
  };
  let res = await request();
  if (res.status === 401) {
    accessToken = null;
    tokenExpiresAt = 0;
    res = await request();
  }
  return res;
}

async function initPicker(): Promise<void> {
  if (!pickerReady) {
    pickerReady = (async () => {
      await loadScript("https://apis.google.com/js/api.js");
      await waitFor(() => !!(window as any).gapi);
      await new Promise<void>((resolve) => gapi.load("picker", { callback: () => resolve() }));
    })();
  }
  return pickerReady;
}

export interface PickedFile {
  id: string;
  name: string;
  mimeType: string;
}

export type DriveResourceKeys = Record<string, string>;

// Drive provides resource keys for certain link-shared files in an Open-with
// launch. Send the exact file-id/key pairs back on every related API request.
export function resourceKeyHeader(resourceKeys?: DriveResourceKeys): string | undefined {
  if (!resourceKeys) return undefined;
  const pairs = Object.entries(resourceKeys)
    .filter(([id, key]) => id.length > 0 && key.length > 0)
    .map(([id, key]) => `${id}/${key}`);
  return pairs.length ? pairs.join(",") : undefined;
}

function resourceKeyRequest(resourceKeys?: DriveResourceKeys): RequestInit {
  const value = resourceKeyHeader(resourceKeys);
  return value ? { headers: { "X-Goog-Drive-Resource-Keys": value } } : {};
}

export async function pickFile(): Promise<PickedFile | null> {
  if (!hasValidToken()) await connect();
  await initPicker();
  return new Promise((resolve) => {
    // No mime filter: .notebook files have no reliable mime, so show all files
    // and let the app route by extension (PDF/image -> convert, .notebook -> edit).
    const view = new google.picker.DocsView(google.picker.ViewId.DOCS).setSelectFolderEnabled(false);
    const picker = new google.picker.PickerBuilder()
      .setAppId(GOOGLE_APP_ID)
      .setOAuthToken(accessToken)
      .setDeveloperKey(GOOGLE_API_KEY)
      .addView(view)
      .setCallback((data: any) => {
        if (data.action === google.picker.Action.PICKED) {
          const d = data.docs[0];
          resolve({ id: d.id, name: d.name, mimeType: d.mimeType });
        } else if (data.action === google.picker.Action.CANCEL) {
          resolve(null);
        }
      })
      .build();
    picker.setVisible(true);
  });
}

export async function downloadFile(id: string, resourceKeys?: DriveResourceKeys): Promise<Uint8Array> {
  const res = await authorizedFetch(
    `https://www.googleapis.com/drive/v3/files/${id}?alt=media`,
    resourceKeyRequest(resourceKeys),
  );
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

export async function getParent(id: string): Promise<string | null> {
  const res = await authorizedFetch(`https://www.googleapis.com/drive/v3/files/${id}?fields=parents`);
  if (!res.ok) return null;
  const j = await res.json();
  return j.parents?.[0] ?? null;
}

export interface FileMeta {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  capabilities?: { canEdit?: boolean };
}

// Used by the "Open with" flow: the launch `state` gives a file id but no name.
export async function getFileMeta(id: string, resourceKeys?: DriveResourceKeys): Promise<FileMeta> {
  const res = await authorizedFetch(
    `https://www.googleapis.com/drive/v3/files/${id}?fields=id,name,mimeType,parents,capabilities(canEdit)`,
    resourceKeyRequest(resourceKeys),
  );
  if (!res.ok) throw new Error(`Could not read file info (${res.status})`);
  const j = await res.json();
  return {
    id: j.id,
    name: j.name,
    mimeType: j.mimeType,
    parents: j.parents,
    capabilities: j.capabilities,
  };
}

export interface UploadedFile {
  id: string;
  name: string;
}

async function doUpload(name: string, bytes: Uint8Array, parentId: string | null): Promise<Response> {
  const metadata: Record<string, unknown> = { name, mimeType: "application/octet-stream" };
  if (parentId) metadata.parents = [parentId];
  const boundary = "notebookconverterboundary31415926";
  const enc = new TextEncoder();
  const pre = enc.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify(metadata) +
      `\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const post = enc.encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(pre.length + bytes.length + post.length);
  body.set(pre, 0);
  body.set(bytes, pre.length);
  body.set(post, pre.length + bytes.length);
  return authorizedFetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name", {
    method: "POST",
    headers: {
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });
}

// Try to save into the source folder; fall back to My Drive root if drive.file
// doesn't grant write access to that folder.
export async function uploadNotebook(
  name: string,
  bytes: Uint8Array,
  parentId: string | null,
  existingId?: string,
): Promise<UploadedFile & { toRoot: boolean; updated: boolean }> {
  // If we already saved this session, overwrite that same file (no duplicates).
  if (existingId) {
    const res = await authorizedFetch(
      `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=media&fields=id,name`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/octet-stream" },
        body: bytes as unknown as BodyInit,
      },
    );
    if (res.ok) {
      const j = await res.json();
      return { id: j.id, name: j.name, toRoot: false, updated: true };
    }
    // else the file may have been deleted/moved — fall through and create a new one
  }
  let res = await doUpload(name, bytes, parentId);
  let toRoot = false;
  if (!res.ok && parentId) {
    res = await doUpload(name, bytes, null);
    toRoot = true;
  }
  if (!res.ok) throw new Error(`Upload failed (${res.status})`);
  const j = await res.json();
  return { id: j.id, name: j.name, toRoot, updated: false };
}
