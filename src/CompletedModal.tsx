import { Modal, App } from "obsidian";
import ReactDOM from "react-dom";
import { createRoot, Root } from "react-dom/client";
import React, { useState } from "react";
import { UploadAdfFileResult } from "@markdown-confluence/lib";

export interface FailedFile {
	fileName: string;
	reason: string;
}

export interface UploadResults {
	errorMessage: string | null;
	errorDetails?: any;
	failedFiles: FailedFile[];
	filesUploadResult: UploadAdfFileResult[];
}

export interface UploadResultsProps {
	uploadResults: UploadResults;
}

const CompletedView: React.FC<UploadResultsProps> = ({ uploadResults }) => {
	const { errorMessage, errorDetails, failedFiles, filesUploadResult } =
		uploadResults;
	const [expanded, setExpanded] = useState(false);
	const [showErrorDetails, setShowErrorDetails] = useState(false);

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
					<a href={result.adfFile.pageUrl}>
						{result.adfFile.absoluteFilePath}
					</a>
				</li>
			));
	};

	return (
		<div className="upload-results">
			<div>
				<h1>Confluence Publish</h1>
			</div>
			{errorMessage ? (
				<div className="error-message">
					<h3>Error</h3>
					<textarea
						readOnly
						value={errorMessage}
						style={{ width: "100%", height: "100px", resize: "vertical" }}
					/>
					{errorDetails && (
						<div style={{ marginTop: "10px" }}>
							<button onClick={() => setShowErrorDetails(!showErrorDetails)}>
								{showErrorDetails ? "Hide" : "Show"} Technical Details
							</button>
							{showErrorDetails && (
								<pre
									style={{
										marginTop: "10px",
										padding: "10px",
										background: "#333",
										color: "#fff",
										overflow: "auto",
										maxHeight: "300px",
										whiteSpace: "pre-wrap",
										userSelect: "text",
									}}
								>
									{typeof errorDetails === "string"
										? errorDetails
										: JSON.stringify(errorDetails, null, 2)}
								</pre>
							)}
						</div>
					)}
				</div>
			) : (
				<>
					<div className="successful-uploads">
						<h3>Successful Uploads</h3>
						<p>
							{filesUploadResult.length} file(s) uploaded
							successfully.
						</p>
					</div>

					{failedFiles.length > 0 && (
						<div className="failed-uploads">
							<h3>Failed Uploads</h3>
							<p>
								{failedFiles.length} file(s) failed to upload.
							</p>
							<ul>
								{failedFiles.map((file, index) => (
									<li key={index}>
										<strong>{file.fileName}</strong>:{" "}
										{file.reason}
									</li>
								))}
							</ul>
						</div>
					)}

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
						<button onClick={() => setExpanded(!expanded)}>
							{expanded ? "Collapse" : "Expand"} Updated Files
						</button>
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
		this.root.render(
			React.createElement(CompletedView, this.uploadResults)
		);
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
