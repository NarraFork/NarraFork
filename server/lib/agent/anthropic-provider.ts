import { createHash, randomUUID } from "node:crypto";
import { outputToText } from "@shared/agent-protocol/tool-output";
import { modelTextFromContentBlocks } from "@shared/native-injection";
import { hasCredentialBoundReasoning } from "@shared/reasoning-credentials";
import { clampReasoningEffort, type ReasoningEffort } from "@shared/reasoning-effort";
import {
	claudeVersionAtLeast,
	modelAcceptsReasoningEffort,
	parseClaudeModel,
} from "@shared/reasoning-effort-support";
import { computeFingerprint } from "../fingerprint";
import { getClaudeDeviceId } from "../installation-id";
import { logger } from "../logger";
import { resolveProxyForUrl } from "../net/proxy";
import { getToolMessage, type Locale } from "../prompt-i18n";
import type { AnthropicProviderConfig } from "../settings";
import {
	getReasoningEffortBlocklist,
	getSettingsRevision,
	parseModelId,
	resolveModelContextWindow,
	settings,
} from "../settings";
import { readWithTimeout } from "../stream-timeout";
import { getImagePath, imageToBase64 } from "../uploads";
import { extractAnthropicUsage } from "../usage-tracking";
import {
	CLAUDE_CLI_VERSION,
	getHttpClaudeCliUserAgent,
	mergeExtraHeaders,
	resolveHttpUserAgent,
} from "../user-agent";
import { fetchWithNetworkDiagnostics } from "./diagnostic-fetch";
import { parseErrorDiagnostics } from "./error-diagnostics";
import {
	isCompletionLimitReason,
	isConnectionClosedError,
	ProviderInvalidStateError,
} from "./error-handling";
import { isGatewayEventType, parseGatewayDataEvent, parseGatewaySSEEvent } from "./gateway-events";
import { buildOpencodeSessionHeader } from "./opencode-session";
import type {
	ChatParams,
	DbMessage,
	GenerateMetaResult,
	GenerateOptions,
	ParsedStreamEvent,
	ProviderAdapter,
} from "./provider";
import {
	assertModelInputModalities,
	effectiveProviderMetadata,
	resolveMetadataReasoning,
	resolveOutputTokenLimit,
} from "./provider-model-metadata";
import { signatureSourcesCompatible } from "./reasoning-source";
import { sanitizeHeaders } from "./request-dump";
import { parseJsonResponseWithBody } from "./response-body";
import { ToolInputStream, toolInputStreamFor } from "./tool-input-stream";
import { resolveToolJsonSchema } from "./tool-registry";
import {
	type AgentToolUse,
	ApiError,
	isDeepSeekModel,
	mapDeepSeekEffort,
	type ResolvedToolDefinition,
} from "./types";

// === Claude Code protocol constants ===

/** Maximum number of server-side web searches per API call. */
const WEB_SEARCH_MAX_USES = 8;

/** Output budget for the one-shot web-search side request. */
const WEB_SEARCH_MAX_TOKENS = 8192;

/**
 * Official Claude Code chat beta flags, in the order the CLI emits them.
 *
 * Derived from `claude-cli` 2.1.251's own beta assembly (a model-level set, a
 * request-level set, and per-attempt pushes inside the retry closure), not from
 * a single capture: the CLI decides each flag PER MODEL, so a fixed string
 * necessarily claims betas the real client would not send for the model in hand.
 * Each entry below repeats the upstream predicate it is gated on. All nine were
 * re-checked against 2.1.251's beta registry — none was renamed or retired.
 *
 * Flags the CLI can also send but NarraFork never earns are omitted, because a
 * beta declares a capability the client must actually implement:
 *   - `oauth-2025-04-20` — only for OAuth-token auth.
 *   - `advanced-tool-use-2025-11-20` / `tool-search-tool-2025-10-19` — tool search.
 *   - `structured-outputs-2025-12-15` — only with an `output_config.format` schema.
 *   - `advisor-tool-2026-03-01`, `fast-mode-2026-02-01`, `afk-mode-2026-01-31`,
 *     `extended-cache-ttl-2025-04-11`, `prompt-caching-evict-2026-05-12`,
 *     `cache-diagnosis-2026-04-07`, `context-hint-2026-04-09`,
 *     `task-budgets-2026-03-13`, `per-turn-control-2026-07-01` — feature-gated.
 *   - `fallback-credit-2026-06-01` — upstream pushes it only once the
 *     fallback-credit lane is armed, i.e. after a server-side fallback minted a
 *     credit token this client would have to echo back. NarraFork never mints or
 *     echoes one, so declaring it described a lane we cannot use.
 *
 * Three betas new in 2.1.251 are withheld for the same reason:
 *   - `auto-mode-classifier-2026-07-16` — assembled by a separate helper used
 *     only for the security-classifier side request, never for `/v1/messages`.
 *   - `thinking-display-updates-2026-08-18` — needs a first-party backend on the
 *     official host plus an enabled feature flag, and turning it on also forces
 *     `thinking.display = "updates"` and removes `redact-thinking`.
 *   - `server-side-fallback-2026-07-01` — the category-shaped sibling of
 *     `-2026-06-01` (the two are alternatives, not a rename). Both require a
 *     locally-held fallback plan and the sticky-beta rejection state machine.
 */
function buildAnthropicBetaFlags(model: string): string {
	const flags: string[] = [];
	// `!r.includes("haiku")` — upstream never claims the Claude Code beta on Haiku.
	if (!/haiku/i.test(model)) flags.push("claude-code-20250219");
	// `eE(e)` / `Xti(e)` — only for models whose 1M window NarraFork actually uses,
	// so the declared beta and getAnthropicEffectiveContextWindow cannot disagree.
	if (supportsAnthropic1mContext(model)) flags.push("context-1m-2025-08-07");
	// `yRn(e)` / `VHS(e)` exclude only the Claude 3 family on a first-party
	// backend, which is outside the supported version range.
	flags.push("interleaved-thinking-2025-05-14");
	flags.push("redact-thinking-2026-02-12");
	flags.push("thinking-token-count-2026-05-13");
	flags.push("context-management-2025-06-27");
	// `_mr` — pushed for every first-party request.
	flags.push("prompt-caching-scope-2026-01-05");
	// `mRn(e)` — see supportsMidConversationSystem (Opus 4.7 is excluded).
	if (supportsMidConversationSystem(model)) flags.push("mid-conversation-system-2026-04-07");
	// `EZb` — pushed only for models that accept `output_config.effort`, which now
	// means only the user's own blocklist can withhold it.
	if (supportsEffort(model)) flags.push("effort-2025-11-24");
	return flags.join(",");
}

/**
 * Minimal beta flags for non-official Anthropic-compatible relays.
 * Only the flags required for the effort parameter to be honored — we avoid
 * sending the full Claude-Code-specific flag set (claude-code-*, context-1m,
 * context-management, etc.) to generic relays that may reject unknown betas.
 */
const ANTHROPIC_EFFORT_BETA_FLAGS = "adaptive-thinking-2026-01-28,effort-2025-11-24";

/** Cache control marker for ephemeral prompt caching. */
const CACHE_CONTROL = { cache_control: { type: "ephemeral" as const } };

/** Default Anthropic API base URL (includes /v1 path). */
const DEFAULT_BASE_URL = "https://api.anthropic.com/v1";

/**
 * Process-wide cache of base URLs that have been resolved to need a `/v1`
 * suffix. Keyed by the normalized (trailing-slash-stripped) base URL.
 *
 * AnthropicProvider instances are created fresh per chat turn (see
 * createProviderByName), so an instance-level cache would be lost between
 * messages — every message in a long session would pay the fallback cost
 * (e.g. a multi-second connection RST against the wrong path) again. This
 * module-level cache ensures each base URL only pays that cost once per
 * process. The stored settings revision invalidates the entry if the user
 * later edits provider settings.
 */
const v1FallbackCache = new Map<string, { revision: number }>();

/** Debounce window for the base-URL fix suggestion broadcast (per base URL). */
const BASEURL_FIX_BROADCAST_DEBOUNCE_MS = 30_000;
/** Last broadcast timestamp keyed by normalized base URL. */
const lastBaseUrlFixBroadcast = new Map<string, number>();

/**
 * Broadcast a `provider_baseurl_fix_suggested` event to all WS clients
 * (debounced per base URL). Fired whenever a `/v1` fallback succeeds for a
 * base URL that lacks `/v1`, so the frontend can offer to persist the fix.
 * Lazy-imports narrator-ws to avoid a circular dependency.
 */
async function broadcastBaseUrlFixSuggested(info: {
	providerId: string;
	providerPrefix: string;
	providerName: string;
	currentBaseUrl: string;
	suggestedBaseUrl: string;
}): Promise<void> {
	const now = Date.now();
	const last = lastBaseUrlFixBroadcast.get(info.currentBaseUrl) ?? 0;
	if (now - last < BASEURL_FIX_BROADCAST_DEBOUNCE_MS) return;
	lastBaseUrlFixBroadcast.set(info.currentBaseUrl, now);
	try {
		const { broadcastToAll } = await import("../../websocket/narrator-ws");
		broadcastToAll({ type: "provider_baseurl_fix_suggested", ...info });
	} catch {
		// WS module not loaded yet — ignore
	}
}

/**
 * Derive a stable session UUID from a conversation id.
 *
 * `claude-cli` carries ONE session id for the lifetime of a conversation: the
 * same value goes out as `X-Claude-Code-Session-Id` and as
 * `metadata.user_id.session_id`, and upstream validates the shape with
 * `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`.
 *
 * NarraFork cannot simply hold the id in an instance field, because
 * AnthropicProvider instances are rebuilt every chat turn (see the
 * v1FallbackCache note above). An instance-scoped id therefore changed on every
 * message of a single conversation, which is not just a fidelity problem:
 * Anthropic-facing relays key credential affinity on this value (sticky-session
 * routing reads `metadata.user_id`'s session segment first and returns it as the
 * routing hash), so a per-turn id scattered the turns of one conversation across
 * different upstream credentials and missed the prompt cache each time — the
 * same failure mode documented for the missing `X-Conversation-ID` header.
 *
 * Deriving it from the conversation id keeps it stable without persisting
 * anything. Same construction as the Codex window id (see deriveCodexWindowId):
 * hash, truncate to 16 bytes, then force the RFC 4122 version/variant bits so
 * the result is a well-formed v4 UUID.
 */
function deriveClaudeSessionId(conversationId: string): string {
	const bytes = createHash("sha256")
		.update(`narrafork-claude-session:${conversationId}`)
		.digest()
		.subarray(0, 16);
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Claude Code CLI version reported in the billing block. Shared with the
 * User-Agent builder so the two can never drift apart.
 */
const CC_CLI_VERSION = CLAUDE_CLI_VERSION;

/**
 * Build the billing block that opens the official system array.
 *
 * Format, transcribed from `claude-cli` 2.1.251's attribution-header builder:
 *   `x-anthropic-billing-header: cc_version={version}.{fingerprint}; cc_entrypoint=cli; cch=00000;`
 *
 * The fingerprint is derived from the first *user-authored* text of the
 * conversation, so it is stable for a given conversation but differs between
 * conversations.
 *
 * `cch=00000;` is a LITERAL, not a per-request hash, so it costs nothing in
 * cache stability: the whole block stays byte-identical across every turn of a
 * conversation. Earlier NarraFork releases dropped it on the theory that it
 * varied per request; the upstream source shows the only value it ever takes is
 * `00000`.
 *
 * Upstream gates it on `(backend === "firstParty" && jo()) || backend ===
 * "vertex"`, where `jo()` means "`ANTHROPIC_BASE_URL` is unset or its host is
 * exactly api.anthropic.com". NarraFork deliberately does NOT reproduce that
 * host check, and the reason is the relay case rather than convenience: a relay
 * configured as an official-dialect provider forwards this block verbatim to
 * api.anthropic.com, so what Anthropic receives is a request arriving at its own
 * endpoint — precisely the case where a real CLI does send `cch`. Adding the
 * host gate would strip it exactly where upstream expects it. For a relay
 * fronting a non-Anthropic upstream the segment is inert, so the fidelity gain
 * on the Anthropic path costs nothing elsewhere.
 *
 * Still omitted, because each is conditional on state NarraFork does not have:
 * `cc_workload=` (a workload id), `cc_is_subagent=true` (upstream's own subagent
 * context object), `cc_prev_req=` and `cc_prompt_id=` (upstream request/prompt
 * ids from the previous turn).
 */
function buildBillingBlock(messages: AnthropicMessage[]): string {
	const fingerprint = computeFingerprint(firstUserAuthoredText(messages), CC_CLI_VERSION);
	return `x-anthropic-billing-header: cc_version=${CC_CLI_VERSION}.${fingerprint}; cc_entrypoint=cli; cch=00000;`;
}

/**
 * First user-authored text in the conversation, used as the fingerprint input.
 *
 * Harness-injected `<system-reminder>` blocks are skipped: Claude Code prepends
 * them to the first user turn, and feeding one into the fingerprint yields a
 * value the API does not expect. Verified against two captured requests whose
 * suffixes (`01d`, `45e`) only both reproduce once reminders are skipped.
 */
function firstUserAuthoredText(messages: AnthropicMessage[]): string {
	const firstUser = messages.find((m) => m.role === "user");
	if (!firstUser) return "";
	const content = firstUser.content;
	if (typeof content === "string") {
		// History rebuilt from the DB joins the original blocks into one string,
		// folding any reminder in with the user text. Strip reminder spans so the
		// fingerprint matches the live-session array path (which skips the
		// reminder block and returns the user block verbatim).
		if (!content.includes("<system-reminder>")) return content;
		return content.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trimStart();
	}
	for (const block of content) {
		if (block.type !== "text" || typeof block.text !== "string") continue;
		if (block.text.includes("<system-reminder>")) continue;
		return block.text;
	}
	return "";
}

/** Identity block injected as the second system block (matches Claude Code). */
const IDENTITY_BLOCK = "You are Claude Code, Anthropic's official CLI for Claude.";

/**
 * `X-Stainless-OS` value, reported the way the Stainless SDK does it — from the
 * host platform rather than a fixed string, so the telemetry stays self-consistent
 * with the rest of the headers.
 */
const STAINLESS_OS =
	process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "MacOS" : "Linux";

/**
 * `X-Stainless-Arch`, derived the way the Stainless SDK derives it. Keeping it
 * host-accurate avoids impossible fingerprint combinations (e.g. MacOS + x64 on
 * Apple Silicon) that no real CLI install would produce.
 */
const STAINLESS_ARCH =
	process.arch === "x64"
		? "x64"
		: process.arch === "arm64"
			? "arm64"
			: process.arch === "ia32"
				? "x86"
				: `other:${process.arch}`;

function clearLegacyCacheMarkers(
	messages: AnthropicMessage[],
	tools: Array<Record<string, unknown>> | undefined,
): void {
	for (const tool of tools ?? []) {
		delete tool.cache_control;
	}
	for (const message of messages) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (block && typeof block === "object") {
				delete (block as Record<string, unknown>).cache_control;
			}
		}
	}
}

/**
 * Place the single conversation breakpoint on the last content block of the last
 * message, whatever its role. The two other official breakpoints live on
 * system[1] (Claude Code identity) and system[2] (the system prompt).
 *
 * Role-agnostic on purpose: captured claude-cli traffic marks a trailing
 * mid-conversation `system` message when the turn ends on one, and otherwise
 * marks the trailing user turn — including when that turn carries only
 * `tool_result` blocks. Restricting this to `user` would drop the breakpoint
 * off the end of the prefix on the system-terminated shape.
 */
function applyFinalCacheBreakpoint(messages: AnthropicMessage[]): void {
	const message = messages.at(-1);
	if (!message) return;

	if (typeof message.content === "string") {
		// Replace instead of mutating in place: the message object is aliased by
		// the loop's shared in-memory history, and converting its content shape
		// there would make later requests send this row array-shaped while a
		// post-restart rebuild sends it string-shaped. The containing array is
		// request-local (chat() maps a fresh array), so element replacement is safe.
		messages[messages.length - 1] = {
			...message,
			content: [{ type: "text", text: message.content, ...CACHE_CONTROL }],
		};
		return;
	}

	for (let blockIndex = message.content.length - 1; blockIndex >= 0; blockIndex--) {
		const block = message.content[blockIndex];
		if (block.type === "text" || block.type === "image" || block.type === "tool_result") {
			Object.assign(block, CACHE_CONTROL);
			return;
		}
	}
}

// === Anthropic message types ===

type CacheControl = { type: "ephemeral" };

type AnthropicContentPart =
	| { type: "text"; text: string; cache_control?: CacheControl }
	| {
			type: "image";
			source: { type: "base64"; media_type: string; data: string };
			cache_control?: CacheControl;
	  }
	| {
			type: "tool_use";
			id: string;
			name: string;
			input: Record<string, unknown>;
			cache_control?: CacheControl;
	  }
	| {
			type: "tool_result";
			tool_use_id: string;
			content:
				| string
				| Array<
						| { type: "text"; text: string }
						| { type: "image"; source: { type: "base64"; media_type: string; data: string } }
				  >;
			is_error?: boolean;
			cache_control?: CacheControl;
	  }
	| { type: "thinking"; thinking: string; signature: string }
	| { type: "redacted_thinking"; data: string };

