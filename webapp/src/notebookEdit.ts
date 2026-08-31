// Open an existing .notebook for annotation and save it back APPEND-ONLY:
// unmodified entry payloads are carried through unchanged; we only add new
// annotations to pages the teacher drew on. ZIP compression metadata is rebuilt.
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import { annotationSvg } from "./notebook";
import type { Annotation } from "./types";

const MAX_NOTEBOOK_ENTRIES = 2_000;
const MAX_NOTEBOOK_ENTRY_BYTES = 50 * 1024 * 1024;
const MAX_NOTEBOOK_UNCOMPRESSED_BYTES = 250 * 1024 * 1024;

export interface EditPage {
  svgName: string; // e.g. "page1.svg"
  originalSvg: string; // untouched markup (used on save)
  renderSvg: string; // self-contained (root xmlns + images inlined) for display
  pageWidth: number; // coordinate space width
  pageHeight: number; // coordinate space height
  annotations: Annotation[]; // NEW annotations only (strokes + text)
}

export interface EditableNotebook {
  entries: Record<string, Uint8Array>;
  pages: EditPage[];
}

function base64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function parseSize(svg: string): { width: number; height: number } {
  const w = /<svg[^>]*\bwidth="([\d.]+)"/.exec(svg);
  const h = /<svg[^>]*\bheight="([\d.]+)"/.exec(svg);
  return { width: w ? parseFloat(w[1]) : 800, height: h ? parseFloat(h[1]) : 1160 };
}

function unzipNotebook(bytes: Uint8Array): Record<string, Uint8Array> {
  let fileCount = 0;
  let totalBytes = 0;
  return unzipSync(bytes, {
    filter: (file) => {
      fileCount += 1;
      totalBytes += file.originalSize;
      if (fileCount > MAX_NOTEBOOK_ENTRIES) {
        throw new Error(`Notebook has too many files (maximum ${MAX_NOTEBOOK_ENTRIES.toLocaleString()}).`);
      }
      if (file.originalSize > MAX_NOTEBOOK_ENTRY_BYTES) {
        throw new Error(`Notebook file ${file.name} is larger than the 50 MB safety limit.`);
      }
      if (totalBytes > MAX_NOTEBOOK_UNCOMPRESSED_BYTES) {
        throw new Error("Notebook expands beyond the 250 MB safety limit.");
      }
      return true;
    },
  });
}

function foregroundCloseIndex(svg: string): number {
  // Preserve the original SVG exactly and only locate the closing tag for the
  // foreground group. This accepts normal whitespace/attribute variation and
  // handles nested <g> elements without serializing the existing document.
  const groupTag = /<\/?g\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi;
  let depth = 0;
  let foundForeground = false;
  let match: RegExpExecArray | null;
  while ((match = groupTag.exec(svg))) {
    const tag = match[0];
    if (tag.startsWith("</")) {
      if (!foundForeground) continue;
      depth -= 1;
      if (depth === 0) return match.index;
      continue;
    }
    if (!foundForeground) {
      const classMatch = /\bclass\s*=\s*(["'])(.*?)\1/i.exec(tag);
      if (!classMatch?.[2].split(/\s+/).includes("foreground")) continue;
      foundForeground = true;
    }
    depth += 1;
  }
  throw new Error("Could not find the page foreground group; no annotations were saved.");
}

function appendAnnotations(svg: string, ink: string): string {
  const insertAt = foregroundCloseIndex(svg);
  return svg.slice(0, insertAt) + ink + svg.slice(insertAt);
}

// Make a page SVG renderable on its own: add the root namespaces (SMART omits
// them) and inline every referenced image as a data URL.
function toRenderable(svg: string, entries: Record<string, Uint8Array>): string {
  let out = svg;
  if (!/<svg[^>]*\bxmlns=/.test(out)) {
    out = out.replace(
      "<svg ",
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ',
    );
  }
  out = out.replace(/xlink:href="(images\/[^"]+)"/g, (m, path: string) => {
    const data = entries[path];
    if (!data) return m;
    const mime = /\.jpe?g$/i.test(path) ? "image/jpeg" : "image/png";
    return `xlink:href="data:${mime};base64,${base64(data)}"`;
  });
  return out;
}

export function openNotebook(bytes: Uint8Array): EditableNotebook {
  const entries = unzipNotebook(bytes);
  const pageNames = Object.keys(entries)
    .filter((n) => /^page\d+\.svg$/.test(n))
    .sort((a, b) => parseInt(a.match(/\d+/)![0], 10) - parseInt(b.match(/\d+/)![0], 10));
  if (pageNames.length === 0) throw new Error("This doesn't look like a SMART .notebook (no pages found).");

  const pages: EditPage[] = pageNames.map((name) => {
    const svg = strFromU8(entries[name]);
    const { width, height } = parseSize(svg);
    return {
      svgName: name,
      originalSvg: svg,
      renderSvg: toRenderable(svg, entries),
      pageWidth: width,
      pageHeight: height,
      annotations: [],
    };
  });
  return { entries, pages };
}

export function saveNotebook(nb: EditableNotebook): Uint8Array {
  const out: Record<string, Uint8Array> = { ...nb.entries };
  for (const page of nb.pages) {
    if (page.annotations.length === 0) continue;
    const ink = page.annotations.map(annotationSvg).join("");
    // Insert before the foreground group closes; existing markup is otherwise untouched.
    out[page.svgName] = strToU8(appendAnnotations(page.originalSvg, ink));
  }
  return zipSync(out, { level: 6 });
}
