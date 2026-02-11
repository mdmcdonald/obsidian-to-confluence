import { ChartData, MermaidRenderer } from "@markdown-confluence/lib";
import { loadMermaid } from "obsidian";
import { Mermaid } from "mermaid";

export type PNGQuality = 'low' | 'medium' | 'high';

export class MermaidElectronPNGRenderer implements MermaidRenderer {
	private quality: PNGQuality;

	constructor(quality: PNGQuality = 'high') {
		this.quality = quality;
	}

	async captureMermaidCharts(charts: ChartData[]): Promise<Map<string, Buffer>> {
		const capturedCharts = new Map<string, Buffer>();

		// Load Mermaid from Obsidian
		const mermaid = (await loadMermaid()) as Mermaid;

		// Configure mermaid for rendering with default theme
		mermaid.initialize({
			startOnLoad: false,
			theme: 'default',
			themeVariables: {
				background: 'transparent'
			},
			flowchart: {
				htmlLabels: false
			}
		});

		const scaleFactors = { 'low': 1, 'medium': 1.5, 'high': 2 };
		const scale = scaleFactors[this.quality];

		for (const chart of charts) {
			try {
				const chartName = chart.name.replace(/\.svg$/, '.png');
				console.log(`[MermaidPNG] === Rendering ${chartName} (quality: ${this.quality}, scale: ${scale}) ===`);

				const chartId = `mermaid-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

				// Create offscreen container for mermaid to render into
				const container = document.createElement('div');
				container.id = chartId;
				container.style.position = 'absolute';
				container.style.left = '-9999px';
				container.style.top = '-9999px';
				document.body.appendChild(container);

				try {
					// Step 1: Render mermaid to SVG.
					// mermaid.render() inserts the SVG into the container AND returns
					// the SVG as a string. The string may contain HTML-isms (unescaped
					// & in labels, foreignObject, etc.) that are not valid XML. To get
					// clean SVG XML, we use the DOM element + XMLSerializer instead.
					await mermaid.render(chartId, chart.data);

					// Get the SVG element from the DOM — mermaid inserts it into
					// the container or as a sibling. Try both.
					let svgElement = container.querySelector('svg');
					if (!svgElement) {
						// mermaid v11+ may insert as a sibling using the chartId
						svgElement = document.querySelector(`#${CSS.escape(chartId)}`);
					}
					if (!svgElement || svgElement.tagName.toLowerCase() !== 'svg') {
						// Last resort: mermaid sometimes creates a wrapper with d- prefix
						svgElement = document.querySelector(`svg#${CSS.escape(chartId)}`) ||
							document.querySelector(`[id^="d${chartId}"] svg`) ||
							document.querySelector(`svg[id*="${chartId.slice(-8)}"]`);
					}

					if (!svgElement) {
						throw new Error("mermaid.render() succeeded but SVG element not found in DOM");
					}
					console.log(`[MermaidPNG] Step 1 - SVG element found (tagName: ${svgElement.tagName})`);

					// Step 2: Extract dimensions from viewBox
					const viewBox = (svgElement as SVGSVGElement).viewBox?.baseVal;
					let width = viewBox && viewBox.width > 0 ? viewBox.width : 800;
					let height = viewBox && viewBox.height > 0 ? viewBox.height : 600;
					const scaledWidth = Math.ceil(width * scale);
					const scaledHeight = Math.ceil(height * scale);
					console.log(`[MermaidPNG] Step 2 - Dimensions: ${width}x${height} -> ${scaledWidth}x${scaledHeight}`);

					// Step 3: Set explicit pixel dimensions on the SVG element
					// (replaces width="100%" / missing height) and remove max-width
					svgElement.setAttribute('width', String(scaledWidth));
					svgElement.setAttribute('height', String(scaledHeight));
					svgElement.removeAttribute('style');

					// Serialize to valid SVG XML via XMLSerializer.
					// This properly escapes &, handles namespaces, and strips
					// any HTML-only constructs that would break image loading.
					const serializer = new XMLSerializer();
					const cleanSvg = serializer.serializeToString(svgElement);
					console.log(`[MermaidPNG] Step 3 - Serialized SVG XML (${cleanSvg.length} chars)`);

					// Step 4: Rasterize SVG to PNG
					const blob = new Blob([cleanSvg], { type: 'image/svg+xml;charset=utf-8' });

					let pngBuffer: Buffer;
					try {
						// Primary: createImageBitmap (no <img> security issues)
						const bitmap = await createImageBitmap(blob);
						console.log(`[MermaidPNG] Step 4a - ImageBitmap: ${bitmap.width}x${bitmap.height}`);

						const canvas = new OffscreenCanvas(scaledWidth, scaledHeight);
						const ctx = canvas.getContext('2d');
						if (!ctx) throw new Error("Failed to get OffscreenCanvas 2d context");

						ctx.fillStyle = '#ffffff';
						ctx.fillRect(0, 0, scaledWidth, scaledHeight);
						ctx.drawImage(bitmap, 0, 0, scaledWidth, scaledHeight);
						bitmap.close();

						const pngBlob = await canvas.convertToBlob({ type: 'image/png' });
						const arrayBuf = await pngBlob.arrayBuffer();
						pngBuffer = Buffer.from(arrayBuf);
						console.log(`[MermaidPNG] Step 4b - PNG: ${pngBuffer.length} bytes`);
					} catch (bitmapErr) {
						// Fallback: data URL + Image + Canvas
						console.warn(`[MermaidPNG] createImageBitmap failed, trying data URL fallback:`, bitmapErr);

						const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(cleanSvg)}`;
						pngBuffer = await new Promise<Buffer>((resolve, reject) => {
							const timeout = setTimeout(() => {
								reject(new Error("Image load timed out after 10s"));
							}, 10000);

							const img = new Image();
							img.onload = () => {
								clearTimeout(timeout);
								try {
									console.log(`[MermaidPNG] Fallback - Image loaded: ${img.naturalWidth}x${img.naturalHeight}`);
									const canvas = document.createElement('canvas');
									canvas.width = scaledWidth;
									canvas.height = scaledHeight;
									const ctx = canvas.getContext('2d');
									if (!ctx) { reject(new Error("No 2d context")); return; }

									ctx.fillStyle = '#ffffff';
									ctx.fillRect(0, 0, scaledWidth, scaledHeight);
									ctx.drawImage(img, 0, 0, scaledWidth, scaledHeight);

									const pngDataUrl = canvas.toDataURL('image/png');
									const base64 = pngDataUrl.split(',')[1];
									console.log(`[MermaidPNG] Fallback - PNG: ${base64.length} base64 chars`);
									resolve(Buffer.from(base64, 'base64'));
								} catch (err) { reject(err); }
							};
							img.onerror = (e) => {
								clearTimeout(timeout);
								reject(new Error(`Image load failed: ${e instanceof ErrorEvent ? e.message : String(e)}`));
							};
							img.src = dataUrl;
						});
					}

					if (pngBuffer.length > 0) {
						capturedCharts.set(chartName, pngBuffer);
						console.log(`[MermaidPNG] SUCCESS: ${chartName} (${pngBuffer.length} bytes, ${scaledWidth}x${scaledHeight})`);
					} else {
						throw new Error("PNG buffer is empty");
					}

				} finally {
					if (container.parentNode) {
						document.body.removeChild(container);
					}
					// Also clean up any mermaid elements that escaped the container
					const orphan = document.querySelector(`#${CSS.escape(chartId)}`);
					if (orphan && orphan.parentNode) {
						orphan.parentNode.removeChild(orphan);
					}
				}

			} catch (error) {
				console.error(`[MermaidPNG] FAILED ${chart.name}:`, error);
				const errorPng = Buffer.from([
					0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
					0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
					0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
					0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
					0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41,
					0x54, 0x78, 0x9C, 0x62, 0x00, 0x00, 0x00, 0x00,
					0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x8D,
					0xB4, 0x19, 0x3A, 0x00, 0x00, 0x00, 0x00, 0x49,
					0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82
				]);
				const chartName = chart.name.replace(/\.svg$/, '.png');
				capturedCharts.set(chartName, errorPng);
			}
		}

		return capturedCharts;
	}
}