/** Ensure content parts have at least one text or tool_use block (some APIs reject thinking-only messages). */
function ensureTextOrToolBlock(parts: AnthropicContentPart[]): void {
	const hasTextOrTool = parts.some((p) => p.type === "text" || p.type === "tool_use");
	if (!hasTextOrTool) {
		// Use "…" instead of "" — the API requires non-whitespace text content.
		parts.push({ type: "text", text: "…" });
	}
}

interface AnthropicMessage {
	role: "user" | "assistant" | "system";
	content: string | AnthropicContentPart[];
}

interface AnthropicTool {
	name: string;
	description: string;
	input_schema: Record<string, unknown>;
	cache_control?: { type: string };
}

interface AnthropicContextManagement {
	edits: Array<{
		type: "clear_thinking_20251015";
		keep: "all";
	}>;
}

const OFFICIAL_CONTEXT_MANAGEMENT: AnthropicContextManagement = {
	edits: [{ type: "clear_thinking_20251015", keep: "all" }],
};

// === Model capability detection ===
//
// Claude family/version parsing lives in @shared/reasoning-effort-support so
// the frontend tier menu and this request path cannot drift apart.

/** Whether a parsed version is at least `major.minor`. */
const atLeastVersion = claudeVersionAtLeast;

/**
 * Whether a model supports extended thinking.
 *
 * Support scope starts at Claude 4.7, so the pre-4 generations are simply out:
 * Claude 3.7's budgeted-thinking special case used to live here and is gone with
 * the rest of the ≤4.6 compatibility surface.
 *
 * Every credential-free relay model (DeepSeek, GLM, Kimi, MiniMax, ...) speaks
 * the classic `enabled` + `budget_tokens` thinking shape on an
 * Anthropic-compatible gateway — reasoning retention for those models is the
 * rule, not a per-vendor exemption, so they all qualify here too.
 */
export function supportsThinking(model: string): boolean {
	if (!hasCredentialBoundReasoning(model)) return true;
	const parsed = parseClaudeModel(model);
	// A strict non-Claude id (gpt/o-series) should never reach an Anthropic
	// endpoint; treat it as thinking-incapable rather than guessing.
	if (!parsed) return false;
	// Fable/Mythos have no pre-4 generation, so any parsed version qualifies.
	if (parsed.family === "fable" || parsed.family === "mythos") return true;
	return parsed.major >= 4;
}

/**
 * Whether a model accepts the effort parameter (`output_config.effort`).
 *
 * Blacklist, not whitelist: effort is near-universal now, so every model gets
 * it unless it is known to reject it. Exclusions are the built-in pre-4.6
 * Claude rule (the official API 400s there) plus the user's
 * `agent.reasoningEffortBlocklist`.
 *
 * The old whitelist ("is this a Claude 4.6+ id") also silently excluded every
 * third-party model reached through an Anthropic-compatible relay — GLM, Kimi,
 * MiniMax and friends can never match a Claude version pattern.
 */
export function supportsEffort(model: string): boolean {
	return modelAcceptsReasoningEffort(model, getReasoningEffortBlocklist());
}

/**
 * Whether a model accepts a `temperature`.
 *
 * `claude-cli` 2.1.251 lists the models that DO take it — `claude-3-*`, Opus
 * 4.0/4.1/4.5/4.6, Sonnet 4.0/4.5/4.6 and Haiku 4.5 — and returns false for
 * everything else. Every in-scope Claude (4.7 and newer, plus the Fable/Mythos
 * series) is therefore on the rejecting side, so the parameter is never sent for
 * a recognised Claude id. Upstream also only sends it when thinking is off,
 * which the caller enforces separately (see `chat`).
 *
 * An unparseable id keeps the parameter: generic Anthropic-compatible relays
 * (GLM, Kimi, ...) expect a normal Messages body, and dropping `temperature`
 * there would change behaviour for models this rule says nothing about.
 */
function acceptsTemperature(model: string): boolean {
	return parseClaudeModel(model) == null;
}

/**
 * Whether a model accepts mid-conversation `role: "system"` messages, i.e.
 * whether the `mid-conversation-system-2026-04-07` beta may be declared.
 *
 * Mirrors `claude-cli` 2.1.251's own gate, which names Opus 4.0–4.7, Sonnet
 * 4.0–4.6 and Haiku 4.5 as unsupported and leaves Opus 4.8+, Sonnet 5+, Haiku 5+
 * and Fable/Mythos on the supported side. Opus 4.7 is the one in-scope
 * exclusion, so this gate cannot collapse into "is this a modern Claude".
 *
 * This is not just a header decision: when the beta is absent upstream stops
 * emitting `api_system` turns altogether, so the caller must downgrade those
 * messages instead (see `chat`).
 */
function supportsMidConversationSystem(model: string): boolean {
	const parsed = parseClaudeModel(model);
	if (!parsed) return false;
	if (parsed.family === "fable" || parsed.family === "mythos") return true;
	if (parsed.family === "opus") return atLeastVersion(parsed, 4, 8);
	return atLeastVersion(parsed, 5, 0);
}

/**
 * Whether to declare the Anthropic effort/adaptive-thinking beta flags.
 *
 * Deliberately narrower than `supportsEffort`: these are Anthropic-specific
 * beta names, and a generic Anthropic-compatible relay fronting a non-Claude
 * model may reject unknown flags outright. So the header keeps the old
 * "Claude 4.6+" whitelist while the body parameter follows the blacklist —
 * a third-party model gets `output_config.effort` without being told about
 * betas its upstream never heard of.
 */
export function declaresEffortBetaFlags(model: string): boolean {
	const parsed = parseClaudeModel(model);
	if (!parsed) return false;
	if (parsed.family === "fable" || parsed.family === "mythos") return true;
	if (parsed.family !== "sonnet" && parsed.family !== "opus") return false;
	return atLeastVersion(parsed, 4, 6);
}

/**
 * Whether a model supports the `xhigh` effort tier (between high and max).
 * Introduced with Opus 4.7, so 4.6 keeps the four-tier ladder.
 */
export function supportsXhighEffort(model: string): boolean {
	const parsed = parseClaudeModel(model);
	if (!parsed) return false;
	if (parsed.family === "fable" || parsed.family === "mythos") return true;
	if (parsed.family !== "sonnet" && parsed.family !== "opus") return false;
	return atLeastVersion(parsed, 4, 7);
}

/** Default output token limit for Anthropic Messages chat requests. */
const DEFAULT_MAX_TOKENS = 64_000;
/** Default output token limit for lightweight Anthropic generation helpers. */
const DEFAULT_GENERATE_MAX_TOKENS = 4_096;

/** Floor the Anthropic API enforces on `thinking.budget_tokens`. */
const MIN_THINKING_BUDGET = 1_024;

/**
 * Placeholder budget for relay models, whose gateways require the
 * `budget_tokens` field but ignore its value (intensity comes from
 * `output_config.effort`).
 */
const RELAY_THINKING_BUDGET = 10_000;

/**
 * Map reasoning effort to Anthropic thinking configuration.
 *
 * Mirrors `claude-cli` 2.1.251's thinking assembly for the supported version
 * range (Claude 4.7 and newer):
 *   - `reasoningEffort === "none"` → `{ type: "disabled" }`, sent explicitly
 *     rather than omitted (upstream emits it for every thinking-capable model on
 *     a first-party backend).
 *   - everything else → `{ type: "adaptive" }`. Upstream's budgeted branch
 *     (`{ type: "enabled", budget_tokens }`) only exists for the 4.0–4.6
 *     generations, which are out of scope.
 *
 * One deliberate divergence: upstream sends `disabled` only on a first-party
 * backend and omits `thinking` entirely elsewhere. NarraFork sends it on every
 * backend, because here `"none"` is the user explicitly asking for no reasoning —
 * omitting the field would let a relay apply its own default and turn thinking
 * back on, silently overriding that choice.
 *
 * Relay models behind an Anthropic-compatible gateway (DeepSeek, GLM, Kimi, ...)
 * are not Claude versions and generally do not implement `adaptive`, so they get
 * the classic budgeted shape with a placeholder value the gateway ignores; their
 * intensity comes from `output_config.effort` instead (see `chat`).
 *
 * @param maxTokens The request's own output ceiling. Only used to keep the
 *   relay placeholder legal — the API requires
 *   `1024 <= budget_tokens < max_tokens`, and the one-shot helper paths run with
 *   a ceiling well below the placeholder.
 */
function buildThinkingConfig(
	model: string,
	reasoningEffort: string | undefined,
	maxTokens: number,
):
	| { type: "adaptive" }
	| { type: "enabled"; budget_tokens: number }
	| { type: "disabled" }
	| undefined {
	const metadata = effectiveProviderMetadata(model);
	if (metadata.reasoning?.supported === false) return undefined;
	if (metadata.reasoning?.supported !== true && !supportsThinking(model)) return undefined;
	reasoningEffort = resolveMetadataReasoning(metadata, reasoningEffort);

	// "none" explicitly disables thinking
	if (reasoningEffort === "none") {
		return { type: "disabled" };
	}

	if (hasCredentialBoundReasoning(model) && metadata.reasoning?.mode !== "budget")
		return { type: "adaptive" };

	const budget = Math.min(RELAY_THINKING_BUDGET, maxTokens - 1);
	if (budget < MIN_THINKING_BUDGET) {
		if (metadata.reasoning?.canDisable === false) {
			throw new Error(
				`Model ${model} requires thinking, but its requested output limit cannot fit the minimum thinking budget.`,
			);
		}
		return { type: "disabled" };
	}
	return { type: "enabled", budget_tokens: budget };
}

/** Effort tiers accepted by models that have the `xhigh` tier (Opus 4.7+). */
const ANTHROPIC_EFFORT_TIERS_WITH_XHIGH: readonly ReasoningEffort[] = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];
/** Effort tiers accepted by 4.6-era models, which have no `xhigh`. */
const ANTHROPIC_EFFORT_TIERS: readonly ReasoningEffort[] = ["low", "medium", "high", "max"];

/**
 * Map reasoning effort to the Anthropic `output_config.effort` value.
 * Only for models that accept the effort API (see supportsEffort).
 *
 * "none" is not mapped (thinking is disabled, so effort is irrelevant).
 * Models with the xhigh tier (Claude 4.7+) pass low/medium/high/xhigh/max
 * through unchanged. On 4.6-era Claude there is no xhigh tier, so the shared
 * clamp (就近、并列偏高) sends xhigh → max.
 *
 * A non-Claude model (unparseable id) keeps the full ladder: we have no tier
 * table for it, and dropping xhigh would silently rewrite a tier the upstream
 * may well accept. `supportsXhighEffort` stays Claude-only because it answers
 * a different question — which tiers a *known* Claude version has.
 */
export function mapEffortParam(
	model: string,
	reasoningEffort: string | undefined,
): "low" | "medium" | "high" | "xhigh" | "max" | undefined {
	const metadata = effectiveProviderMetadata(model);
	reasoningEffort = resolveMetadataReasoning(metadata, reasoningEffort);
	if (!reasoningEffort || reasoningEffort === "none") return undefined;
	if (metadata.reasoning?.levels?.length)
		return reasoningEffort as "low" | "medium" | "high" | "xhigh" | "max";
	const isKnownClaude = parseClaudeModel(model) != null;
	const supported =
		!isKnownClaude || supportsXhighEffort(model)
			? ANTHROPIC_EFFORT_TIERS_WITH_XHIGH
			: ANTHROPIC_EFFORT_TIERS;
	return clampReasoningEffort(reasoningEffort as ReasoningEffort, supported) as
		| "low"
		| "medium"
		| "high"
		| "xhigh"
		| "max";
}

// === SSE event types ===

type AnthropicUsagePayload = {
	input_tokens?: number | null;
	output_tokens?: number | null;
	cache_read_input_tokens?: number | null;
	cache_creation_input_tokens?: number | null;
	cache_creation?: {
		ephemeral_5m_input_tokens?: number | null;
		ephemeral_1h_input_tokens?: number | null;
	};
};

interface AnthropicStreamEvent {
	type: string;
	index?: number;
	message?: {
		id?: string;
		model?: string;
		usage?: AnthropicUsagePayload;
	};
	content_block?: {
		type?: string;
		id?: string;
		name?: string;
		text?: string;
		input?: Record<string, unknown>;
		thinking?: string;
		reasoning_content?: string;
		signature?: string;
		data?: string;
		// server_tool_use / web_search_tool_result fields
		tool_use_id?: string;
		content?:
			| Array<{
					title: string;
					url: string;
					snippet?: string;
					encrypted_content?: string;
					page_age?: string;
			  }>
			| { type: string; error_code: string };
	};
	delta?: {
		type?: string;
		text?: string;
		partial_json?: string;
		stop_reason?: string;
		thinking?: string;
		reasoning_content?: string;
		signature?: string;
	};
	usage?: AnthropicUsagePayload;
	error?: { type?: string; message?: string; code?: number | string };
	/** Gateway-style top-level error code (e.g. writeSSEError emits {code, message, error}). */
	code?: number | string;
}

// === Tool call accumulator ===

interface ToolAccumEntry {
	outputIndex?: number;
	id: string;
	name: string;
	args?: string;
	inputStream?: ToolInputStream;
	emitted: boolean;
}

/** Accumulator for server-side tool calls (web_search). */
interface ServerToolAccumEntry {
	id: string;
	name: string;
	args: string;
	/** Extracted query from accumulated JSON */
	query?: string;
}

/** Cumulative Anthropic usage snapshot, mirroring Claude Code's updateUsage semantics. */
interface AnthropicUsageAccum {
	inputTokens: number;
	outputTokens: number;
	cachedInputTokens: number;
	cacheCreationInputTokens: number;
	cacheCreation5mTokens: number;
	cacheCreation1hTokens: number;
	/** Text lanes tracked alongside the per-response usage state. */
	textBlocks?: Set<number>;
}

function createAnthropicUsageAccum(): AnthropicUsageAccum {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cachedInputTokens: 0,
		cacheCreationInputTokens: 0,
		cacheCreation5mTokens: 0,
		cacheCreation1hTokens: 0,
	};
}

function isPositiveTokenCount(value: number | null | undefined): value is number {
	return value != null && value > 0;
}

/**
 * Update cumulative usage from Anthropic streaming events.
 *
 * Anthropic sends cumulative totals, not deltas. Claude Code also guards input/cache
 * fields with `> 0` because `message_delta` may explicitly send zeroes for those
 * fields; those zeroes must not erase the real values from `message_start`.
 */
function updateAnthropicUsageAccum(
	usage: AnthropicUsageAccum,
	partUsage: AnthropicUsagePayload | undefined,
): void {
	if (!partUsage) return;
	if (isPositiveTokenCount(partUsage.input_tokens)) usage.inputTokens = partUsage.input_tokens;
	if (isPositiveTokenCount(partUsage.cache_read_input_tokens)) {
		usage.cachedInputTokens = partUsage.cache_read_input_tokens;
	}
	if (isPositiveTokenCount(partUsage.cache_creation_input_tokens)) {
		usage.cacheCreationInputTokens = partUsage.cache_creation_input_tokens;
	}
	if (partUsage.output_tokens != null) usage.outputTokens = partUsage.output_tokens;

	const cacheCreation = partUsage.cache_creation;
	if (cacheCreation?.ephemeral_5m_input_tokens != null) {
		usage.cacheCreation5mTokens = cacheCreation.ephemeral_5m_input_tokens;
	}
	if (cacheCreation?.ephemeral_1h_input_tokens != null) {
		usage.cacheCreation1hTokens = cacheCreation.ephemeral_1h_input_tokens;
	}
	if (
		partUsage.cache_creation_input_tokens == null &&
		(cacheCreation?.ephemeral_5m_input_tokens != null ||
			cacheCreation?.ephemeral_1h_input_tokens != null)
	) {
		usage.cacheCreationInputTokens = usage.cacheCreation5mTokens + usage.cacheCreation1hTokens;
	}
}

function anthropicPromptFootprintTokens(usage: AnthropicUsageAccum): number {
	return usage.inputTokens + usage.cachedInputTokens + usage.cacheCreationInputTokens;
}

function parsedUsageFromAnthropicAccum(
	usage: AnthropicUsageAccum,
	contextWindow?: number | null,
): ParsedStreamEvent {
	return {
		usage: {
			promptTokens: anthropicPromptFootprintTokens(usage),
			inputTokens: usage.inputTokens,
			completionTokens: usage.outputTokens,
			cachedInputTokens: usage.cachedInputTokens,
			cacheCreationInputTokens: usage.cacheCreationInputTokens,
			cacheCreation5mTokens: usage.cacheCreation5mTokens,
			cacheCreation1hTokens: usage.cacheCreation1hTokens,
			...(contextWindow != null && { contextWindow }),
		},
	};
}

function promptTokensFromAnthropicPayload(
	usage: AnthropicUsagePayload | undefined,
): number | undefined {
	if (!usage) return undefined;
	const inputTokens = usage.input_tokens ?? 0;
	const cacheRead = usage.cache_read_input_tokens ?? 0;
	const cacheCreation =
		usage.cache_creation_input_tokens ??
		(usage.cache_creation?.ephemeral_5m_input_tokens ?? 0) +
			(usage.cache_creation?.ephemeral_1h_input_tokens ?? 0);
	const total = inputTokens + cacheRead + cacheCreation;
	return total > 0 ? total : undefined;
}

