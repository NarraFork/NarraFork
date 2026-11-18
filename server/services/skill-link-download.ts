import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { AppError, ValidationError } from "@server/lib/errors";
import { Agent, request } from "undici/index.js";
import {
	type DownloadedSkillFile,
	downloadGitHubSkill,
	parseGitHubSkillUrl,
} from "./skill-github-import";

const MAX_URL_LENGTH = 2048;
const MAX_BYTES = 200_000;
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

interface SkillLinkBody extends AsyncIterable<Uint8Array> {
	destroy(): unknown;
	on?(event: "error", listener: (error: Error) => void): unknown;
}

export interface SkillLinkResponse {
	statusCode: number;
	headers: Record<string, string | string[] | undefined>;
	body: SkillLinkBody;
}

export interface SkillLinkRequestOptions {
	dispatcher: Agent;
	method: "GET";
	headers: Record<string, string>;
	signal: AbortSignal;
	maxRedirections: 0;
	headersTimeout: number;
	bodyTimeout: number;
	highWaterMark: number;
}

/** Test seams only: neither changes the public-address policy nor supplies production proxies. */
export interface SkillLinkDownloadDeps {
	resolve(hostname: string, signal: AbortSignal): Promise<LookupAddress[]>;
	request(url: URL, options: SkillLinkRequestOptions): Promise<SkillLinkResponse>;
}

const defaults: SkillLinkDownloadDeps = {
	resolve: (hostname) => lookup(hostname, { all: true, verbatim: true }),
	request: (url, options) => request(url, options),
};

function aborted(): AppError {
	return new AppError("Skill link download was cancelled or timed out.", 408, "SKILL_LINK_ABORTED");
}

function checkAbort(signal: AbortSignal): void {
	if (signal.aborted) throw aborted();
}

function invalidUrl(): ValidationError {
	return new ValidationError(
		"Use a public HTTP(S) raw SKILL.md link without credentials or a fragment.",
		"SKILL_LINK_URL",
	);
}

function privateHost(): ValidationError {
	return new ValidationError(
		"Skill links must use a public Internet address; private and reserved networks are not allowed.",
		"SKILL_LINK_PRIVATE_HOST",
	);
}

function tooLarge(): ValidationError {
	return new ValidationError("SKILL.md exceeds the 200000-byte limit.", "SKILL_LINK_LIMIT");
}

function htmlPage(): ValidationError {
	return new ValidationError(
		"This link returned an HTML page. Use the raw SKILL.md link instead.",
		"SKILL_LINK_HTML",
	);
}

