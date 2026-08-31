import "./style.css";
import { rasterizePdf } from "./pdf";
import { imageToPage, makePreview, u8Blob, rasterizeSvg } from "./image";
import { buildNotebook } from "./notebook";
import { openNotebook, saveNotebook, type EditableNotebook } from "./notebookEdit";
import { parseOpenState } from "./openwith";
import * as drive from "./drive";
import type { Page, Stroke, TextBox, Annotation } from "./types";

const WIDTHS = { highlighter: 21, pen: 3 } as const;
const TEXT_SIZE = 36; // page units
const DEFAULT_COLOR = { highlighter: "#ffff00", pen: "#000000", text: "#000000" } as const;
const MAX_INPUT_BYTES = 100 * 1024 * 1024;

// One page as the editor sees it. `pageW/H` is the coordinate space new strokes
// are recorded in (800-based for conversions, the SVG's own size for edits).
// The background raster is produced lazily by `makeBg` and cached, so opening a
// big notebook is instant and only viewed pages get rendered.
interface EditorPage {
  pageW: number;
  pageH: number;
  annotations: Annotation[];
  makeBg: () => Promise<{ png: Uint8Array; widthPx: number; heightPx: number }>;
  bgCache?: { png: Uint8Array; rasterW: number; rasterH: number };
}

// ---- DOM ----
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const dropEl = $<HTMLElement>("drop");
const fileEl = $<HTMLInputElement>("file");
const dpiEl = $<HTMLSelectElement>("dpi");
const editorEl = $<HTMLElement>("editor");
const bg = $<HTMLCanvasElement>("bg");
const ink = $<HTMLCanvasElement>("ink");
const colorEl = $<HTMLInputElement>("color");
const pageInd = $<HTMLElement>("pageind");
const statusEl = $<HTMLElement>("status");
const toastEl = $<HTMLElement>("toast");
const stageEl = $<HTMLElement>("stage");
const measureCtx = document.createElement("canvas").getContext("2d")!;

// ---- state ----
let pages: EditorPage[] = [];
let current = 0;
let tool: "highlighter" | "pen" | "text" | "select" = "highlighter";
let baseName = "converted";
let drawing: Stroke | null = null;
let selected: Annotation | null = null; // move-tool selection (new annotations only)
let dragStart: { x: number; y: number } | null = null;
let mode: "convert" | "edit" = "convert";
let editable: EditableNotebook | null = null; // set in edit mode (append-only save)
let sourceParentId: string | null = null; // Drive folder of the opened file
let savedDriveId: string | null = null; // Drive file id to overwrite on save
let renderRevision = 0;

const isNotebook = (name: string) => /\.notebook$/i.test(name);
const setStatus = (msg: string, err = false) => {
  statusEl.textContent = msg;
  statusEl.classList.toggle("err", err);
};
const tick = () => new Promise((r) => setTimeout(r, 30));

let toastTimer: number | undefined;
function toast(message: string, err = false, link?: { href: string; label: string }, suffix = "") {
  toastEl.replaceChildren(document.createTextNode(message));
  if (link) {
    const a = document.createElement("a");
    a.href = link.href;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = link.label;
    toastEl.append(a);
  }
  if (suffix) toastEl.append(document.createTextNode(suffix));
  toastEl.classList.toggle("err", err);
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toastEl.hidden = true), 8000);
}

// ---- file intake ----
function wireDrop() {
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    dropEl.classList.remove("dragover");
    const f = (e as DragEvent).dataTransfer?.files?.[0];
    if (f) void handleFile(f);
  });
  for (const evt of ["dragenter", "dragover"]) {
    dropEl.addEventListener(evt, (e) => { e.preventDefault(); dropEl.classList.add("dragover"); });
  }
  dropEl.addEventListener("dragleave", () => dropEl.classList.remove("dragover"));
  fileEl.addEventListener("change", () => {
    const f = fileEl.files?.[0];
    if (f) void handleFile(f);
  });
  $("openDrive").addEventListener("click", () => void openFromDrive());
}

async function handleFile(file: File) {
  sourceParentId = null;
  savedDriveId = null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  await routeBytes(bytes, file.name, file.type);
}

