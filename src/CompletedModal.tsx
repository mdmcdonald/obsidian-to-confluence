import { Modal, App } from "obsidian";
import { createRoot, Root } from "react-dom/client";
import React, { useState } from "react";
import type { UploadResults } from "./publishResults";
import {
	DIAGNOSTIC_LABEL,
	LINK_DIAGNOSTIC_KINDS,
	rankPagesByDiagnostics,
	summariseDiagnostics,
} from "./linkDiagnostics";

export interface UploadResultsProps {
	uploadResults: UploadResults;
}

const CompletedView: React.FC<UploadResultsProps> = ({ uploadResults }) => {
	const { errorMessage, failedFiles, filesUploadResult, renamedFiles, skipped, orphansHandled } = uploadResults;
	const [expanded, setExpanded] = useState(false);
	const [renamesExpanded, setRenamesExpanded] = useState(false);
	const [openPage, setOpenPage] = useState<string | null>(null);

	// F5 — link/title problems found while rendering. These never fail a publish;
	// they are a to-do list, and the dry run is where they are meant to be fixed.
	const diagnostics = uploadResults.diagnostics ?? [];
	const diagnosticSummary = uploadResults.diagnosticSummary ?? summariseDiagnostics(diagnostics);
	const worstPages = rankPagesByDiagnostics(diagnostics).slice(0, 10);
	const diagnosticErrors = diagnostics.filter((d) => d.severity === "error").length;

	const countResults = {
		content: { same: 0, updated: 0 },
		images: { same: 0, updated: 0 },
		labels: { same: 0, updated: 0 },
	};

	filesUploadResult.forEach((result) => {
		countResults.content[result.contentResult]++;
		countResults.images[result.imageResult]++;
		countResults.labels[result.labelResult]++;
	});

	const renderUpdatedFiles = (type: "content" | "image" | "label") => {
		return filesUploadResult
			.filter((result) => result[`${type}Result`] === "updated")
			.map((result, index) => (
				<li key={index}>
					<a href={result.adfFile.pageUrl}>{result.adfFile.absoluteFilePath}</a>
				</li>
			));
	};

	const hasFailures = failedFiles.length > 0;
	const hasSuccesses = filesUploadResult.length > 0;
	const totalFiles = filesUploadResult.length + failedFiles.length;

	return (
		<div className="upload-results">
			<div>
				<h1>Confluence Publish</h1>
			</div>
			{errorMessage ? (
				<div
					className="error-message"
					style={{
						border: "1px solid #e74c3c",
						padding: "12px",
						borderRadius: "4px",
						marginBottom: "12px",
						backgroundColor: "rgba(231, 76, 60, 0.1)",
					}}
				>
					<h3 style={{ color: "#e74c3c", marginTop: 0 }}>Publish Failed</h3>
					<p style={{ whiteSpace: "pre-wrap", fontFamily: "monospace", fontSize: "12px" }}>{errorMessage}</p>
					<p style={{ fontSize: "12px", opacity: 0.7 }}>
						Check the developer console (Ctrl+Shift+I) for detailed logs.
					</p>
				</div>
			) : (
				<>
					{/* Show failures first and prominently if any exist */}
					{hasFailures && (
						<div
							className="failed-uploads"
							style={{
								border: "1px solid #e74c3c",
								padding: "12px",
								borderRadius: "4px",
								marginBottom: "12px",
								backgroundColor: "rgba(231, 76, 60, 0.1)",
							}}
						>
							<h3 style={{ color: "#e74c3c", marginTop: 0 }}>
								{hasSuccesses
									? `${failedFiles.length} of ${totalFiles} file(s) failed`
									: `All ${failedFiles.length} file(s) failed to publish`}
							</h3>
							<ul style={{ listStyle: "none", padding: 0 }}>
								{failedFiles.map((file, index) => (
									<li
										key={index}
										style={{
											marginBottom: "8px",
											padding: "8px",
											backgroundColor: "rgba(0,0,0,0.05)",
											borderRadius: "4px",
										}}
									>
										<strong>{file.fileName}</strong>
										<p
											style={{ margin: "4px 0 0 0", whiteSpace: "pre-wrap", fontFamily: "monospace", fontSize: "11px" }}
										>
											{file.reason}
										</p>
									</li>
								))}
							</ul>
							<p style={{ fontSize: "12px", opacity: 0.7 }}>
								Check the developer console (Ctrl+Shift+I) for detailed API logs.
							</p>
						</div>
					)}

					{hasSuccesses && (
						<div className="successful-uploads" style={{ marginBottom: "12px" }}>
							<h3 style={{ color: hasFailures ? undefined : "#27ae60" }}>
								{filesUploadResult.length} file(s) published successfully
							</h3>
						</div>
					)}

					{(skipped ?? 0) > 0 && (
						<div className="skipped-uploads" style={{ marginBottom: "12px", opacity: 0.85 }}>
							<h3 style={{ marginTop: 0 }}>{skipped} note(s) unchanged — skipped</h3>
						</div>
					)}

					{orphansHandled && orphansHandled.ids.length > 0 && (
						<div
							className="orphaned-pages"
							style={{
								border: "1px solid #e67e22",
								padding: "12px",
								borderRadius: "4px",
								marginBottom: "12px",
								backgroundColor: "rgba(230, 126, 34, 0.08)",
							}}
						>
							<h3 style={{ color: "#e67e22", marginTop: 0 }}>
								{orphansHandled.action === "report"
									? `${orphansHandled.ids.length} orphaned page(s) detected — not removed`
									: `${orphansHandled.ok} page(s) trashed (source note removed)`}
							</h3>
							{orphansHandled.failed > 0 && (
								<p style={{ fontSize: "12px", color: "#e74c3c" }}>
									{orphansHandled.failed} could not be processed — see the developer console.
								</p>
							)}
							<p style={{ fontSize: "12px", opacity: 0.7, fontFamily: "monospace" }}>
								Page IDs: {orphansHandled.ids.join(", ")}
							</p>
						</div>
					)}

					{diagnostics.length > 0 && (
						<div
							className="link-diagnostics"
							style={{
								border: "1px solid #9b59b6",
								padding: "12px",
								borderRadius: "4px",
								marginBottom: "12px",
								backgroundColor: "rgba(155, 89, 182, 0.08)",
							}}
						>
							<h3 style={{ color: "#9b59b6", marginTop: 0 }}>
								{diagnostics.length} link/title issue(s) — {diagnosticErrors} error(s)
							</h3>
							<p style={{ fontSize: "12px", marginBottom: "8px", opacity: 0.8 }}>
								These did not fail the publish. Run "Check Confluence links and titles" for the full report.
							</p>
							<table className="result-table" style={{ fontSize: "12px", marginBottom: "8px" }}>
								<tbody>
									{LINK_DIAGNOSTIC_KINDS.filter((kind) => (diagnosticSummary[kind] ?? 0) > 0).map((kind) => (
										<tr key={kind}>
											<td>{DIAGNOSTIC_LABEL[kind]}</td>
											<td style={{ textAlign: "right" }}>{diagnosticSummary[kind]}</td>
										</tr>
									))}
								</tbody>
							</table>
							<ul style={{ listStyle: "none", padding: 0, fontSize: "12px" }}>
								{worstPages.map((page) => (
									<li key={page.sourcePath} style={{ marginBottom: "4px" }}>
										<button
											onClick={() => setOpenPage(openPage === page.sourcePath ? null : page.sourcePath)}
											style={{ fontFamily: "monospace", textAlign: "left", width: "100%" }}
										>
											{openPage === page.sourcePath ? "▾" : "▸"} {page.sourcePath || "(unknown page)"} — ✗{page.errors}{" "}
											⚠{page.warnings}
										</button>
										{openPage === page.sourcePath && (
											<ul style={{ listStyle: "none", padding: "4px 0 4px 16px", fontFamily: "monospace" }}>
												{page.diagnostics.map((d, index) => (
													<li key={index} style={{ marginBottom: "2px" }}>
														<span style={{ color: d.severity === "error" ? "#e74c3c" : "#f39c12" }}>
															{d.severity === "error" ? "✗" : "⚠"}
														</span>{" "}
														{DIAGNOSTIC_LABEL[d.kind]}: {d.target}
														{d.display && d.display !== d.target ? ` (${d.display})` : ""}
													</li>
												))}
											</ul>
										)}
									</li>
								))}
							</ul>
						</div>
					)}

					{renamedFiles && renamedFiles.length > 0 && (
						<div
							className="renamed-files"
							style={{
								border: "1px solid #3498db",
								padding: "12px",
								borderRadius: "4px",
								marginBottom: "12px",
								backgroundColor: "rgba(52, 152, 219, 0.08)",
							}}
						>
							<h3 style={{ color: "#3498db", marginTop: 0 }}>
								{renamedFiles.length} file(s) renamed to avoid title collisions
							</h3>
							<p style={{ fontSize: "12px", marginBottom: "8px", opacity: 0.8 }}>
								Multiple notes mapped to the same Confluence page title. Each was given a short hash suffix derived from
								its vault path.
							</p>
							<button onClick={() => setRenamesExpanded(!renamesExpanded)} style={{ marginBottom: "8px" }}>
								{renamesExpanded ? "Hide" : "Show"} renames
							</button>
							{renamesExpanded && (
								<ul style={{ listStyle: "none", padding: 0, fontSize: "12px", fontFamily: "monospace" }}>
									{renamedFiles.map((r, index) => (
										<li
											key={index}
											style={{
												marginBottom: "6px",
												padding: "4px 8px",
												backgroundColor: "rgba(0,0,0,0.04)",
												borderRadius: "3px",
											}}
										>
											<div>{r.filePath}</div>
											<div style={{ marginLeft: "12px", opacity: 0.85 }}>
												{r.originalTitle} → <strong>{r.renamedTitle}</strong>
											</div>
										</li>
									))}
								</ul>
							)}
						</div>
					)}

					{!hasSuccesses && !hasFailures && (
						<div
							style={{
								padding: "12px",
								border: "1px solid #f39c12",
								borderRadius: "4px",
								backgroundColor: "rgba(243, 156, 18, 0.1)",
							}}
						>
							<h3 style={{ color: "#f39c12", marginTop: 0 }}>No files found to publish</h3>
							<p>
								Check that your "Folder to Publish" setting is correct and that files have{" "}
								<code>connie-publish: true</code> in frontmatter or are in the configured folder.
							</p>
						</div>
					)}

					{hasSuccesses && (
						<>
							<table className="result-table">
								<thead>
									<tr>
										<th>Type</th>
										<th>Same</th>
										<th>Updated</th>
									</tr>
								</thead>
								<tbody>
									<tr>
										<td>Content</td>
										<td>{countResults.content.same}</td>
										<td>{countResults.content.updated}</td>
									</tr>
									<tr>
										<td>Images</td>
										<td>{countResults.images.same}</td>
										<td>{countResults.images.updated}</td>
									</tr>
									<tr>
										<td>Labels</td>
										<td>{countResults.labels.same}</td>
										<td>{countResults.labels.updated}</td>
									</tr>
								</tbody>
							</table>
							<div className="expandable-section">
								<button onClick={() => setExpanded(!expanded)}>{expanded ? "Collapse" : "Expand"} Updated Files</button>
								{expanded && (
									<div className="updated-files">
										<div className="updated-content">
											<h4>Updated Content</h4>
											<ul>{renderUpdatedFiles("content")}</ul>
										</div>
										<div className="updated-images">
											<h4>Updated Images</h4>
											<ul>{renderUpdatedFiles("image")}</ul>
										</div>
										<div className="updated-labels">
											<h4>Updated Labels</h4>
											<ul>{renderUpdatedFiles("label")}</ul>
										</div>
									</div>
								)}
							</div>
						</>
					)}
				</>
			)}
		</div>
	);
};

export class CompletedModal extends Modal {
	uploadResults: UploadResultsProps;
	root: Root | null = null;

	constructor(app: App, uploadResults: UploadResultsProps) {
		super(app);
		this.uploadResults = uploadResults;
	}

	override onOpen() {
		const { contentEl } = this;
		this.root = createRoot(contentEl);
		this.root.render(React.createElement(CompletedView, this.uploadResults));
	}

	override onClose() {
		if (this.root) {
			this.root.unmount();
			this.root = null;
		}
		const { contentEl } = this;
		contentEl.empty();
	}
}
