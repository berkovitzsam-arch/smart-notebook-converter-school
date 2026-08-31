// The .notebook engine: turn pages (background image + ink strokes) into a
// SMART Notebook .notebook file. Pure — no DOM, no WASM — so it runs in Node
// tests and the browser identically. Ported from file2notebook.py +
// annotate_demo.py (format reverse-engineered from SMART Notebook for Mac 26.0).

import { zipSync, strToU8 } from "fflate";
import type { Page, Stroke, TextBox, Annotation } from "./types";

const PAGE_WIDTH = 800;

const ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function randId(n = 25): string {
  let s = "";
  for (let i = 0; i < n; i++) s += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  return s;
}

function imageName(): string {
  const num = 10000 + Math.floor(Math.random() * 90000);
  let suffix = "";
  const hex = "0123456789abcdef";
  for (let i = 0; i < 7; i++) suffix += hex[Math.floor(Math.random() * 16)];
  return `NBK-${num}-${suffix}.png`;
}

// A pen or highlighter stroke -> the exact <polyline> markup SMART itself emits.
export function polylineSvg(s: Stroke): string {
  const xs = s.points.map((p) => p.x);
  const ys = s.points.map((p) => p.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const pts = s.points.map((p) => `${p.x.toFixed(6)},${p.y.toFixed(6)}`).join(" ");
  const hil = s.tool === "highlighter" ? 'hilighter="1" ' : "";
  const op = s.tool === "highlighter" ? 'opacity="0.50" ' : "";
  return (
    `<polyline fill="none" points="${pts} " stroke-linecap="round" ` +
    `stroke-linejoin="round" ${hil}stroke="${s.color}" stroke-width="${s.width.toFixed(2)}" ` +
    `fade-time="6" fade-enable="0" RotationPoint="(320.000000,240.000000)" ` +
    `transform="rotate(0.00,${cx.toFixed(2)},${cy.toFixed(2)})" ${op}` +
    `xml:id="annotation.${randId()}" visible="1"/>`
  );
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// A text box -> the <text>/<tspan> markup SMART emits (decoded from a real file).
export function textSvg(t: TextBox): string {
  // Mirror the one real SMART sample exactly (English had language_direction="1",
  // textdirection="0"); only vary the visible alignment. Hebrew glyphs render RTL
  // via Unicode bidi regardless. RTL specifics may need refining after a SMART test.
  const just = t.rtl ? "right" : "left";
  const baseline = (t.fontSize * 0.82).toFixed(2);
  return (
    `<text transform="translate(${t.x.toFixed(0)},${t.y.toFixed(0)}) ` +
    `rotate(0.000,${(t.width / 2).toFixed(3)},${(t.height / 2).toFixed(3)}) scale(1.000,1.000)" ` +
    `smart-txt-ver="2.10" editwidth="${t.width.toFixed(2)}" editheight="${t.height.toFixed(2)}" ` +
    `forcewidth="0" forceheight="0" language_direction="1" textdirection="0" theme_anno_style="0" ` +
    `RotationPoint="(320.000000,240.000000)" xml:id="annotation.${randId()}" visible="1">` +
    `<tspan justification="${just}" bullet="0"><tspan>` +
    `<tspan fill="${t.color}" font-size="${t.fontSize.toFixed(3)}" font-family="Arial" ` +
    `char-transform="0.00 1.00 0.00 0.00 0.00 1.00" textLength="${t.width.toFixed(2)}" y="${baseline}" x="0.00">` +
    `${escapeXml(t.text)}</tspan></tspan></tspan></text>`
  );
}

export function annotationSvg(a: Annotation): string {
  return a.kind === "text" ? textSvg(a) : polylineSvg(a);
}

function pageSvg(page: Page, imgName: string, dispH: number): string {
  const ink = page.annotations.map(annotationSvg).join("");
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<svg width="${PAGE_WIDTH}" height="${dispH.toFixed(2)}" xml:id="page.${randId()}">` +
    '<g class="foreground">' +
    '<image xmlns:xlink="http://www.w3.org/1999/xlink" x="0.00" y="0.00" ' +
    `width="${PAGE_WIDTH.toFixed(2)}" height="${dispH.toFixed(2)}" ` +
    'RotationPoint="(320.000000,240.000000)" ' +
    `transform="rotate(0.00,${(PAGE_WIDTH / 2).toFixed(2)},${(dispH / 2).toFixed(2)})" ` +
    `xml:id="annotation.${randId()}" visible="1" ` +
    `xlink:href="images/${imgName}"/>` +
    ink +
    "</g></svg>"
  );
}

function manifestXml(pageFiles: string[], imageFiles: string[]): string {
  const files = (list: string[]) => list.map((h) => `<file href="${h}"/>`).join("");
  const pages = files(pageFiles);
  const images = files(imageFiles);
  const first = pageFiles[0];
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<manifest identifier="id1" version="2006-01" ' +
    'smartnotebook:filesource="notebook-converter-webapp 0.1" ' +
    'xmlns="http://www.imsglobal.org/xsd/imscp_v1p1" ' +
    'xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_v1p3" ' +
    'xmlns:smartnotebook="http://www.smarttech.com/2006-01/notebook" ' +
    'xmlns:smartgallery="http://www.smarttech.com/2006-01/gallery">' +
    "<metadata><schema>ADL SCORM</schema><schemaversion>CAM 1.3</schemaversion>" +
    "<adlcp:location>metadata.xml</adlcp:location></metadata>" +
    '<organizations><organization id="pagegroups">' +
    '<item id="group0" identifierref="group0_pages"><title>Group 1</title></item>' +
    "</organization></organizations>" +
    "<resources>" +
    `<resource identifier="group0_pages" href="${first}" type="webcontent" adlcp:scormType="asset">${pages}</resource>` +
    `<resource identifier="pages" href="${first}" type="webcontent" adlcp:scormType="asset">${pages}</resource>` +
    `<resource identifier="images">${images}</resource>` +
    '<resource identifier="sounds"/><resource identifier="attachments"/>' +
    '<resource identifier="flash"/><resource identifier="videos"/>' +
    '<resource identifier="annotationmetadata"/><resource identifier="brush"/>' +
    "</resources></manifest>"
  );
}

function metadataXml(): string {
  const guid = (globalThis.crypto?.randomUUID?.() ?? randId(32)).toUpperCase();
  const now = new Date().toISOString().slice(0, 19); // YYYY-MM-DDTHH:MM:SS
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<lom:lom xmlns:lom="http://ltsc.ieee.org/xsd/LOM" ' +
    'xmlns:smartgallery="http://www.smarttech.com/2006-01/gallery">' +
    "<lom:metaMetadata><lom:identifier><lom:catalog>URI</lom:catalog>" +
    "<lom:entry>http://www.adlnet.org/metadata/MDO_01</lom:entry></lom:identifier>" +
    "<lom:metadataSchema>LOMv1.0</lom:metadataSchema>" +
    "<lom:metadataSchema>SCORM_CAM_v1.3</lom:metadataSchema></lom:metaMetadata>" +
    "<lom:general><lom:identifier><lom:category>URI</lom:category>" +
    `<lom:entry>http://tempuri.org/randomid?id=${guid}</lom:entry></lom:identifier>` +
    '<lom:title><lom:string language="en"></lom:string></lom:title>' +
    '<lom:description><lom:string language="en"></lom:string></lom:description>' +
    '<lom:keyword><lom:string language="en"></lom:string></lom:keyword></lom:general>' +
    "<lom:technical><lom:format>application/x-smarttech-notebook</lom:format>" +
    "<lom:requirement><lom:orComposite><lom:type><lom:source>LOMv1.0</lom:source>" +
    "<lom:value>browser</lom:value></lom:type><lom:name><lom:source>LOMv1.0</lom:source>" +
    "<lom:value>x-smarttech-notebook</lom:value></lom:name>" +
    "<lom:minimumVersion>ms-windows:9.5;macos:9.5;unix:9.5</lom:minimumVersion>" +
    "</lom:orComposite></lom:requirement></lom:technical>" +
    "<lom:rights><lom:cost><lom:source>LOMv1.0</lom:source><lom:value>no</lom:value></lom:cost>" +
    "<lom:copyrightAndOtherRestrictions><lom:source>LOMv1.0</lom:source>" +
    "<lom:value>yes</lom:value></lom:copyrightAndOtherRestrictions>" +
    '<lom:description><lom:string language="en"></lom:string></lom:description></lom:rights>' +
    `<lom:lifeCycle><smartgallery:creationdatetime>${now}</smartgallery:creationdatetime>` +
    '<lom:version><lom:string language="en">1.0</lom:string></lom:version>' +
    "<lom:status><lom:source>LOMv1.0</lom:source><lom:value>final</lom:value></lom:status>" +
    "</lom:lifeCycle></lom:lom>"
  );
}

const SETTINGS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<AutoExport time="Off" type="None"/>';

export function buildNotebook(pages: Page[], previewPng?: Uint8Array): Uint8Array {
  if (pages.length === 0) throw new Error("No pages to build.");
  const files: Record<string, Uint8Array> = {};
  const pageFiles: string[] = [];
  const imageFiles: string[] = [];

  pages.forEach((page, i) => {
    const imgName = imageName();
    const dispH = (PAGE_WIDTH * page.heightPx) / page.widthPx;
    const pageFile = `page${i + 1}.svg`;
    pageFiles.push(pageFile);
    imageFiles.push(`images/${imgName}`);
    files[pageFile] = strToU8(pageSvg(page, imgName, dispH));
    files[`images/${imgName}`] = page.png;
  });

  files["imsmanifest.xml"] = strToU8(manifestXml(pageFiles, imageFiles));
  files["metadata.xml"] = strToU8(metadataXml());
  files["settings.xml"] = strToU8(SETTINGS_XML);
  files["preview.png"] = previewPng ?? pages[0].png;

  return zipSync(files, { level: 6 });
}
