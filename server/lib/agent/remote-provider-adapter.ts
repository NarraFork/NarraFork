import type { JsonValue, ProviderStreamEvent } from "@server/lib/plugins/protocol";
import { isHostTruncatedDump, PLUGIN_REQUEST_DUMP_MAX_BYTES } from "@server/lib/plugins/protocol";
import type {
	ModelCatalog,
	PluginProviderRpcClient,
	ProviderChatParams,
	ProviderContentBlock,
	ProviderDescriptor,
	ProviderGenerateParams,
	ProviderMessage,
	ProviderModelDescriptor,
	ProviderOperation,
	ProviderToolDefinition,
} from "@server/services/plugin-provider-rpc";
import { parseModelId } from "@shared/model-id";
import { hasCredentialBoundReasoning } from "@shared/reasoning-credentials";
import { type NeutralTurn, projectHistory, type ResolvedImage } from "./projection";
import type {
	BuiltHistory,
	ChatParams,
	DbMessage,
	GenerateMetaResult,
	GenerateOptions,
	ParsedStreamEvent,
	ProviderAdapter,
} from "./provider";
import {
	collectSecretConfigValues,
	maskSecretValues,
	type RecordingAttemptRequest,
	sanitizeHeaders,
} from "./request-dump";
import { unsupportedResponseFormatReason } from "./response-format";
import { resolveToolJsonSchema } from "./tool-registry";
import type {
	ApiRequestDiagnostics,
	ReasoningProviderMetadata,
	ResolvedToolDefinition,
} from "./types";
import { orderUserContent } from "./user-content-order";

type ProviderUsage = NonNullable<Extract<ProviderStreamEvent, { type: "usage" }>["usage"]>;

/** Plugin-reported upstream request/response evidence; consumed only by the dump tap. */
type DumpStreamEvent = Extract<ProviderStreamEvent, { type: "dump.request" | "dump.response" }>;

/** The narrow RPC surface consumed by the adapter; useful for tests and alternate runtimes. */
export interface RemoteProviderRpcClient {
	chat(params: ProviderChatParams, options?: { signal?: AbortSignal }): Promise<ProviderOperation>;
	generate(
		params: ProviderGenerateParams,
		options?: { signal?: AbortSignal },
	): Promise<ProviderOperation>;
}

export interface RemoteProviderAdapterOptions {
	rpc?: RemoteProviderRpcClient | PluginProviderRpcClient;
	/** Alias accepted for callers that name the injected dependency client. */
	client?: RemoteProviderRpcClient | PluginProviderRpcClient;
	providerTypeId: string;
	providerInstanceId: string;
	providerPrefix: string;
	config: Record<string, JsonValue>;
	/**
	 * Resolve the config to send with each request, replacing the static `config`.
	 *
	 * Plugin providers use this to merge stored credentials in at call time (see
	 * `plugin-provider-credential-resolver`). It is invoked per request rather than once
	 * at construction so a rotated key or a revoked plugin takes effect immediately.
	 * When omitted, the static `config` is sent unchanged.
	 */
	resolveConfig?: () => Promise<Record<string, JsonValue>>;
	modelCatalog:
		| ReadonlyMap<string, ProviderModelDescriptor>
		| ModelCatalog
		| readonly ProviderModelDescriptor[];
	descriptor?: ProviderDescriptor;
}

type JsonObject = Record<string, JsonValue>;
type CanonicalReasoningMetadata = {
	source: string;
	format: string;
	data: JsonValue;
};

type PluginReasoningMetadata = ReasoningProviderMetadata & {
	plugin?: {
		providerTypeId: string;
		source: string;
		format: string;
		data: JsonValue;
	};
};

/**
 * Adapter for executable plugin providers. All history/tool conversion stays in the host and
 * only the deliberately small canonical DTO crosses the RPC boundary.
 */
export class RemoteProviderAdapter implements ProviderAdapter {
	readonly mayLeakXmlToolCalls: boolean;

	private readonly rpc: RemoteProviderRpcClient;
	private readonly providerTypeId: string;
	private readonly providerInstanceId: string;
	private readonly providerPrefix: string;
	private readonly config: Record<string, JsonValue>;
	private readonly resolveConfig?: () => Promise<Record<string, JsonValue>>;
	readonly modelCatalog: ReadonlyMap<string, ProviderModelDescriptor>;
	private activeReasoningSource: string;

	constructor(options: RemoteProviderAdapterOptions) {
		const rpc = options.rpc ?? options.client;
		if (!rpc) throw new TypeError("RemoteProviderAdapter requires an RPC client");
		this.rpc = rpc;
		this.providerTypeId = options.providerTypeId;
		this.providerInstanceId = options.providerInstanceId;
		this.providerPrefix = options.providerPrefix;
		this.config = cloneJson(options.config);
		if (options.resolveConfig) this.resolveConfig = options.resolveConfig;
		this.modelCatalog = normalizeModelCatalog(options.modelCatalog);
		this.activeReasoningSource = this.defaultReasoningSource();
		this.mayLeakXmlToolCalls = options.descriptor?.capabilities.mayLeakXmlToolCalls ?? false;
	}

	formatTools(tools: ResolvedToolDefinition[]): unknown[] {
		return tools.map(
			(tool): ProviderToolDefinition => ({
				name: tool.name,
				description: tool.description,
				inputSchema: cloneJson(resolveToolJsonSchema(tool) as JsonObject),
			}),
		);
	}

	async buildHistory(
		dbMessages: DbMessage[],
		model: string,
		narratorId?: string,
	): Promise<BuiltHistory> {
		const projected = await projectHistory(
			dbMessages,
			{
				strict: hasCredentialBoundReasoning(parseModelId(model).model),
				reasoningSource: this.activeReasoningSource,
			},
			narratorId,
		);
		return {
			history: this.remoteWireHistory(projected.turns),
			replayedInjectionMessageIds: projected.replayedInjectionMessageIds,
		};
	}