async function openFromDrive() {
  try {
    setStatus("Opening Google Drive…");
    const picked = await drive.pickFile();
    if (!picked) { setStatus(""); return; }
    setStatus(`Downloading ${picked.name}…`);
    const bytes = await drive.downloadFile(picked.id);
    if (isNotebook(picked.name)) {
      sourceParentId = null;
      await routeBytes(bytes, picked.name, picked.mimeType);
      savedDriveId = picked.id; // Save overwrites the same Drive file
    } else {
      sourceParentId = await drive.getParent(picked.id);
      savedDriveId = null;
      await routeBytes(bytes, picked.name, picked.mimeType);
    }
  } catch (err) {
    console.error(err);
    setStatus(`Google Drive error: ${(err as Error).message}`, true);
  }
}

// Launched via Google Drive "Open with": Drive opens the app at OPEN_URL?state=...
// Only acts when a valid open-state is present; otherwise the normal drop screen shows.
async function handleOpenWithState() {
  const st = parseOpenState(location.search);
  if (!st || st.action !== "open" || st.ids.length === 0) return;
  const id = st.ids[0];
  try {
    setStatus("Opening file from Google Drive…");
    await drive.connect();
    const meta = await drive.getFileMeta(id, st.resourceKeys);
    setStatus(`Downloading ${meta.name}…`);
    const bytes = await drive.downloadFile(id, st.resourceKeys);
    const canEdit = meta.capabilities?.canEdit !== false;
    if (isNotebook(meta.name)) {
      sourceParentId = null;
      await routeBytes(bytes, meta.name, meta.mimeType);
      // Drive documents that are view-only should never appear to be saved in
      // place. Saving creates a new .notebook instead.
      savedDriveId = canEdit ? id : null;
    } else {
      sourceParentId = meta.parents?.[0] ?? null;
      savedDriveId = null;
      await routeBytes(bytes, meta.name, meta.mimeType);
    }
    if (!canEdit) {
      toast("This Drive file is read-only. Saving will create a new .notebook file instead.", true);
    }
  } catch (err) {
    console.error(err);
    setStatus(`Could not open the file from Google Drive: ${(err as Error).message}`, true);
  }
}

async function routeBytes(bytes: Uint8Array, name: string, mimeType: string) {
  try {
    if (bytes.byteLength > MAX_INPUT_BYTES) {
      throw new Error("That file is larger than the 100 MB browser safety limit.");
    }
    if (isNotebook(name)) await openForEdit(bytes, name);
    else await loadConvert(bytes, name, mimeType);
  } catch (err) {
    console.error(err);
    setStatus(`Could not open that file: ${(err as Error).message}`, true);
  }
}

async function loadConvert(bytes: Uint8Array, name: string, mimeType: string) {
  mode = "convert";
  editable = null;
  baseName = name.replace(/\.[^.]+$/, "") || "converted";
  const isPdf = mimeType === "application/pdf" || /\.pdf$/i.test(name);
  let src: Page[];
  if (isPdf) {
    const dpi = parseInt(dpiEl.value, 10);
    setStatus(`Rendering PDF at ${dpi} DPI…`);
    await tick();
    src = await rasterizePdf(bytes, {
      dpi,
      onProgress: (done, total) => setStatus(`Rendering page ${Math.min(done + 1, total)} of ${total} at ${dpi} DPI…`),
    });
  } else {
    setStatus("Loading image…");
    await tick();
    src = [await imageToPage(bytes, mimeType)];
  }
  pages = src.map((p) => ({
    pageW: 800,
    pageH: (800 * p.heightPx) / p.widthPx,
    annotations: p.annotations,
    // Conversions are already rasterized — cache immediately.
    bgCache: { png: p.png, rasterW: p.widthPx, rasterH: p.heightPx },
    makeBg: async () => ({ png: p.png, widthPx: p.widthPx, heightPx: p.heightPx }),
  }));
  showEditor(`Loaded ${pages.length} page${pages.length > 1 ? "s" : ""}. Draw to highlight, then download or save to Drive.`);
}

