// PDF -> page images via MuPDF (WASM). DOM-free, so it runs in Node and the
// browser identically. Same engine as the PyMuPDF prototype (file2notebook.py).

import * as mupdf from "mupdf";
import type { Page } from "./types";

// Yield to the event loop so the UI can paint. MessageChannel is NOT subject to
// background-tab timer throttling (setTimeout is clamped to ~1s in blurred tabs).
const inBrowser = typeof window !== "undefined";
const MAX_PDF_PAGES = 100;
const MAX_PAGE_PIXELS = 50_000_000;
function yieldToEventLoop(): Promise<void> {
  if (inBrowser && typeof MessageChannel !== "undefined") {
    return new Promise((resolve) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => { ch.port1.close(); resolve(); };
      ch.port2.postMessage(0);
    });
  }
  return new Promise((r) => setTimeout(r, 0));
}

export interface RasterOptions {
  dpi?: number; // default 300 (SMART's own PDF import is ~288)
  maxPages?: number;
  onProgress?: (done: number, total: number) => void;
}

// Async + yields between pages so the browser can paint progress and stay
// responsive on multi-page documents. In Node the per-page yield is negligible.
export async function rasterizePdf(bytes: Uint8Array, opts: RasterOptions = {}): Promise<Page[]> {
  const dpi = opts.dpi ?? 300;
  if (!Number.isFinite(dpi) || dpi <= 0) throw new Error("DPI must be a positive number.");
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  try {
    const total = doc.countPages();
    const n = opts.maxPages ? Math.min(opts.maxPages, total) : total;
    if (n > MAX_PDF_PAGES) {
      throw new Error(`PDF has ${n} pages; the browser safety limit is ${MAX_PDF_PAGES}.`);
    }
    const scaleFactor = dpi / 72;
    const scale = mupdf.Matrix.scale(scaleFactor, scaleFactor);

    const pages: Page[] = [];
    for (let i = 0; i < n; i++) {
      opts.onProgress?.(i, n);
      const page = doc.loadPage(i);
      try {
        const [x0, y0, x1, y1] = page.getBounds();
        const widthPx = Math.ceil(Math.abs(x1 - x0) * scaleFactor);
        const heightPx = Math.ceil(Math.abs(y1 - y0) * scaleFactor);
        if (widthPx * heightPx > MAX_PAGE_PIXELS) {
          throw new Error(
            `Page ${i + 1} would render to ${(widthPx * heightPx / 1e6).toFixed(1)} million pixels; ` +
            "reduce DPI or use a smaller PDF.",
          );
        }
        const pixmap = page.toPixmap(scale, mupdf.ColorSpace.DeviceRGB, false);
        try {
          pages.push({
            png: pixmap.asPNG(),
            widthPx: pixmap.getWidth(),
            heightPx: pixmap.getHeight(),
            annotations: [],
          });
        } finally {
          pixmap.destroy?.();
        }
      } finally {
        page.destroy?.();
      }
      await yieldToEventLoop();
    }
    opts.onProgress?.(n, n);
    return pages;
  } finally {
    doc.destroy?.();
  }
}