	/** Second projection stage for plugin providers: neutral turns → the canonical DTO. */
	private remoteWireHistory(turns: readonly NeutralTurn[]): ProviderMessage[] {
		const history: ProviderMessage[] = [];
		const source = this.activeReasoningSource;
		const image = (resolved: ResolvedImage): ProviderContentBlock => ({
			type: "image",
			mediaType: resolved.mediaType,
			dataBase64: resolved.base64,
		});
		for (const turn of turns) {
			if (turn.kind === "input") {
				for (const item of turn.items) {
					const content = orderUserContent(
						item.text,
						item.images.flatMap((resolved) => (resolved ? [resolved] : [])),
						"after",
					).map(
						(part): ProviderContentBlock =>
							part.type === "text" ? { type: "text", text: part.text } : image(part.image),
					);
					if (content.length) history.push({ role: "user", content });
				}
				continue;
			}
			if (turn.kind === "tool_results") {
				history.push({
					role: "tool",
					content: turn.results.map((result) => ({
						type: "tool_result",
						toolUseId: result.wireId,
						name: result.name,
						content: [{ type: "text", text: result.text }, ...result.images.map(image)],
						isError: result.isError,
					})),
				});
				continue;
			}
			const content: ProviderContentBlock[] = [];
			for (const item of turn.items) {
				switch (item.kind) {
					case "text":
						content.push({ type: "text", text: item.text });
						break;
					case "reasoning": {
						const plugin = item.credentials.plugin;
						const continuation = isCanonicalReasoningMetadata(plugin)
							? compatibleContinuation(plugin, source)
							: undefined;
						if (item.text || continuation)
							content.push({
								type: "reasoning",
								text: item.text,
								...(continuation ? { continuation } : {}),
							});
						break;
					}
					case "redacted_reasoning":
						content.push({
							type: "redacted_reasoning",
							data: item.data,
							...(item.sameSource ? { source } : {}),
						});
						break;
					case "tool_call":
						content.push({
							type: "tool_call",
							toolUseId: item.wireId,
							name: item.name,
							input: cloneJson(item.input as JsonObject),
							...(item.signature?.sameSource
								? {
										continuation: {
											source,
											format: "tool-continuation",
											data: item.signature.value,
										},
									}
								: {}),
						});
						break;
					case "web_search":
						content.push({
							type: "web_search",
							id: item.wireId,
							...(item.query ? { query: item.query } : {}),
							...(item.queries ? { queries: item.queries } : {}),
						});
						break;
					case "image_generation":
						content.push({
							type: "image_generation",
							id: item.wireId,
							...(item.result ? { result: item.result } : {}),
							...(item.revisedPrompt ? { revisedPrompt: item.revisedPrompt } : {}),
						});
						break;
				}
			}
			if (content.length) history.push({ role: "assistant", content });
		}
		return history;
	}

	getActiveReasoningSource(): string {
		return this.activeReasoningSource;
	}

	injectSystemPrompt(
		history: unknown[],
		systemPrompt: string,
		_model: string,
		_locale?: string,
	): void {
		const canonical = history as ProviderMessage[];
		const existing = canonical.find((message) => message.role === "system");
		const content: ProviderContentBlock[] = [{ type: "text", text: systemPrompt }];
		if (existing) {
			existing.content = content;
			return;
		}
		canonical.unshift({ role: "system", content });
	}

	async *chat(params: ChatParams): AsyncGenerator<ParsedStreamEvent> {
		if (params.signal.aborted) throw createAbortError(params.signal.reason);
		// Remote plugins, not the host's canonical DTO, know the actual model input.
		await params.onInputCharacters?.(null);
		const chatParams = await this.buildChatParams(params);
		const operation = await this.rpc.chat(chatParams, {
			signal: params.signal,
		});
		if (params.signal.aborted) {
			await operation.cancel("user_abort").catch(() => undefined);
			throw createAbortError(params.signal.reason);
		}
		const removeAbort = this.listenForAbort(operation, params.signal);
		const dumpTap = this.createDumpTap(params, chatParams);
		let usage: ProviderUsage | undefined;
		let requestStarted = false;
		let cancelled = false;
		try {
			for await (const event of operation.events()) {
				// Dump events are diagnostic side-channel data: they feed the request-dump
				// collector, never the parsed-event stream, and must not mark the request as
				// started or count as visible output.
				if (event.type === "dump.request" || event.type === "dump.response") {
					dumpTap(event);
					continue;
				}
				if (event.type === "request_started") {
					await params.onInputCharacters?.(event.inputCharacters ?? null);
					requestStarted = true;
					if (event.reasoningSource) this.activeReasoningSource = event.reasoningSource;
					params.onRequestStart?.({ credentialId: event.credentialId });
					continue;
				}
				if (!requestStarted && isVisibleEvent(event)) {
					requestStarted = true;
					params.onRequestStart?.();
				}
				let mergedEvent = event;
				if ((event.type === "usage" || event.type === "done") && event.usage) {
					usage = mergeUsage(usage, event.usage);
					mergedEvent = { ...event, usage };
				}
				const mapped = mapStreamEvent(mergedEvent, {
					providerPrefix: this.providerPrefix,
					providerTypeId: this.providerTypeId,
					providerInstanceId: this.providerInstanceId,
					modelId: modelIdFor(params.model, this.providerPrefix),
					activeReasoningSource: this.activeReasoningSource,
				});
				if (mapped === undefined) continue;
				if (mapped === CANCELLED) {
					// A cancelled terminal may be the only (or corrected) billing snapshot.
					if (event.type === "done" && event.usage && usage) yield mapUsage(usage);
					// Drain the RPC generator so its post-done error takes precedence.
					cancelled = true;
					continue;
				}
				yield mapped;
			}
			if (cancelled) throw createAbortError(params.signal.reason);
		} finally {
			removeAbort();
			// Preserve a request that never got a response (e.g. connect failure) so the
			// persisted dump still shows what was sent.
			dumpTap.flush();
		}
	}

	async generate(text: string, model: string): Promise<string> {
		const result = await this.runGenerate({
			model,
			request: { mode: "prompt", text },
		});
		return result.text;
	}