async function openForEdit(bytes: Uint8Array, name: string) {
  mode = "edit";
  baseName = name.replace(/\.[^.]+$/, "") || "notebook";
  setStatus("Opening .notebook…");
  await tick();
  editable = openNotebook(bytes);
  pages = editable.pages.map((ep) => ({
    pageW: ep.pageWidth,
    pageH: ep.pageHeight,
    annotations: ep.annotations, // same array -> saveNotebook reads these
    makeBg: () => rasterizeSvg(ep.renderSvg, ep.pageWidth, ep.pageHeight, 2),
  }));
  showEditor(`Opened ${baseName} (${pages.length} page${pages.length > 1 ? "s" : ""}). Highlight, then Save — your original content is kept.`);
}

function showEditor(status: string) {
  current = 0;
  dropEl.hidden = true;
  editorEl.hidden = false;
  setStatus(status);
  void renderPage();
}

// ---- rendering ----
async function renderPage() {
  const revision = ++renderRevision;
  const pageIndex = current;
  const p = pages[pageIndex];
  pageInd.textContent = `${pageIndex + 1} / ${pages.length}`;
  if (!p.bgCache) {
    const prev = statusEl.textContent;
    setStatus("Rendering page…");
    const r = await p.makeBg();
    if (revision !== renderRevision || pageIndex !== current) return;
    p.bgCache = { png: r.png, rasterW: r.widthPx, rasterH: r.heightPx };
    if (statusEl.textContent === "Rendering page…") setStatus(prev);
  }
  const c = p.bgCache;
  const bmp = await createImageBitmap(u8Blob(c.png, "image/png"));
  if (revision !== renderRevision || pageIndex !== current) {
    bmp.close();
    return;
  }
  bg.width = c.rasterW; bg.height = c.rasterH;
  bg.getContext("2d")!.drawImage(bmp, 0, 0);
  bmp.close();
  ink.width = c.rasterW; ink.height = c.rasterH;
  drawStrokes();
}

