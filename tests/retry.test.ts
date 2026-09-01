import { test } from "node:test";
import assert from "node:assert/strict";

import {
	JITTER_MAX_MS,
	RETRYABLE_STATUSES,
	isAttachmentUpload,
	isRetryableStatus,
	parseRetryAfter,
	planRetry,
	retryDelay,
	runWithRetry,
	type AttemptOutcome,
} from "../src/retry";

// ---------------------------------------------------------------------------
// Status classification (F9)
// ---------------------------------------------------------------------------

test("only rate limiting and transient gateway failures are retryable", () => {
	for (const status of [429, 502, 503, 504]) {
		assert.equal(isRetryableStatus(status), true, `${status} should retry`);
		assert.equal(RETRYABLE_STATUSES.has(status), true);
	}
	for (const status of [400, 401, 403, 404, 409, 413, 422, 500, 501]) {
		assert.equal(isRetryableStatus(status), false, `${status} should not retry`);
	}
});

test("a transport failure with no status is retryable", () => {
	assert.equal(isRetryableStatus(undefined), true);
});

// ---------------------------------------------------------------------------
// Backoff (F9)
// ---------------------------------------------------------------------------

test("retryDelay doubles the base each attempt and adds bounded jitter", () => {
	assert.equal(retryDelay(0, 1000, undefined, 0), 1000);
	assert.equal(retryDelay(1, 1000, undefined, 0), 2000);
	assert.equal(retryDelay(2, 1000, undefined, 0), 4000);
	// Jitter is additive and never exceeds JITTER_MAX_MS.
	assert.equal(retryDelay(0, 1000, undefined, 0.5), 1000 + Math.floor(0.5 * JITTER_MAX_MS));
	assert.ok(retryDelay(0, 1000, undefined, 0.999) < 1000 + JITTER_MAX_MS);
});

test("a Retry-After caps the backoff rather than replacing it", () => {
	// The server asked for less than our backoff — honour the shorter wait.
	assert.equal(retryDelay(3, 1000, 500, 0), 500);
	// A hostile Retry-After: 3600 must not stall the publish beyond our backoff.
	assert.equal(retryDelay(0, 1000, 3_600_000, 0), 1000);
	assert.equal(retryDelay(0, 1000, 0, 0), 0);
});

test("parseRetryAfter reads delta-seconds and HTTP dates", () => {
	assert.equal(parseRetryAfter("30"), 30_000);
	assert.equal(parseRetryAfter("  5 "), 5000);
	assert.equal(parseRetryAfter(undefined), undefined);
	assert.equal(parseRetryAfter(""), undefined);
	assert.equal(parseRetryAfter("not a date"), undefined);

	const now = Date.parse("2026-09-01T12:00:00Z");
	assert.equal(parseRetryAfter("Tue, 01 Sep 2026 12:00:10 GMT", now), 10_000);
	// A date already in the past clamps to zero rather than going negative.
	assert.equal(parseRetryAfter("Tue, 01 Sep 2026 11:59:00 GMT", now), 0);
});

// ---------------------------------------------------------------------------
// Attachment uploads (F9)
// ---------------------------------------------------------------------------

test("an attachment upload is recognised only for POST/PUT", () => {
	assert.equal(isAttachmentUpload("/api/content/123/child/attachment", "POST"), true);
	assert.equal(isAttachmentUpload("/api/content/123/child/attachment/456/data", "PUT"), true);
	assert.equal(isAttachmentUpload("/api/content/123/child/attachment?x=1", "POST"), true);
	assert.equal(isAttachmentUpload("/api/content/123/child/attachment", "GET"), false);
	assert.equal(isAttachmentUpload("/api/content/123", "POST"), false);
	assert.equal(isAttachmentUpload(undefined, "POST"), false);
});