	async generateWithMeta(
		text: string,
		model: string,
		systemInstruction?: string,
		options?: GenerateOptions,
	): Promise<GenerateMetaResult> {
		const result = await this.runGenerate({
			model,
			request: { mode: "prompt", text, ...(systemInstruction ? { systemInstruction } : {}) },
			options,
		});
		// The remote-executor protocol carries no schema constraint, so a
		// requested responseFormat is reported as degraded rather than dropped.
		if (!options?.responseFormat || result.responseFormatDegraded) return result;
		return {
			...result,
			responseFormatDegraded: unsupportedResponseFormatReason("Remote executor"),
		};
	}

	async generateWithHistory(
		systemInstruction: string,
		content: string,
		model: string,
		locale?: string,
		options?: GenerateOptions,
	): Promise<string> {
		const result = await this.runGenerate({
			model,
			request: { mode: "history", systemInstruction, content, ...(locale ? { locale } : {}) },
			options,
		});
		return result.text;
	}

	generateWithHistoryWithMeta(
		systemInstruction: string,
		content: string,
		model: string,
		locale?: string,
		options?: GenerateOptions,
	): Promise<GenerateMetaResult> {
		return this.runGenerate({
			model,
			request: { mode: "history", systemInstruction, content, ...(locale ? { locale } : {}) },
			options,
		});
	}

	/**
	 * Build the consumer for plugin-reported `dump.request` / `dump.response` events.
	 *
	 * Returns a no-op when the loop attached no collector (dump disabled, or the toggle
	 * flipped off mid-session): the events are dropped here while the RPC layer
	 * independently rejects ones the plugin was never invited to send.
	 *
	 * Sanitization is host-owned on purpose — the plugin process holds the credentials
	 * (the host handed them over in `config`), so the exact secret values are known here
	 * and masked out of URLs, headers, and bodies regardless of what the plugin sent.
	 *
	 * Attempt tracking mirrors the collector's model: a `dump.request` carrying
	 * url/headers opens a new upstream attempt, and the first `dump.response` of an
	 * attempt calls `beginResponseAttempt` — so plugins that retry internally produce a
	 * faithful attempt sequence in the recording.
	 */
	private createDumpTap(
		params: ChatParams,
		chatParams: ProviderChatParams,
	): ((event: DumpStreamEvent) => void) & { flush(): void } {
		const noop = Object.assign(() => {}, { flush: () => {} });
		const collector = params.requestDump;
		if (!collector) return noop;

		const maxBytes = chatParams.requestDump?.maxBytes ?? PLUGIN_REQUEST_DUMP_MAX_BYTES;
		const secrets = collectSecretConfigValues(chatParams.config);
		const mask = (text: string): string => maskSecretValues(text, secrets);
		const maskHeaders = (
			headers: Record<string, string> | undefined,
		): Record<string, string> | undefined => {
			const sanitized = sanitizeHeaders(headers);
			if (!sanitized) return undefined;
			return Object.fromEntries(
				Object.entries(sanitized).map(([key, value]) => [key, mask(value)]),
			);
		};

		interface PendingRequest {
			transport?: string;
			url?: string;
			headers?: Record<string, string>;
		}
		let pendingRequest: PendingRequest | null = null;
		let responseOpen = false;
		let responseFailed = false;
		let responseTruncated = false;
		let responseBytes = 0;
		// Delay only a bounded suffix so credentials split across arbitrary plugin
		// chunks are still masked. All other reported bytes reach the worker live.
		const secretTail = Math.min(
			maxBytes,
			Math.max(0, ...secrets.map((secret) => secret.length * 12 + 16)),
		);
		let requestTail = "";
		let responseTail = "";
		const emitBody = (direction: "request" | "response", chunk: string, final = false): void => {
			const pending = mask((direction === "request" ? requestTail : responseTail) + chunk);
			let cut = final ? pending.length : Math.max(0, pending.length - secretTail);
			if (!final && cut > 0 && /[\uD800-\uDBFF]/.test(pending[cut - 1])) cut--;
			const text = pending.slice(0, cut);
			if (direction === "request") requestTail = pending.slice(cut);
			else responseTail = pending.slice(cut);
			if (text)
				collector.frame({
					direction,
					type: "plugin.reported_body",
					text,
					metadata: { source: "plugin-reported", boundary: "sanitized-chunks" },
				});
		};

		// Bodies already reached the recorder as sanitized frames; attempts carry metadata only.
		const buildRequest = (): RecordingAttemptRequest => ({
			transport: pendingRequest?.transport ?? "plugin",
			...(pendingRequest?.url ? { url: pendingRequest.url } : {}),
			...(pendingRequest?.headers ? { headers: pendingRequest.headers } : {}),
		});
		const closeResponse = (complete: boolean): void => {
			if (!responseOpen) return;
			responseOpen = false;
			// Mask the pending tail, not each chunk: plugins choose arbitrary
			// boundaries (including inside escaped secrets). Reset for EVERY retry.
			emitBody("response", "", true);
			collector.finishResponseCapture(complete && !responseFailed && !responseTruncated);
			collector.setResponseMeta({
				bodyBytesReceived: responseBytes,
				...(responseTruncated ? { bodyTruncated: true } : {}),
			});
			responseBytes = 0;
			responseFailed = false;
			responseTruncated = false;
		};
		/** Preserve a request whose response never arrived before starting the next attempt. */
		const preservePendingRequest = (): void => {
			if (!pendingRequest) return;
			emitBody("request", "", true);
			collector.setRequest(buildRequest(), false);
			pendingRequest = null;
		};

		const tap = ((event: DumpStreamEvent): void => {
			collector.frame({
				direction: event.type === "dump.request" ? "request" : "response",
				type: `plugin.${event.type}`,
				...(event.truncated
					? {
							sourceTruncated: isHostTruncatedDump(event) ? ("host" as const) : ("plugin" as const),
						}
					: {}),
				metadata: {
					source: "plugin-reported",
					...(event.type === "dump.request" && event.url ? { url: mask(event.url) } : {}),
					...(event.headers ? { headers: maskHeaders(event.headers) } : {}),
					...(event.truncated ? { truncated: true } : {}),
				},
			});
			if (event.type === "dump.request") {
				const opensAttempt =
					event.transport !== undefined || event.url !== undefined || event.headers !== undefined;
				if (opensAttempt) {
					closeResponse(false);
					preservePendingRequest();
					pendingRequest = {
						...(event.transport ? { transport: mask(event.transport) } : {}),
						...(event.url ? { url: mask(event.url) } : {}),
						...(event.headers ? { headers: maskHeaders(event.headers) } : {}),
					};
				}
				if (event.bodyChunk) emitBody("request", event.bodyChunk);
				return;
			}
			// dump.response
			if (!responseOpen) {
				responseOpen = true;
				responseFailed = false;
				emitBody("request", "", true);
				collector.beginResponseAttempt(buildRequest(), false);
				pendingRequest = null;
				collector.setResponseMeta({
					...(event.status !== undefined ? { status: event.status } : {}),
					...(event.headers ? { headers: maskHeaders(event.headers) } : {}),
				});
			}
			if (event.bodyChunk) {
				responseBytes += Buffer.byteLength(event.bodyChunk);
				emitBody("response", event.bodyChunk);
			}
			if (event.truncated) responseTruncated = true;
			if (event.error) {
				responseFailed = true;
				collector.setResponseError(mask(event.error));
			}
			if (event.final) closeResponse(!event.truncated);
		}) as ((event: DumpStreamEvent) => void) & { flush(): void };
		tap.flush = (): void => {
			closeResponse(false);
			preservePendingRequest();
		};
		return tap;
	}