/**
 * Whether a model can ingest a 1M-token context window.
 *
 * Covers Sonnet/Opus 4.6+ (including 4.7/4.8), the 5 series, and Fable/Mythos.
 * The whole Sonnet 4 family (4, 4.5) is kept as well: the official request path
 * already sends the `context-1m-2025-08-07` beta, which exists precisely for
 * Sonnet 4's 1M window — narrowing this list would silently drop those models
 * back to 200k. Opus 4/4.5 were never on the list and stay off it.
 */
export function supportsAnthropic1mContext(model: string): boolean {
	const parsed = parseClaudeModel(parseModelId(model).model);
	if (!parsed) return false;
	if (parsed.family === "fable" || parsed.family === "mythos") return true;
	if (parsed.family !== "sonnet" && parsed.family !== "opus") return false;
	// Existing behavior: the entire Sonnet 4 family gets 1M.
	if (parsed.family === "sonnet" && parsed.major === 4) return true;
	return atLeastVersion(parsed, 4, 6);
}

export function getAnthropicEffectiveContextWindow(
	model: string,
	config: AnthropicProviderConfig,
): number | null {
	// Do NOT strip the first `:` segment here. For NUG delegates `model` is the
	// full routed id (`<channel>:<model>`, e.g. antigravity:gemini-3.8-flash-high)
	// and stripping would drop the channel, producing a lookup key
	// (`gw:gemini-3.8-flash-high`) that matches neither the NUG cache nor the
	// model catalog — everything silently falls back to the 272k default and the
	// wrong value then overrides the correct top-level one in loop.ts. Direct
	// Anthropic providers pass bare ids, where nothing is stripped anyway, and
	// resolveModelContextWindow already handles a model that starts with
	// `config.prefix`. Keeping the routed id also makes per-model user overrides
	// and local bindings keyed on the full id resolve identically on both paths.
	const resolved = resolveModelContextWindow(model, config.prefix);
	// Official-API floor, but never above an explicit configuration. A per-model
	// override typed in settings, or the provider's own defaultContextWindow, is
	// a deliberate user decision (relays commonly cap far below 1M) — raising it
	// to 1M here would make the custom value look ignored and delay auto-compact
	// past the real limit. Only derived values (gateway catalog, built-in table,
	// default fallback) get lifted to the official 1M window.
	const explicit =
		resolved.source === "user" || resolved.source === "provider" || resolved.source === "card";
	if (!explicit && config.officialApi && supportsAnthropic1mContext(model)) {
		return Math.max(resolved.contextWindow, 1_000_000);
	}
	return resolved.contextWindow;
}

function calculateAnthropicContextPercent(
	usage: AnthropicUsagePayload | undefined,
	model: string,
	config: AnthropicProviderConfig,
): number | undefined {
	const promptTokens = promptTokensFromAnthropicPayload(usage);
	if (promptTokens == null) return undefined;
	const contextWindow = getAnthropicEffectiveContextWindow(model, config);
	if (!contextWindow) return undefined;
	return Math.min((promptTokens / contextWindow) * 100, 100);
}

function createAnthropicApiError(response: Response, rawBody: string): ApiError {
	let payload: Record<string, unknown> = {};
	try {
		const parsed = JSON.parse(rawBody);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			payload = parsed as Record<string, unknown>;
		}
	} catch {
		// Keep the bounded raw message below when the provider did not return JSON.
	}
	const nested = payload.error;
	const nestedMessage =
		nested &&
		typeof nested === "object" &&
		typeof (nested as Record<string, unknown>).message === "string"
			? String((nested as Record<string, unknown>).message)
			: undefined;
	const message =
		nestedMessage ?? (typeof payload.message === "string" ? payload.message : rawBody);
	const diagnostics = parseErrorDiagnostics(
		{
			...payload,
			statusCode: response.status,
			message,
			responseHeaders: Object.fromEntries(response.headers.entries()),
		},
		{
			source: "provider",
			phase: "http_error",
			statusCode: response.status,
			message,
		},
	);
	return new ApiError(
		response.status,
		`Anthropic API error ${response.status}: ${message}`,
		diagnostics,
	);
}

type AnthropicGenerateJsonResponse = {
	content?: Array<{ type?: string; text?: string }>;
	usage?: AnthropicUsagePayload;
	stop_reason?: string | null;
	error?: { type?: string; code?: string | number; message?: string };
};

function parsedAnthropicUsageToUsageData(
	usage: NonNullable<ParsedStreamEvent["usage"]>,
): GenerateMetaResult["usage"] {
	return {
		inputTokens: usage.inputTokens ?? 0,
		outputTokens: usage.completionTokens ?? 0,
		cachedInputTokens: usage.cachedInputTokens ?? 0,
		cacheCreationInputTokens: usage.cacheCreationInputTokens ?? 0,
		cacheCreation5mInputTokens: usage.cacheCreation5mTokens ?? 0,
		cacheCreation1hInputTokens: usage.cacheCreation1hTokens ?? 0,
		...(usage.reasoningTokens != null && { reasoningTokens: usage.reasoningTokens }),
	};
}

async function parseAnthropicGenerateResponse(
	response: Response,
	model: string,
	config: AnthropicProviderConfig,
	options?: GenerateOptions,
): Promise<GenerateMetaResult> {
	const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
	if (contentType.includes("text/event-stream")) {
		if (!response.body) {
			throw new Error("Anthropic API returned no body");
		}

		let text = "";
		let usage: GenerateMetaResult["usage"] = null;
		let contextPercent: number | undefined;
		let reportedContextPercent: number | undefined;
		let outputTruncated = false;
		const contextWindow = getAnthropicEffectiveContextWindow(model, config);
		for await (const event of parseAnthropicSSEStream(response.body, contextWindow)) {
			if (event.text != null) {
				text += event.text;
				await options?.onTextDelta?.(event.text);
			}
			if (event.reasoning) await options?.onReasoningDelta?.(event.reasoning);
			if (event.usage) {
				usage = parsedAnthropicUsageToUsageData(event.usage);
				const promptTokens = event.usage.promptTokens;
				const effectiveWindow = event.usage.contextWindow ?? contextWindow;
				if (reportedContextPercent == null && promptTokens != null && effectiveWindow) {
					contextPercent = Math.min((promptTokens / effectiveWindow) * 100, 100);
				}
			}
			// Window occupancy is independent of token accounting. In particular,
			// trailing placeholder usage must not replace a gateway measurement.
			if (event.contextUsagePercentage != null && Number.isFinite(event.contextUsagePercentage)) {
				reportedContextPercent = Math.min(Math.max(event.contextUsagePercentage, 0), 100);
				contextPercent = reportedContextPercent;
			}
			if (event.invalidState) {
				if (text && isCompletionLimitReason(event.invalidState.reason)) {
					// Keep paid-for output and drain trailing usage instead of failing the helper.
					outputTruncated = true;
					continue;
				}
				throw new ProviderInvalidStateError(
					event.invalidState.reason,
					`Anthropic API error: ${event.invalidState.message}`,
					{ diagnostics: event.invalidState.diagnostics },
				);
			}
		}
		return { text, contextPercent, usage, ...(outputTruncated && { outputTruncated }) };
	}

	// Compatibility fallback for relays that ignore stream=true and still return
	// JSON. Parsed through parseJsonResponseWithBody because the same 200-with-a
	// -non-JSON-body shape is how WAFs, reverse proxies, and captive portals
	// answer; `response.json()` would consume the page and report only that JSON
	// parsing failed.
	const json = await parseJsonResponseWithBody<AnthropicGenerateJsonResponse>(
		response,
		"Anthropic API",
	);
	const stopReason = json.stop_reason ?? undefined;
	const specialStopReason =
		stopReason === "max_tokens"
			? "max_tokens"
			: stopReason === "model_context_window_exceeded"
				? "model_context_window_exceeded"
				: stopReason === "refusal"
					? "refusal"
					: stopReason === "content_filter"
						? "content_filter"
						: undefined;
	const jsonErrorReason = json.error
		? String(json.error.code ?? json.error.type ?? "api_error")
		: undefined;
	const invalidReason = jsonErrorReason ?? specialStopReason;
	const text =
		json.content
			?.filter((content) => content.type === "text")
			.map((content) => content.text ?? "")
			.join("") ?? "";
	const outputTruncated = !json.error && stopReason === "max_tokens" && text.length > 0;
	if (invalidReason && !outputTruncated) {
		const message =
			json.error?.message ??
			(json.error
				? `Upstream returned error ${invalidReason} (no error message provided).`
				: `Upstream returned stop_reason=${stopReason} (no error message provided).`);
		const diagnostics = parseErrorDiagnostics(
			{ reason: invalidReason, message, error: json.error },
			{ source: "provider", phase: "json_response", reason: invalidReason, message },
		);
		throw new ProviderInvalidStateError(invalidReason, `Anthropic API error: ${message}`, {
			diagnostics,
		});
	}
	if (text) await options?.onTextDelta?.(text);
	return {
		text,
		...(outputTruncated && { outputTruncated }),
		contextPercent: calculateAnthropicContextPercent(json.usage, model, config),
		usage: json.usage ? extractAnthropicUsage(json.usage) : null,
	};
}

/**
 * Anthropic native Messages API provider.
 *
 * Uses the Anthropic Messages API directly:
 *   POST /v1/messages with streaming via SSE
 *
 * Key differences from OpenAI:
 *   - System prompt is a top-level `system` field, not a message
 *   - Tool results are sent as user messages with tool_result content blocks
 *   - Streaming uses content_block_start/delta/stop events
 *   - User/assistant turns alternate; official requests may preserve mid-conversation system messages
 */
export class AnthropicProvider implements ProviderAdapter {
	private config: AnthropicProviderConfig;
	/** Whether to reject unauthorized TLS certs (default true). */
	private tlsRejectUnauthorized: boolean;
	/** Cached base URL after successful /v1 fallback resolution. */
	private resolvedBaseUrl?: string;
	/**
	 * Session id used when the caller has no conversation to derive one from —
	 * the one-shot utility paths (title/summary generation), which upstream also
	 * treats as standalone sessions.
	 *
	 * A UUID rather than a nanoid because that is the only shape upstream accepts
	 * for a session id. The chat path does not use this field: it derives a
	 * conversation-stable id instead (see sessionIdFor).
	 */
	private readonly fallbackSessionId = randomUUID();
	/**
	 * Reasoning-signature source identity to report instead of the configured
	 * prefix. Set by NUG when this provider is used as an `anthropic`-channel
	 * delegate so signatures are tagged with the NUG channel (e.g.
	 * `nug:anthropic`) rather than a bare `anthropic`.
	 */
	private reasoningSourceOverride?: string;
	constructor(config: AnthropicProviderConfig) {
		this.config = config;
		this.tlsRejectUnauthorized = config.tlsRejectUnauthorized !== false;
	}

	/** Override the reasoning-signature source identity (used by NUG delegates). */
	setReasoningSourceOverride(source: string | undefined): void {
		this.reasoningSourceOverride = source;
	}

