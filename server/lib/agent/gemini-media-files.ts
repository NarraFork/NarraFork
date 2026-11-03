import { createHash } from "node:crypto";
import { abortableSleep } from "./abortable-sleep";
import { geminiMediaMime } from "./native-media";

/** Below both Google's current 100MB inline ceiling and our 64MiB request guard. */
export const GEMINI_MEDIA_INLINE_REQUEST_BYTES = 48 * 1024 * 1024;
export const GEMINI_FILES_METADATA_MAX_BYTES = 64 * 1024;

async function readFileMetadata<T>(response: Response, signal: AbortSignal): Promise<T> {
	if (!response.body) throw new Error("Gemini Files API returned no metadata body.");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	let text = "";
	const onAbort = () => {
		void reader.cancel(signal.reason).catch(() => {});
	};
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		while (true) {
			signal.throwIfAborted();
			const { done, value } = await reader.read();
			signal.throwIfAborted();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > GEMINI_FILES_METADATA_MAX_BYTES) {
				void reader.cancel().catch(() => {});
				throw new Error("Gemini Files API metadata exceeds the 64KiB response limit.");
			}
			text += decoder.decode(value, { stream: true });
		}
		text += decoder.decode();
		try {
			return JSON.parse(text) as T;
		} catch {
			throw new Error("Gemini Files API returned invalid JSON metadata.");
		}
	} finally {
		signal.removeEventListener("abort", onAbort);
		reader.releaseLock();
	}
}

interface GeminiFile {
	name?: string;
	uri?: string;
	mimeType?: string;
	state?: string;
	expirationTime?: string;
}

type MediaFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
interface Options {
	baseUrl: string;
	apiKey: string;
	fetch: MediaFetch;
	inlineLimitBytes?: number;
	processingTimeoutMs?: number;
	pollIntervalMs?: number;
}

/** Files state is scoped to one provider instance/credential/endpoint, never shared globally. */
export class GeminiMediaFiles {
	private cache = new Map<string, { file: GeminiFile; expires: number }>();
	constructor(private options: Options) {}