	private async buildChatParams(params: ChatParams): Promise<ProviderChatParams> {
		const history = canonicalHistory(params.history, this.activeReasoningSource);
		const toolResults = params.toolResults
			.map(canonicalizeToolResult)
			.filter(isProviderContentBlock);
		let currentText = params.content;
		let currentImages = (params.images ?? []).map((image) => ({
			mediaType: mediaTypeFor(image.format),
			dataBase64: image.base64,
		}));
		// The projected history already ends with the current turn. Plugins expect it in
		// `current`, so the trailing user or tool message moves there.
		if (!currentText && !currentImages.length && !toolResults.length) {
			const last = history.at(-1);
			if (last?.role === "tool") {
				history.pop();
				toolResults.push(...last.content.filter((block) => block.type === "tool_result"));
			} else if (last?.role === "user") {
				history.pop();
				currentText = last.content
					.flatMap((block) =>
						block.type === "text" && typeof block.text === "string" ? [block.text] : [],
					)
					.join("");
				currentImages = last.content.flatMap((block) =>
					block.type === "image" &&
					typeof block.mediaType === "string" &&
					typeof block.dataBase64 === "string"
						? [{ mediaType: block.mediaType, dataBase64: block.dataBase64 }]
						: [],
				);
			}
		}
		return {
			...(await this.baseParams(params.model)),
			conversation: {
				conversationId: params.conversationId,
				...(params.stickySessionKey ? { stickySessionKey: params.stickySessionKey } : {}),
				...(params.resetUpstreamSession ? { resetUpstreamSession: true } : {}),
			},
			// The hint's presence doubles as protocol negotiation: a plugin may emit
			// dump.request/dump.response events only for calls that carry it, so hosts
			// predating those event types never receive one. `maxBytes` is a separate
			// diagnostic retention ceiling, never model-output admission.
			...(params.requestDump
				? {
						requestDump: {
							maxBytes: PLUGIN_REQUEST_DUMP_MAX_BYTES,
						},
					}
				: {}),
			request: {
				history,
				current: {
					text: currentText,
					...(currentImages.length ? { images: currentImages } : {}),
					toolResults,
				},
				tools: canonicalTools(params.tools),
				...(params.reasoningEffort || params.serviceTier || params.metadata
					? {
							options: {
								...(params.reasoningEffort ? { reasoningEffort: params.reasoningEffort } : {}),
								...(params.serviceTier ? { serviceTier: params.serviceTier } : {}),
								...(params.metadata ? { metadata: safeJsonObject(params.metadata) } : {}),
							},
						}
					: {}),
			},
		};
	}

	/**
	 * Async because `resolveConfig` may read stored credentials. Both call sites are
	 * already inside async request paths, so this adds no new suspension point; a
	 * resolver failure surfaces as the request's own error rather than being swallowed
	 * into a silently unauthenticated call.
	 */
	private async baseParams(
		model: string,
	): Promise<
		Pick<
			ProviderChatParams,
			"providerTypeId" | "providerInstanceId" | "providerPrefix" | "config" | "modelId"
		>
	> {
		const config = this.resolveConfig
			? cloneJson(await this.resolveConfig())
			: cloneJson(this.config);
		return {
			providerTypeId: this.providerTypeId,
			providerInstanceId: this.providerInstanceId,
			providerPrefix: this.providerPrefix,
			config,
			modelId: modelIdFor(model, this.providerPrefix),
		};
	}

	private async runGenerate(input: {
		model: string;
		request: ProviderGenerateParams["request"];
		options?: GenerateOptions;
	}): Promise<GenerateMetaResult> {
		if (input.options?.signal?.aborted) throw createAbortError(input.options.signal.reason);
		const operation = await this.rpc.generate(
			{
				...(await this.baseParams(input.model)),
				request: cloneJson(input.request),
				...(input.options?.reasoningEffort
					? { options: { reasoningEffort: input.options.reasoningEffort } }
					: {}),
			},
			{ signal: input.options?.signal },
		);
		if (input.options?.signal?.aborted) {
			await operation.cancel("user_abort").catch(() => undefined);
			throw createAbortError(input.options.signal.reason);
		}
		const removeAbort = this.listenForAbort(operation, input.options?.signal);
		let text = "";
		let usage: ProviderUsage | undefined;
		let credentialId: string | undefined;
		let cancelled = false;
		try {
			for await (const event of operation.events()) {
				if (event.type.startsWith("tool_call.")) {
					throw new Error("provider.generate emitted a tool event");
				}
				switch (event.type) {
					case "request_started":
						credentialId = event.credentialId;
						if (event.reasoningSource) this.activeReasoningSource = event.reasoningSource;
						break;
					case "text.delta":
						text += event.text;
						await input.options?.onTextDelta?.(event.text);
						break;
					case "usage":
						usage = mergeUsage(usage, event.usage);
						break;
					case "error":
						throw operationError(event.error, {
							providerPrefix: this.providerPrefix,
							providerTypeId: this.providerTypeId,
							providerInstanceId: this.providerInstanceId,
							modelId: modelIdFor(input.model, this.providerPrefix),
							activeReasoningSource: this.activeReasoningSource,
						});
					case "done":
						if (event.status === "cancelled") {
							// Cancellation can precede the RPC generator's original failure.
							cancelled = true;
							break;
						}
						if (event.status === "failed") {
							throw new Error(`Provider generation failed (${event.stopReason})`);
						}
						if (event.usage) usage = mergeUsage(usage, event.usage);
						return buildGenerateMeta(text, usage, credentialId);
					case "reasoning.delta":
						// Surfaced so lightweight callers can show a "thinking" progress
						// phase; the text itself is not part of the generate result.
						await input.options?.onReasoningDelta?.(event.text);
						break;
					case "reasoning.metadata":
					case "reasoning.redacted":
						break;
				}
			}
		} finally {
			removeAbort();
		}
		if (cancelled) throw createAbortError(input.options?.signal?.reason);
		throw new Error("Provider generation ended without a done event");
	}