	/**
	 * Proxy-aware fetch with optional TLS verification bypass. Resolves the
	 * proxy per target URL, honouring this provider's own proxy override
	 * (absent/"default" → global policy). Covers streaming and auxiliary
	 * summary/title calls alike.
	 */
	private pfetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
		const target = input instanceof Request ? input.url : input;
		const proxy = resolveProxyForUrl(target, this.config.proxy);
		return fetchWithNetworkDiagnostics(input, init, {
			proxy,
			tls: this.tlsRejectUnauthorized === false ? { rejectUnauthorized: false } : undefined,
		});
	}

	/**
	 * Resolve the session id for one request.
	 *
	 * Conversation-derived when the caller has a conversation, so every turn of
	 * that conversation reports the same id (see deriveClaudeSessionId for why
	 * that matters). The utility paths pass nothing and get this instance's
	 * fallback id.
	 */
	private sessionIdFor(conversationId?: string): string {
		return conversationId ? deriveClaudeSessionId(conversationId) : this.fallbackSessionId;
	}

	/**
	 * Build the shared chat/utility request headers for this provider mode.
	 *
	 * @param conversationId Present only on the chat path. Drives the session id,
	 *   which must match the one in `metadata.user_id` for the same request.
	 */
	private buildRequestHeaders(
		apiKey: string,
		isOfficial: boolean,
		model: string,
		accept = "application/json",
		conversationId?: string,
	): Record<string, string> {
		const headers: Record<string, string> = {
			Accept: accept,
			"Content-Type": "application/json",
			"anthropic-version": "2023-06-01",
		};
		if (isOfficial) {
			headers.Authorization = `Bearer ${apiKey}`;
			headers["anthropic-beta"] = buildAnthropicBetaFlags(model);
			headers["anthropic-dangerous-direct-browser-access"] = "true";
			headers["user-agent"] = this.resolveUserAgent(true);
			headers["x-app"] = "cli";
			headers["X-Claude-Code-Session-Id"] = this.sessionIdFor(conversationId);
			// Fresh per attempt, matching `claude-cli`'s `ZGp`, which mints a UUID
			// for every official-API attempt (`Gn() === "firstParty" && mf()`) and
			// passes it as this header. It is request-scoped telemetry, so it lands
			// outside the cached prefix and cannot affect cache hits.
			headers["x-client-request-id"] = randomUUID();
			// Stainless SDK telemetry, matching the chat path.
			headers["X-Stainless-Arch"] = STAINLESS_ARCH;
			headers["X-Stainless-Lang"] = "js";
			headers["X-Stainless-OS"] = STAINLESS_OS;
			// The `anthropic-sdk-typescript` version bundled into `claude-cli`
			// 2.1.251, read from the SDK's own `VERSION` constant. The SDK reports
			// it verbatim, so a stale value here is a version the CLI never shipped.
			headers["X-Stainless-Package-Version"] = "0.112.1";
			headers["X-Stainless-Retry-Count"] = "0";
			headers["X-Stainless-Runtime"] = "node";
			headers["X-Stainless-Runtime-Version"] = "v26.3.0";
			headers["X-Stainless-Timeout"] = "600";
		} else {
			headers["x-api-key"] = apiKey;
			headers["user-agent"] = this.resolveUserAgent(false);
			if (declaresEffortBetaFlags(model)) {
				headers["anthropic-beta"] = ANTHROPIC_EFFORT_BETA_FLAGS;
			}
		}
		// OpenCode Go serves this protocol at /zen/go/v1/messages and reads session
		// identity only from its own header, so it has to be added here rather than
		// carried by the Anthropic wire format. Applied before extraHeaders so an
		// operator override still wins.
		Object.assign(
			headers,
			buildOpencodeSessionHeader({
				baseUrl: this.config.baseUrl,
				conversationId,
				extraHeaders: this.config.extraHeaders,
			}),
		);
		return this.applyExtraHeaders(headers);
	}

	/**
	 * Build system blocks for the official-API one-shot utility paths, mirroring
	 * the chat path's stable 3-block prefix (billing fingerprint, identity,
	 * caller instruction).
	 *
	 * No cache_control anywhere: captured CLI utility requests carry zero
	 * breakpoints. These prompts are short-lived and vary per call, so a
	 * breakpoint would only pay the cache-write cost without ever being read.
	 */
	private buildUtilitySystemBlocks(
		isOfficial: boolean,
		messages: AnthropicMessage[],
		systemInstruction?: string,
	): Array<Record<string, unknown>> | undefined {
		if (!isOfficial) {
			return systemInstruction ? [{ type: "text", text: systemInstruction }] : undefined;
		}
		const blocks: Array<Record<string, unknown>> = [
			{ type: "text", text: buildBillingBlock(messages) },
			{ type: "text", text: IDENTITY_BLOCK },
		];
		if (systemInstruction) {
			blocks.push({ type: "text", text: systemInstruction });
		}
		return blocks;
	}

	/**
	 * Attribution metadata the official API receives on every request.
	 *
	 * `metadata` carries exactly one key, `user_id`, whose value is the JSON
	 * *string* of the inner object — not a nested object. `account_uuid` is the
	 * empty string rather than omitted, matching what upstream sends when no
	 * account is signed in.
	 *
	 * Caller-supplied `metadata` is spread FIRST so the attribution `user_id`
	 * always wins. The opposite order let a caller's own `user_id` replace it,
	 * and that value has a contract the caller has no reason to know about:
	 * relays parse it for device/session identity, and one that fails to parse
	 * makes them treat the request as coming from an unknown client — which for
	 * Anthropic-facing relays means substituting their own short system prompt
	 * and losing the prompt cache. Extra keys still pass through.
	 *
	 * @param conversationId Present only on the chat path; keeps `session_id`
	 *   equal to the `X-Claude-Code-Session-Id` header on the same request.
	 */
	private buildRequestMetadata(
		isOfficial: boolean,
		metadata?: Record<string, unknown>,
		conversationId?: string,
	): Record<string, unknown> | undefined {
		if (!isOfficial) return metadata;
		return {
			...(metadata ?? {}),
			user_id: JSON.stringify({
				device_id: getClaudeDeviceId(),
				account_uuid: "",
				session_id: this.sessionIdFor(conversationId),
			}),
		};
	}

	private applyExtraHeaders(headers: Record<string, string>): Record<string, string> {
		// `"user-agent"` is the casing buildRequestHeaders writes above; passing it
		// keeps an operator override on that one key instead of leaving a second
		// differently-cased key that fetch would comma-join onto it.
		mergeExtraHeaders(headers, this.config.extraHeaders, "user-agent");
		return headers;
	}

	/**
	 * Resolve the User-Agent for this provider.
	 *
	 * Anthropic traffic — official Claude Code API and third-party Claude Code
	 * relays alike — defaults to the Claude CLI identity. Operators can still
	 * override per provider via userAgentMode/customUserAgent.
	 */
	private resolveUserAgent(_isOfficial: boolean): string {
		return resolveHttpUserAgent({
			mode: this.config.userAgentMode,
			custom: this.config.customUserAgent,
			fallback: getHttpClaudeCliUserAgent(),
		});
	}

	/** Get the effective base URL, using cached resolution if available. */

	private getBaseUrl(): string {
		if (this.resolvedBaseUrl) return this.resolvedBaseUrl;
		const normalized = (this.config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
		// Honor a prior process-wide /v1 resolution for this base URL (unless the
		// user changed settings since, which bumps the revision).
		if (!AnthropicProvider.hasV1Suffix(normalized)) {
			const cached = v1FallbackCache.get(normalized);
			if (cached && cached.revision === getSettingsRevision()) {
				this.resolvedBaseUrl = `${normalized}/v1`;
				return this.resolvedBaseUrl;
			}
		}
		return normalized;
	}

	/** Whether a base URL already ends with /v1 (case-insensitive). */
	private static hasV1Suffix(url: string): boolean {
		return /\/v1\/?$/i.test(url);
	}

	/**
	 * Record a successful `/v1` fallback: cache it both on this instance and
	 * process-wide, and suggest the user persist the fix.
	 *
	 * @param originalBaseUrl - The normalized base URL that lacked `/v1`.
	 * @param retryBase - The working base URL (originalBaseUrl + "/v1").
	 */
	private recordV1Fallback(originalBaseUrl: string, retryBase: string): void {
		this.resolvedBaseUrl = retryBase;
		v1FallbackCache.set(originalBaseUrl, { revision: getSettingsRevision() });
		const suggestedBaseUrl = retryBase;
		void broadcastBaseUrlFixSuggested({
			providerId: this.config.id,
			providerPrefix: this.config.prefix,
			providerName: this.config.name || this.config.prefix,
			currentBaseUrl: this.config.baseUrl || originalBaseUrl,
			suggestedBaseUrl,
		});
	}

	/**
	 * Fetch with automatic /v1 suffix fallback.
	 *
	 * Triggers the `/v1` retry in two cases when the base URL lacks `/v1`:
	 *   1. The initial request returns a non-ok HTTP response (e.g. 404). This
	 *      is what small requests hit — the gateway answers quickly.
	 *   2. The initial request THROWS a connection-closed error (ECONNRESET /
	 *      "socket connection was closed unexpectedly"). Large request bodies on
	 *      a wrong path can make the gateway RST the connection before sending
	 *      any response, so case 1 never fires. Without this branch the error
	 *      propagates as a retryable error and the agent loop retries forever
	 *      against the same wrong path (observed as 0% success on long sessions).
	 *
	 * On a successful fallback the resolved base URL is cached (instance- and
	 * process-wide) and a fix suggestion is broadcast to clients.
	 */
	private async fetchWithV1Fallback(path: string, init: RequestInit): Promise<Response> {
		const baseUrl = this.getBaseUrl();
		const url = `${baseUrl}${path}`;
		// All requests go through the proxy-aware fetch so streaming and auxiliary
		// calls uniformly follow the global outbound proxy policy.
		const doFetch = this.pfetch.bind(this);
		const canFallback = !AnthropicProvider.hasV1Suffix(baseUrl);

		let response: Response;
		try {
			response = await doFetch(url, init);
		} catch (err) {
			// Connection reset before any response. Under this branch's design
			// assumption, a thrown connection error means the ORIGINAL path was
			// wrong: gateways RST large request bodies on wrong paths before
			// answering, so `/v1` is the corrected path. We therefore surface the
			// retry's outcome (even a non-ok status) — re-throwing the original
			// retryable connection error would make the agent loop retry the wrong
			// path forever (observed as 0% success on long sessions).
			if (canFallback && isConnectionClosedError(err)) {
				const retryBase = `${baseUrl}/v1`;
				const retryUrl = `${retryBase}${path}`;
				logger.debug("Anthropic request connection closed, retrying with /v1 suffix", {
					originalUrl: url,
					retryUrl,
					error: err instanceof Error ? err.message : String(err),
				});
				let retryResponse: Response;
				try {
					retryResponse = await doFetch(retryUrl, init);
				} catch {
					// Both paths dropped the connection — surface the ORIGINAL
					// (user-configured) URL's error, which is the one they control.
					throw err;
				}
				if (retryResponse.ok) {
					this.recordV1Fallback(baseUrl, retryBase);
				}
				return retryResponse;
			}
			throw err;
		}

		if (response.ok || !canFallback) {
			return response;
		}

		// Original returned a non-ok HTTP response (this is the case the user's
		// bug report describes: the configured URL fails WITH a real error body).
		// We still try `/v1` (broad trigger, by design), but must not let a WORSE
		// fallback — a wrong-path 404/405, or a WAF that drops the connection —
		// hide the real endpoint's error. Cache the original status/body first so
		// we can reconstruct it if the retry turns out worse.
		const retryBase = `${baseUrl}/v1`;
		const retryUrl = `${retryBase}${path}`;
		const originalStatus = response.status;
		const originalStatusText = response.statusText;
		const originalContentType = response.headers.get("content-type");
		const originalBody = await response.text().catch(() => "");

		logger.debug("Anthropic request failed, retrying with /v1 suffix", {
			originalUrl: url,
			retryUrl,
			status: originalStatus,
		});

		// Rebuild the drained original response so callers can read its status +
		// body. Only content-type is preserved (content-length/encoding would no
		// longer match the already-decoded body string).
		const rebuildOriginal = (): Response => {
			const headers = new Headers();
			if (originalContentType) headers.set("content-type", originalContentType);
			return new Response(originalBody, {
				status: originalStatus,
				statusText: originalStatusText,
				headers,
			});
		};

		let retryResponse: Response;
		try {
			retryResponse = await doFetch(retryUrl, init);
		} catch (retryErr) {
			// Fallback path dropped the connection (e.g. WAF). Surface the original
			// endpoint's real error instead of the fallback transport failure.
			logger.debug("Anthropic /v1 fallback threw; surfacing original error", {
				retryUrl,
				originalStatus,
				error: retryErr instanceof Error ? retryErr.message : String(retryErr),
			});
			return rebuildOriginal();
		}

		if (retryResponse.ok) {
			this.recordV1Fallback(baseUrl, retryBase);
			return retryResponse;
		}

		// Both failed. A 404/405 is the "wrong path" signal that triggered the
		// fallback, so it is the least informative. Only prefer the retry when the
		// ORIGINAL looked like a wrong path AND the retry reached a real endpoint;
		// otherwise keep the original endpoint's error.
		const isWrongPath = (status: number): boolean => status === 404 || status === 405;
		if (isWrongPath(originalStatus) && !isWrongPath(retryResponse.status)) {
			return retryResponse;
		}
		// Drain the retry body to free the connection, then surface the original.
		await retryResponse.text().catch(() => {});
		return rebuildOriginal();
	}

	formatTools(tools: ResolvedToolDefinition[]): unknown[] {
		return tools.map(
			(tool): AnthropicTool => ({
				name: tool.name,
				description: tool.description,
				input_schema: {
					$schema: "https://json-schema.org/draft/2020-12/schema",
					...resolveToolJsonSchema(tool),
				},
			}),
		);
	}

	async buildHistory(
		dbMessages: DbMessage[],
		model: string,
		narratorId?: string,
	): Promise<{ history: unknown[]; trailingToolResults: unknown[]; trailingUserText?: string }> {
		// narratorId is required to resolve history images: an uploaded image is
		// stored per narrator and the row only carries its id, so without the owner
		// the bytes cannot be found. It used to be ignored here, which silently
		// dropped every image from replayed history.
		return buildAnthropicHistory(
			dbMessages,
			this.getActiveReasoningSource(),
			!!this.config.officialApi,
			narratorId,
			hasCredentialBoundReasoning(parseModelId(model).model),
		);
	}

	getActiveReasoningSource(): string | undefined {
		// A direct Anthropic-family provider is one upstream server, identified
		// by its configured prefix. Reasoning-signature source override lets NUG
		// reuse this provider as a delegate while tagging signatures with the NUG
		// channel identity instead.
		return this.reasoningSourceOverride ?? this.config.prefix;
	}

	injectSystemPrompt(
		history: unknown[],
		systemPrompt: string,
		_model: string,
		_locale?: string,
	): void {
		// Anthropic uses a top-level `system` array. Store the NarraFork prompt as
		// a marker at index 0 so chat() can construct the official cacheable prefix.
		const h = history as AnthropicMessage[];
		h.unshift({
			role: "user",
			content: `__SYSTEM__:${systemPrompt}`,
		} as AnthropicMessage);
	}

	async *chat(params: ChatParams): AsyncGenerator<ParsedStreamEvent> {
		const apiKey = this.config.apiKey;

		if (!apiKey) {
			throw new Error(`Anthropic API key not configured for provider "${this.config.name}".`);
		}

		const isOfficial = !!this.config.officialApi;
		const model = parseModelId(params.model).model;
		const isDeepSeek = isDeepSeekModel(model);
		// Strict models (Claude families, gpt/o-series) mint server-bound reasoning
		// credentials; an uncredentialed thinking block must be dropped for them.
		// Every relay model keeps its plain-text reasoning instead — with an empty
		// signature where the wire schema demands one.
		const strictReasoning = hasCredentialBoundReasoning(model);
		// A mid-conversation `role: "system"` turn is only legal while the
		// `mid-conversation-system-2026-04-07` beta is declared, and that beta is
		// itself model-gated (see supportsMidConversationSystem). Upstream handles
		// the unsupported case by not emitting `api_system` turns at all; here the
		// equivalent is the downgrade the compatible path already performs, so a
		// model without the capability never receives a message role it will reject.
		const midConversationSystem = isOfficial && supportsMidConversationSystem(model);
		const history = (params.history as AnthropicMessage[]).map((message) =>
			!midConversationSystem && message.role === "system"
				? { ...message, role: "user" as const }
				: message,
		);
		const tools = params.tools as AnthropicTool[];

		// Extract system prompt from the marker message
		let systemPrompt: string | undefined;
		if (
			history.length > 0 &&
			typeof history[0].content === "string" &&
			history[0].content.startsWith("__SYSTEM__:")
		) {
			systemPrompt = history[0].content.slice("__SYSTEM__:".length);
			history.shift();
		}

		// Append tool results as user message with tool_result content blocks
		const toolResultParts: AnthropicContentPart[] = [];
		for (const tr of params.toolResults as Array<{
			tool_use_id: string;
			content:
				| string
				| Array<
						| { type: "text"; text: string }
						| { type: "image"; source: { type: "base64"; media_type: string; data: string } }
				  >;
			is_error?: boolean;
		}>) {
			toolResultParts.push({
				type: "tool_result",
				tool_use_id: tr.tool_use_id,
				content: tr.content,
				is_error: tr.is_error,
			});
		}

		// Append current user message
		if (params.content && params.content !== ".") {
			if (toolResultParts.length > 0) {
				const parts: AnthropicContentPart[] = [...toolResultParts];
				if (params.images?.length) {
					for (const img of params.images) {
						parts.push({
							type: "image",
							source: {
								type: "base64",
								media_type: `image/${img.format}`,
								data: img.base64,
							},
						});
					}
				}
				parts.push({ type: "text", text: params.content });
				history.push({ role: "user", content: parts });
			} else {
				const parts: AnthropicContentPart[] = [];
				if (params.images?.length) {
					for (const img of params.images) {
						parts.push({
							type: "image",
							source: {
								type: "base64",
								media_type: `image/${img.format}`,
								data: img.base64,
							},
						});
					}
				}
				parts.push({ type: "text", text: params.content });
				history.push({ role: "user", content: parts });
			}
		} else if (toolResultParts.length > 0) {
			history.push({ role: "user", content: toolResultParts });
		} else if (params.content) {
			history.push({ role: "user", content: [{ type: "text", text: params.content }] });
		}

		// Sanitize BEFORE normalizing. Every step from here to `ensureAlternating`
		// can REMOVE a whole message, and the normalizer is what guarantees the two
		// positional invariants the API enforces: user/assistant alternation, and a
		// mid-conversation system turn sitting between a user turn and an assistant
		// turn (or at the very end). Normalizing first and pruning afterwards broke
		// both — dropping the assistant turn that followed a system entry left that
		// entry in front of a user turn, which 400s at that index on every later
		// request too.
		const draft = history;

		// Final safety net: drop any assistant messages with empty/null content
		// before sending to the API. This catches edge cases where messages with
		// empty contentJson (e.g. interrupted streaming) slip through buildHistory.
		for (let i = draft.length - 1; i >= 0; i--) {
			const m = draft[i];
			if (m.role === "assistant") {
				const c = m.content;
				if (
					c == null ||
					(typeof c === "string" && c === "") ||
					(Array.isArray(c) && c.length === 0)
				) {
					logger.debug("Dropping empty assistant message before API call", {
						index: i,
						contentType: typeof c,
					});
					draft.splice(i, 1);
				}
			}
		}

		// Use the unified Anthropic Messages output token ceiling. Every model in
		// the supported range caps at or above it.
		const maxTokens = resolveOutputTokenLimit(
			effectiveProviderMetadata(params.model),
			params.maxOutputTokens,
			DEFAULT_MAX_TOKENS,
		)!;

		// Build thinking configuration
		const thinkingConfig = buildThinkingConfig(params.model, params.reasoningEffort, maxTokens);
		const thinkingEnabled = !!thinkingConfig && thinkingConfig.type !== "disabled";

		// When thinking is not enabled, strip thinking/redacted_thinking blocks from
		// history messages. Third-party Anthropic-compatible APIs (e.g. DeepSeek) may
		// return thinking blocks in their responses, which get persisted and replayed
		// in subsequent turns. If the model isn't recognized as supporting thinking,
		// sending these blocks back without a `thinking` config triggers a 400 error.
		if (!thinkingEnabled) {
			stripThinkingBlocks(draft);
		}

		// Even when thinking IS enabled, we must sanitize the history:
		// 1. Remove assistant messages that contain ONLY thinking blocks (orphaned
		//    from interrupted streaming). These cause "thinking blocks cannot be
		//    modified" API errors.
		// 2. Strip trailing thinking blocks from the last assistant message — the
		//    API requires assistant messages to end with text or tool_use, not
		//    thinking/redacted_thinking.
		if (thinkingEnabled) {
			// Runs first: removing an empty thinking block can leave a message
			// thinking-only or empty, and the two filters below are what clean that up.
			dropEmptyThinkingBlocks(draft);

			// A thinking block that carries no signature the strict upstream would
			// accept cannot be sent at all — see dropUnreplayableThinkingBlocks.
			// Relay models are exempt: their gateways mint no signatures, so the
			// relay sanitizer below echoes the text with an empty signature instead.
			if (strictReasoning) {
				dropUnreplayableThinkingBlocks(draft);
			}

			filterThinkingOnlyAssistantMessages(draft);
			stripTrailingThinkingFromLastAssistant(draft);

			// Relay gateways (generalized from the DeepSeek case) don't support
			// redacted_thinking, and their thinking mode requires thinking blocks
			// on assistant messages. Sanitize replayed history before sending it.
			if (!strictReasoning) {
				sanitizeRelayThinkingBlocks(draft);
			}
		}

		// Normalize alternation and place mid-conversation system turns legally, now
		// that the final set of messages is known.
		const messages = ensureAlternating(draft);

		// Build system blocks — official API uses the stable Claude Code 3-block
		// prefix, while proxy mode uses only the NarraFork system prompt.
		const systemBlocks: Array<Record<string, unknown>> = [];
		if (isOfficial) {
			systemBlocks.push(
				{ type: "text", text: buildBillingBlock(messages) },
				{ type: "text", text: IDENTITY_BLOCK, ...CACHE_CONTROL },
			);
			if (systemPrompt) {
				systemBlocks.push({ type: "text", text: systemPrompt, ...CACHE_CONTROL });
			}
		} else if (systemPrompt) {
			systemBlocks.push({ type: "text", text: systemPrompt });
		}

		// Clone tool definitions so legacy cache markers can be removed without
		// mutating the caller's in-memory tool registry.
		const cachedTools = tools.length > 0 ? tools.map((tool) => ({ ...tool })) : undefined;

		// Remove markers inherited from older requests in every mode. Official
		// Claude Code requests then add exactly one conversation breakpoint: the
		// final cacheable block of the final message, whatever its role (see
		// applyFinalCacheBreakpoint — trailing system and tool_result-only turns
		// are marked too).
		clearLegacyCacheMarkers(messages, cachedTools);
		if (isOfficial) {
			applyFinalCacheBreakpoint(messages);
		}

		const body: Record<string, unknown> = {
			model,
			messages,
			max_tokens: maxTokens,
			stream: true,
		};
		// `context_management` carries exactly one edit, `clear_thinking_20251015`,
		// so upstream only builds it when thinking is on (`yGp({hasThinking})` and
		// the `Wi.includes(R2t)` guard next to it). Sending a thinking edit on a
		// request that produces no thinking describes work the server cannot do,
		// and it requires the context-management beta this model may not declare.
		if (isOfficial && thinkingEnabled) {
			body.context_management = OFFICIAL_CONTEXT_MANAGEMENT;
		}

		// Add thinking configuration
		if (thinkingConfig) {
			body.thinking = thinkingConfig;
		}

		// Temperature: upstream sends it only when thinking is off AND the model
		// still accepts the parameter (`!Za && wHo(d)`). Every Claude in the
		// supported range rejects it, so the previous unconditional
		// `temperature: 1` was a 400 on exactly the newest models. Only third-party
		// relay ids, which `wHo` says nothing about, still receive it.
		if (!thinkingEnabled && acceptsTemperature(model)) {
			body.temperature = 1;
		}

		// Effort parameter: official Anthropic API and Anthropic-compatible relays
		// (e.g. Claude Code proxies) both accept output_config.effort. Sent for any
		// effort-capable model regardless of officialApi.
		//
		// NOT gated on `thinkingEnabled`: that flag tracks the Anthropic-specific
		// `thinking` block, which only Claude-shaped ids opt into. A third-party
		// model behind an Anthropic-compatible relay (GLM, Kimi, ...) has no
		// `thinking` config yet still honors output_config.effort, so gating on it
		// would reinstate the whitelist we just removed. An explicit "none" is
		// still respected — that means the user asked for no reasoning.
		//
		// No default tier is substituted: an unset effort means "the caller stated
		// no preference", so the upstream's own default must stand. Injecting
		// `medium` here was harmless while this branch only ran for Claude 4.6+
		// (the session path always resolves a tier), but under the blacklist policy
		// it would impose a tier on every third-party model whose caller left it
		// unset. The OpenAI path already sends nothing in that case.
		if (
			supportsEffort(model) ||
			effectiveProviderMetadata(params.model).reasoning?.supported === true
		) {
			const effort = mapEffortParam(params.model, params.reasoningEffort);
			if (effort) body.output_config = { effort };
		}

		// DeepSeek effort: output_config.effort controls thinking intensity
		// (DeepSeek supports "high" and "max"; low/medium map to high)
		if (isDeepSeek && thinkingEnabled) {
			const effort = mapDeepSeekEffort(
				resolveMetadataReasoning(effectiveProviderMetadata(params.model), params.reasoningEffort),
			);
			if (effort) {
				body.output_config = { effort };
			}
		}

		body.system = systemBlocks;

		// Tools: `web_search_20250305` is deliberately NEVER declared here, even when
		// native search is enabled. Declaring a server tool in the main conversation
		// shifts the cached prefix (tools sit at its very front) and routes the turn
		// through relay search-orchestration paths measured dropping `cache_control`
		// markers entirely. Mirroring the Claude CLI, native search runs as a separate
		// one-shot side request (see performWebSearch); the main request only ever
		// carries function tools.
		if (cachedTools) {
			body.tools = cachedTools;
		}

		const requestMetadata = this.buildRequestMetadata(
			isOfficial,
			params.metadata,
			params.conversationId,
		);
		if (requestMetadata) body.metadata = requestMetadata;

		// Request path: official API uses ?beta=true, proxy mode uses plain path.
		assertModelInputModalities(params.model, body);
		const reqPath = isOfficial ? "/messages?beta=true" : "/messages";

		const reqHeaders = this.buildRequestHeaders(
			apiKey,
			isOfficial,
			model,
			"application/json",
			params.conversationId,
		);

		params.requestDump?.setRequest({
			transport: "http",
			url: `${this.getBaseUrl()}${reqPath}`,
			headers: sanitizeHeaders(reqHeaders),
			body,
		});

		logger.debug("Anthropic chat request", {
			model,
			endpoint: `${this.getBaseUrl()}${reqPath}`,
			toolCount: tools.length,
			messageCount: messages.length,
			hasSystem: !!systemPrompt,
			maxTokens,
			thinkingType: thinkingConfig?.type,
			reasoningEffort: params.reasoningEffort,
		});

		const bodyStr = JSON.stringify(body);

		params.onRequestStart?.();
		const response = await this.fetchWithV1Fallback(reqPath, {
			method: "POST",
			headers: reqHeaders,
			body: bodyStr,
			signal: params.signal,
		});
		const responseTextPromise = params.requestDump
			? response
					.clone()
					.text()
					.catch((error) => {
						params.requestDump?.setResponseError(error);
						return "";
					})
			: undefined;
		params.requestDump?.setResponseMeta({
			status: response.status,
			headers: sanitizeHeaders(response.headers),
		});

		if (!response.ok) {
			const errText = await response.text().catch(() => "");
			params.requestDump?.setResponseBodyText(errText);
			throw createAnthropicApiError(response, errText);
		}

		if (!response.body) {
			throw new Error("Anthropic API returned no body");
		}

		yield* parseAnthropicSSEStream(
			response.body,
			getAnthropicEffectiveContextWindow(model, this.config),
		);
		if (responseTextPromise) {
			const bodyText = await responseTextPromise;
			const maxSize = settings.agent?.requestDumpMaxSize ?? 1024 * 1024;
			params.requestDump?.setResponseBodyTextWithLimit(bodyText, maxSize);
		}
	}

	formatToolResult(
		toolUseId: string,
		output: string,
		isError: boolean,
		images?: Array<{ format: string; base64: string }>,
	): unknown {
		if (images?.length) {
			const content: Array<
				| { type: "image"; source: { type: "base64"; media_type: string; data: string } }
				| { type: "text"; text: string }
			> = [];
			for (const img of images) {
				content.push({
					type: "image",
					source: {
						type: "base64",
						media_type: `image/${img.format}`,
						data: img.base64,
					},
				});
			}
			content.push({ type: "text", text: output });
			return { tool_use_id: toolUseId, content, is_error: isError || undefined };
		}
		return { tool_use_id: toolUseId, content: output, is_error: isError || undefined };
	}

	pushUserTurn(
		history: unknown[],
		content: string,
		_model: string,
		toolResults: unknown[],
		images?: Array<{ format: string; base64: string }>,
	): void {
		const h = history as AnthropicMessage[];
		const parts: AnthropicContentPart[] = [];

		for (const tr of toolResults as Array<{
			tool_use_id: string;
			content:
				| string
				| Array<
						| { type: "text"; text: string }
						| { type: "image"; source: { type: "base64"; media_type: string; data: string } }
				  >;
			is_error?: boolean;
		}>) {
			parts.push({
				type: "tool_result",
				tool_use_id: tr.tool_use_id,
				content: tr.content,
				is_error: tr.is_error,
			});
		}

		for (const img of images ?? []) {
			parts.push({
				type: "image",
				source: {
					type: "base64",
					media_type: `image/${img.format}`,
					data: img.base64,
				},
			});
		}

		const hasText = !!content && content !== ".";
		if (hasText) {
			parts.push({ type: "text", text: content });
		} else if (images?.length) {
			parts.push({ type: "text", text: "[user sent image(s)]" });
		}

		if (parts.length > 0) {
			h.push({ role: "user", content: parts });
		}
	}

	pushAssistantTurn(
		history: unknown[],
		text: string,
		toolUses: AgentToolUse[],
		reasoningBlocks?: Array<{
			text: string;
			providerMetadata?: import("./types").ReasoningProviderMetadata;
			outputIndex?: number;
		}>,
		_webSearches?: Array<{
			id: string;
			query?: string;
			queries?: string[];
			outputIndex?: number;
		}>,
		_messageId?: string,
		_imageGenerations?: Array<{
			id: string;
			revisedPrompt?: string;
			result?: string;
			outputIndex?: number;
		}>,
		textOutputIndex?: number,
		redactedThinkingBlocks?: Array<{
			data: string;
			outputIndex?: number;
			signatureSource?: string;
		}>,
		orderedContent?: readonly import("./types").ContentBlock[],
	): void {
		const h = history as AnthropicMessage[];
		if (orderedContent) {
			const parts: AnthropicContentPart[] = [];
			for (const block of orderedContent) {
				if (block.type === "text" && block.text.trim()) {
					parts.push({ type: "text", text: block.text });
				} else if (block.type === "reasoning" && block.text.trim()) {
					parts.push({
						type: "thinking",
						thinking: block.text,
						signature: block.providerMetadata?.anthropic?.signature ?? "",
					});
				} else if (block.type === "redacted_thinking") {
					parts.push({ type: "redacted_thinking", data: block.data });
				} else if (block.type === "tool_use") {
					parts.push({
						type: "tool_use",
						id: block.toolUseId,
						name: block.name,
						input: block.input,
					});
				}
			}
			if (parts.length) {
				ensureTextOrToolBlock(parts);
				h.push({ role: "assistant", content: parts });
			}
			return;
		}

		// Collect all blocks with their outputIndex and sort by position.
		// When no block has an explicit outputIndex (legacy messages), fall back
		// to the fixed ordering: reasoning → text → tool_use.
		const indexed: Array<{ part: AnthropicContentPart; outputIndex: number }> = [];

		if (reasoningBlocks) {
			for (let i = 0; i < reasoningBlocks.length; i++) {
				const rb = reasoningBlocks[i];
				// A thinking block with empty text is rejected upstream
				// ("messages.N.content.M.thinking: ... too short"), and because the
				// offending block lives in replayed history every later turn fails at
				// the same index — the conversation is permanently wedged.
				//
				// Empty text with a signature is produced by an interrupted stream:
				// content_block_start opens a thinking block, signature_delta fills the
				// signature, and the connection dies before any thinking_delta arrives.
				// Such a block carries no information — the signature is only meaningful
				// as proof-of-origin for text that exists — so it is dropped rather than
				// padded. Padding is not an option: the signature is cryptographically
				// bound to the original text, so invented filler turns a length error
				// into a harder-to-diagnose signature verification failure.
				if (!rb.text || rb.text.trim() === "") continue;
				const sig = rb.providerMetadata?.anthropic?.signature ?? "";
				indexed.push({
					part: { type: "thinking", thinking: rb.text, signature: sig },
					// Fallback uses the kept-block count (indexed.length), not the raw
					// loop index i: dropping an empty block above must not leave a gap
					// that reorders the surviving block after the text/tool_use blocks,
					// which anchor their own fallback to indexed.length too.
					outputIndex: rb.outputIndex ?? indexed.length,
				});
			}
		}

		if (redactedThinkingBlocks) {
			for (const rb of redactedThinkingBlocks) {
				indexed.push({
					part: { type: "redacted_thinking", data: rb.data },
					outputIndex: rb.outputIndex ?? indexed.length,
				});
			}
		}

		// Whitespace-only text is rejected upstream ("text content blocks must
		// contain non-whitespace text"), and because the block lands in replayed
		// history every later turn fails at the same index — the conversation is
		// permanently wedged, exactly like the empty-thinking case above. A plain
		// truthiness check is not enough: it stops "" but passes " " and "\n".
		if (text?.trim()) {
			// Use the real textOutputIndex when available; otherwise place text
			// after reasoning blocks but before tool_use blocks.
			const fallbackIdx = indexed.length;
			indexed.push({
				part: { type: "text", text },
				outputIndex: textOutputIndex ?? fallbackIdx,
			});
		}

		for (let i = 0; i < toolUses.length; i++) {
			const tu = toolUses[i];
			const fallbackIdx = indexed.length;
			indexed.push({
				part: {
					type: "tool_use",
					id: tu.toolUseId,
					name: tu.name,
					input: tu.input,
				},
				outputIndex: tu.outputIndex ?? fallbackIdx,
			});
		}

		indexed.sort((a, b) => a.outputIndex - b.outputIndex);
		const parts = indexed.map((e) => e.part);

		if (parts.length > 0) {
			ensureTextOrToolBlock(parts);
			h.push({ role: "assistant", content: parts });
		}
	}

	async generate(text: string, model: string): Promise<string> {
		const result = await this.generateWithMeta(text, model);
		return result.text;
	}

	async generateWithMeta(
		text: string,
		model: string,
		systemInstruction?: string,
		options?: GenerateOptions,
	): Promise<GenerateMetaResult> {
		const apiKey = this.config.apiKey;

		if (!apiKey) {
			throw new Error(`Anthropic API key not configured for provider "${this.config.name}".`);
		}

		const bareModel = parseModelId(model).model;
		const isOfficial = !!this.config.officialApi;
		const messages: AnthropicMessage[] = [{ role: "user", content: text }];
		const body: {
			model: string;
			max_tokens: number;
			messages: AnthropicMessage[];
			stream: true;
			system?: Array<Record<string, unknown>>;
			thinking?: ReturnType<typeof buildThinkingConfig>;
			output_config?: { effort: string };
			metadata?: Record<string, unknown>;
		} = {
			model: bareModel,
			max_tokens: resolveOutputTokenLimit(
				effectiveProviderMetadata(model),
				options?.maxOutputTokens,
				DEFAULT_GENERATE_MAX_TOKENS,
			)!,
			messages,
			stream: true,
		};
		const system = this.buildUtilitySystemBlocks(isOfficial, messages, systemInstruction);
		if (system) body.system = system;
		const reasoningEffort =
			options?.reasoningEffort ??
			effectiveProviderMetadata(model).reasoning?.defaultLevel ??
			undefined;
		if (reasoningEffort !== undefined) {
			const thinkingConfig = buildThinkingConfig(model, reasoningEffort, body.max_tokens);
			if (thinkingConfig) body.thinking = thinkingConfig;
			const effort = mapEffortParam(model, reasoningEffort);
			if (
				effort &&
				(supportsEffort(bareModel) ||
					effectiveProviderMetadata(model).reasoning?.supported === true)
			) {
				body.output_config = {
					effort: isDeepSeekModel(bareModel) ? (mapDeepSeekEffort(effort) ?? effort) : effort,
				};
			}
		}
		const metadata = this.buildRequestMetadata(isOfficial);
		if (metadata) body.metadata = metadata;

		const headers = this.buildRequestHeaders(apiKey, isOfficial, bareModel, "text/event-stream");

		const response = await this.fetchWithV1Fallback(
			isOfficial ? "/messages?beta=true" : "/messages",
			{
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: options?.signal,
			},
		);

		if (!response.ok) {
			const errText = await response.text().catch(() => "");
			throw createAnthropicApiError(response, errText);
		}

		return parseAnthropicGenerateResponse(response, bareModel, this.config, options);
	}

	async generateWithHistory(
		systemInstruction: string,
		content: string,
		model: string,
		locale?: string,
		options?: GenerateOptions,
	): Promise<string> {
		const result = await this.generateWithHistoryWithMeta(
			systemInstruction,
			content,
			model,
			locale,
			options,
		);
		return result.text;
	}

	async generateWithHistoryWithMeta(
		systemInstruction: string,
		content: string,
		model: string,
		locale?: string,
		options?: GenerateOptions,
	): Promise<GenerateMetaResult> {
		const apiKey = this.config.apiKey;

		if (!apiKey) {
			throw new Error(`Anthropic API key not configured for provider "${this.config.name}".`);
		}

		const isOfficial = !!this.config.officialApi;
		const reminder = getToolMessage("titleReminder", (locale ?? "en") as Locale);
		const bareModel = parseModelId(model).model;

		const messages: AnthropicMessage[] = [
			{
				role: "user",
				content: `${reminder}\n\n${content}`,
			},
		];
		const body: {
			model: string;
			max_tokens: number;
			system?: Array<Record<string, unknown>>;
			messages: AnthropicMessage[];
			stream: true;
			thinking?: ReturnType<typeof buildThinkingConfig>;
			output_config?: { effort: string };
			metadata?: Record<string, unknown>;
		} = {
			model: bareModel,
			max_tokens: resolveOutputTokenLimit(
				effectiveProviderMetadata(model),
				options?.maxOutputTokens,
				DEFAULT_GENERATE_MAX_TOKENS,
			)!,
			messages,
			stream: true,
		};
		const system = this.buildUtilitySystemBlocks(isOfficial, messages, systemInstruction);
		if (system) body.system = system;
		const reasoningEffort =
			options?.reasoningEffort ??
			effectiveProviderMetadata(model).reasoning?.defaultLevel ??
			undefined;
		if (reasoningEffort !== undefined) {
			const thinkingConfig = buildThinkingConfig(model, reasoningEffort, body.max_tokens);
			if (thinkingConfig) body.thinking = thinkingConfig;
			const effort = mapEffortParam(model, reasoningEffort);
			if (
				effort &&
				(supportsEffort(bareModel) ||
					effectiveProviderMetadata(model).reasoning?.supported === true)
			) {
				body.output_config = {
					effort: isDeepSeekModel(bareModel) ? (mapDeepSeekEffort(effort) ?? effort) : effort,
				};
			}
		}
		const metadata = this.buildRequestMetadata(isOfficial);
		if (metadata) body.metadata = metadata;

		const genHeaders = this.buildRequestHeaders(apiKey, isOfficial, bareModel, "text/event-stream");
		const response = await this.fetchWithV1Fallback(
			isOfficial ? "/messages?beta=true" : "/messages",
			{
				method: "POST",
				headers: genHeaders,
				body: JSON.stringify(body),
				signal: options?.signal,
			},
		);

		if (!response.ok) {
			const errText = await response.text().catch(() => "");
			throw createAnthropicApiError(response, errText);
		}

		return parseAnthropicGenerateResponse(response, bareModel, this.config, options);
	}

	/**
	 * One-shot server-side web search, mirroring the Claude CLI's WebSearch side
	 * request. This is the ONLY code site that declares `web_search_20250305`:
	 * the main conversation request never carries it, so the cached prefix is
	 * byte-identical whether or not search is used.
	 *
	 * Request shape (CLI parity):
	 *   - no function tools — only the server search tool
	 *   - forced `tool_choice: {type:"tool", name:"web_search"}`
	 *   - no `thinking`
	 *   - zero `cache_control` breakpoints anywhere (short-lived request; a
	 *     breakpoint would pay the cache-write cost without ever being read)
	 */
	async performWebSearch(params: {
		model: string;
		query: string;
		allowedDomains?: string[];
		blockedDomains?: string[];
		signal?: AbortSignal;
	}): Promise<{ text: string; sources: Array<{ title?: string; url?: string }> }> {
		const metadataModel = params.model.startsWith(`${this.config.prefix}:`)
			? params.model
			: `${this.config.prefix}:${params.model}`;
		if (effectiveProviderMetadata(metadataModel).nativeSearch?.supported === false) {
			throw new Error(`Model ${params.model} does not support native search.`);
		}
		const apiKey = this.config.apiKey;
		if (!apiKey) {
			throw new Error(`Anthropic API key not configured for provider "${this.config.name}".`);
		}

		const isOfficial = !!this.config.officialApi;
		const bareModel = parseModelId(params.model).model;
		const messages: AnthropicMessage[] = [
			{ role: "user", content: `Perform a web search for the query: ${params.query}` },
		];

		const searchTool: Record<string, unknown> = {
			type: "web_search_20250305",
			name: "web_search",
			max_uses: WEB_SEARCH_MAX_USES,
		};
		if (params.allowedDomains?.length) searchTool.allowed_domains = params.allowedDomains;
		if (params.blockedDomains?.length) searchTool.blocked_domains = params.blockedDomains;

		const body: Record<string, unknown> = {
			model: bareModel,
			max_tokens: resolveOutputTokenLimit(
				effectiveProviderMetadata(metadataModel),
				undefined,
				WEB_SEARCH_MAX_TOKENS,
			)!,
			messages,
			stream: true,
			tools: [searchTool],
			tool_choice: { type: "tool", name: "web_search" },
		};
		const system = this.buildUtilitySystemBlocks(isOfficial, messages);
		if (system) body.system = system;
		const metadata = this.buildRequestMetadata(isOfficial);
		if (metadata) body.metadata = metadata;

		const headers = this.buildRequestHeaders(apiKey, isOfficial, bareModel, "text/event-stream");
		const response = await this.fetchWithV1Fallback(
			isOfficial ? "/messages?beta=true" : "/messages",
			{
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: params.signal,
			},
		);
		if (!response.ok) {
			const errText = await response.text().catch(() => "");
			throw createAnthropicApiError(response, errText);
		}
		if (!response.body) {
			throw new Error("Anthropic web search returned no body");
		}
		return collectWebSearchStream(response.body);
	}
}

