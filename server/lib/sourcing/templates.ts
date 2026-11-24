/**
 * Service templates: how one kind of upstream is used, without any user data
 * (docs/PROVIDER-SOURCING-DESIGN.md §15.2).
 *
 * The behaviours (quota probe, then model list, availability, import dedupe) are attached
 * by the S2 PRs as each caller moves onto templates.
 */
import type { QuotaSnapshot } from "@shared/quota-snapshot";
import type { ServiceTemplateId, SourceProtocol, SourceRegion } from "@shared/sourcing/identify";
import type { CredentialAuth } from "../credential-store";
import { probeDeepSeekQuota } from "../deepseek-balance-cache";
import { probeKimiQuota } from "../kimi-usage-cache";
import { probeOpencodeQuota } from "../opencode-usage-cache";
import { probeRelayQuota } from "../provider-balance-cache";
import type { UsageSubject } from "../provider-key-subjects";
import type { CustomApiProviderConfig } from "../settings/types";
import type { SourceGroupView } from "./source-groups";

export type { ServiceTemplateId } from "@shared/sourcing/identify";

/** `known`: the user only adds a credential. `api`: the user adds an endpoint + key. */
export type ServiceTemplateKind = "known" | "api";

/** Credential login kinds; `opaque` is a plugin's secret-field bag. */
export type AuthKind = CredentialAuth["kind"] | "opaque";

export type ProtocolEndpoints = Partial<Record<SourceProtocol, string>>;

export interface ServiceTemplate {
	id: ServiceTemplateId;
	kind: ServiceTemplateKind;
	/** Prefix a new group prefers; taken prefixes get the usual numeric suffix. */
	preferredPrefix?: string;
	/** Official endpoint per protocol for a `known` template without regions. */
	endpoints?: ProtocolEndpoints;
	/** Regional endpoints; keys from different regions are not interchangeable. */
	regions?: Partial<Record<SourceRegion, ProtocolEndpoints>>;
	authKinds: readonly AuthKind[];
	/** Several credentials can share the group's pool. */
	multiCredential: boolean;
	/** Plan allowance windows rather than pay-per-use. */
	subscription: boolean;
	/** Advanced options the template presets on a new group. */
	defaults?: Partial<Pick<CustomApiProviderConfig, "userAgentMode">>;
	/** A user may add a personal credential here (S4). */
	personal: boolean;
	/**
	 * Read one credential's allowance (sourcing/quota-store.ts keeps the result). Templates
	 * without it have no quota to show. Throws when the upstream cannot answer.
	 */
	probeQuota?: (
		group: SourceGroupView,
		credential: UsageSubject,
		signal: AbortSignal,
	) => Promise<QuotaSnapshot>;
}

type ProbeQuota = NonNullable<ServiceTemplate["probeQuota"]>;

/**
 * Kimi Code and OpenCode Go answer per key; DeepSeek and relay balances per provider, so
 * their caches probe the group's first credential (§15.4). Relays are probed on every
 * endpoint that is not a dedicated service, official APIs included, as before.
 */
const relay: ProbeQuota = (_group, credential, signal) => probeRelayQuota(credential, signal);
const QUOTA_PROBES: Partial<Record<ServiceTemplateId, ProbeQuota>> = {
	"kimi-code": (_group, credential, signal) => probeKimiQuota(credential, signal),
	"opencode-go": (_group, credential, signal) => probeOpencodeQuota(credential, signal),
	deepseek: (_group, credential, signal) => probeDeepSeekQuota(credential, signal),
	openai: relay,
	anthropic: relay,
	gemini: relay,
	"openai-compatible": relay,
	"anthropic-compatible": relay,
	"gemini-compatible": relay,
};

const KIMI_CODE = (host: string): ProtocolEndpoints => ({
	"anthropic-messages": `https://${host}/coding/v1`,
	"completions-compatible": `https://${host}/coding/v1`,
	"openai-responses": `https://${host}/coding/v1`,
});

