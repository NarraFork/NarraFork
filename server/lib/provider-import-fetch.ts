/**
 * Server-side fetch of `/.well-known/narrafork-provider.json` for provider import
 * (docs/PROVIDER_IMPORT.md §5).
 *
 * The server fetches rather than the browser so gateways need no CORS setup and
 * the request follows NarraFork's outbound proxy policy. Because the server is
 * making a request on an admin's behalf, every hop is checked by the plugin
 * installer's SSRF guard, redirects may only stay within the registrable domain
 * the user typed (otherwise "this config came from that domain" no longer
 * holds), and each attempt is bounded in time and size.
 */

import {
	type ImportFetchAttempt,
	type ImportFetchResult,
	isSameSite,
	PROVIDER_IMPORT_LIMITS,
	type ProviderImportValidation,
	resolveRemoteCandidates,
	validateImportPayload,
} from "@shared/provider-import";
import { assertPublicHost, assertPublicUrl } from "./agent/tools/plugin-install";
import { outboundFetch } from "./net/outbound-fetch";
import { resolveProxyForUrl } from "./net/proxy";

const ATTEMPT_TIMEOUT_MS = 5_000;
const MAX_REDIRECTS = 3;

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
type LookupLike = (
	hostname: string,
	options?: { all?: boolean },
) => Promise<Array<{ address: string; family: number }>>;

export interface ImportFetchDeps {
	fetchImpl?: FetchLike;
	lookupImpl?: LookupLike;
}

const defaultFetch: FetchLike = (input, init) =>
	outboundFetch(input, init, { proxyUrl: resolveProxyForUrl(input), retryPolicy: "never" });

function errorText(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/** Read at most `limit` bytes; null when the body is larger. */
async function readLimited(response: Response, limit: number): Promise<string | null> {
	const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
	if (Number.isFinite(declared) && declared > limit) {
		void response.body?.cancel().catch(() => {});
		return null;
	}
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > limit) {
			await reader.cancel().catch(() => {});
			return null;
		}
		chunks.push(value);
	}
	const merged = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(merged);
}

type AttemptResult =
	| { kind: "next"; attempt: ImportFetchAttempt }
	| { kind: "stop"; attempt: ImportFetchAttempt }
	| ({ kind: "found"; attempt: ImportFetchAttempt; finalUrl: string } & ProviderImportValidation);

async function attemptCandidate(
	candidate: string,
	deps: Required<ImportFetchDeps>,
): Promise<AttemptResult> {
	const originHost = new URL(candidate).hostname;
	let current = candidate;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		const url = new URL(current);
		if (url.protocol !== "https:") {
			return {
				kind: "next",
				attempt: { url: candidate, outcome: "blocked", detail: "HTTPS only" },
			};
		}
		try {
			assertPublicUrl(url);
			await assertPublicHost(url.hostname, { lookupImpl: deps.lookupImpl });
		} catch (error) {
			return {
				kind: "next",
				attempt: { url: candidate, outcome: "blocked", detail: errorText(error) },
			};
		}

		let response: Response;
		try {
			response = await deps.fetchImpl(current, {
				method: "GET",
				redirect: "manual",
				credentials: "omit",
				headers: { accept: "application/json" },
				signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
			});
		} catch (error) {
			return {
				kind: "next",
				attempt: { url: candidate, outcome: "network", detail: errorText(error) },
			};
		}

		if (response.status >= 300 && response.status < 400) {
			void response.body?.cancel().catch(() => {});
			const location = response.headers.get("location");
			let next: URL | null = null;
			try {
				next = location ? new URL(location, current) : null;
			} catch {
				// A malformed Location is the site's problem: report it, try the next candidate.
			}
			if (!next || !isSameSite(next.hostname, originHost)) {
				return {
					kind: "next",
					attempt: {
						url: candidate,
						outcome: "redirect-blocked",
						detail: next?.host ?? (location ? "invalid Location" : "no Location"),
					},
				};
			}
			current = next.toString();
			continue;
		}
		if (!response.ok) {
			void response.body?.cancel().catch(() => {});
			return {
				kind: "next",
				attempt: {
					url: candidate,
					outcome: response.status === 404 ? "not-found" : "http-error",
					detail: `HTTP ${response.status}`,
				},
			};
		}
		// Single-page sites answer unknown paths with their index page.
		if ((response.headers.get("content-type") ?? "").toLowerCase().includes("text/html")) {
			void response.body?.cancel().catch(() => {});
			return { kind: "next", attempt: { url: candidate, outcome: "html" } };
		}

		let body: string | null;
		try {
			body = await readLimited(response, PROVIDER_IMPORT_LIMITS.maxFetchBytes);
		} catch (error) {
			return {
				kind: "next",
				attempt: { url: candidate, outcome: "network", detail: errorText(error) },
			};
		}
		if (body === null) return { kind: "stop", attempt: { url: candidate, outcome: "too-large" } };
		if (body.trimStart().startsWith("<")) {
			return { kind: "next", attempt: { url: candidate, outcome: "html" } };
		}

		let raw: unknown;
		try {
			raw = JSON.parse(body);
		} catch {
			return { kind: "stop", attempt: { url: candidate, outcome: "bad-json" } };
		}
		// A public file must not carry keys: they are dropped and reported, never used.
		const validation = validateImportPayload(raw, { allowApiKey: false });
		if (!validation.ok) {
			return {
				kind: "stop",
				attempt: { url: candidate, outcome: "invalid", detail: validation.detail },
			};
		}
		return {
			kind: "found",
			attempt: { url: candidate, outcome: "ok" },
			finalUrl: current,
			payload: validation.payload,
			ignoredFields: validation.ignoredFields,
			droppedApiKey: validation.droppedApiKey,
		};
	}
	return {
		kind: "next",
		attempt: {
			url: candidate,
			outcome: "redirect-blocked",
			detail: `more than ${MAX_REDIRECTS} redirects`,
		},
	};
}

/**
 * Probe the candidates for `input` in order. Unreachable or missing files move
 * on to the next candidate; a file that exists but is wrong stops the search so
 * the site owner sees the actual error.
 */
export async function fetchRemoteImportConfig(
	input: string,
	options: { exact: boolean } & ImportFetchDeps,
): Promise<ImportFetchResult> {
	const candidates = resolveRemoteCandidates(input, { exact: options.exact });
	if (!candidates.ok) return { ok: false, error: "bad-domain", attempts: [] };
	const deps: Required<ImportFetchDeps> = {
		fetchImpl: options.fetchImpl ?? defaultFetch,
		lookupImpl:
			options.lookupImpl ??
			(async (hostname) => {
				const { lookup } = await import("node:dns/promises");
				return lookup(hostname, { all: true });
			}),
	};

	const attempts: ImportFetchAttempt[] = [];
	for (const candidate of candidates.urls) {
		const result = await attemptCandidate(candidate, deps);
		attempts.push(result.attempt);
		if (result.kind === "found") {
			return {
				ok: true,
				sourceUrl: result.finalUrl,
				host: new URL(result.finalUrl).hostname,
				attempts,
				payload: result.payload,
				ignoredFields: result.ignoredFields,
				droppedApiKey: result.droppedApiKey,
			};
		}
		if (result.kind === "stop") return { ok: false, error: "invalid", attempts };
	}
	return { ok: false, error: "not-found", attempts };
}
