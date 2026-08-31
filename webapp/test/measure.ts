// Ad-hoc: measure real PDFs through the actual engine (pages, timing, output size).
// Run: npx tsx test/measure.ts "file1.pdf" "file2.pdf" ...
import { readFileSync } from "node:fs";
import { rasterizePdf } from "../src/pdf";
import { buildNotebook } from "../src/notebook";

for (const f of process.argv.slice(2)) {
  const name = f.split("/").pop();
  try {
    const bytes = new Uint8Array(readFileSync(f));
    const t0 = performance.now();
    const pages = await rasterizePdf(bytes, { dpi: 300 });
    const t1 = performance.now();
    const nb = buildNotebook(pages);
    const t2 = performance.now();
    console.log(
      `${name}\n  ${pages.length}p  ${pages[0].widthPx}x${pages[0].heightPx}px  |  ` +
        `raster ${(t1 - t0).toFixed(0)}ms  build ${(t2 - t1).toFixed(0)}ms  |  ` +
        `out ${(nb.length / 1e6).toFixed(1)}MB (${(nb.length / 1e6 / pages.length).toFixed(2)}MB/page)`,
    );
  } catch (e) {
    console.log(`${name}: ERROR ${(e as Error).message}`);
  }
}