	private listenForAbort(operation: ProviderOperation, signal?: AbortSignal): () => void {
		if (!signal) return () => undefined;
		const abort = () => {
			void operation.cancel("user_abort");
		};
		signal.addEventListener("abort", abort, { once: true });
		return () => signal.removeEventListener("abort", abort);
	}

	private defaultReasoningSource(): string {
		return `plugin:${this.providerTypeId}:${this.providerInstanceId}`;
	}
}

const CANCELLED = Symbol("cancelled");

function mapStreamEvent(
	event: ProviderStreamEvent,
	context: {
		providerPrefix: string;
		providerTypeId: string;
		providerInstanceId: string;
		modelId: string;
		activeReasoningSource: string;
	},
): ParsedStreamEvent | typeof CANCELLED | undefined {
	switch (event.type) {
		case "content.boundary":
			return {
				contentBoundary: {
					kind: event.kind,
					phase: event.phase,
					blockId: event.blockId,
					outputIndex: event.outputIndex,
				},
			};
		case "text.delta":
			return { text: event.text, textOutputIndex: event.outputIndex, textBlockId: event.blockId };
		case "text.citation":
			// Schema-level bounds already applied; the loop normalizes and drops
			// anything that does not resolve against the cleaned text.
			return {
				textCitations: event.citations.map((citation) => ({ ...citation })),
				textBlockId: event.blockId,
			};
		case "reasoning.delta":
			return {
				reasoning: event.text,
				reasoningBlockId: event.blockId,
				reasoningOutputIndex: event.outputIndex,
				...(event.metadata
					? { reasoningMetadata: mapReasoningMetadata(event.metadata, context) }
					: {}),
			};
		case "reasoning.metadata":
			return {
				reasoningBlockId: event.blockId,
				reasoningOutputIndex: event.outputIndex,
				reasoningMetadata: mapReasoningMetadata(event.metadata, context),
			};
		case "reasoning.redacted":
			return {
				redactedThinking: { data: event.data, outputIndex: event.outputIndex },
			};
		case "tool_call.start":
			return {
				toolUseChunk: {
					toolUseId: event.toolUseId,
					name: event.name,
					input: "",
					outputIndex: event.outputIndex,
				},
			};
		case "tool_call.delta":
			return { toolUseChunk: { toolUseId: event.toolUseId, input: event.argumentsDelta } };
		case "tool_call.end":
			return { toolUseChunk: { toolUseId: event.toolUseId, stop: true } };
		case "tool_call.complete":
			return {
				toolUses: [
					{
						toolUseId: event.toolUseId,
						name: event.name,
						input: event.input,
						...(event.outputIndex === undefined ? {} : { outputIndex: event.outputIndex }),
					},
				],
			};
		case "usage":
			return mapUsage(event.usage);
		case "error":
			return { invalidState: mapInvalidState(event.error, context) };
		case "done":
			if (event.status === "cancelled") return CANCELLED;
			return mapDone(event, context);
		case "request_started":
			return undefined;
	}
}

