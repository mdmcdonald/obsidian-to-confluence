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
			theme: 'default',  // Use default theme for Confluence compatibility
			themeVariables: {
				background: 'transparent'
			},
			flowchart: {
				htmlLabels: false  // Avoid foreignObject elements (not rendered in <img>)
			}
		});

		// Set scale based on quality
		const scaleFactors = {
			'low': 1,
			'medium': 1.5,
			'high': 2
		};
		const scale = scaleFactors[this.quality];

		for (const chart of charts) {
			try {
				// Change extension from .svg to .png
				const chartName = chart.name.replace(/\.svg$/, '.png');

				console.log(`[MermaidPNG] === Rendering ${chartName} (quality: ${this.quality}, scale: ${scale}) ===`);
				console.log(`[MermaidPNG] Input (${chart.data.length} chars): ${chart.data.substring(0, 200)}`);

				// Create a unique ID for this chart
				const chartId = `mermaid-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

				// Create a container div for rendering
				const container = document.createElement('div');
				container.id = chartId;
				container.style.position = 'absolute';
				container.style.left = '-9999px';
				container.style.top = '-9999px';
				document.body.appendChild(container);

				try {
					// Step 1: Render mermaid to SVG
					const { svg } = await mermaid.render(chartId, chart.data);
					console.log(`[MermaidPNG] Step 1 - mermaid.render produced SVG (${svg.length} chars)`);
					console.log(`[MermaidPNG] SVG preview: ${svg.substring(0, 300)}`);

					// Step 2: Parse SVG to extract dimensions
					const parser = new DOMParser();
					const svgDoc = parser.parseFromString(svg, 'image/svg+xml');
					const svgElement = svgDoc.documentElement as unknown as SVGSVGElement;

					// Check for XML parse errors
					const parseError = svgDoc.querySelector('parsererror');
					if (parseError) {
						throw new Error(`SVG parse error: ${parseError.textContent}`);
					}

					const viewBox = svgElement.getAttribute('viewBox');
					const widthAttr = svgElement.getAttribute('width');
					const heightAttr = svgElement.getAttribute('height');
					console.log(`[MermaidPNG] Step 2 - SVG attrs: viewBox="${viewBox}" width="${widthAttr}" height="${heightAttr}"`);

					let width = 800;
					let height = 600;

					if (svgElement.viewBox && svgElement.viewBox.baseVal && svgElement.viewBox.baseVal.width > 0) {
						width = svgElement.viewBox.baseVal.width;
						height = svgElement.viewBox.baseVal.height;
						console.log(`[MermaidPNG] Using viewBox dimensions: ${width}x${height}`);
					} else if (widthAttr && heightAttr) {
						width = parseFloat(widthAttr) || 800;
						height = parseFloat(heightAttr) || 600;
						console.log(`[MermaidPNG] Using width/height attrs: ${width}x${height}`);
					} else {
						console.warn(`[MermaidPNG] No dimensions found on SVG, using defaults: ${width}x${height}`);
					}

					// Step 3: Scale and serialize
					const scaledWidth = Math.ceil(width * scale);
					const scaledHeight = Math.ceil(height * scale);
					console.log(`[MermaidPNG] Step 3 - Scaled dimensions: ${scaledWidth}x${scaledHeight}`);

					svgElement.setAttribute('width', scaledWidth.toString());
					svgElement.setAttribute('height', scaledHeight.toString());

					const scaledSvg = new XMLSerializer().serializeToString(svgDoc);
					console.log(`[MermaidPNG] Serialized SVG: ${scaledSvg.length} chars`);

					// Step 4: Create data URL
					const svgData = Buffer.from(scaledSvg).toString('base64');
					const dataUrl = `data:image/svg+xml;base64,${svgData}`;
					console.log(`[MermaidPNG] Step 4 - Data URL length: ${dataUrl.length}`);

					// Step 5: Rasterize via Canvas
					const pngBuffer = await new Promise<Buffer>((resolve, reject) => {
						const img = new Image();
						img.onload = () => {
							try {
								console.log(`[MermaidPNG] Step 5a - Image loaded: naturalWidth=${img.naturalWidth} naturalHeight=${img.naturalHeight}`);

								if (img.naturalWidth === 0 || img.naturalHeight === 0) {
									reject(new Error(`Image loaded but has zero dimensions: ${img.naturalWidth}x${img.naturalHeight}`));
									return;
								}

								const canvas = document.createElement('canvas');
								canvas.width = scaledWidth;
								canvas.height = scaledHeight;
								const ctx = canvas.getContext('2d');
								if (!ctx) {
									reject(new Error("Failed to get 2d canvas context"));
									return;
								}

								// White background for Confluence readability
								ctx.fillStyle = '#ffffff';
								ctx.fillRect(0, 0, scaledWidth, scaledHeight);
								ctx.drawImage(img, 0, 0, scaledWidth, scaledHeight);
								console.log(`[MermaidPNG] Step 5b - Drew image onto ${scaledWidth}x${scaledHeight} canvas`);

								const pngDataUrl = canvas.toDataURL('image/png');
								console.log(`[MermaidPNG] Step 5c - canvas.toDataURL length: ${pngDataUrl.length}, prefix: ${pngDataUrl.substring(0, 40)}`);

								const base64 = pngDataUrl.split(',')[1];
								if (!base64 || base64.length === 0) {
									reject(new Error(`toDataURL produced empty base64: ${pngDataUrl.substring(0, 100)}`));
									return;
								}

								const buf = Buffer.from(base64, 'base64');
								console.log(`[MermaidPNG] Step 5d - Final PNG buffer: ${buf.length} bytes`);
								resolve(buf);
							} catch (err) {
								console.error(`[MermaidPNG] Error in onload handler:`, err);
								reject(err);
							}
						};
						img.onerror = (e) => {
							const detail = e instanceof ErrorEvent ? e.message : String(e);
							console.error(`[MermaidPNG] Image onerror fired:`, detail, e);
							reject(new Error(`Failed to load SVG into Image: ${detail}`));
						};
						console.log(`[MermaidPNG] Step 5 - Setting img.src (data URL, ${dataUrl.length} chars)...`);
						img.src = dataUrl;
					});

					if (pngBuffer.length > 0) {
						capturedCharts.set(chartName, pngBuffer);
						console.log(`[MermaidPNG] SUCCESS: ${chartName} (${pngBuffer.length} bytes, ${scaledWidth}x${scaledHeight})`);
					} else {
						throw new Error("Canvas produced empty PNG buffer");
					}

				} finally {
					// Clean up the container
					if (container.parentNode) {
						document.body.removeChild(container);
					}
				}

			} catch (error) {
				console.error(`[MermaidPNG] FAILED to render ${chart.name}:`, error);
				// Create an error placeholder PNG (1x1 transparent pixel)
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