function drawStrokes() {
  const p = pages[current];
  if (!p) return;
  const c = p.bgCache;
  const ctx = ink.getContext("2d")!;
  ctx.clearRect(0, 0, ink.width, ink.height);
  if (!c) return;
  const sx = c.rasterW / p.pageW;
  const sy = c.rasterH / p.pageH;
  const items: Annotation[] = drawing ? [...p.annotations, drawing] : p.annotations;
  for (const a of items) {
    if (a.kind === "text") { drawTextItem(ctx, a, sx); continue; }
    if (a.points.length === 0) continue;
    ctx.globalAlpha = a.tool === "highlighter" ? 0.5 : 1;
    ctx.strokeStyle = a.color;
    ctx.lineWidth = (a.width / p.pageW) * c.rasterW;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(a.points[0].x * sx, a.points[0].y * sy);
    for (let i = 1; i < a.points.length; i++) ctx.lineTo(a.points[i].x * sx, a.points[i].y * sy);
    if (a.points.length === 1) ctx.lineTo(a.points[0].x * sx + 0.01, a.points[0].y * sy);
    ctx.stroke();
  }
  if (selected && p.annotations.includes(selected)) {
    const b = bboxOf(selected);
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = "#2563eb";
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 2;
    ctx.strokeRect(b.x0 * sx, b.y0 * sy, (b.x1 - b.x0) * sx, (b.y1 - b.y0) * sy);
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

function drawTextItem(ctx: CanvasRenderingContext2D, t: TextBox, sx: number) {
  ctx.globalAlpha = 1;
  ctx.fillStyle = t.color;
  ctx.font = `${(t.fontSize * sx).toFixed(1)}px Arial`;
  ctx.textBaseline = "top";
  ctx.textAlign = t.rtl ? "right" : "left";
  ctx.direction = t.rtl ? "rtl" : "ltr";
  const drawX = (t.rtl ? t.x + t.width : t.x) * sx;
  ctx.fillText(t.text, drawX, t.y * sx);
  ctx.textAlign = "left";
  ctx.direction = "ltr";
}

// ---- drawing ----
function pointToPage(e: PointerEvent) {
  const rect = ink.getBoundingClientRect();
  const p = pages[current];
  return {
    x: ((e.clientX - rect.left) / rect.width) * p.pageW,
    y: ((e.clientY - rect.top) / rect.height) * p.pageH,
  };
}

// ---- select / move (operates on newly-added annotations only) ----
function bboxOf(a: Annotation) {
  if (a.kind === "text") return { x0: a.x, y0: a.y, x1: a.x + a.width, y1: a.y + a.height };
  const xs = a.points.map((p) => p.x);
  const ys = a.points.map((p) => p.y);
  const pad = a.width / 2 + 4;
  return { x0: Math.min(...xs) - pad, y0: Math.min(...ys) - pad, x1: Math.max(...xs) + pad, y1: Math.max(...ys) + pad };
}

function hitTest(px: number, py: number): Annotation | null {
  const anns = pages[current].annotations;
  for (let i = anns.length - 1; i >= 0; i--) {
    const b = bboxOf(anns[i]);
    if (px >= b.x0 && px <= b.x1 && py >= b.y0 && py <= b.y1) return anns[i];
  }
  return null;
}

function moveAnnotation(a: Annotation, dx: number, dy: number) {
  if (a.kind === "text") {
    a.x += dx;
    a.y += dy;
  } else {
    a.points = a.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
  }
}

function deleteSelected() {
  if (!selected) return;
  const anns = pages[current].annotations;
  const i = anns.indexOf(selected);
  if (i >= 0) anns.splice(i, 1);
  selected = null;
  drawStrokes();
}

function wireDrawing() {
  ink.addEventListener("pointerdown", (e) => {
    if (tool === "text") {
      const pt = pointToPage(e);
      startTextEntry(pt.x, pt.y);
      return;
    }
    if (tool === "select") {
      const pt = pointToPage(e);
      selected = hitTest(pt.x, pt.y);
      if (selected) {
        dragStart = pt;
        try { ink.setPointerCapture(e.pointerId); } catch { /* non-fatal */ }
      }
      drawStrokes();
      return;
    }
    const t = tool as "pen" | "highlighter";
    try { ink.setPointerCapture(e.pointerId); } catch { /* non-fatal */ }
    drawing = { kind: "stroke", tool: t, color: colorEl.value, width: WIDTHS[t], points: [pointToPage(e)] };
    drawStrokes();
  });
  ink.addEventListener("pointermove", (e) => {
    if (dragStart && selected) {
      const pt = pointToPage(e);
      moveAnnotation(selected, pt.x - dragStart.x, pt.y - dragStart.y);
      dragStart = pt;
      drawStrokes();
      return;
    }
    if (!drawing) return;
    drawing.points.push(pointToPage(e));
    drawStrokes();
  });
  const finish = () => {
    if (dragStart) { dragStart = null; return; }
    if (!drawing) return;
    if (drawing.points.length > 0) pages[current].annotations.push(drawing);
    drawing = null;
    drawStrokes();
  };
  ink.addEventListener("pointerup", finish);
  ink.addEventListener("pointercancel", finish);

  window.addEventListener("keydown", (e) => {
    if ((e.key === "Delete" || e.key === "Backspace") && selected && !editorEl.hidden) {
      if (document.activeElement?.tagName === "INPUT") return; // don't hijack text entry
      e.preventDefault();
      deleteSelected();
    }
  });
}

function measureTextWidth(text: string, fontSize: number): number {
  measureCtx.font = `${fontSize}px Arial`;
  return measureCtx.measureText(text).width;
}

// Click-to-place text: a positioned input over the page; Enter/blur commits.
function startTextEntry(px: number, py: number) {
  const p = pages[current];
  const rect = ink.getBoundingClientRect();
  const dispScale = rect.width / p.pageW; // displayed px per page unit
  const input = document.createElement("input");
  input.type = "text";
  input.dir = "auto";
  input.className = "text-entry";
  input.style.left = `${px * dispScale}px`;
  input.style.top = `${py * dispScale}px`;
  input.style.fontSize = `${Math.max(12, TEXT_SIZE * dispScale)}px`;
  input.style.color = colorEl.value;
  stageEl.appendChild(input);
  setTimeout(() => input.focus(), 0);

  let done = false;
  const commit = () => {
    if (done) return;
    done = true;
    const text = input.value.trim();
    input.remove();
    if (!text) return;
    const rtl = /[֐-׿؀-ۿ܀-߿]/.test(text); // Hebrew/Arabic
    p.annotations.push({
      kind: "text",
      x: px,
      y: py,
      text,
      color: colorEl.value,
      fontSize: TEXT_SIZE,
      width: measureTextWidth(text, TEXT_SIZE),
      height: TEXT_SIZE * 1.3,
      rtl,
    });
    drawStrokes();
  };
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    else if (e.key === "Escape") { e.preventDefault(); done = true; input.remove(); }
  });
}