function mapDone(
	event: Extract<ProviderStreamEvent, { type: "done" }>,
	context: Parameters<typeof mapStreamEvent>[1],
): ParsedStreamEvent | undefined {
	const usage = event.usage ? mapUsage(event.usage) : undefined;
	const result: ParsedStreamEvent = {
		...(event.messageId ? { messageId: event.messageId } : {}),
		...(event.conversationId ? { conversationId: event.conversationId } : {}),
		...(event.responseId ? { responseId: event.responseId } : {}),
		...(event.credentialId ? { credentialId: event.credentialId } : {}),
		stopReason: event.stopReason,
		...(usage?.usage ? { usage: usage.usage } : {}),
		...(usage?.contextUsagePercentage === undefined
			? {}
			: { contextUsagePercentage: usage.contextUsagePercentage }),
		...(usage?.metering ? { metering: usage.metering } : {}),
	};
	if (event.stopReason === "max_output_tokens") {
		result.invalidState = {
			reason: "max_output_tokens",
			message: "Provider output reached the maximum token limit",
			diagnostics: diagnosticsFor(
				{
					classification: "api",
					code: "max_output_tokens",
					message: "Provider output reached the maximum token limit",
				},
				context,
			),
		};
	} else if (event.status === "failed" && event.stopReason !== "cancelled") {
		result.invalidState = {
			reason: "provider_failed",
			message: `Provider operation failed (${event.stopReason})`,
			diagnostics: diagnosticsFor(
				{
					classification: "api",
					code: event.stopReason,
					message: `Provider operation failed (${event.stopReason})`,
				},
				context,
			),
		};
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

function mergeUsage(previous: ProviderUsage | undefined, update: ProviderUsage): ProviderUsage {
	const merged = { ...previous, ...update };
	if (update.promptTokens === 0 && (previous?.promptTokens ?? 0) > 0) {
		merged.promptTokens = previous?.promptTokens;
	}
	// An old net counter must not survive a correction to its prompt/cache buckets.
	// A freshly reported inputTokens (including zero) remains authoritative.
	if (
		merged.promptTokens !== undefined &&
		update.inputTokens === undefined &&
		((update.promptTokens ?? 0) > 0 ||
			update.cachedInputTokens !== undefined ||
			update.cacheCreationInputTokens !== undefined ||
			update.cacheCreation5mTokens !== undefined ||
			update.cacheCreation1hTokens !== undefined)
	) {
		delete merged.inputTokens;
	}
	return merged;
}

function mapUsage(usage: ProviderUsage): ParsedStreamEvent {
	return {
		usage: {
			...(usage.promptTokens === undefined && usage.inputTokens === undefined
				? {}
				: {
						promptTokens:
							usage.promptTokens ??
							(usage.inputTokens ?? 0) + (usage.cachedInputTokens ?? 0) + cacheWriteTokens(usage),
					}),
			...(usage.inputTokens === undefined && usage.promptTokens === undefined
				? {}
				: { inputTokens: netInputTokens(usage) }),
			...(usage.completionTokens === undefined ? {} : { completionTokens: usage.completionTokens }),
			...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
			...(usage.cachedInputTokens === undefined
				? {}
				: { cachedInputTokens: usage.cachedInputTokens }),
			...(usage.cacheCreationInputTokens === undefined &&
			usage.cacheCreation5mTokens === undefined &&
			usage.cacheCreation1hTokens === undefined
				? {}
				: { cacheCreationInputTokens: cacheWriteTokens(usage) }),
			...(usage.cacheCreation5mTokens === undefined
				? {}
				: { cacheCreation5mTokens: usage.cacheCreation5mTokens }),
			...(usage.cacheCreation1hTokens === undefined
				? {}
				: { cacheCreation1hTokens: usage.cacheCreation1hTokens }),
			...(usage.contextWindow === undefined ? {} : { contextWindow: usage.contextWindow }),
		},
		...(usage.contextUsagePercentage === undefined
			? {}
			: { contextUsagePercentage: usage.contextUsagePercentage }),
		...(usage.metering ? { metering: usage.metering } : {}),
	};
}

function mapReasoningMetadata(
	metadata: CanonicalReasoningMetadata,
	context: Parameters<typeof mapStreamEvent>[1],
): ReasoningProviderMetadata {
	const plugin: PluginReasoningMetadata["plugin"] = {
		providerTypeId: context.providerTypeId,
		source: metadata.source,
		format: metadata.format,
		data: cloneJson(metadata.data),
	};
	return {
		signatureSource: metadata.source,
		plugin,
	} as ReasoningProviderMetadata;
}

function mapInvalidState(
	error: Extract<ProviderStreamEvent, { type: "error" }>["error"],
	context: Parameters<typeof mapStreamEvent>[1],
): NonNullable<ParsedStreamEvent["invalidState"]> {
	return {
		reason: error.reason ?? error.code,
		message: error.message,
		diagnostics: diagnosticsFor(error, context),
	};
}

function diagnosticsFor(
	error: {
		classification: string;
		code: string;
		message: string;
		reason?: string;
		statusCode?: number;
		retryable?: boolean;
		phase?: string;
		requestId?: string;
		providerRequestId?: string;
		responseSnippet?: string;
		responseHeaders?: Record<string, string>;
	},
	context: Parameters<typeof mapStreamEvent>[1],
): ApiRequestDiagnostics {
	return {
		schema: "narrafork.error-diagnostics.v1",
		source: error.classification === "protocol" ? "parser" : "provider",
		phase: error.phase,
		statusCode: error.statusCode,
		code: error.code,
		reason: error.reason,
		message: error.message,
		requestId: error.requestId,
		providerRequestId: error.providerRequestId,
		provider: context.providerPrefix,
		model: `${context.providerPrefix}:${context.modelId}`,
		transport: "plugin-stdio",
		retryable: error.retryable,
		responseHeaders: error.responseHeaders ? { ...error.responseHeaders } : undefined,
		responseSnippet: error.responseSnippet,
	};
}

function operationError(
	error: Extract<ProviderStreamEvent, { type: "error" }>["error"],
	context: Parameters<typeof mapStreamEvent>[1],
): Error {
	const mapped = mapInvalidState(error, context);
	const result = new Error(mapped.message);
	result.name = "RemoteProviderError";
	Object.defineProperty(result, "diagnostics", { value: mapped.diagnostics, enumerable: true });
	return result;
}

function canonicalTools(tools: unknown[]): ProviderToolDefinition[] {
	return tools.flatMap((tool) => {
		if (!tool || typeof tool !== "object") return [];
		const record = tool as Record<string, unknown>;
		const name = typeof record.name === "string" ? record.name : undefined;
		if (!name) return [];
		const description = typeof record.description === "string" ? record.description : "";
		const functionRecord =
			record.function && typeof record.function === "object"
				? (record.function as Record<string, unknown>)
				: undefined;
		const functionParameters = functionRecord?.parameters;
		const inputSchema =
			(isJsonObject(record.inputSchema) && record.inputSchema) ||
			(isJsonObject(record.parameters) && record.parameters) ||
			(isJsonObject(functionParameters) && functionParameters) ||
			{};
		return [{ name, description, inputSchema: cloneJson(inputSchema as JsonObject) }];
	});
}

function canonicalHistory(history: unknown[], reasoningSource: string): ProviderMessage[] {
	return history.flatMap((entry) => {
		if (!entry || typeof entry !== "object") return [];
		const record = entry as Record<string, unknown>;
		const role = canonicalRole(record.role);
		if (!role || !Array.isArray(record.content)) return [];
		const content = record.content.flatMap((block) => {
			const canonical = canonicalizeContentBlock(block, reasoningSource);
			return canonical ? [canonical] : [];
		});
		if (content.length === 0) return [];
		return [
			{
				role,
				content,
				...(typeof record.messageId === "string" ? { messageId: record.messageId } : {}),
			},
		];
	});
}

function canonicalizeToolResult(value: unknown): ProviderContentBlock | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	if (record.type === "tool_result") {
		const toolUseId = typeof record.toolUseId === "string" ? record.toolUseId : undefined;
		if (!toolUseId) return undefined;
		const content = canonicalToolResultContent(record.content);
		return {
			type: "tool_result",
			toolUseId,
			...(typeof record.name === "string" ? { name: record.name } : {}),
			content,
			isError: record.isError === true,
		};
	}
	const toolUseId =
		(typeof record.toolUseId === "string" && record.toolUseId) ||
		(typeof record.tool_call_id === "string" && record.tool_call_id) ||
		(typeof record.call_id === "string" && record.call_id);
	if (!toolUseId) return undefined;
	const content = canonicalToolResultContent(record.content ?? record.output);
	return {
		type: "tool_result",
		toolUseId,
		...(typeof record.name === "string" ? { name: record.name } : {}),
		content,
		isError: record.isError === true || record.is_error === true,
	};
}

function canonicalToolResultContent(value: unknown): ProviderContentBlock[] {
	if (Array.isArray(value)) {
		const result: ProviderContentBlock[] = [];
		for (const entry of value) {
			if (!entry || typeof entry !== "object") continue;
			const record = entry as Record<string, unknown>;
			if (record.type === "text" && typeof record.text === "string") {
				result.push({ type: "text", text: record.text });
				continue;
			}
			if (record.type === "image") {
				const mediaType = typeof record.mediaType === "string" ? record.mediaType : undefined;
				const dataBase64 = typeof record.dataBase64 === "string" ? record.dataBase64 : undefined;
				if (mediaType && dataBase64) result.push({ type: "image", mediaType, dataBase64 });
			}
		}
		if (result.length > 0) return result;
	}
	return [{ type: "text", text: typeof value === "string" ? value : outputText(value) }];
}

function canonicalizeContentBlock(
	value: unknown,
	reasoningSource: string,
): ProviderContentBlock | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const type = typeof record.type === "string" ? record.type : undefined;
	if (type === "text" && typeof record.text === "string" && record.text) {
		return withOptionalIndex(
			{ type: "text", text: record.text },
			optionalIndex(record.outputIndex),
		);
	}
	if (
		(type === "reasoning" || type === "thinking") &&
		typeof (record.text ?? record.thinking) === "string"
	) {
		const text = String(record.text ?? record.thinking);
		const continuation = continuationFromStoredBlock(record, reasoningSource);
		if (!text && !continuation) return undefined;
		return withOptionalIndex(
			{ type: "reasoning", text, ...(continuation ? { continuation } : {}) },
			optionalIndex(record.outputIndex),
		);
	}
	if (type === "redacted_thinking" || type === "redacted_reasoning") {
		if (typeof record.data !== "string" || !record.data) return undefined;
		const source =
			typeof record.signatureSource === "string" && record.signatureSource === reasoningSource
				? record.signatureSource
				: undefined;
		return withOptionalIndex(
			{
				type: "redacted_reasoning",
				data: record.data,
				...(source ? { source } : {}),
			},
			optionalIndex(record.outputIndex),
		);
	}
	if (type === "image") {
		const mediaType =
			typeof record.mediaType === "string"
				? record.mediaType
				: typeof record.format === "string"
					? mediaTypeFor(record.format)
					: undefined;
		const dataBase64 =
			typeof record.dataBase64 === "string"
				? record.dataBase64
				: typeof record.base64 === "string"
					? record.base64
					: undefined;
		if (!mediaType || !dataBase64) return undefined;
		return { type: "image", mediaType, dataBase64 };
	}
	if (type === "tool_use" || type === "tool_call") {
		const toolUseId =
			(typeof record.toolUseId === "string" && record.toolUseId) ||
			(typeof record.id === "string" && record.id);
		const name = typeof record.name === "string" ? record.name : undefined;
		if (!toolUseId || !name) return undefined;
		const continuation =
			typeof record.thoughtSignature === "string" &&
			record.thoughtSignatureSource === reasoningSource
				? { source: reasoningSource, format: "tool-continuation", data: record.thoughtSignature }
				: isJsonValue(record.continuation)
					? record.continuation
					: undefined;
		return withOptionalIndex(
			{
				type: "tool_call",
				toolUseId,
				name,
				input: parseJsonObject(record.input),
				...(continuation ? { continuation } : {}),
			},
			optionalIndex(record.outputIndex),
		);
	}
	if (type === "tool_result") return canonicalizeToolResult(value);
	if (type === "web_search" && typeof record.id === "string") {
		return withOptionalIndex(
			{
				type: "web_search",
				id: record.id,
				...(typeof record.query === "string" ? { query: record.query } : {}),
				...(stringArray(record.queries) ? { queries: stringArray(record.queries) } : {}),
			},
			optionalIndex(record.outputIndex),
		);
	}
	if (type === "image_generation" && typeof record.id === "string") {
		return withOptionalIndex(
			{
				type: "image_generation",
				id: record.id,
				...(typeof record.result === "string" ? { result: record.result } : {}),
				...(typeof record.revisedPrompt === "string"
					? { revisedPrompt: record.revisedPrompt }
					: {}),
			},
			optionalIndex(record.outputIndex),
		);
	}
	return undefined;
}