// === SSE stream parser ===

/**
 * Collect the one-shot web-search side request's stream into flattened text plus
 * a source list. Minimal by design: the request forces `web_search`, disables
 * thinking, and carries no function tools, so only `text`,
 * `server_tool_use` and `web_search_tool_result` blocks can appear.
 */
async function collectWebSearchStream(
	body: ReadableStream<Uint8Array>,
): Promise<{ text: string; sources: Array<{ title?: string; url?: string }> }> {
	const decoder = new TextDecoder();
	let buffer = "";
	const textByIndex = new Map<number, string>();
	const sources: Array<{ title?: string; url?: string }> = [];
	const seenUrls = new Set<string>();
	let hasSearchResultEvidence = false;
	let stopReason: string | undefined;

	const handleEvent = (event: AnthropicStreamEvent): void => {
		const streamError = extractAnthropicStreamError(event);
		if (streamError) {
			throw new Error(`Anthropic web search error: ${streamError.message}`);
		}
		if (event.type === "message_delta" && event.delta?.stop_reason) {
			stopReason = event.delta.stop_reason;
			return;
		}
		const idx = event.index ?? 0;
		if (event.type === "content_block_start" && event.content_block) {
			const block = event.content_block;
			if (block.type === "text") {
				textByIndex.set(idx, block.text ?? "");
			} else if (block.type === "web_search_tool_result") {
				if (Array.isArray(block.content)) {
					// A completed result block proves execution, even with zero matches.
					// Neither assistant prose/URLs nor server_tool_use alone proves it.
					hasSearchResultEvidence = true;
					for (const row of block.content) {
						if (row.url && seenUrls.has(row.url)) continue;
						if (row.url) seenUrls.add(row.url);
						sources.push({ title: row.title, url: row.url });
					}
				} else if (block.content?.error_code) {
					// web_search_tool_result_error shape ({type, error_code}). Surface it
					// as a channel failure so executeSearch can fall through to the next
					// configured channel instead of reporting a confident empty result.
					throw new Error(`Anthropic web search failed: ${block.content.error_code}`);
				}
			}
			return;
		}
		if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
			textByIndex.set(idx, (textByIndex.get(idx) ?? "") + (event.delta.text ?? ""));
		}
	};

	const reader = body.getReader();
	try {
		while (true) {
			const { done, value } = await readWithTimeout(reader);
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed.startsWith("data:")) continue;
				const jsonStr = trimmed.startsWith("data: ") ? trimmed.slice(6) : trimmed.slice(5);
				let data: AnthropicStreamEvent;
				try {
					data = JSON.parse(jsonStr) as AnthropicStreamEvent;
				} catch {
					continue;
				}
				handleEvent(data);
			}
		}
	} catch (err) {
		// Bailing mid-stream (SSE error event, timeout, parse failure) leaves the
		// HTTP response open; cancel it so the connection is released immediately.
		await reader.cancel().catch(() => {});
		throw err;
	} finally {
		reader.releaseLock();
	}

	const text = [...textByIndex.entries()]
		.sort(([a], [b]) => a - b)
		.map(([, value]) => value)
		.join("\n")
		.trim();
	if (!hasSearchResultEvidence && !text && sources.length === 0) {
		// No completed search and no content: preserve the upstream stop reason
		// for diagnosis. A genuine empty result block is still a valid search.
		throw new Error(
			stopReason && stopReason !== "end_turn"
				? `Anthropic web search returned no content (stop_reason: ${stopReason})`
				: "Anthropic web search returned no content",
		);
	}
	if (!hasSearchResultEvidence) {
		throw new Error("Anthropic web search returned no search result evidence");
	}
	return { text, sources };
}