const TEMPLATES: readonly ServiceTemplate[] = [
	{
		id: "codex",
		kind: "known",
		preferredPrefix: "codex",
		endpoints: { "openai-responses": "https://chatgpt.com/backend-api/codex" },
		authKinds: ["oauth", "pat", "agent_identity"],
		multiCredential: true,
		subscription: true,
		personal: true,
	},
	{
		id: "kimi-code",
		kind: "known",
		preferredPrefix: "kimi",
		regions: { china: KIMI_CODE("api.kimi.com"), international: KIMI_CODE("api.kimi.ai") },
		authKinds: ["api_key"],
		multiCredential: true,
		subscription: true,
		// Token Plan keys present NarraFork's own User-Agent (presets.ts).
		defaults: { userAgentMode: "narrafork" },
		personal: true,
	},
	{
		id: "opencode-go",
		kind: "known",
		preferredPrefix: "opencode",
		endpoints: {
			"anthropic-messages": "https://opencode.ai/zen/go/v1",
			"completions-compatible": "https://opencode.ai/zen/go/v1",
			"openai-responses": "https://opencode.ai/zen/go/v1",
		},
		authKinds: ["api_key"],
		multiCredential: true,
		subscription: true,
		personal: true,
	},
	{
		id: "deepseek",
		kind: "known",
		preferredPrefix: "deepseek",
		endpoints: {
			"anthropic-messages": "https://api.deepseek.com/anthropic/v1",
			"completions-compatible": "https://api.deepseek.com/v1",
			"openai-responses": "https://api.deepseek.com/v1",
		},
		authKinds: ["api_key"],
		multiCredential: true,
		subscription: false,
		personal: true,
	},
	{
		id: "openai",
		kind: "known",
		preferredPrefix: "openai",
		endpoints: {
			"openai-responses": "https://api.openai.com/v1",
			"completions-compatible": "https://api.openai.com/v1",
		},
		authKinds: ["api_key"],
		multiCredential: true,
		subscription: false,
		personal: true,
	},
	{
		id: "anthropic",
		kind: "known",
		preferredPrefix: "anthropic",
		endpoints: { "anthropic-messages": "https://api.anthropic.com/v1" },
		authKinds: ["api_key"],
		multiCredential: true,
		subscription: false,
		personal: true,
	},
	{
		id: "gemini",
		kind: "known",
		preferredPrefix: "gemini",
		endpoints: { "gemini-compatible": "https://generativelanguage.googleapis.com/v1beta" },
		authKinds: ["api_key"],
		multiCredential: true,
		subscription: false,
		personal: true,
	},
	{
		// Prepaid balance. One key until TokenDance joins the credential pool (S2 PR 7).
		id: "tokendance",
		kind: "known",
		preferredPrefix: "tokendance",
		authKinds: ["api_key"],
		multiCredential: false,
		subscription: false,
		personal: false,
	},
	{
		// Routed as pay-per-use today; one key until the credential pool takes it (S2 PR 7).
		id: "command-code",
		kind: "known",
		preferredPrefix: "CommandCode",
		authKinds: ["api_key"],
		multiCredential: false,
		subscription: false,
		personal: false,
	},
	{
		id: "openai-compatible",
		kind: "api",
		authKinds: ["api_key"],
		multiCredential: true,
		subscription: false,
		personal: true,
	},
	{
		id: "anthropic-compatible",
		kind: "api",
		authKinds: ["api_key"],
		multiCredential: true,
		subscription: false,
		personal: true,
	},
	{
		id: "gemini-compatible",
		kind: "api",
		authKinds: ["api_key"],
		multiCredential: true,
		subscription: false,
		personal: true,
	},
	{
		// NUG is excluded from the key pool until S2 PR 7.
		id: "nug",
		kind: "api",
		preferredPrefix: "nug",
		authKinds: ["api_key"],
		multiCredential: false,
		subscription: false,
		personal: true,
	},
	{
		// Configured by the plugin config service; one opaque credential per provider (§15.7).
		id: "plugin",
		kind: "api",
		authKinds: ["opaque"],
		multiCredential: false,
		subscription: false,
		personal: false,
	},
];

/** Templates are shared by every caller, so nothing in them may be mutated. */
function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
}

const byId = new Map<ServiceTemplateId, ServiceTemplate>(
	TEMPLATES.map((template) => {
		const probeQuota = QUOTA_PROBES[template.id];
		return [template.id, deepFreeze(probeQuota ? { ...template, probeQuota } : template)];
	}),
);

export function listServiceTemplates(): readonly ServiceTemplate[] {
	return [...byId.values()];
}

/** Every id in `SERVICE_TEMPLATE_IDS` has a template (asserted by the tests). */
export function getServiceTemplate(id: ServiceTemplateId): ServiceTemplate {
	return byId.get(id) as ServiceTemplate;
}
