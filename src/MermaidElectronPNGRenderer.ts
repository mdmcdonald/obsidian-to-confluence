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

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Replace every <foreignObject> in the SVG with a native SVG <text> element
 * positioned at the same coordinates. Electron's createImageBitmap (and the
 * <img> data-URL fallback) refuse to rasterize SVGs containing foreignObject,
 * which mermaid uses to host HTML labels in most non-flowchart diagram types.
 * Bold/italic styling inside the HTML label is lost; the textual content and
 * diagram structure survive.
 */
function replaceForeignObjects(svg: string): string {
	if (!svg.includes("<foreignObject")) return svg;

	const parser = new DOMParser();
	const doc = parser.parseFromString(svg, "image/svg+xml");
	if (doc.querySelector("parsererror")) {
		console.warn("[MermaidPNG] SVG parse failed; skipping foreignObject replacement");
		return svg;
	}

	const foreignObjects = Array.from(doc.querySelectorAll("foreignObject"));
	if (foreignObjects.length === 0) return svg;

	for (const fo of foreignObjects) {
		const x = parseFloat(fo.getAttribute("x") || "0");
		const y = parseFloat(fo.getAttribute("y") || "0");
		const width = parseFloat(fo.getAttribute("width") || "0");
		const height = parseFloat(fo.getAttribute("height") || "0");

		// Mermaid typically places one <div> per visual line. If we find
		// multiple block-level children, treat each as a separate line.
		// Otherwise fall back to splitting textContent on newlines.
		const blockChildren = Array.from(
			fo.querySelectorAll(":scope > div, :scope > p, :scope > div > div, :scope > div > p"),
		);
		let lines: string[];
		if (blockChildren.length > 1) {
			lines = blockChildren
				.map((el) => (el.textContent || "").trim())
				.filter((s) => s.length > 0);
		} else {
			lines = (fo.textContent || "")
				.split(/\r?\n+/)
				.map((s) => s.trim())
				.filter((s) => s.length > 0);
		}
		if (lines.length === 0) lines = [""];

		const textEl = doc.createElementNS(SVG_NS, "text");
		textEl.setAttribute("text-anchor", "middle");
		textEl.setAttribute("font-family", "sans-serif");
		textEl.setAttribute("font-size", "14");

		const cx = x + width / 2;
		const cy = y + height / 2;
		const lineHeight = 16;
		const startY = cy - (lineHeight * (lines.length - 1)) / 2;

		if (lines.length === 1) {
			textEl.setAttribute("x", String(cx));
			textEl.setAttribute("y", String(cy));
			textEl.setAttribute("dominant-baseline", "central");
			textEl.textContent = lines[0];
		} else {
			for (let i = 0; i < lines.length; i++) {
				const tspan = doc.createElementNS(SVG_NS, "tspan");
				tspan.setAttribute("x", String(cx));
				tspan.setAttribute("y", String(startY + i * lineHeight));
				tspan.textContent = lines[i];
				textEl.appendChild(tspan);
			}
		}

		fo.parentNode?.replaceChild(textEl, fo);
	}

	console.log(`[MermaidPNG] Replaced ${foreignObjects.length} foreignObject element(s) with native SVG <text>`);

	return new XMLSerializer().serializeToString(doc);
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
					const svg = replaceForeignObjects(rawSvg);
					console.log(`[MermaidPNG] mermaid.render produced ${rawSvg.length} chars of SVG (post-cleanup: ${svg.length} chars)`);

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

					// createImageBitmap on a Blob is the most reliable raster path
					// in Electron — avoids the tainted-canvas / blocked-onload issues
					// of <img> with data: or blob: URLs.
					const blob = new Blob([fixedSvg], { type: "image/svg+xml;charset=utf-8" });

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
						const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(fixedSvg)}`;
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