	async prepare<T extends Record<string, unknown>>(
		body: T,
		protocol: "generate" | "interactions",
		signal?: AbortSignal,
	): Promise<T> {
		signal?.throwIfAborted();
		const candidates: Array<{ item: Record<string, unknown>; data: string; mime: string }> = [];
		// Media only occupies protocol content slots. Tool arguments, schemas and JSON
		// results may also contain MIME fields, but are never upload candidates.
		const record = (value: unknown): Record<string, unknown> | undefined =>
			value && typeof value === "object" && !Array.isArray(value)
				? (value as Record<string, unknown>)
				: undefined;
		const add = (value: unknown): void => {
			const item = record(value);
			if (!item) return;
			const inline = record(item.inlineData);
			if (protocol === "interactions" && !["audio", "video"].includes(String(item.type))) return;
			const data = protocol === "generate" ? inline?.data : item.data;
			const mime = protocol === "generate" ? inline?.mimeType : item.mime_type;
			if (typeof mime !== "string" || !/^(audio|video)\//.test(mime)) return;
			// Already uploaded Interactions inputs have a URI instead of inline bytes.
			if (protocol === "interactions" && typeof item.uri === "string" && data === undefined) return;
			if (typeof data !== "string") throw new Error("Gemini native media has no media bytes.");
			geminiMediaMime({
				type: mime.startsWith("audio/") ? "audio" : "video",
				mediaType: mime,
				base64: data,
			});
			candidates.push({ item, data, mime });
		};
		if (protocol === "generate") {
			for (const content of Array.isArray(body.contents) ? body.contents : []) {
				const parts = record(content)?.parts;
				for (const part of Array.isArray(parts) ? parts : []) add(part);
			}
		} else {
			for (const step of Array.isArray(body.input) ? body.input : []) {
				const item = record(step);
				if (item?.type !== "user_input") continue;
				for (const part of Array.isArray(item.content) ? item.content : []) add(part);
			}
		}
		if (!candidates.length) return body;
		let estimatedBytes = 0;
		const scan = (value: unknown): void => {
			if (typeof value === "string") {
				estimatedBytes += Buffer.byteLength(value);
				return;
			}
			if (!value || typeof value !== "object") {
				estimatedBytes += 8;
				return;
			}
			if (Array.isArray(value)) {
				for (const part of value) scan(part);
				return;
			}
			const item = value as Record<string, unknown>;
			for (const [key, val] of Object.entries(item)) {
				estimatedBytes += key.length + 8;
				scan(val);
			}
		};
		scan(body);
		if (estimatedBytes <= (this.options.inlineLimitBytes ?? GEMINI_MEDIA_INLINE_REQUEST_BYTES))
			return body;
		// Replace on a cloned request. Persistent history must retain bytes for retries and replay.
		const replacements = new Map<object, Record<string, unknown>>();
		for (const candidate of candidates) {
			const file = await this.upload(candidate.data, candidate.mime, signal);
			replacements.set(
				candidate.item,
				protocol === "generate"
					? {
							...candidate.item,
							inlineData: undefined,
							fileData: { mimeType: candidate.mime, fileUri: file.uri },
						}
					: { ...candidate.item, data: undefined, uri: file.uri },
			);
		}
		const clone = (value: unknown): unknown => {
			if (!value || typeof value !== "object") return value;
			if (Array.isArray(value)) return value.map(clone);
			const replacement = replacements.get(value);
			if (replacement) return replacement;
			return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
		};
		return clone(body) as T;
	}

	private async upload(
		base64: string,
		mimeType: string,
		parentSignal?: AbortSignal,
	): Promise<GeminiFile> {
		const base = new URL(this.options.baseUrl);
		if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash)
			throw new Error(
				"Gemini Files API requires a credential-isolated HTTPS endpoint without URL credentials or query parameters.",
			);
		const version = base.pathname.match(/^(.*)\/(v1(?:beta\d*)?)\/?$/);
		if (!version) throw new Error("Gemini Files API requires a versioned native Gemini base URL.");
		const key = createHash("sha256").update(mimeType).update(base64).digest("hex");
		const cached = this.cache.get(key);
		if (cached && cached.expires > Date.now()) return cached.file;
		const signal = AbortSignal.any([
			...(parentSignal ? [parentSignal] : []),
			AbortSignal.timeout(this.options.processingTimeoutMs ?? 120_000),
		]);
		signal.throwIfAborted();
		const bytes = Buffer.from(base64, "base64");
		const uploadUrl = new URL(`${version[1]}/upload/${version[2]}/files`, base.origin);
		const start = await this.options.fetch(uploadUrl, {
			method: "POST",
			redirect: "error",
			signal,
			headers: {
				"x-goog-api-key": this.options.apiKey,
				"X-Goog-Upload-Protocol": "resumable",
				"X-Goog-Upload-Command": "start",
				"X-Goog-Upload-Header-Content-Length": String(bytes.length),
				"X-Goog-Upload-Header-Content-Type": mimeType,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ file: { display_name: "NarraFork native media" } }),
		});
		if (!start.ok)
			throw new Error(`Gemini Files API upload initialization failed (${start.status}).`);
		const session = start.headers.get("x-goog-upload-url");
		if (!session) throw new Error("Gemini Files API omitted the resumable upload URL.");
		const sessionUrl = new URL(session, uploadUrl);
		if (
			sessionUrl.origin !== base.origin ||
			sessionUrl.protocol !== "https:" ||
			sessionUrl.username ||
			sessionUrl.password
		)
			throw new Error(
				"Gemini Files API returned a cross-origin or unsafe upload URL; media and credentials were not forwarded.",
			);
		signal.throwIfAborted();
		// The session URL is already authorized. Never attach our API key to it.
		const uploaded = await this.options.fetch(sessionUrl, {
			method: "POST",
			redirect: "error",
			signal,
			headers: {
				"Content-Length": String(bytes.length),
				"Content-Type": mimeType,
				"X-Goog-Upload-Offset": "0",
				"X-Goog-Upload-Command": "upload, finalize",
			},
			body: bytes,
		});
		if (!uploaded.ok) throw new Error(`Gemini Files API media upload failed (${uploaded.status}).`);
		const payload = await readFileMetadata<{ file?: GeminiFile }>(uploaded, signal);
		let file = payload.file;
		if (!file?.name || !/^files\/[a-zA-Z0-9_-]+$/.test(file.name))
			throw new Error("Gemini Files API returned an invalid file resource.");
		while (file.state === "PROCESSING") {
			await abortableSleep(this.options.pollIntervalMs ?? 1_000, signal);
			signal.throwIfAborted();
			const status = await this.options.fetch(
				`${this.options.baseUrl.replace(/\/$/, "")}/${file.name}`,
				{
					method: "GET",
					redirect: "error",
					signal,
					headers: { "x-goog-api-key": this.options.apiKey },
				},
			);
			if (!status.ok)
				throw new Error(`Gemini Files API processing check failed (${status.status}).`);
			const next = await readFileMetadata<GeminiFile>(status, signal);
			if (next.name !== file.name)
				throw new Error("Gemini Files API changed the file resource during processing.");
			file = next;
		}
		signal.throwIfAborted();
		if (file.state !== "ACTIVE")
			throw new Error(
				`Gemini Files API media processing failed (${file.state ?? "missing state"}).`,
			);
		if (!file.uri) throw new Error("Gemini Files API returned no media URI.");
		const uri = new URL(file.uri);
		if (uri.protocol !== "https:" || uri.origin !== base.origin || uri.username || uri.password)
			throw new Error("Gemini Files API returned an unsafe or cross-origin media URI.");
		const oldest = this.cache.keys().next().value;
		if (this.cache.size >= 32 && oldest !== undefined) this.cache.delete(oldest);
		const expires = Math.min(
			Date.now() + 46 * 60 * 60 * 1_000,
			Date.parse(file.expirationTime ?? "") || Infinity,
		);
		this.cache.set(key, { file, expires });
		return file;
	}
}
