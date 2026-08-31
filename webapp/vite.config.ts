import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const modeEnv = loadEnv(mode, process.cwd(), "VITE_");
  if (mode === "school") {
    const required = [
      "VITE_GOOGLE_CLIENT_ID",
      "VITE_GOOGLE_API_KEY",
      "VITE_GOOGLE_APP_ID",
      "VITE_BASE_PATH",
    ] as const;
    const missing = required.filter((key) => !modeEnv[key] || /^(your-|placeholder)/i.test(modeEnv[key]));
    const invalidBase = modeEnv.VITE_BASE_PATH && !/^\/[a-z0-9._-]+\/$/i.test(modeEnv.VITE_BASE_PATH);
    if (modeEnv.VITE_DEPLOYMENT_TARGET !== "school" || missing.length > 0 || invalidBase) {
      throw new Error(
        "School build requires a complete .env.school.local with VITE_DEPLOYMENT_TARGET=school " +
        "and a slash-delimited VITE_BASE_PATH for its isolated host " +
        `(missing/invalid: ${missing.join(", ") || (invalidBase ? "VITE_BASE_PATH" : "deployment target")}).`,
      );
    }
  }

  return {
    plugins: [{
      name: "deployment-site-verification",
      transformIndexHtml(html: string) {
        if (mode !== "school") return html;
        const schoolHtml = html.replace(
          /\s*<meta name="google-site-verification" content="[^"]*" \/>\n/,
          "\n",
        );
        const token = modeEnv.VITE_GOOGLE_SITE_VERIFICATION?.trim();
        if (!token) {
          return schoolHtml;
        }
        if (!/^[A-Za-z0-9_-]+$/.test(token)) {
          throw new Error("VITE_GOOGLE_SITE_VERIFICATION contains unexpected characters.");
        }
        return schoolHtml.replace(
          "    <meta name=\"description\"",
          `    <meta name="google-site-verification" content="${token}" />\n    <meta name="description"`,
        );
      },
    }],
    // mupdf ships its own WASM; excluding it from pre-bundling keeps the loader intact.
    optimizeDeps: { exclude: ["mupdf"], esbuildOptions: { target: "esnext" } },
    // mupdf's WASM loader uses top-level await -> need a target that allows it.
    esbuild: { target: "esnext" },
    build: { target: "esnext" },
    base: mode === "school" ? modeEnv.VITE_BASE_PATH : "/",
    server: { port: 5173, strictPort: true },
  };
});
