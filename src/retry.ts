/**
 * Bounded retry policy for Confluence API calls (F9).
 *
 * A 2,700-page publish runs for a long time and a single transient 503 or a
 * rate-limit response should not cost the whole run. This module holds the
 * pure decisions — is this retryable, how long do we wait — so they can be
 * unit-tested without a transport.
 */

/** Statuses worth retrying: rate limiting and transient gateway failures. */
export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);

/** Upper bound on the random jitter added to each backoff, in milliseconds. */
export const JITTER_MAX_MS = 250;

/**
 * Whether an HTTP status should be retried. Every other 4xx is a request the
 * server will reject identically next time; `undefined` means the transport
 * failed before a status existed (a network error), which is retryable.
 */
export function isRetryableStatus(status: number | undefined): boolean {
	if (status === undefined) return true; // network-level failure
	return RETRYABLE_STATUSES.has(status);
}

/**
 * Delay before attempt `attempt` (0-based) of a retry.
 *
 * Exponential backoff from `baseMs` plus jitter, capped by the server's
 * `Retry-After` when it sent one — the cap keeps a hostile or mistaken
 * `Retry-After: 3600` from stalling a publish for an hour.
 *
 * `jitterFraction` is injectable so tests are deterministic.
 */
export function retryDelay(
	attempt: number,
	baseMs: number,
	retryAfterMs?: number,
	jitterFraction = Math.random(),
): number {
	const base = Math.max(0, baseMs);
	const backoff = base * Math.pow(2, Math.max(0, attempt)) + Math.floor(jitterFraction * JITTER_MAX_MS);
	if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
		return Math.min(backoff, retryAfterMs);
	}
	return backoff;
}

/**
 * Parse a `Retry-After` header (delta-seconds or an HTTP date) to milliseconds.
 * Returns undefined when absent or unparseable.
 */
export function parseRetryAfter(header: string | undefined | null, now = Date.now()): number | undefined {
	if (!header) return undefined;
	const trimmed = String(header).trim();
	if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
	const at = Date.parse(trimmed);
	if (Number.isNaN(at)) return undefined;
	return Math.max(0, at - now);
}

/**
 * Attachment uploads are the one request we never retry on a 5xx: Data Center
 * may have accepted the upload before failing the response, and a blind retry
 * creates a duplicate. The existing "same file name" recovery path picks it up
 * on the next run instead.
 */
export function isAttachmentUpload(url: string | undefined, method: string | undefined): boolean {
	if (!url) return false;
	const m = (method ?? "GET").toUpperCase();
	if (m !== "POST" && m !== "PUT") return false;
	return /\/child\/attachment(\/|$|\?)/.test(url);
}

/**
 * The full retry decision for one failed attempt.
 *
 * `attempt` is 0-based (0 = the first failure). Returns the delay to wait, or
 * null when the request must not be retried.
 */
export function planRetry(options: {
	attempt: number;
	retryMax: number;
	retryBaseMs: number;
	status: number | undefined;
	url?: string;
	method?: string;
	retryAfterMs?: number;
	jitterFraction?: number;
}): number | null {
	const { attempt, retryMax, retryBaseMs, status, url, method, retryAfterMs, jitterFraction } = options;
	if (attempt >= Math.max(0, retryMax)) return null;
	if (!isRetryableStatus(status)) return null;
	// A 5xx / network failure on an attachment upload may already have been
	// applied server-side; 429 is safe because the request never reached the
	// handler.
	if (status !== 429 && isAttachmentUpload(url, method)) return null;
	return retryDelay(attempt, retryBaseMs, retryAfterMs, jitterFraction);
}

/** One transport attempt's outcome, normalised away from any HTTP client. */
export interface AttemptOutcome<R> {
	/** The response, when the transport produced one. */
	response?: R;
	/** HTTP status, or undefined for a transport-level failure. */
	status?: number;
	/** The thrown error, when the transport failed before producing a status. */
	error?: unknown;
	/** Milliseconds the server asked us to wait, if it sent Retry-After. */
	retryAfterMs?: number;
}

export interface RunWithRetryOptions<R> {
	/** Perform one attempt. Must not throw — failures come back as `error`. */
	attempt: (attemptIndex: number) => Promise<AttemptOutcome<R>>;
	/** Sleep between attempts; injected so tests need no real timers. */
	wait: (ms: number) => Promise<void>;
	retryMax: number;
	retryBaseMs: number;
	url?: string;
	method?: string;
	/** Called before each wait, so the caller can log without owning the loop. */
	onRetry?: (info: { attempt: number; delay: number; status: number | undefined; error: unknown }) => void;
	jitterFraction?: number;
}

/**
 * Drive `attempt` until it succeeds or the policy in `planRetry` gives up.
 *
 * Success is any outcome with no error and no 4xx/5xx status. On giving up, a
 * transport error is rethrown and an error *response* is returned as-is, so the
 * caller's existing error handling still sees the server's own body.
 *
 * Pure apart from the injected transport and sleeper, so the whole loop — not
 * just the policy it consults — is unit-testable.
 */
export async function runWithRetry<R>(options: RunWithRetryOptions<R>): Promise<R | undefined> {
	const { attempt, wait, retryMax, retryBaseMs, url, method, onRetry, jitterFraction } = options;
	for (let i = 0; ; i++) {
		const outcome = await attempt(i);
		const failed = outcome.error !== undefined || (typeof outcome.status === "number" && outcome.status >= 400);
		if (!failed) return outcome.response;

		const status = outcome.error !== undefined ? undefined : outcome.status;
		const delay = planRetry({
			attempt: i,
			retryMax,
			retryBaseMs,
			status,
			url,
			method,
			retryAfterMs: outcome.retryAfterMs,
			jitterFraction,
		});
		if (delay === null) {
			if (outcome.error !== undefined) throw outcome.error;
			return outcome.response;
		}
		onRetry?.({ attempt: i, delay, status, error: outcome.error });
		await wait(delay);
	}
}
