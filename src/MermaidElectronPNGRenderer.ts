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
				htmlLabels: false  // Try to avoid foreignObject elements
			}
		});
		
		// Set scale based on quality
		const scaleFactors = {
			'low': 1,
			'medium': 1.5,
			'high': 2
		};
		const scale = scaleFactors[this.quality];
		
		// Get Electron's nativeImage module
		const { nativeImage } = require('electron');
		
		for (const chart of charts) {
			try {
				// Change extension from .svg to .png
				const chartName = chart.name.replace(/\.svg$/, '.png');
				
				console.log(`[MermaidElectronPNGRenderer] Rendering ${chartName} (quality: ${this.quality}, scale: ${scale})...`);
				
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
					// Render the chart to SVG
					const { svg } = await mermaid.render(chartId, chart.data);
					
					// Parse SVG to get dimensions
					const parser = new DOMParser();
					const svgDoc = parser.parseFromString(svg, 'image/svg+xml');
					const svgElement = svgDoc.documentElement as unknown as SVGSVGElement;
					
					// Get dimensions from viewBox or width/height
					let width = 800;
					let height = 600;
					
					if (svgElement.viewBox && svgElement.viewBox.baseVal) {
						width = svgElement.viewBox.baseVal.width;
						height = svgElement.viewBox.baseVal.height;
					} else if (svgElement.width && svgElement.height) {
						width = parseFloat(svgElement.getAttribute('width') || '800');
						height = parseFloat(svgElement.getAttribute('height') || '600');
					}
					
					// Apply scale for quality
					const scaledWidth = Math.floor(width * scale);
					const scaledHeight = Math.floor(height * scale);
					
					// Update SVG dimensions for scaling
					svgElement.setAttribute('width', scaledWidth.toString());
					svgElement.setAttribute('height', scaledHeight.toString());
					
					// Convert modified SVG back to string
					const scaledSvg = new XMLSerializer().serializeToString(svgDoc);
					
					// Convert SVG to data URL
					const svgData = Buffer.from(scaledSvg).toString('base64');
					const dataUrl = `data:image/svg+xml;base64,${svgData}`;
					
					// Use Electron's nativeImage to convert to PNG
					const image = nativeImage.createFromDataURL(dataUrl);
					
					// Get PNG buffer
					const pngBuffer = image.toPNG();
					
					if (pngBuffer && pngBuffer.length > 0) {
						// Store the PNG
						capturedCharts.set(chartName, pngBuffer);
						console.log(`[MermaidElectronPNGRenderer] Successfully rendered ${chartName} (${pngBuffer.length} bytes)`);
					} else {
						console.error(`[MermaidElectronPNGRenderer] Rendered buffer is empty for ${chartName}`);
						throw new Error("Rendered PNG buffer is empty");
					}
					
				} finally {
					// Clean up the container
					if (container.parentNode) {
						document.body.removeChild(container);
					}
				}
				
			} catch (error) {
				console.error(`Failed to render Mermaid chart ${chart.name}:`, error);
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