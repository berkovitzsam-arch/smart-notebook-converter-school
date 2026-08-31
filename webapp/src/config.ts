// Browser OAuth values are public at runtime, but do not commit a live API key.
// Configure these in webapp/.env.local; see .env.example and README.md.
export const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "";
export const GOOGLE_API_KEY = import.meta.env.VITE_GOOGLE_API_KEY ?? "";
export const GOOGLE_APP_ID = import.meta.env.VITE_GOOGLE_APP_ID ?? ""; // Cloud project number (Picker appId)

// `drive.file` limits file access to files the user opens with this app or that
// the app creates. `drive.install` is the narrowly scoped permission Drive uses
// to show this app in its right-click "Open with" menu.
export const DRIVE_SCOPE = [
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/drive.install",
].join(" ");

export function assertGoogleConfig(): void {
  if (GOOGLE_CLIENT_ID && GOOGLE_API_KEY && GOOGLE_APP_ID) return;
  throw new Error("Google Drive is not configured. Copy .env.example to .env.local and add your Google values.");
}
