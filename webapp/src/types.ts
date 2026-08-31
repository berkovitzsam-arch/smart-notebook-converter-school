export interface Stroke {
  kind: "stroke";
  tool: "pen" | "highlighter";
  color: string; // hex, e.g. "#ff0000"
  width: number; // stroke width in page units (800-wide page space)
  points: { x: number; y: number }[]; // page-space coordinates
}

export interface TextBox {
  kind: "text";
  x: number; // page-space top-left
  y: number;
  text: string;
  color: string;
  fontSize: number; // page units
  width: number; // measured, page units
  height: number; // page units
  rtl: boolean; // right-to-left (Hebrew/Arabic)
}

export type Annotation = Stroke | TextBox;

export interface Page {
  png: Uint8Array; // background image for the page
  widthPx: number;
  heightPx: number;
  annotations: Annotation[];
}