// ---- toolbar ----
function wireToolbar() {
  document.querySelectorAll<HTMLButtonElement>(".tool").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tool").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      tool = btn.dataset.tool as "highlighter" | "pen" | "text" | "select";
      const c = DEFAULT_COLOR[tool as keyof typeof DEFAULT_COLOR];
      if (c) colorEl.value = c;
      selected = null;
      ink.style.cursor = tool === "text" ? "text" : tool === "select" ? "default" : "crosshair";
      drawStrokes();
    });
  });
  $("undo").addEventListener("click", () => { pages[current]?.annotations.pop(); selected = null; drawStrokes(); });
  $("prev").addEventListener("click", () => { if (current > 0) { current--; selected = null; void renderPage(); } });
  $("next").addEventListener("click", () => { if (current < pages.length - 1) { current++; selected = null; void renderPage(); } });
  $("reset").addEventListener("click", () => {
    pages = []; current = 0; drawing = null; selected = null; dragStart = null; editable = null; mode = "convert";
    sourceParentId = null; savedDriveId = null;
    editorEl.hidden = true; dropEl.hidden = false; fileEl.value = "";
    setStatus("");
  });
  $("download").addEventListener("click", () => void download());
  $("saveDrive").addEventListener("click", () => void saveToDrive());
}

// Produce the .notebook bytes for the current mode.
async function buildOutputBytes(): Promise<Uint8Array> {
  if (mode === "edit" && editable) return saveNotebook(editable);
  const preview = await makePreview(pages[0].bgCache!.png);
  const src: Page[] = pages.map((p) => ({
    png: p.bgCache!.png,
    widthPx: p.bgCache!.rasterW,
    heightPx: p.bgCache!.rasterH,
    annotations: p.annotations,
  }));
  return buildNotebook(src, preview);
}

const annotationCount = () => pages.reduce((sum, p) => sum + p.annotations.length, 0);

async function download() {
  if (pages.length === 0) return;
  try {
    setStatus("Building .notebook…");
    await tick();
    const bytes = await buildOutputBytes();
    const url = URL.createObjectURL(u8Blob(bytes, "application/octet-stream"));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${baseName}.notebook`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    toast(`✓ Downloaded ${baseName}.notebook (${pages.length} pages, ${annotationCount()} annotations, ${(bytes.length / 1e6).toFixed(1)} MB).`);
  } catch (err) {
    console.error(err);
    toast(`Could not build the file: ${(err as Error).message}`, true);
  }
}

async function saveToDrive() {
  if (pages.length === 0) return;
  const btn = $<HTMLButtonElement>("saveDrive");
  const label = btn.textContent;
  btn.disabled = true;
  try {
    if (!drive.isConnected()) {
      btn.textContent = "Connecting…";
      await drive.connect();
    }
    btn.textContent = "Saving…";
    const bytes = await buildOutputBytes();
    const res = await drive.uploadNotebook(`${baseName}.notebook`, bytes, sourceParentId, savedDriveId ?? undefined);
    savedDriveId = res.id;
    const link = { href: `https://drive.google.com/file/d/${res.id}/view`, label: res.name };
    if (res.updated) {
      toast("✓ Saved ", false, link, " back to Google Drive (same file). Open it on your SMART Board.");
    } else {
      toast("✓ Saved ", false, link, ` to ${res.toRoot ? "My Drive" : "the source folder"}. Re-saving updates this same file.`);
    }
  } catch (err) {
    console.error(err);
    toast(`Save to Drive failed: ${(err as Error).message}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

wireDrop();
wireDrawing();
wireToolbar();
setStatus("");
void handleOpenWithState();