test("a 5xx on an attachment upload is never retried, but a 429 is", () => {
	const base = { attempt: 0, retryMax: 3, retryBaseMs: 1000, url: "/api/content/1/child/attachment", method: "POST" };
	assert.equal(planRetry({ ...base, status: 503 }), null);
	// A network error may also have been applied server-side.
	assert.equal(planRetry({ ...base, status: undefined }), null);
	// 429 never reached the handler, so re-sending cannot duplicate the file.
	assert.equal(planRetry({ ...base, status: 429, jitterFraction: 0 }), 1000);
});

// ---------------------------------------------------------------------------
// planRetry (F9)
// ---------------------------------------------------------------------------

test("planRetry stops once retryMax attempts have been made", () => {
	const base = { retryMax: 3, retryBaseMs: 1000, status: 503, jitterFraction: 0 };
	assert.equal(planRetry({ ...base, attempt: 0 }), 1000);
	assert.equal(planRetry({ ...base, attempt: 2 }), 4000);
	assert.equal(planRetry({ ...base, attempt: 3 }), null);
	// retryMax 0 disables retrying entirely.
	assert.equal(planRetry({ ...base, retryMax: 0, attempt: 0 }), null);
});

test("planRetry refuses a non-retryable status regardless of the attempt count", () => {
	assert.equal(planRetry({ attempt: 0, retryMax: 5, retryBaseMs: 1000, status: 400 }), null);
	assert.equal(planRetry({ attempt: 0, retryMax: 5, retryBaseMs: 1000, status: 404 }), null);
});

// ---------------------------------------------------------------------------
// The loop itself (F9)
// ---------------------------------------------------------------------------

/** Build a transport that yields the given outcomes in order, counting calls. */
function transport(outcomes: AttemptOutcome<string>[]) {
	const waits: number[] = [];
	let calls = 0;
	return {
		get calls() {
			return calls;
		},
		waits,
		run: (retryMax = 3) =>
			runWithRetry<string>({
				retryMax,
				retryBaseMs: 1000,
				jitterFraction: 0,
				url: "/api/content/1",
				method: "PUT",
				wait: async (ms) => {
					waits.push(ms);
				},
				attempt: async () => {
					const outcome = outcomes[calls] ?? outcomes[outcomes.length - 1];
					calls++;
					return outcome;
				},
			}),
	};
}

test("a transport that fails twice then succeeds is called three times", async () => {
	const t = transport([{ status: 503 }, { status: 503 }, { status: 200, response: "ok" }]);
	assert.equal(await t.run(), "ok");
	assert.equal(t.calls, 3);
	assert.deepEqual(t.waits, [1000, 2000]);
});

test("a 400 is not retried — one call, no wait, the error response returned", async () => {
	const t = transport([{ status: 400, response: "bad request" }]);
	assert.equal(await t.run(), "bad request");
	assert.equal(t.calls, 1);
	assert.deepEqual(t.waits, []);
});

test("a persistent failure gives up after retryMax retries and returns the last response", async () => {
	const t = transport([{ status: 503, response: "still down" }]);
	assert.equal(await t.run(2), "still down");
	// One initial attempt plus two retries.
	assert.equal(t.calls, 3);
	assert.deepEqual(t.waits, [1000, 2000]);
});

test("a network error is retried and finally rethrown, not swallowed", async () => {
	const boom = new Error("socket hang up");
	const t = transport([{ error: boom }]);
	await assert.rejects(() => t.run(1), /socket hang up/);
	assert.equal(t.calls, 2);
});

test("a network error that later succeeds resolves to the response", async () => {
	const t = transport([{ error: new Error("ECONNRESET") }, { status: 200, response: "recovered" }]);
	assert.equal(await t.run(), "recovered");
	assert.equal(t.calls, 2);
});

test("the loop honours a Retry-After the server sent", async () => {
	const t = transport([{ status: 429, retryAfterMs: 250 }, { status: 200, response: "ok" }]);
	assert.equal(await t.run(), "ok");
	assert.deepEqual(t.waits, [250]);
});

test("a successful first attempt never waits", async () => {
	const t = transport([{ status: 200, response: "ok" }]);
	assert.equal(await t.run(), "ok");
	assert.equal(t.calls, 1);
	assert.deepEqual(t.waits, []);
});