function continuationFromStoredBlock(
	block: Record<string, unknown>,
	reasoningSource: string,
): CanonicalReasoningMetadata | undefined {
	if (isCanonicalReasoningMetadata(block.continuation)) {
		return compatibleContinuation(block.continuation, reasoningSource);
	}
	const metadata = block.providerMetadata;
	if (!metadata || typeof metadata !== "object") return undefined;
	const record = metadata as Record<string, unknown>;
	if (isCanonicalReasoningMetadata(record.plugin)) {
		return compatibleContinuation(record.plugin, reasoningSource);
	}
	return undefined;
}

function compatibleContinuation(
	metadata: CanonicalReasoningMetadata,
	reasoningSource: string,
): CanonicalReasoningMetadata | undefined {
	if (metadata.source !== reasoningSource) return undefined;
	return { source: metadata.source, format: metadata.format, data: cloneJson(metadata.data) };
}

function isCanonicalReasoningMetadata(value: unknown): value is CanonicalReasoningMetadata {
	return (
		!!value &&
		typeof value === "object" &&
		typeof (value as Record<string, unknown>).source === "string" &&
		typeof (value as Record<string, unknown>).format === "string" &&
		isJsonValue((value as Record<string, unknown>).data)
	);
}

function canonicalRole(role: DbMessage["role"] | unknown): ProviderMessage["role"] | undefined {
	if (role === "assistant") return "assistant";
	if (role === "system") return "system";
	if (role === "tool") return "tool";
	if (role === "user" || role === "sys") return "user";
	return undefined;
}