export async function* parseAnthropicSSEStream(
	body: ReadableStream<Uint8Array>,
	contextWindow?: number | null,
): AsyncGenerator<ParsedStreamEvent> {
	const decoder = new TextDecoder();
	let buffer = "";
	let lineCount = 0;

	// Tool call accumulators keyed by content block index
	const toolAccum = new Map<number, ToolAccumEntry>();
	const thinkingAccum = new Map<number, ThinkingAccumEntry>();
	const redactedThinkingAccum = new Map<number, string>();
	const serverToolAccum = new Map<number, ServerToolAccumEntry>();
	const usageAccum = createAnthropicUsageAccum();

	// Stream integrity tracking
	let receivedMessageStart = false;
	let receivedAnyContentBlock = false;
	// Track SSE event: type for gateway-injected events
	let currentEventType = "";

	const reader = body.getReader();
	try {
		while (true) {
			const { done, value } = await readWithTimeout(reader);
			if (done) break;
			buffer += decoder.decode(value, { stream: true });

			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				// Track SSE event: lines for gateway-injected events
				if (trimmed.startsWith("event:")) {
					currentEventType = trimmed.slice(6).trim();
					continue;
				}
				// Support both "data: {...}" (standard SSE) and "data:{...}" (no space)
				if (!trimmed.startsWith("data:")) continue;

				if (lineCount < 5) {
					logger.debug("Anthropic SSE line", {
						lineIndex: lineCount,
						preview: trimmed.slice(0, 300),
					});
				}
				lineCount++;

				// Extract JSON payload: skip "data: " or "data:"
				const jsonStr = trimmed.startsWith("data: ") ? trimmed.slice(6) : trimmed.slice(5);

				let data: Record<string, unknown>;
				try {
					data = JSON.parse(jsonStr);
				} catch {
					currentEventType = "";
					continue;
				}

				// Gateway-injected events: check SSE event: type first, then data-embedded type
				if (currentEventType && isGatewayEventType(currentEventType)) {
					const gwEvt = parseGatewaySSEEvent(currentEventType, data);
					currentEventType = "";
					if (gwEvt) {
						yield gwEvt;
						continue;
					}
				}
				const sseEventName = currentEventType;
				currentEventType = "";
				const gwEvt = parseGatewayDataEvent(data);
				if (gwEvt) {
					yield gwEvt;
					continue;
				}

				// Some relays/gateways send an error as `event: error` whose data
				// payload lacks a `type` field. Backfill it so extractAnthropicStreamError
				// recognizes the error instead of dropping it (which would surface to the
				// user as a misleading empty response). Mirrors the Responses parser.
				if (sseEventName === "error" && typeof data.type !== "string") {
					data.type = "error";
				}

				const event = data as unknown as AnthropicStreamEvent;

				// Track stream integrity
				if (event.type === "message_start") receivedMessageStart = true;
				if (event.type === "content_block_start") receivedAnyContentBlock = true;

				const events = parseAnthropicEvent(
					event,
					toolAccum,
					thinkingAccum,
					redactedThinkingAccum,
					serverToolAccum,
					usageAccum,
					contextWindow,
				);
				for (const evt of events) {
					yield evt;
				}
			}
		}

		// Process remaining buffer
		const remaining = buffer.trim();
		if (remaining.startsWith("data:")) {
			try {
				const jsonStr = remaining.startsWith("data: ") ? remaining.slice(6) : remaining.slice(5);
				const event = JSON.parse(jsonStr);

				if (event.type === "message_start") receivedMessageStart = true;
				if (event.type === "content_block_start") receivedAnyContentBlock = true;

				const events = parseAnthropicEvent(
					event,
					toolAccum,
					thinkingAccum,
					redactedThinkingAccum,
					serverToolAccum,
					usageAccum,
					contextWindow,
				);
				for (const evt of events) {
					yield evt;
				}
			} catch {
				// ignore
			}
		}

		// Stream integrity checks
		if (!receivedMessageStart) {
			logger.warn("Anthropic SSE stream ended without message_start event");
		} else if (!receivedAnyContentBlock) {
			logger.warn("Anthropic SSE stream had message_start but no content blocks");
		}

		// Flush un-emitted tool calls
		for (const [, acc] of toolAccum) {
			if (!acc.emitted) {
				acc.emitted = true;
				yield {
					toolUseChunk: {
						toolUseId: acc.id,
						name: acc.name,
						stop: true,
						outputIndex: acc.outputIndex,
					},
				};
			}
		}
	} finally {
		reader.releaseLock();
	}
}

/** Accumulator for thinking block signature (keyed by content_block index). */
type ThinkingAccumEntry = { signature: string; blockIndex: number };

/**
 * Robustly detect an error envelope in an Anthropic-protocol SSE event and, if
 * present, extract a `{ reason, message }` for an invalidState event.
 *
 * The native Anthropic API sends `{ type: "error", error: { type, message } }`.
 * But intermediaries (notably the narrafork unified gateway's writeSSEError, and
 * other Anthropic-compatible relays) emit different shapes such as
 * `{ code, message, error: { code, message } }` — sometimes WITHOUT a top-level
 * `type: "error"`. The original parser only matched `type === "error"` with a
 * nested `error.message`, so those gateway-style errors were silently dropped and
 * surfaced to the user as a misleading "empty response". This helper recognizes
 * all of those shapes.
 *
 * It reads fields off an untyped view of the event so a string `message` (error
 * envelope) does not collide with the object `message` used by `message_start`.
 * Normal streaming events (message_start/delta, content_block_*, ping,
 * message_delta, …) carry neither a top-level `error` object nor a top-level
 * `code` paired with a string `message`, so they are never misclassified.
 */
export function extractAnthropicStreamError(
	event: AnthropicStreamEvent,
): NonNullable<ParsedStreamEvent["invalidState"]> | null {
	const raw = event as unknown as Record<string, unknown>;
	const nested =
		raw.error && typeof raw.error === "object" ? (raw.error as Record<string, unknown>) : undefined;
	const topMessageIsString = typeof raw.message === "string";
	const hasTopCode = raw.code != null;

	const isError = raw.type === "error" || nested != null || (hasTopCode && topMessageIsString);
	if (!isError) return null;

	const nestedType = nested && nested.type != null ? nested.type : undefined;
	const nestedCode = nested && nested.code != null ? nested.code : undefined;
	const reasonCandidate =
		nestedType ?? nestedCode ?? raw.code ?? (raw.type !== "error" ? raw.type : undefined);
	const reason = reasonCandidate != null ? String(reasonCandidate) : "api_error";

	const nestedMessage =
		nested && typeof nested.message === "string" ? (nested.message as string) : undefined;
	const message =
		nestedMessage ??
		(topMessageIsString ? (raw.message as string) : undefined) ??
		`Upstream returned error ${reason || "api_error"} (no error message provided).`;

	return {
		reason: reason || "api_error",
		message,
		diagnostics: parseErrorDiagnostics(raw, {
			source: raw.diagnostics != null || raw.code != null ? "gateway" : "provider",
			phase: "sse_error",
			reason: reason || "api_error",
			message,
		}),
	};
}

