// Bundles the TypeScript test files to CommonJS so Node's built-in test runner
// (`node --test`) can execute them without any extra test-framework dependency.
// The modules under test are pure (no `obsidian` import), so nothing needs to
// be externalised beyond Node builtins (handled automatically by platform:node).
import esbuild from "esbuild";
import { readdirSync } from "node:fs";

const entryPoints = readdirSync("tests")
	.filter((f) => f.endsWith(".test.ts"))
	.map((f) => `tests/${f}`);

await esbuild.build({
	entryPoints,
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "node18",
	outdir: "dist-tests",
	outExtension: { ".js": ".cjs" },
	sourcemap: "inline",
	logLevel: "info",
});