function buildGenerateMeta(
	text: string,
	usage: ProviderUsage | undefined,
	credentialId: string | undefined,
): GenerateMetaResult {
	return {
		text,
		contextPercent: usage?.contextUsagePercentage,
		usage: usageToUsageData(usage),
		credentialId,
		meterUsage: usage?.metering?.usage,
		meterUnit: usage?.metering?.unit,
	};
}

function cacheWriteTokens(usage: ProviderUsage): number {
	return Math.max(
		usage.cacheCreationInputTokens ?? 0,
		(usage.cacheCreation5mTokens ?? 0) + (usage.cacheCreation1hTokens ?? 0),
	);
}

function netInputTokens(usage: ProviderUsage): number {
	// Plugin inputTokens 遵循内部净输入契约；promptTokens 则是含缓存读写的完整输入。
	return (
		usage.inputTokens ??
		Math.max(
			(usage.promptTokens ?? 0) - (usage.cachedInputTokens ?? 0) - cacheWriteTokens(usage),
			0,
		)
	);
}

function usageToUsageData(usage: ProviderUsage | undefined): GenerateMetaResult["usage"] {
	if (!usage) return null;
	if (
		usage.inputTokens === undefined &&
		usage.promptTokens === undefined &&
		usage.completionTokens === undefined &&
		usage.cachedInputTokens === undefined &&
		usage.cacheCreationInputTokens === undefined &&
		usage.cacheCreation5mTokens === undefined &&
		usage.cacheCreation1hTokens === undefined
	) {
		return null;
	}
	return {
		inputTokens: netInputTokens(usage),
		outputTokens: usage.completionTokens ?? 0,
		cachedInputTokens: usage.cachedInputTokens ?? 0,
		cacheCreationInputTokens: cacheWriteTokens(usage),
		cacheCreation5mInputTokens: usage.cacheCreation5mTokens ?? 0,
		cacheCreation1hInputTokens: usage.cacheCreation1hTokens ?? 0,
		reasoningTokens: usage.reasoningTokens ?? 0,
	};
}

function normalizeModelCatalog(
	catalog: RemoteProviderAdapterOptions["modelCatalog"],
): ReadonlyMap<string, ProviderModelDescriptor> {
	if (
		catalog &&
		typeof (catalog as ReadonlyMap<string, ProviderModelDescriptor>).get === "function"
	) {
		return new Map(catalog as ReadonlyMap<string, ProviderModelDescriptor>);
	}
	if (Array.isArray(catalog)) return new Map(catalog.map((model) => [model.id, model]));
	return new Map((catalog as ModelCatalog).models.map((model) => [model.id, model]));
}

function modelIdFor(model: string, providerPrefix: string): string {
	const prefix = `${providerPrefix}:`;
	return model.startsWith(prefix) ? model.slice(prefix.length) : model;
}

function defaultReasoningSourceFor(providerTypeId: string, providerInstanceId: string): string {
	return `plugin:${providerTypeId}:${providerInstanceId}`;
}

function mediaTypeFor(format: string): string {
	return format.includes("/") ? format : `image/${format}`;
}

function withOptionalIndex<T extends JsonObject>(value: T, outputIndex: number | undefined): T {
	return outputIndex === undefined ? value : ({ ...value, outputIndex } as T);
}

function optionalIndex(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function jsonObject(value: unknown): JsonObject {
	return isJsonObject(value) ? cloneJson(value) : {};
}

function parseJsonObject(value: unknown): JsonObject {
	if (typeof value === "string") {
		try {
			const parsed: unknown = JSON.parse(value);
			return jsonObject(parsed);
		} catch {
			return {};
		}
	}
	return jsonObject(value);
}

function safeJsonObject(value: Record<string, unknown>): JsonObject {
	return jsonObject(value);
}

function outputText(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === undefined || value === null) return "";
	try {
		return JSON.stringify(toJsonValue(value)) ?? "";
	} catch {
		return String(value);
	}
}

function stringArray(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((item) => typeof item === "string")
		? [...value]
		: undefined;
}

function isProviderContentBlock(
	value: ProviderContentBlock | undefined,
): value is ProviderContentBlock {
	return value !== undefined;
}

function isJsonObject(value: unknown): value is JsonObject {
	return isJsonValue(value) && typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJsonValue);
	if (typeof value !== "object") return false;
	return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function toJsonValue(value: unknown): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (Array.isArray(value)) return value.map(toJsonValue);
	if (typeof value === "object" && value !== null) {
		const result: JsonObject = {};
		for (const [key, nested] of Object.entries(value)) {
			if (nested === undefined || typeof nested === "function" || typeof nested === "bigint")
				continue;
			result[key] = toJsonValue(nested);
		}
		return result;
	}
	return String(value);
}

function cloneJson<T extends JsonValue>(value: T): T {
	return structuredClone(value);
}

function isVisibleEvent(event: ProviderStreamEvent): boolean {
	return (
		event.type === "text.delta" ||
		event.type === "reasoning.delta" ||
		event.type === "reasoning.metadata" ||
		event.type === "reasoning.redacted" ||
		event.type === "tool_call.start" ||
		event.type === "tool_call.complete"
	);
}

function createAbortError(reason?: unknown): Error {
	const error = new Error(reason instanceof Error ? reason.message : "The operation was aborted");
	error.name = "AbortError";
	return error;
}

// Keep this helper used by callers that inspect the stable source without a constructed adapter.
export function remoteProviderReasoningSource(
	providerTypeId: string,
	providerInstanceId: string,
): string {
	return defaultReasoningSourceFor(providerTypeId, providerInstanceId);
}

export type { JsonValue };