/** Validate the original string as well: URL() silently removes controls and normalizes slashes. */
function parsePublicUrl(value: string, base?: URL): URL {
	if (
		typeof value !== "string" ||
		!value ||
		value.length > MAX_URL_LENGTH ||
		/[\s\p{Cc}\p{Cs}\\#]/u.test(value)
	) {
		throw invalidUrl();
	}
	let url: URL;
	try {
		if (/[\p{Cc}\p{Cs}\\]/u.test(decodeURIComponent(value))) throw invalidUrl();
		url = base ? new URL(value, base) : new URL(value);
	} catch {
		throw invalidUrl();
	}
	if (
		!["http:", "https:"].includes(url.protocol) ||
		(!base && !/^https?:\/\/[^/?#]+/i.test(value)) ||
		/^(?:https?:)?\/\/[^/?#]*@/i.test(value) ||
		url.username ||
		url.password ||
		url.hash ||
		url.href.length > MAX_URL_LENGTH
	) {
		throw invalidUrl();
	}
	const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
	if (isIP(hostname)) {
		if (!isPublicAddress(hostname)) throw privateHost();
	} else if (
		!hostname.includes(".") ||
		/(?:^|\.)(?:localhost|local|internal|lan|home|invalid|test|example|onion)$/i.test(hostname) ||
		hostname.endsWith(".home.arpa") ||
		!/^[a-z0-9.-]+$/i.test(hostname)
	) {
		throw privateHost();
	}
	return url;
}

/** Conservative global-unicast policy, including IPv4 aliases and IPv6 transition ranges. */
function isPublicAddress(address: string): boolean {
	if (typeof address !== "string" || address.includes("%")) return false;
	const family = isIP(address);
	if (family === 4) {
		const [a, b, c] = address.split(".").map(Number);
		return !(
			a === 0 ||
			a === 10 ||
			a === 127 ||
			a >= 224 ||
			(a === 100 && b >= 64 && b <= 127) ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 0 && (c === 0 || c === 2)) ||
			(a === 192 && b === 88 && c === 99) ||
			(a === 192 && b === 168) ||
			(a === 198 && (b === 18 || b === 19)) ||
			(a === 198 && b === 51 && c === 100) ||
			(a === 203 && b === 0 && c === 113)
		);
	}
	if (family !== 6) return false;
	// URL canonicalization also expands dotted IPv4-mapped spellings into hexadecimal words.
	const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
	const [left, right] = canonical.split("::");
	const head = left ? left.split(":") : [];
	const tail = right ? right.split(":") : [];
	const words = (
		right === undefined
			? head
			: [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail]
	).map((word) => Number.parseInt(word, 16));
	return (
		(words[0] & 0xe000) === 0x2000 &&
		!(words[0] === 0x2001 && (words[1] < 0x200 || words[1] === 0xdb8)) &&
		words[0] !== 0x2002 &&
		words[0] !== 0x3ffe &&
		!(words[0] === 0x3fff && (words[1] & 0xf000) === 0)
	);
}

/** An ignoring/stalled resolver, request or iterator must not outlive the caller's deadline. */
function withAbort<T>(
	promise: Promise<T>,
	signal: AbortSignal,
	disposeLate?: (value: T) => void,
): Promise<T> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const onAbort = () => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			reject(aborted());
		};
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
		promise.then(
			(value) => {
				if (settled) {
					disposeLate?.(value);
					return;
				}
				settled = true;
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				if (settled) return;
				settled = true;
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

function discardResponse(response: SkillLinkResponse): void {
	try {
		// Undici's destroy() can emit RequestAbortedError even when no error argument was supplied.
		response.body.on?.("error", () => {});
		response.body.destroy();
	} catch {
		// Cleanup must neither replace the actual error nor await a broken transport.
	}
}

function destroyAgent(agent: Agent): void {
	try {
		void agent.destroy().catch(() => {});
	} catch {
		// Do not extend the caller's deadline waiting for cleanup.
	}
}

async function resolvePublicAddress(
	url: URL,
	signal: AbortSignal,
	resolve: SkillLinkDownloadDeps["resolve"],
): Promise<LookupAddress> {
	const hostname = url.hostname.replace(/^\[|\]$/g, "");
	if (isIP(hostname)) return { address: hostname, family: isIP(hostname) };
	let answers: LookupAddress[];
	try {
		answers = await withAbort(
			Promise.resolve().then(() => resolve(hostname, signal)),
			signal,
		);
	} catch (error) {
		if (signal.aborted) throw aborted();
		if (error instanceof AppError) throw error;
		throw new AppError("Unable to resolve the public skill link host.", 502, "SKILL_LINK_DNS");
	}
	checkAbort(signal);
	if (
		!Array.isArray(answers) ||
		!answers.length ||
		answers.length > 64 ||
		answers.some(
			(answer) =>
				!answer || isIP(answer.address) !== answer.family || !isPublicAddress(answer.address),
		)
	) {
		throw privateHost();
	}
	// Copy rather than retain a mutable DNS result: the connector always returns this exact answer.
	return { address: answers[0].address, family: answers[0].family };
}

function pinnedAgent(url: URL, address: LookupAddress, signal: AbortSignal): Agent {
	const hostname = url.hostname.replace(/^\[|\]$/g, "");
	const fixed = Object.freeze({ ...address });
	const fixedLookup: LookupFunction = (requestedHost, options, callback) => {
		if (signal.aborted || requestedHost.toLowerCase() !== hostname.toLowerCase()) {
			callback(new Error("Skill link connection was cancelled or changed host."), "", 0);
			return;
		}
		callback(null, options.all ? [{ ...fixed }] : fixed.address, fixed.family);
	};
	return new Agent({
		connections: 1,
		pipelining: 0,
		maxRedirections: 0,
		maxHeaderSize: 16 * 1024,
		maxResponseSize: MAX_BYTES + 1,
		autoSelectFamily: false,
		connect: {
			lookup: fixedLookup,
			servername: isIP(hostname) ? undefined : hostname,
			rejectUnauthorized: true,
			signal,
		},
	});
}

function header(response: SkillLinkResponse, name: string): string {
	const value = response.headers[name];
	return Array.isArray(value) ? value.join(",") : (value ?? "");
}

async function readMarkdown(response: SkillLinkResponse, signal: AbortSignal): Promise<Uint8Array> {
	if (/^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/i.test(header(response, "content-type"))) {
		throw htmlPage();
	}
	const encoding = header(response, "content-encoding").trim().toLowerCase();
	if (encoding && encoding !== "identity") {
		throw new ValidationError(
			"Use an uncompressed UTF-8 raw SKILL.md link.",
			"SKILL_LINK_ENCODING",
		);
	}
	const length = header(response, "content-length");
	if (/^\d+$/.test(length) && Number(length) > MAX_BYTES) throw tooLarge();

	// A single bounded allocation; never concatenate an unbounded list of network chunks.
	const buffer = new Uint8Array(MAX_BYTES + 1);
	let size = 0;
	const iterator = response.body[Symbol.asyncIterator]();
	while (true) {
		checkAbort(signal);
		const { value, done } = await withAbort(
			Promise.resolve().then(() => iterator.next()),
			signal,
		);
		if (done) break;
		if (!(value instanceof Uint8Array)) {
			throw new AppError(
				"The skill link returned an invalid response body.",
				502,
				"SKILL_LINK_BODY",
			);
		}
		if (value.byteLength > MAX_BYTES - size) throw tooLarge();
		buffer.set(value, size);
		size += value.byteLength;
	}
	checkAbort(signal);
	const bytes = buffer.subarray(0, size);
	let content: string;
	try {
		content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new ValidationError("SKILL.md must be valid UTF-8 text.", "SKILL_LINK_ENCODING");
	}
	let prefix = content.trimStart();
	// Leading comments are normal on HTML pages; Markdown examples later in the text are not pages.
	while (prefix.startsWith("<!--")) {
		const end = prefix.indexOf("-->");
		if (end < 0) break;
		prefix = prefix.slice(end + 3).trimStart();
	}
	if (/^<(?:!doctype\s+html\b|(?:html|head|body)(?:\s|\/?>))/i.test(prefix)) throw htmlPage();
	return bytes;
}

/** Shared routing predicate for callers which must snapshot files before starting the download. */
export function isGitHubSkillDirectoryUrl(value: string): boolean {
	try {
		if (parsePublicUrl(value).hostname !== "github.com") return false;
		parseGitHubSkillUrl(value);
		return true;
	} catch {
		return false;
	}
}

/** Anonymous, direct requests only. The caller owns the single overall (45s) deadline. */
export async function downloadSkillLink(
	value: string,
	signal: AbortSignal,
	deps: Partial<SkillLinkDownloadDeps> = {},
): Promise<{ files: DownloadedSkillFile[]; kind: "directory" | "markdown" }> {
	checkAbort(signal);
	let url = parsePublicUrl(value);
	if (isGitHubSkillDirectoryUrl(value)) {
		return { files: await downloadGitHubSkill(value, signal), kind: "directory" };
	}
	const resolve = deps.resolve ?? defaults.resolve;
	const sendRequest = deps.request ?? defaults.request;
	for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
		checkAbort(signal);
		const address = await resolvePublicAddress(url, signal, resolve);
		checkAbort(signal);
		const agent = pinnedAgent(url, address, signal);
		const onAbort = () => destroyAgent(agent);
		signal.addEventListener("abort", onAbort, { once: true });
		let response: SkillLinkResponse | undefined;
		try {
			response = await withAbort<SkillLinkResponse>(
				Promise.resolve().then(() => {
					checkAbort(signal);
					return sendRequest(url, {
						dispatcher: agent,
						method: "GET",
						headers: {
							accept: "text/markdown, text/plain;q=0.9, application/octet-stream;q=0.8",
							"accept-encoding": "identity",
						},
						signal,
						maxRedirections: 0,
						headersTimeout: 45_000,
						bodyTimeout: 45_000,
						highWaterMark: 16 * 1024,
					});
				}),
				signal,
				discardResponse,
			);
			checkAbort(signal);
			if (REDIRECT_STATUSES.has(response.statusCode)) {
				if (redirect === MAX_REDIRECTS) {
					throw new ValidationError("The skill link exceeds 3 redirects.", "SKILL_LINK_REDIRECT");
				}
				const next = parsePublicUrl(header(response, "location"), url);
				if (url.protocol === "https:" && next.protocol !== "https:") {
					throw new ValidationError(
						"Skill links cannot redirect HTTPS to HTTP.",
						"SKILL_LINK_REDIRECT",
					);
				}
				url = next;
				continue;
			}
			if (response.statusCode !== 200) {
				throw new AppError(
					`The skill link returned HTTP ${response.statusCode}; use a public raw SKILL.md link.`,
					502,
					"SKILL_LINK_HTTP",
				);
			}
			const bytes = await readMarkdown(response, signal);
			return { files: [{ path: "SKILL.md", bytes }], kind: "markdown" };
		} catch (error) {
			if (signal.aborted) throw aborted();
			if (error instanceof AppError) throw error;
			if (
				error &&
				typeof error === "object" &&
				"code" in error &&
				error.code === "UND_ERR_RES_EXCEEDED_MAX_SIZE"
			) {
				throw tooLarge();
			}
			throw new AppError("Unable to download this public skill link.", 502, "SKILL_LINK_REQUEST");
		} finally {
			signal.removeEventListener("abort", onAbort);
			if (response) discardResponse(response);
			destroyAgent(agent);
		}
	}
	throw new AppError("Skill link download did not complete.", 500, "SKILL_LINK_INCOMPLETE");
}