export function parseAnthropicEvent(
	event: AnthropicStreamEvent,
	toolAccum: Map<number, ToolAccumEntry>,
	thinkingAccum: Map<number, ThinkingAccumEntry>,
	redactedThinkingAccum: Map<number, string>,
	serverToolAccum: Map<number, ServerToolAccumEntry>,
	usageAccum: AnthropicUsageAccum,
	contextWindow?: number | null,
): ParsedStreamEvent[] {
	// ── Error (checked first, before the `type` guard) ──
	// Error envelopes may lack a top-level `type` (gateway/relay shapes), so detect
	// them up front rather than relying on `type === "error"`. Without this, a
	// type-less error event falls through the `if (!type) return []` guard below and
	// is silently dropped, surfacing to the user as a misleading empty response.
	const streamError = extractAnthropicStreamError(event);
	if (streamError) {
		return [{ invalidState: streamError }];
	}

	const type = event.type;
	if (!type) return [];

	// ── Message start — extract message ID and usage ──
	if (type === "message_start" && event.message) {
		const results: ParsedStreamEvent[] = [];
		if (event.message.id) {
			results.push({ messageId: event.message.id });
		}
		if (event.message.usage) {
			updateAnthropicUsageAccum(usageAccum, event.message.usage);
			results.push(parsedUsageFromAnthropicAccum(usageAccum, contextWindow));
		}
		return results;
	}

	// ── Content block start ──
	if (type === "content_block_start" && event.content_block) {
		const idx = event.index ?? 0;
		const block = event.content_block;

		if (block.type === "text") {
			usageAccum.textBlocks ??= new Set();
			usageAccum.textBlocks.add(idx);
			return [
				{
					...(block.text ? { text: block.text } : {}),
					textBlockId: `anthropic:${idx}`,
					textOutputIndex: idx,
					contentBoundary: {
						kind: "text",
						phase: "start",
						blockId: `anthropic:${idx}`,
						outputIndex: idx,
					},
				},
			];
		}

		if (block.type === "tool_use" && block.id && block.name) {
			toolAccum.set(idx, {
				id: block.id,
				name: block.name,
				inputStream: new ToolInputStream(),
				emitted: false,
				outputIndex: idx,
			});
			logger.debug("Anthropic tool call started", {
				index: idx,
				toolUseId: block.id,
				toolName: block.name,
			});
			return [
				{
					toolUseChunk: {
						toolUseId: block.id,
						name: block.name,
						input: undefined,
						stop: false,
						outputIndex: idx,
					},
				},
			];
		}
		// Server-side tool use (web_search) — track but don't emit as local tool call
		if (block.type === "server_tool_use" && block.id && block.name) {
			serverToolAccum.set(idx, { id: block.id, name: block.name, args: "" });
			logger.debug("Anthropic server tool use started", {
				index: idx,
				id: block.id,
				name: block.name,
			});
			return [{ webSearch: { id: block.id, status: "in_progress" } }];
		}
		// Web search result — emit completion event
		if (block.type === "web_search_tool_result") {
			const toolUseId = block.tool_use_id ?? "";
			// Find the matching server tool entry to get the query
			let query: string | undefined;
			for (const [, acc] of serverToolAccum) {
				if (acc.id === toolUseId) {
					query = acc.query;
					break;
				}
			}
			// Check for error response
			if (block.content && !Array.isArray(block.content)) {
				const errContent = block.content as { type: string; error_code: string };
				logger.warn("Anthropic web search error", { error_code: errContent.error_code });
				return [{ webSearch: { id: toolUseId, status: "completed", query } }];
			}
			return [{ webSearch: { id: toolUseId, status: "completed", query } }];
		}
		// Thinking block start — initialize signature accumulator.
		// Some Anthropic-compatible APIs (notably DeepSeek relays) put the
		// first/full thinking text directly on content_block_start instead of
		// emitting Anthropic's standard thinking_delta events. Treat it as
		// reasoning so it is persisted and replayed as a thinking block on the
		// next request.
		if (block.type === "thinking") {
			thinkingAccum.set(idx, { signature: block.signature ?? "", blockIndex: idx });
			const initialThinking = block.thinking ?? block.reasoning_content ?? block.text;
			if (initialThinking) {
				return [
					{
						reasoning: initialThinking,
						reasoningBlockId: `anthropic:${idx}`,
						reasoningMetadata: { anthropic: { blockIndex: idx } },
						reasoningOutputIndex: idx,
					},
				];
			}
			return [
				{
					contentBoundary: {
						kind: "reasoning",
						phase: "start",
						blockId: `anthropic:${idx}`,
						outputIndex: idx,
					},
				},
			];
		}
		// Redacted thinking arrives as a complete content block. Match Claude Code's
		// contentBlocks[index] flow by waiting for content_block_stop before emitting
		// the completed block for persistence/replay.
		if (block.type === "redacted_thinking" && block.data) {
			redactedThinkingAccum.set(idx, block.data);
			return [];
		}
		return [];
	}

	// ── Content block delta ──
	if (type === "content_block_delta" && event.delta) {
		const idx = event.index ?? 0;

		// Thinking delta (extended thinking).
		// Official Anthropic streams use `thinking_delta.thinking`; a few
		// Anthropic-compatible relays stream a thinking content block using
		// `text_delta.text` or `reasoning_content` instead. If the current block
		// index was introduced as `type: "thinking"`, route those deltas to the
		// reasoning channel rather than visible assistant text.
		const isThinkingBlockDelta = event.delta.type === "thinking_delta" || thinkingAccum.has(idx);
		const thinkingDelta = event.delta.thinking ?? event.delta.reasoning_content ?? event.delta.text;
		if (isThinkingBlockDelta && thinkingDelta != null) {
			if (!thinkingAccum.has(idx)) thinkingAccum.set(idx, { signature: "", blockIndex: idx });
			return [
				{
					reasoning: thinkingDelta,
					reasoningBlockId: `anthropic:${idx}`,
					reasoningMetadata: { anthropic: { blockIndex: idx } },
					reasoningOutputIndex: idx,
				},
			];
		}

		// Text delta
		if (event.delta.type === "text_delta" && event.delta.text != null) {
			usageAccum.textBlocks ??= new Set();
			usageAccum.textBlocks.add(idx);
			return [{ text: event.delta.text, textOutputIndex: idx, textBlockId: `anthropic:${idx}` }];
		}

		// Signature delta — assign (Anthropic sends one per thinking block)
		if (event.delta.type === "signature_delta" && event.delta.signature) {
			const acc = thinkingAccum.get(idx);
			if (acc) {
				acc.signature = event.delta.signature;
			}
			return [];
		}

		// Tool use input delta
		if (event.delta.type === "input_json_delta" && event.delta.partial_json != null) {
			// Server tool accumulator — extract query for web search progress
			const serverAcc = serverToolAccum.get(idx);
			if (serverAcc) {
				serverAcc.args += event.delta.partial_json;
				try {
					const match = serverAcc.args.match(/"query"\s*:\s*"((?:[^"\\]|\\.)*)"/);
					if (match?.[1]) {
						serverAcc.query = JSON.parse(`"${match[1]}"`);
						return [
							{ webSearch: { id: serverAcc.id, status: "searching", query: serverAcc.query } },
						];
					}
				} catch {
					// ignore partial JSON parse errors
				}
				return [];
			}

			const acc = toolAccum.get(idx);
			if (acc && !acc.emitted) {
				toolInputStreamFor(acc).feed(event.delta.partial_json);
				const results: ParsedStreamEvent[] = [
					{
						toolUseChunk: {
							toolUseId: acc.id,
							name: acc.name,
							input: event.delta.partial_json,
							stop: false,
							outputIndex: idx,
						},
					},
				];
				// Early completion if args form valid JSON
				if (toolInputStreamFor(acc).hasCompleteInput()) {
					results.push({
						toolUseChunk: {
							toolUseId: acc.id,
							name: acc.name,
							stop: true,
							outputIndex: acc.outputIndex,
						},
					});
					acc.emitted = true;
				}
				return results;
			}
		}
		// Unknown delta type — log for diagnostics
		logger.debug("Unknown Anthropic content_block_delta type", {
			deltaType: event.delta.type,
			index: idx,
		});
		return [];
	}

	// ── Content block stop ──
	if (type === "content_block_stop") {
		const idx = event.index ?? 0;
		const acc = toolAccum.get(idx);
		if (acc && !acc.emitted) {
			acc.emitted = true;
			return [
				{
					toolUseChunk: {
						toolUseId: acc.id,
						name: acc.name,
						stop: true,
						outputIndex: acc.outputIndex,
					},
				},
			];
		}
		// Thinking block stop — emit signature as reasoning metadata
		const thinkAcc = thinkingAccum.get(idx);
		if (thinkAcc) {
			thinkingAccum.delete(idx);
			const results: ParsedStreamEvent[] = [];
			if (thinkAcc.signature) {
				results.push({
					reasoningMetadata: {
						anthropic: { blockIndex: thinkAcc.blockIndex, signature: thinkAcc.signature },
					},
					reasoningBlockId: `anthropic:${idx}`,
					reasoningOutputIndex: thinkAcc.blockIndex,
				});
			}
			results.push({
				contentBoundary: {
					kind: "reasoning",
					phase: "complete",
					blockId: `anthropic:${idx}`,
					outputIndex: idx,
				},
			});
			return results;
		}
		if (usageAccum.textBlocks?.delete(idx)) {
			return [
				{
					contentBoundary: {
						kind: "text",
						phase: "complete",
						blockId: `anthropic:${idx}`,
						outputIndex: idx,
					},
				},
			];
		}

		const redactedData = redactedThinkingAccum.get(idx);
		if (redactedData) {
			redactedThinkingAccum.delete(idx);
			return [{ redactedThinking: { data: redactedData, outputIndex: idx } }];
		}
		return [];
	}

	// ── Message delta (stop reason, usage) ──
	if (type === "message_delta") {
		const results: ParsedStreamEvent[] = [];

		// Flush un-emitted tool calls
		for (const [, acc] of toolAccum) {
			if (!acc.emitted) {
				results.push({
					toolUseChunk: {
						toolUseId: acc.id,
						name: acc.name,
						stop: true,
						outputIndex: acc.outputIndex,
					},
				});
				acc.emitted = true;
			}
		}

		// Usage update. Anthropic streaming usage is cumulative; preserve input/cache
		// values from message_start while applying the final output_tokens from delta.
		if (event.usage) {
			updateAnthropicUsageAccum(usageAccum, event.usage);
			results.push(parsedUsageFromAnthropicAccum(usageAccum, contextWindow));
		}

		// Stop reason — always propagate to loop layer
		const stopReason = event.delta?.stop_reason;
		if (stopReason) {
			results.push({ stopReason });

			// Critical stop reasons → invalidState for special handling
			if (stopReason === "max_tokens") {
				const message = "Upstream returned stop_reason=max_tokens (no error message provided).";
				results.push({
					invalidState: {
						reason: "max_tokens",
						message,
						diagnostics: parseErrorDiagnostics(
							{ reason: "max_tokens", message },
							{ source: "provider", phase: "stop_reason", reason: "max_tokens", message },
						),
					},
				});
			} else if (stopReason === "model_context_window_exceeded") {
				const message =
					"Upstream returned stop_reason=model_context_window_exceeded (no error message provided).";
				results.push({
					invalidState: {
						reason: "model_context_window_exceeded",
						message,
						diagnostics: parseErrorDiagnostics(
							{ reason: stopReason, message },
							{ source: "provider", phase: "stop_reason", reason: stopReason, message },
						),
					},
				});
			} else if (stopReason === "refusal") {
				const message = "Upstream returned stop_reason=refusal (no error message provided).";
				results.push({
					invalidState: {
						reason: "refusal",
						message,
						diagnostics: parseErrorDiagnostics(
							{ reason: "refusal", message },
							{ source: "provider", phase: "stop_reason", reason: "refusal", message },
						),
					},
				});
			}
		}

		return results;
	}

	// Error events are handled up front by extractAnthropicStreamError above.

	return [];
}

// === History builder ===

async function buildAnthropicHistory(
	dbMessages: DbMessage[],
	currentReasoningSource?: string,
	useMidConversationSystemRole = false,
	narratorId?: string,
	strictReasoning = false,
): Promise<{
	history: AnthropicMessage[];
	trailingToolResults: Array<{ tool_use_id: string; content: string; is_error?: boolean }>;
	trailingUserText?: string;
}> {
	// Filter model-visible messages: user, assistant, sys (system context)
	// Exclude: system (legacy, kept for backward compatibility), disp (UI-only display messages)
	const topLevel = dbMessages.filter(
		(m) => !m.parentToolUseId && (m.role === "user" || m.role === "assistant" || m.role === "sys"),
	);

	// Trailing `sys` rows are fresh model-visible context (a Dynamic Spec reminder,
	// a goal continuation). They are lifted out of history and returned so the
	// caller can send them as the CURRENT turn.
	//
	// Position is the whole point: left in history they become the last thing
	// before the current turn, so the model reads them as background rather than as
	// what it was just asked. The injection still arrives either way, which is why
	// getting this wrong is invisible — the model simply weights it lower.
	//
	// Only when the mid-conversation system role is unavailable. With
	// `officialApi` the row stays in history as `role:"system"`, which already
	// marks it as standing instruction — that is deliberate Claude Code behaviour
	// and must not be rewritten.
	const trailingSysMessages: DbMessage[] = [];
	if (!useMidConversationSystemRole) {
		while (topLevel.length > 0 && topLevel[topLevel.length - 1].role === "sys") {
			const message = topLevel.pop();
			if (message) trailingSysMessages.unshift(message);
		}
	}
	const trailingSysText = trailingSysMessages
		.map((message) => dbMessageVisibleText(message))
		.filter(Boolean)
		.join("\n\n");

	// Drop the last user message — it's sent as the current message
	if (topLevel.length > 0 && topLevel[topLevel.length - 1].role === "user") {
		topLevel.pop();
	}

	const history: AnthropicMessage[] = [];
	let pendingToolResults: Array<{ tool_use_id: string; content: string; is_error?: boolean }> = [];

	for (const msg of topLevel) {
		if (msg.role === "assistant") {
			// Flush pending tool results as a user message
			if (pendingToolResults.length > 0) {
				history.push({
					role: "user",
					content: pendingToolResults.map((tr) => ({
						type: "tool_result" as const,
						tool_use_id: tr.tool_use_id,
						content: tr.content,
						is_error: tr.is_error,
					})),
				});
				pendingToolResults = [];
			}

			const content = Array.isArray(msg.contentJson) ? msg.contentJson : [];
			const parts: AnthropicContentPart[] = [];

			// Web search blocks — inject as user context before the assistant message
			const webSearchBlocks = content.filter(
				(b: { type: string }) => b.type === "web_search",
			) as Array<{ type: "web_search"; query?: string; queries?: string[] }>;
			if (webSearchBlocks.length > 0) {
				const searchSummary = webSearchBlocks
					.map((ws) => {
						const q = ws.query || ws.queries?.join(", ") || "unknown";
						return `[Web search: ${q}]`;
					})
					.join("\n");
				history.push({ role: "user", content: searchSummary });
			}

			// Build a set of completed tool call IDs for filtering
			const completedToolUseIds = new Set(
				msg.toolCalls
					?.filter((tc) => tc.status === "success" || tc.status === "fail")
					.map((tc) => tc.toolUseId) ?? [],
			);

			// Build a map of tool call data for quick lookup
			const toolCallMap = new Map<
				string,
				{ toolName: string; toolUseId: string; inputJson: unknown }
			>();
			if (msg.toolCalls) {
				for (const tc of msg.toolCalls) {
					if (tc.toolName && tc.toolUseId && completedToolUseIds.has(tc.toolUseId)) {
						toolCallMap.set(tc.toolUseId, tc);
					}
				}
			}

			// Track which tool_use IDs have been emitted via contentJson blocks
			const emittedToolUseIds = new Set<string>();

			// Single-pass: iterate contentJson in original order to preserve
			// interleaved thinking block positions (required by interleaved-thinking beta).
			for (const b of content) {
				const block = b as {
					type: string;
					thinking?: string;
					text?: string;
					signature?: string;
					data?: string;
					id?: string;
					name?: string;
					input?: Record<string, unknown>;
					signatureSource?: string;
					providerMetadata?: { anthropic?: { signature?: string }; signatureSource?: string };
				};
				if (block.type === "thinking" && block.thinking) {
					// Legacy shape: signature stored on the block directly, with the
					// source (if any) on providerMetadata. Strict models only echo the
					// signature back when it was minted by the current upstream; relay
					// models mint no signatures, so their text is always preserved and
					// an absent signature stays empty.
					const sig = strictReasoning
						? signatureSourcesCompatible(
								block.providerMetadata?.signatureSource,
								currentReasoningSource,
							)
							? (block.signature ?? "")
							: ""
						: (block.signature ?? "");
					parts.push({
						type: "thinking",
						thinking: block.thinking,
						signature: sig,
					});
				} else if (block.type === "reasoning" && block.text) {
					// DB stores thinking as "reasoning" blocks with signature in providerMetadata.
					// Strict models drop the signature when it belongs to a different
					// upstream server (e.g. a different NUG channel), since replaying it
					// would fail signature verification. Relay models skip the source
					// check entirely — their reasoning text crosses upstreams freely.
					const sig = strictReasoning
						? signatureSourcesCompatible(
								block.providerMetadata?.signatureSource,
								currentReasoningSource,
							)
							? (block.providerMetadata?.anthropic?.signature ?? "")
							: ""
						: (block.providerMetadata?.anthropic?.signature ?? "");
					parts.push({
						type: "thinking",
						thinking: block.text,
						signature: sig,
					});
				} else if (block.type === "redacted_thinking" && block.data) {
					// Encrypted thinking is server-specific — only replay it to the
					// upstream that produced it. When the source does not match (or is
					// unknown on legacy messages), drop the block entirely rather than
					// echo an opaque payload the current server cannot validate. Relay
					// models never validate it either, and the block carries no text
					// worth preserving, so it is dropped for them unconditionally.
					if (
						strictReasoning &&
						signatureSourcesCompatible(block.signatureSource, currentReasoningSource)
					) {
						parts.push({ type: "redacted_thinking", data: block.data });
					}
				} else if (block.type === "text" && block.text) {
					parts.push({ type: "text", text: block.text });
				} else if (block.type === "tool_use" && block.id) {
					// contentJson may store tool_use blocks directly; use them if
					// the tool call is completed, otherwise look up from toolCalls.
					const tc = toolCallMap.get(block.id);
					if (tc) {
						let input: Record<string, unknown> = {};
						try {
							input =
								typeof tc.inputJson === "string"
									? JSON.parse(tc.inputJson)
									: ((tc.inputJson as Record<string, unknown>) ?? {});
						} catch {
							input = {};
						}
						parts.push({
							type: "tool_use",
							id: tc.toolUseId,
							name: tc.toolName,
							input,
						});
						emittedToolUseIds.add(tc.toolUseId);
					}
				}
				// Skip web_search, image_generation, and other non-API block types
			}

			// Append any completed tool calls not already emitted via contentJson
			// (backward compat: older messages may not have tool_use in contentJson)
			for (const [toolUseId, tc] of toolCallMap) {
				if (!emittedToolUseIds.has(toolUseId)) {
					let input: Record<string, unknown> = {};
					try {
						input =
							typeof tc.inputJson === "string"
								? JSON.parse(tc.inputJson)
								: ((tc.inputJson as Record<string, unknown>) ?? {});
					} catch {
						input = {};
					}
					parts.push({
						type: "tool_use",
						id: tc.toolUseId,
						name: tc.toolName,
						input,
					});
				}
			}

			// If no text block was found in contentJson, fall back to contentText
			if (!parts.some((p) => p.type === "text") && msg.contentText) {
				// Insert text before the first tool_use block
				const firstToolIdx = parts.findIndex((p) => p.type === "tool_use");
				const textPart: AnthropicContentPart = { type: "text", text: msg.contentText };
				if (firstToolIdx >= 0) {
					parts.splice(firstToolIdx, 0, textPart);
				} else {
					parts.push(textPart);
				}
			}

			if (parts.length > 0) {
				ensureTextOrToolBlock(parts);
				history.push({ role: "assistant", content: parts });
			}

			// Collect tool results for next turn
			if (msg.toolCalls) {
				for (const tc of msg.toolCalls) {
					if (tc.status === "success" || tc.status === "fail") {
						pendingToolResults.push({
							tool_use_id: tc.toolUseId,
							content: outputToText(tc.outputJson),
							is_error: tc.status === "fail" || undefined,
						});
					}
				}
			}
		} else if (msg.role === "user" || msg.role === "sys") {
			// Flush pending tool results before the next model-visible context message.
			// Official Claude Code requests retain sys rows as mid-conversation system
			// messages; compatible relays receive the historical user-role fallback.
			if (pendingToolResults.length > 0) {
				history.push({
					role: "user",
					content: pendingToolResults.map((tr) => ({
						type: "tool_result" as const,
						tool_use_id: tr.tool_use_id,
						content: tr.content,
						is_error: tr.is_error,
					})),
				});
				pendingToolResults = [];
			}

			const content = Array.isArray(msg.contentJson) ? msg.contentJson : [];
			const text = modelTextFromContentBlocks(content) || msg.contentText || "";

			// Images attached to a past user turn have to be rebuilt from disk: the
			// row stores an imageId, not the bytes. This branch previously read text
			// only, so every history image was dropped and a follow-up question
			// about an earlier screenshot reached the model with nothing to look at.
			const images = await resolveHistoryImages(msg, narratorId);

			const role = msg.role === "sys" && useMidConversationSystemRole ? "system" : "user";
			if (images.length > 0) {
				// A mid-conversation system message cannot carry image parts, so an
				// image forces the user role. That only affects `sys` rows, which do
				// not carry uploads in practice.
				const parts: AnthropicContentPart[] = [...images];
				if (text) parts.unshift({ type: "text", text });
				history.push({ role: "user", content: parts });
			} else if (text) {
				history.push({ role, content: text });
			}
		}
	}

	return {
		history,
		trailingToolResults: pendingToolResults,
		trailingUserText: trailingSysText || undefined,
	};
}

