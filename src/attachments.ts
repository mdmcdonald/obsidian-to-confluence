/**
 * Non-image attachment links (F4c).
 *
 * A knowledge corpus links to files a reader is meant to open — a MATLAB
 * script, a notebook, a schema, a CSV. Today those become dead relative hrefs.
 * With `assetLinkMode: "attach"` the file is uploaded to the page that links to
 * it and the link becomes `<ac:link><ri:attachment .../></ac:link>`.
 *
 * This module holds the pure parts: which extensions count as assets, and the
 * per-page attachment naming (Confluence attachment names are unique within a
 * page, so two different vault files with the same basename must be
 * distinguished deterministically).
 */

/** How a relative link to a non-markdown file is published. */
export type AssetLinkMode = "text" | "attach" | "base-url";

/**
 * Extensions treated as linkable assets by default: the artefacts an
 * engineering corpus references but does not render inline. Images are NOT
 * here — they go through the library's image pipeline as embeds.
 */
export const DEFAULT_ASSET_EXTENSIONS: readonly string[] = [
	"m",
	"mlx",
	"ipynb",
	"yaml",
	"yml",
	"json",
	"py",
	"html",
	"svg",
	"pdf",
	"csv",
	"txt",
];

/** Small deterministic FNV-1a hash → 6 hex chars (no crypto dependency). */
function hash6(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, "0").slice(0, 6);
}

export function isAssetExtension(extension: string, configured: readonly string[]): boolean {
	if (!extension) return false;
	const ext = extension.toLowerCase().replace(/^\./, "");
	return configured.some((e) => e.toLowerCase().replace(/^\./, "") === ext);
}

/** One file to upload as an attachment of one page. */
export interface AttachmentRequest {
	/** Vault path of the source file. */
	vaultPath: string;
	/** Name the attachment is stored (and referenced) under on the page. */
	filename: string;
}

/**
 * Decide the attachment name a vault file gets on a given page.
 *
 * The plain basename is used wherever it is free, because that is the name the
 * reader sees in the Attachments list. When two distinct vault files on the
 * same page share a basename, the later one gets a stable path-derived prefix
 * so the link never silently points at the wrong file.
 *
 * `claimed` maps filename → vaultPath and is mutated, so a caller can walk a
 * page's links in order and get stable, collision-free names.
 */
export function attachmentNameFor(vaultPath: string, claimed: Map<string, string>): string {
	const base = vaultPath.split("/").pop() || vaultPath;
	const existing = claimed.get(base);
	if (existing === undefined) {
		claimed.set(base, vaultPath);
		return base;
	}
	if (existing === vaultPath) return base;

	const prefixed = `${hash6(vaultPath)}-${base}`;
	const prefixedOwner = claimed.get(prefixed);
	if (prefixedOwner === undefined) {
		claimed.set(prefixed, vaultPath);
		return prefixed;
	}
	// Same path already claimed the prefixed form; otherwise (a genuine hash
	// collision) keep extending deterministically.
	if (prefixedOwner === vaultPath) return prefixed;
	let candidate = prefixed;
	while (claimed.has(candidate) && claimed.get(candidate) !== vaultPath) candidate = `_${candidate}`;
	claimed.set(candidate, vaultPath);
	return candidate;
}

/** Join a base URL with a vault-relative path, without doubling separators. */
export function joinBaseUrl(baseUrl: string, vaultPath: string): string {
	const base = baseUrl.trim().replace(/\/+$/, "");
	const path = vaultPath.replace(/^\/+/, "");
	const encoded = path
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/");
	return base ? `${base}/${encoded}` : `/${encoded}`;
}
