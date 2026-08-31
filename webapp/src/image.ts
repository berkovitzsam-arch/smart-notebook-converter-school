// Browser-only: decode an image file into a Page (flattened onto white so the
// notebook page has a solid background).
import type { Page } from "./types";

const MAX_IMAGE_PIXELS = 50_000_000;

// TS 5.7 types Uint8Array as generic over its buffer; Blob wants ArrayBuffer-backed.
export const u8Blob = (data: Uint8Array, type: string): Blob =>
  new Blob([data as unknown as BlobPart], { type });

export async function imageToPage(bytes: Uint8Array, mime: string): Promise<Page> {
  const blob = u8Blob(bytes, mime || "image/png");
  const bmp = await createImageBitmap(blob);
  const pixelCount = bmp.width * bmp.height;
  if (pixelCount > MAX_IMAGE_PIXELS) {
    bmp.close();
    throw new Error(
      `Image is ${(pixelCount / 1e6).toFixed(1)} million pixels; the browser safety limit is 50 million.`,
    );
  }
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const png = await canvasToPng(canvas);
  return { png, widthPx: canvas.width, heightPx: canvas.height, annotations: [] };
}

export function canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (b) => {
      if (!b) return reject(new Error("toBlob failed"));
      resolve(new Uint8Array(await b.arrayBuffer()));
    }, "image/png");
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to render a .notebook page"));
    img.src = src;
  });
}

// Render a self-contained page SVG (in pageWidth×pageHeight units) to a PNG for
// on-screen display. Display-only — saving reuses the original high-res image.
export async function rasterizeSvg(
  svg: string,
  pageWidth: number,
  pageHeight: number,
  scale = 2,
): Promise<{ png: Uint8Array; widthPx: number; heightPx: number }> {
  const widthPx = Math.max(1, Math.round(pageWidth * scale));
  const heightPx = Math.max(1, Math.round(pageHeight * scale));
  if (widthPx * heightPx > MAX_IMAGE_PIXELS) {
    throw new Error(
      `Notebook page would render to ${(widthPx * heightPx / 1e6).toFixed(1)} million pixels; ` +
      "the browser safety limit is 50 million.",
    );
  }
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const img = await loadImage(url);
    const canvas = document.createElement("canvas");
    canvas.width = widthPx;
    canvas.height = heightPx;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, widthPx, heightPx);
    ctx.drawImage(img, 0, 0, widthPx, heightPx);
    return { png: await canvasToPng(canvas), widthPx, heightPx };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Downscaled thumbnail for preview.png (keeps the .notebook smaller).
export async function makePreview(pagePng: Uint8Array): Promise<Uint8Array> {
  const bmp = await createImageBitmap(u8Blob(pagePng, "image/png"));
  const w = 138;
  const h = Math.max(1, Math.round((bmp.height / bmp.width) * w));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return canvasToPng(canvas);
}
