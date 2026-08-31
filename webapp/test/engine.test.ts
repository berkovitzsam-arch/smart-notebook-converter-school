// Portable engine verification. It creates a tiny PDF in memory, rasterizes it
// with MuPDF, builds a notebook, then edits a whitespace-variant notebook page.
// Run: npm run test:engine
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { buildNotebook, textSvg } from "../src/notebook";
import { openNotebook, saveNotebook } from "../src/notebookEdit";
import { rasterizePdf } from "../src/pdf";
import { parseOpenState } from "../src/openwith";
import type { Page, Stroke, TextBox } from "../src/types";

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

function expectThrows(fn: () => unknown, contains: string) {
  try {
    fn();
  } catch (error) {
    expect((error as Error).message.includes(contains), `Expected error to include: ${contains}`);
    return;
  }
  throw new Error(`Expected function to throw: ${contains}`);
}

// A standards-compliant 72pt-square blank PDF. Generating it here avoids a
// machine-specific or checked-in binary fixture while still testing MuPDF WASM.
function tinyPdf(): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Resources << >> /Contents 4 0 R >>",
    "<< /Length 0 >>\nstream\n\nendstream",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${offset.toString().padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

const rasterized = await rasterizePdf(tinyPdf(), { dpi: 72, maxPages: 1 });
expect(rasterized.length === 1, "MuPDF should rasterize the generated one-page PDF");
expect(rasterized[0].widthPx > 0 && rasterized[0].heightPx > 0, "Rasterized page should have pixels");

const pen: Stroke = {
  kind: "stroke", tool: "pen", color: "#ff0000", width: 3,
  points: [{ x: 12, y: 14 }, { x: 24, y: 22 }, { x: 36, y: 14 }],
};
const highlighter: Stroke = {
  kind: "stroke", tool: "highlighter", color: "#ffff00", width: 21,
  points: [{ x: 10, y: 40 }, { x: 62, y: 40 }],
};
const text: TextBox = {
  kind: "text", x: 10, y: 50, text: "שלום <test>", color: "#000000",
  fontSize: 20, width: 120, height: 26, rtl: true,
};

const pages: Page[] = [
  { ...rasterized[0], annotations: [] },
  { ...rasterized[0], annotations: [] },
];
const sourceEntries = unzipSync(buildNotebook(pages));
const originalPage1 = strFromU8(sourceEntries["page1.svg"])
  .replace('<g class="foreground">', '<g\n  class="foreground"\n>')
  .replace("</g></svg>", "</g>\n</svg>");
sourceEntries["page1.svg"] = strToU8(originalPage1);

const opened = openNotebook(zipSync(sourceEntries));
expect(opened.pages.length === 2, "Editor should find both pages");
opened.pages[0].annotations.push(pen, highlighter, text);
const savedEntries = unzipSync(saveNotebook(opened));
const savedPage1 = strFromU8(savedEntries["page1.svg"]);

expect(savedPage1.includes('stroke="#ff0000"'), "Edited page should contain the pen stroke");
expect(savedPage1.includes('hilighter="1"'), "Edited page should contain native highlighter markup");
expect(savedPage1.includes("שלום &lt;test&gt;"), "Text content should be XML escaped");
expect(savedPage1.includes('<g\n  class="foreground"\n>'), "Whitespace-variant foreground group should be preserved");
expect(sameBytes(savedEntries["page2.svg"], sourceEntries["page2.svg"]), "Unedited page payload should be preserved");
expect(sameBytes(savedEntries["metadata.xml"], sourceEntries["metadata.xml"]), "Unedited metadata payload should be preserved");

const malformedEntries = { ...sourceEntries, "page1.svg": strToU8('<svg width="800" height="600"><g/></svg>') };
const malformed = openNotebook(zipSync(malformedEntries));
malformed.pages[0].annotations.push(pen);
expectThrows(() => saveNotebook(malformed), "foreground group");

const escaped = textSvg({ ...text, text: '<script>&"' });
expect(escaped.includes("&lt;script&gt;&amp;&quot;"), "Text SVG should escape XML-sensitive characters");

const launch = parseOpenState("?state=" + encodeURIComponent(JSON.stringify({
  ids: ["file-123"],
  resourceKeys: { "file-123": "resource-key" },
  action: "open",
  userId: "42",
})));
expect(launch?.ids[0] === "file-123", "Open-with state should retain the Drive file ID");
expect(launch?.resourceKeys?.["file-123"] === "resource-key", "Open-with state should retain Drive resource keys");
expect(parseOpenState("?state=not-json") === null, "Malformed Open-with state should be ignored safely");

console.log("ENGINE OK — portable PDF rasterization, notebook build, safe edit injection, XML escaping, and Open-with state parsing verified.");
