import { ChartData, MermaidRenderer } from "@markdown-confluence/lib";
import { loadMermaid, Plugin } from "obsidian";
import { Mermaid } from "mermaid";
import SparkMD5 from "spark-md5";

export type PNGQuality = "low" | "medium" | "high";

/**
 * 1x1 transparent PNG, used as a placeholder when a chart fails to render so
 * the publish flow can continue rather than aborting the whole page.
 */
const FALLBACK_PNG = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
	0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
	0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
	0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x00, 0x00, 0x00,
	0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x8d, 0xb4, 0x19, 0x3a, 0x00,
	0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

function escapeXmlText(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function getAttr(attrs: string, name: string): string | undefined {
	const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`));
	return m ? m[1] : undefined;
}

/**
 * Replace every <foreignObject> in the SVG with a native SVG <text> at the
 * same centre. Electron's createImageBitmap and <img> data-URL paths both
 * refuse SVGs containing foreignObject — mermaid uses it for HTML labels in
 * most non-flowchart diagram types (sequence, class, state, ER, gantt, ...).
 *
 * Uses string replacement rather than DOMParser+XMLSerializer because a prior
 * commit (b1f8021 → reverted in 50775b6) found that round-tripping the
 * mermaid SVG through the DOM corrupted it in ways that broke rasterization.
 * HTML styling inside labels is lost; textual content and layout survive.
 */
function replaceForeignObjects(svg: string): string {
	if (!svg.includes("<foreignObject")) return svg;
	let replaced = 0;
	const out = svg.replace(
		/<foreignObject\b([^>]*)>([\s\S]*?)<\/foreignObject>/gi,
		(_match, attrs: string, inner: string) => {
			replaced++;
			const x = parseFloat(getAttr(attrs, "x") || "0");
			const y = parseFloat(getAttr(attrs, "y") || "0");
			const width = parseFloat(getAttr(attrs, "width") || "0");
			const height = parseFloat(getAttr(attrs, "height") || "0");
			const cx = x + width / 2;
			const cy = y + height / 2;

			// Mermaid typically wraps each visual line in a <div> or <span>.
			// Pull each non-empty block-element text as one line; if there are
			// no block elements, treat the whole inner as a single line.
			const blockMatches = Array.from(
				inner.matchAll(/<(?:div|p|span)\b[^>]*>([\s\S]*?)<\/(?:div|p|span)>/gi),
			);
			let lines: string[] = [];
			if (blockMatches.length > 0) {
				for (const m of blockMatches) {
					const t = m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
					if (t.length > 0) lines.push(t);
				}
			}
			if (lines.length === 0) {
				const flat = inner.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
				lines = flat.length > 0 ? [flat] : [""];
			}

			const baseAttrs = `text-anchor="middle" font-family="sans-serif" font-size="14"`;
			if (lines.length === 1) {
				return `<text x="${cx}" y="${cy}" dominant-baseline="central" ${baseAttrs}>${escapeXmlText(lines[0])}</text>`;
			}
			const lineHeight = 16;
			const startY = cy - (lineHeight * (lines.length - 1)) / 2;
			const tspans = lines
				.map(
					(line, i) =>
						`<tspan x="${cx}" y="${startY + i * lineHeight}">${escapeXmlText(line)}</tspan>`,
				)
				.join("");
			return `<text ${baseAttrs}>${tspans}</text>`;
		},
	);
	if (replaced > 0) {
		console.log(`[MermaidPNG] Replaced ${replaced} foreignObject element(s) with native SVG <text>`);
	}
	return out;
}

/**
 * Drop any inline `background:` style that mermaid attaches to elements —
 * the previous SVGMermaidRenderer found these caused some renderers to
 * reject the SVG. Run before dimension fix-up.
 */
function stripBackgroundStyles(svg: string): string {
	return svg.replace(/style="([^"]*)"/gi, (_m, style: string) => {
		const cleaned = style
			.split(";")
			.map((s) => s.trim())
			.filter((s) => s.length > 0 && !/^background\s*:/i.test(s))
			.join("; ");
		return `style="${cleaned}"`;
	});
}

export class MermaidElectronPNGRenderer implements MermaidRenderer {
	private quality: PNGQuality;
	private plugin: Plugin;

	constructor(quality: PNGQuality = "high", plugin: Plugin) {
		this.quality = quality;
		this.plugin = plugin;
	}

	private cacheDir(): string {
		return `${this.plugin.manifest.dir}/mermaid-cache`;
	}

	private cacheKey(chartData: string): string {
		return `${SparkMD5.hash(chartData)}-${this.quality}.png`;
	}

	private async readCache(key: string): Promise<Buffer | undefined> {
		const adapter = this.plugin.app.vault.adapter;
		const path = `${this.cacheDir()}/${key}`;
		try {
			if (!(await adapter.exists(path))) return undefined;
			const data = await adapter.readBinary(path);
			return Buffer.from(data);
		} catch (err) {
			console.warn(`[MermaidPNG] Cache read failed for ${key}:`, err);
			return undefined;
		}
	}

	private async writeCache(key: string, buf: Buffer): Promise<void> {
		const adapter = this.plugin.app.vault.adapter;
		const dir = this.cacheDir();
		try {
			if (!(await adapter.exists(dir))) {
				await adapter.mkdir(dir);
			}
			const path = `${dir}/${key}`;
			const arr = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
			await adapter.writeBinary(path, arr);
		} catch (err) {
			console.warn(`[MermaidPNG] Cache write failed for ${key}:`, err);
		}
	}

	async captureMermaidCharts(charts: ChartData[]): Promise<Map<string, Buffer>> {
		const capturedCharts = new Map<string, Buffer>();

		// Resolve cache hits before initialising Mermaid — if everything is cached
		// we can skip mermaid + DOM work entirely.
		const uncached: { chart: ChartData; chartName: string; key: string }[] = [];
		for (const chart of charts) {
			const chartName = chart.name.replace(/\.svg$/, ".png");
			const key = this.cacheKey(chart.data);
			const cached = await this.readCache(key);
			if (cached) {
				capturedCharts.set(chartName, cached);
				console.log(`[MermaidPNG] CACHE HIT: ${chartName} (${cached.length} bytes)`);
			} else {
				uncached.push({ chart, chartName, key });
			}
		}

		if (uncached.length === 0) return capturedCharts;

		const mermaid = (await loadMermaid()) as Mermaid;
		mermaid.initialize({
			startOnLoad: false,
			theme: "default",
			themeVariables: { background: "transparent" },
			flowchart: { htmlLabels: false },
		});

		const scaleFactors = { low: 1, medium: 1.5, high: 2 };
		const scale = scaleFactors[this.quality];

		for (const { chart, chartName, key } of uncached) {
			try {
				console.log(`[MermaidPNG] Rendering ${chartName} (quality: ${this.quality}, scale: ${scale})`);

				const chartId = `mermaid-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

				const container = document.createElement("div");
				container.id = chartId;
				container.style.position = "absolute";
				container.style.left = "-9999px";
				container.style.top = "-9999px";
				document.body.appendChild(container);

				try {
					const { svg: rawSvg } = await mermaid.render(chartId, chart.data);
					const svgNoFo = replaceForeignObjects(rawSvg);
					const svg = stripBackgroundStyles(svgNoFo);
					console.log(`[MermaidPNG] mermaid.render produced ${rawSvg.length} chars (sanitised: ${svg.length} chars)`);

					// Extract viewBox dimensions for explicit pixel sizing.
					const viewBoxMatch = svg.match(/viewBox="([^"]+)"/);
					let width = 800;
					let height = 600;
					if (viewBoxMatch) {
						const parts = viewBoxMatch[1].split(/\s+/).map(Number);
						if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
							width = parts[2];
							height = parts[3];
						}
					}
					const scaledWidth = Math.ceil(width * scale);
					const scaledHeight = Math.ceil(height * scale);

					// Fix root <svg> attributes only — child elements may also have
					// width/height that must not be touched.
					const svgTagMatch = svg.match(/^(<svg\s[^>]*>)/);
					let fixedSvg = svg;
					if (svgTagMatch) {
						let svgTag = svgTagMatch[1];
						if (/\swidth="[^"]*"/.test(svgTag)) {
							svgTag = svgTag.replace(/\swidth="[^"]*"/, ` width="${scaledWidth}"`);
						} else {
							svgTag = svgTag.replace(/>$/, ` width="${scaledWidth}">`);
						}
						if (/\sheight="[^"]*"/.test(svgTag)) {
							svgTag = svgTag.replace(/\sheight="[^"]*"/, ` height="${scaledHeight}"`);
						} else {
							svgTag = svgTag.replace(/>$/, ` height="${scaledHeight}">`);
						}
						svgTag = svgTag.replace(/style="[^"]*max-width:[^"]*"/, 'style=""');
						fixedSvg = svgTag + svg.slice(svgTagMatch[1].length);
					}

					// Prepend an XML declaration for decoder compatibility. The
					// dimension-fix regex above is anchored to `^<svg` so this
					// has to happen AFTER that step.
					const decoded = fixedSvg.startsWith("<?xml")
						? fixedSvg
						: '<?xml version="1.0" encoding="UTF-8"?>\n' + fixedSvg;

					// createImageBitmap on a Blob is the most reliable raster path
					// in Electron — avoids the tainted-canvas / blocked-onload issues
					// of <img> with data: or blob: URLs.
					const blob = new Blob([decoded], { type: "image/svg+xml;charset=utf-8" });

					let pngBuffer: Buffer;
					try {
						const bitmap = await createImageBitmap(blob);
						const canvas = new OffscreenCanvas(scaledWidth, scaledHeight);
						const ctx = canvas.getContext("2d");
						if (!ctx) throw new Error("Failed to get OffscreenCanvas 2d context");
						ctx.fillStyle = "#ffffff";
						ctx.fillRect(0, 0, scaledWidth, scaledHeight);
						ctx.drawImage(bitmap, 0, 0, scaledWidth, scaledHeight);
						bitmap.close();
						const pngBlob = await canvas.convertToBlob({ type: "image/png" });
						const arrayBuf = await pngBlob.arrayBuffer();
						pngBuffer = Buffer.from(arrayBuf);
					} catch (bitmapErr) {
						// Fallback: URI-encoded data URL + Image + Canvas. Same-origin
						// so the canvas doesn't taint.
						console.warn(`[MermaidPNG] createImageBitmap failed, falling back:`, bitmapErr);
						const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(decoded)}`;
						pngBuffer = await new Promise<Buffer>((resolve, reject) => {
							const timeout = setTimeout(() => reject(new Error("Image load timed out after 10s")), 10000);
							const img = new Image();
							img.onload = () => {
								clearTimeout(timeout);
								try {
									const canvas = document.createElement("canvas");
									canvas.width = scaledWidth;
									canvas.height = scaledHeight;
									const ctx = canvas.getContext("2d");
									if (!ctx) { reject(new Error("No 2d context")); return; }
									ctx.fillStyle = "#ffffff";
									ctx.fillRect(0, 0, scaledWidth, scaledHeight);
									ctx.drawImage(img, 0, 0, scaledWidth, scaledHeight);
									const pngDataUrl = canvas.toDataURL("image/png");
									const base64 = pngDataUrl.split(",")[1];
									resolve(Buffer.from(base64, "base64"));
								} catch (err) { reject(err); }
							};
							img.onerror = (e) => {
								clearTimeout(timeout);
								reject(new Error(`Image load failed: ${e instanceof ErrorEvent ? e.message : String(e)}`));
							};
							img.src = dataUrl;
						});
					}

					if (pngBuffer.length === 0) throw new Error("PNG buffer is empty");

					capturedCharts.set(chartName, pngBuffer);
					await this.writeCache(key, pngBuffer);
					console.log(`[MermaidPNG] OK ${chartName} (${pngBuffer.length} bytes, ${scaledWidth}x${scaledHeight}, cached)`);
				} finally {
					if (container.parentNode) {
						document.body.removeChild(container);
					}
				}
			} catch (error) {
				console.error(`[MermaidPNG] FAILED ${chart.name}:`, error);
				capturedCharts.set(chartName, FALLBACK_PNG);
			}
		}

		return capturedCharts;
	}
}