/**
 * Text of a stored message as the model would see it.
 *
 * Reads the structured blocks first and falls back to the flat column, matching
 * how the other history builders read a row: `contentText` is not always populated
 * for rows written through the block path.
 */
function dbMessageVisibleText(msg: DbMessage): string {
	const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];
	return modelTextFromContentBlocks(blocks) || msg.contentText || "";
}

/**
 * Rebuild the image parts of a past user message from disk.
 *
 * Returns an empty array when there is nothing to replay, which covers the common
 * case (no images) as well as every failure: a missing file, an unreadable file, or
 * a message whose owning narrator is unknown. Failures are logged and skipped
 * rather than thrown — losing one image from replayed history is bad, but failing
 * the whole turn because an old upload was cleaned up is worse.
 *
 * Mirrors the Responses-API implementation in `openai-provider.ts`; the two differ
 * only in the content-part shape each protocol expects.
 */
async function resolveHistoryImages(
	msg: DbMessage,
	narratorId?: string,
): Promise<Array<{ type: "image"; source: { type: "base64"; media_type: string; data: string } }>> {
	const ownerNarratorId = msg.narratorId ?? narratorId;
	if (!ownerNarratorId || !Array.isArray(msg.contentJson)) return [];

	const blocks = (msg.contentJson as Array<Record<string, unknown>>).filter(
		(block) => block.type === "image" && typeof block.imageId === "string",
	);
	if (blocks.length === 0) return [];

	const parts: Array<{
		type: "image";
		source: { type: "base64"; media_type: string; data: string };
	}> = [];
	for (const block of blocks) {
		const imageId = block.imageId as string;
		const uploadNarratorId =
			typeof block.uploadNarratorId === "string" ? block.uploadNarratorId : ownerNarratorId;
		const filePath = getImagePath(uploadNarratorId, imageId);
		if (!filePath) {
			logger.warn("Anthropic history image missing on disk; skipping replay", {
				messageId: msg.id,
				uploadNarratorId,
				imageId,
			});
			continue;
		}
		try {
			const result = await imageToBase64(filePath);
			// The detected type wins over the stored one: a file renamed or saved
			// with the wrong extension would otherwise be declared as a media type
			// its bytes contradict, which the API rejects.
			const mediaType =
				result.detectedMediaType ??
				(typeof block.mediaType === "string" ? block.mediaType : "image/png");
			parts.push({
				type: "image",
				source: { type: "base64", media_type: mediaType, data: result.base64 },
			});
		} catch (error) {
			logger.warn("Failed to rebuild Anthropic history image; skipping replay", {
				messageId: msg.id,
				uploadNarratorId,
				imageId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return parts;
}

// === Helpers ===

/**
 * Flatten a mid-conversation system message down to its text.
 *
 * Wire messages fed back in (a caller replaying a previous request body) can
 * carry the array shape `applyFinalCacheBreakpoint` produces, so both forms have
 * to be readable here. Any `cache_control` marker is discarded — the request path
 * re-derives breakpoints from scratch on every turn.
 */
function systemMessageText(message: AnthropicMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n\n");
}

/**
 * Ensure user/assistant messages alternate while preserving official
 * mid-conversation system messages as independent entries.
 *
 * Mid-conversation system turns are buffered rather than emitted where they sit,
 * because the API constrains their position:
 *
 *   `role 'system' must precede an 'assistant' message or end the array`
 *
 * NarraFork's `sys` rows are injected asynchronously from all over the product —
 * container events, review feedback, merge summaries, session prompts — so their
 * chronological position is arbitrary. Emitted verbatim they routinely land in
 * front of a user turn (including the current one, which `chat` appends last),
 * or back to back with another `sys` row, and the request 400s at that index for
 * the rest of the conversation.
 *
 * `claude-cli` solves it with the same buffer: its `api_system` entries live in a
 * pending list that is flushed immediately before it pushes an assistant turn and
 * once more when the array ends, and a flush whose predecessor is not a user turn
 * is emitted as a plain user message instead. That yields
 * exactly two legal shapes — `user, system, assistant` and `user, system` at the
 * end — and never puts a system message after an assistant, which would also
 * break user/assistant alternation. This mirrors it.
 */
function ensureAlternating(messages: AnthropicMessage[]): AnthropicMessage[] {
	if (messages.length === 0) return messages;

	/** Check if a message has usable content (non-empty string or non-empty array). */
	function hasContent(m: AnthropicMessage): boolean {
		if (typeof m.content === "string") return m.content.length > 0;
		if (Array.isArray(m.content)) return m.content.length > 0;
		return false;
	}

	const result: AnthropicMessage[] = [];
	/** Mid-conversation system text awaiting a legal position. */
	const pendingSystem: string[] = [];

	const pushOrMerge = (message: AnthropicMessage): void => {
		const last = result[result.length - 1];
		if (last && last.role === message.role && last.role !== "system") {
			last.content = [...toContentParts(last.content), ...toContentParts(message.content)];
			return;
		}
		result.push(message);
	};

	const flushSystem = (): void => {
		if (pendingSystem.length === 0) return;
		const text = pendingSystem.join("\n\n");
		pendingSystem.length = 0;
		// Only a user turn may be followed by a system turn. Anywhere else the
		// directive is delivered as user content, exactly as the CLI does.
		if (result[result.length - 1]?.role === "user") {
			result.push({ role: "system", content: text });
			return;
		}
		pushOrMerge({ role: "user", content: [{ type: "text", text }] });
	};

	for (const msg of messages) {
		if (msg.role === "system") {
			const text = systemMessageText(msg);
			if (text) pendingSystem.push(text);
			continue;
		}

		const normalized: AnthropicMessage = {
			role: msg.role,
			content:
				typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : msg.content,
		};
		if (!hasContent(normalized)) continue;

		// The buffer is released right before the assistant turn it precedes, so the
		// message that follows a system entry is always that assistant turn.
		if (normalized.role === "assistant") flushSystem();
		pushOrMerge(normalized);
	}
	// Anything still buffered ends the array, the other legal position.
	flushSystem();

	const filtered = result.filter(hasContent);
	if (filtered.length > 0 && filtered[0].role !== "user") {
		filtered.unshift({ role: "user", content: [{ type: "text", text: "…" }] });
	}

	return filtered;
}

function toContentParts(content: string | AnthropicContentPart[]): AnthropicContentPart[] {
	if (typeof content === "string") {
		return [{ type: "text", text: content }];
	}
	return content;
}

/**
 * Remove thinking / redacted_thinking content blocks from all assistant messages.
 * Mutates the messages array in place. This is needed when sending history to
 * Anthropic-compatible APIs that don't support thinking mode — if thinking blocks
 * are present in the history but the request doesn't enable thinking, the API
 * returns a 400 error.
 */
function stripThinkingBlocks(messages: AnthropicMessage[]): void {
	for (const msg of messages) {
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		const filtered = (msg.content as AnthropicContentPart[]).filter(
			(b) => b.type !== "thinking" && b.type !== "redacted_thinking",
		);
		if (filtered.length !== (msg.content as AnthropicContentPart[]).length) {
			// Ensure at least one text block remains (API requires non-empty content)
			if (!filtered.some((b) => b.type === "text" || b.type === "tool_use")) {
				filtered.push({ type: "text", text: "…" });
			}
			msg.content = filtered;
		}
	}
}

const RELAY_SYNTHETIC_THINKING = " ";

/**
 * Sanitize thinking blocks for relay models behind Anthropic-compatible gateways
 * (generalized from the DeepSeek case). Those gateways don't support
 * redacted_thinking, so it is dropped; thinking text is always preserved and
 * replayed with an empty signature when the upstream supplied none — relay
 * models mint no signatures at all, and echoing the text back is what keeps
 * their reasoning continuity intact.
 */
function sanitizeRelayThinkingBlocks(messages: AnthropicMessage[]): void {
	for (const msg of messages) {
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		const parts = msg.content as AnthropicContentPart[];
		const filtered: AnthropicContentPart[] = [];
		for (const block of parts) {
			if (block.type === "redacted_thinking") continue;
			if (block.type !== "thinking") {
				filtered.push(block);
				continue;
			}

			filtered.push(block.signature?.trim() ? block : { ...block, signature: "" });
		}

		if (
			!filtered.some((b) => b.type === "thinking" || b.type === "text" || b.type === "tool_use")
		) {
			filtered.push({ type: "text", text: "…" });
		}
		msg.content = filtered;
	}
	patchMissingThinkingBlocks(messages);
}

/**
 * Relay gateways in thinking mode require thinking blocks on historical
 * assistant messages. When authentic reasoning is unavailable, use a
 * single-space placeholder with an empty signature. Neither value is persisted.
 */
function patchMissingThinkingBlocks(messages: AnthropicMessage[]): void {
	for (const msg of messages) {
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		const parts = msg.content as AnthropicContentPart[];
		const hasThinking = parts.some((b) => b.type === "thinking");
		if (hasThinking) continue;
		parts.unshift({
			type: "thinking",
			thinking: RELAY_SYNTHETIC_THINKING,
			signature: "",
		});
	}
}

function isThinkingBlock(block: AnthropicContentPart): boolean {
	return block.type === "thinking" || block.type === "redacted_thinking";
}

/**
 * Strip trailing thinking/redacted_thinking blocks from the last assistant message.
 * The Anthropic API doesn't allow assistant messages to end with thinking blocks —
 * they must end with text or tool_use. This typically happens when a streaming
 * response is interrupted after emitting thinking but before emitting text/tool_use.
 *
 * Ref: Claude Code (un) filterTrailingThinkingFromLastAssistant
 */
function stripTrailingThinkingFromLastAssistant(messages: AnthropicMessage[]): void {
	if (messages.length === 0) return;
	const last = messages[messages.length - 1];
	if (last.role !== "assistant" || !Array.isArray(last.content)) return;

	const content = last.content as AnthropicContentPart[];
	if (content.length === 0) return;

	const lastBlock = content[content.length - 1];
	if (!isThinkingBlock(lastBlock)) return;

	// Find last non-thinking block
	let lastValidIndex = content.length - 1;
	while (lastValidIndex >= 0 && isThinkingBlock(content[lastValidIndex])) {
		lastValidIndex--;
	}

	if (lastValidIndex < 0) {
		// All blocks were thinking — replace with placeholder
		last.content = [{ type: "text", text: "…" }];
	} else {
		last.content = content.slice(0, lastValidIndex + 1);
	}
}

/**
 * Filter out assistant messages that contain ONLY thinking/redacted_thinking blocks
 * (no text, tool_use, or other content). These "orphaned" thinking-only messages
 * can appear when:
 * - A streaming response is interrupted after emitting thinking but before text/tool_use
 * - Messages are compacted and intervening messages are removed
 *
 * Such messages cause "thinking blocks cannot be modified" API errors when replayed.
 * When removed, we must ensure the remaining messages still alternate user/assistant.
 *
 * Ref: Claude Code (un) filterOrphanedThinkingOnlyMessages
 */
function filterThinkingOnlyAssistantMessages(messages: AnthropicMessage[]): void {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

		const content = msg.content as AnthropicContentPart[];
		if (content.length === 0) continue;

		const allThinking = content.every((b) => isThinkingBlock(b));
		if (allThinking) {
			logger.debug("Dropping thinking-only assistant message before API call", {
				index: i,
				blockCount: content.length,
			});
			messages.splice(i, 1);
		}
	}
}

/**
 * Drop `thinking` blocks whose text is empty, anywhere in the history.
 *
 * The API requires every thinking block to be non-empty and rejects the whole
 * request otherwise ("messages.N.content.M.thinking: ... too short"). Because the
 * offending block sits in replayed history, the failure is not transient: every
 * subsequent turn re-sends the same block at the same index and fails
 * identically, wedging the conversation permanently.
 *
 * The producers are guarded at their source, but this runs on every request as a
 * last line of defence, because histories persisted before those guards existed
 * are still on disk. It is deliberately position-agnostic:
 * `filterThinkingOnlyAssistantMessages` only removes messages where *every* block
 * is thinking, and `stripTrailingThinkingFromLastAssistant` only looks at the tail
 * of the final message — an empty thinking block sitting at `content[0]` of a
 * mid-history message alongside text/tool_use escapes both.
 *
 * Blocks are dropped rather than padded: a thinking signature is cryptographically
 * bound to its original text, so substituting filler text would trade a length
 * error for a signature verification failure. `redacted_thinking` is untouched —
 * it legitimately carries no text, only opaque `data`.
 */
function dropEmptyThinkingBlocks(messages: AnthropicMessage[]): void {
	for (const msg of messages) {
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		const content = msg.content as AnthropicContentPart[];
		const kept = content.filter(
			(b) => b.type !== "thinking" || (typeof b.thinking === "string" && b.thinking.trim() !== ""),
		);
		if (kept.length === content.length) continue;
		logger.debug("Dropping empty thinking block before API call", {
			removed: content.length - kept.length,
			remaining: kept.length,
		});
		msg.content = kept;
	}
}

/**
 * Drop `thinking` blocks that carry no signature this upstream would accept.
 *
 * A thinking signature is minted by one specific server and proves the block's
 * text came from that server's model. There is no "unsigned thinking" wire form:
 * the official API answers `messages.N.content.M: Invalid \`signature\` in
 * \`thinking\` block` for an empty or foreign signature, and because the offending
 * block lives in replayed history the failure repeats identically on every
 * subsequent turn — the conversation is wedged permanently, not transiently.
 *
 * Two producers create such blocks, both deliberately:
 *   - `buildAnthropicHistory` blanks the signature when the stored
 *     `signatureSource` does not match this provider (a cross-provider fork, a
 *     different NUG channel, a renamed provider prefix, or any message persisted
 *     before `signatureSource` existed). Echoing a foreign signature would fail
 *     verification, so blanking it was the safe half of the decision — but
 *     keeping the text alongside a blank signature is not a legal request.
 *   - `pushAssistantTurn` defaults the signature to `""` when a stream died
 *     between `content_block_start` and `signature_delta`.
 *
 * Dropping is what Anthropic prescribes for exactly this case: thinking blocks are
 * "passed back unchanged on the same model; other models drop them silently
 * (unbilled — nothing to strip)". `claude-cli` never emits an unsigned block over
 * the wire either — the one place it builds `{ thinking, signature: "" }`, the
 * interrupt handler, marks the message virtual so the normalizer excludes it.
 *
 * The cost is reasoning continuity for that turn, and — when the dropped block
 * belonged to the final assistant message before a `tool_result` — the loss of the
 * thinking the API prefers to see there. Both are strictly better than a request
 * that cannot succeed at all.
 *
 * `redacted_thinking` is not handled here: `buildAnthropicHistory` already drops
 * it outright on a source mismatch, since its payload is opaque and carries no
 * text worth preserving.
 */
function dropUnreplayableThinkingBlocks(messages: AnthropicMessage[]): void {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		const content = msg.content as AnthropicContentPart[];
		const kept = content.filter(
			(b) => b.type !== "thinking" || (typeof b.signature === "string" && b.signature !== ""),
		);
		if (kept.length === content.length) continue;
		logger.debug("Dropping unsignable thinking block before API call", {
			index: i,
			removed: content.length - kept.length,
			remaining: kept.length,
		});
		// Nothing survived: the message was an interrupted-stream artifact that held
		// only unusable thinking. Leaving `content: []` behind would trade the
		// signature error for an empty-content one, and the filters that would
		// normally clean this up both skip zero-length content.
		if (kept.length === 0) {
			messages.splice(i, 1);
			continue;
		}
		msg.content = kept;
	}
}
