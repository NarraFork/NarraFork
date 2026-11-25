/**
 * Service templates: how one kind of upstream is used, without any user data
 * (docs/PROVIDER-SOURCING-DESIGN.md §15.2).
 *
 * The behaviours (quota probe, then model list, availability, import dedupe) are attached
 * by the S2 PRs as each caller moves onto templates.
 */
import { createHash } from "node:crypto";
import type { QuotaSnapshot } from "@shared/quota-snapshot";
import type { ServiceTemplateId, SourceProtocol, SourceRegion } from "@shared/sourcing/identify";
import { pluginProviderRegistry } from "../../services/plugin-provider-registry";
import {
	probeTokenDanceQuota,
	type TokenDanceSubject,
	tokenDanceQuotaIdentity,
} from "../../services/tokendance-service";
import type { CommandCodeProviderSettings } from "../agent/commandcode-provider";
import { isNugRelayEligible } from "../agent/nug-delegate-config";
import { getCodexCredentialDedupeKeys } from "../codex-credential-dedupe";
import { getCodexManager, peekCodexManager } from "../codex-manager";
import { projectCodexUsageSnapshot } from "../codex-usage";
import {
	type CommandCodeUsageSubject,
	commandCodeQuotaIdentity,
	probeCommandCodeQuota,
} from "../commandcode-usage";
import type { Credential, CredentialAuth } from "../credential-store";
import { customApiStreamQuotaIdentity } from "../custom-api-quota-cache";
import { deepSeekQuotaIdentity, probeDeepSeekQuota } from "../deepseek-balance-cache";
import { kimiQuotaIdentity, probeKimiQuota } from "../kimi-usage-cache";
import { resolveKnownUnavailableNugModel } from "../nug-model-availability";
import { type NugQuotaSubject, nugQuotaIdentity, probeNugQuota } from "../nug-quota-cache";
import { opencodeQuotaIdentity, probeOpencodeQuota } from "../opencode-usage-cache";
import { probeRelayQuota, providerBalanceQuotaIdentity } from "../provider-balance-cache";
import type { UsageSubject } from "../provider-key-subjects";
import { settings } from "../settings";
import type {
	CustomApiProviderConfig,
	NUGProviderConfig,
	TokenDanceSettings,
} from "../settings/types";
import { readTemplateModelList, type SourceModel } from "./model-list-readers";
import { type CredentialRouting, keyRouting, type RoutingPreview } from "./routing";
import type { SourceGroupView } from "./source-groups";

export type { ServiceTemplateId } from "@shared/sourcing/identify";

/** `known`: the user only adds a credential. `api`: the user adds an endpoint + key. */
export type ServiceTemplateKind = "known" | "api";

/** Credential login kinds; `opaque` is a plugin's secret-field bag. */
export type AuthKind = CredentialAuth["kind"] | "opaque";

export type ProtocolEndpoints = Partial<Record<SourceProtocol, string>>;

type QuotaSubject = UsageSubject<
	| CustomApiProviderConfig
	| NUGProviderConfig
	| TokenDanceSettings
	| (CommandCodeProviderSettings & { apiKey: string })
>;

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
	/** Import identity keys; unsupported auth has no identity in this template. */
	dedupeKeys(credential: Omit<Credential, "id">): readonly string[];
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
		credential: QuotaSubject,
		signal: AbortSignal,
	) => Promise<QuotaSnapshot>;
	/** A read-only projection when another canonical store owns the usage (Codex). */
	projectQuota?: (credentialId: string) => QuotaSnapshot | undefined;
	/** Pure memory only: an explicit false rules out this model, unknown does not. */
	isModelAvailable?: (group: SourceGroupView, value?: string) => boolean;
	/** Whether any credential can serve; specialised pools retain their own policies. */
	hasAvailableCredentials?: CredentialRouting["hasAvailableCredentials"];
	routingPreview?: (group: SourceGroupView, now: number) => RoutingPreview | null;
	/** Complete cached model entries. Explicit refresh stays with the catalog owner. */
	listModels: (
		group: SourceGroupView,
		credential?: Credential,
		signal?: AbortSignal,
	) => Promise<readonly SourceModel[]>;
}

type ProbeQuota = NonNullable<ServiceTemplate["probeQuota"]>;

/**
 * Kimi Code and OpenCode Go answer per key; DeepSeek and relay balances per provider, so
 * their caches probe the group's first credential (§15.4). Relays are probed on every
 * endpoint that is not a dedicated service, official APIs included, as before.
 */
// The template id on each caller determines which member of QuotaSubject it supplies.
const custom = (credential: QuotaSubject): UsageSubject => credential as UsageSubject;
const relay: ProbeQuota = (_group, credential, signal) =>
	probeRelayQuota(custom(credential), signal);
const QUOTA_PROBES: Partial<Record<ServiceTemplateId, ProbeQuota>> = {
	"kimi-code": (_group, credential, signal) => probeKimiQuota(custom(credential), signal),
	"opencode-go": (_group, credential, signal) => probeOpencodeQuota(custom(credential), signal),
	deepseek: (_group, credential, signal) => probeDeepSeekQuota(custom(credential), signal),
	tokendance: (_group, credential, signal) =>
		probeTokenDanceQuota(credential as TokenDanceSubject, signal),
	"command-code": (_group, credential, signal) =>
		probeCommandCodeQuota(credential as CommandCodeUsageSubject, signal),
	nug: (_group, credential, signal) => probeNugQuota(credential as NugQuotaSubject, signal),
	openai: relay,
	anthropic: relay,
	gemini: relay,
	"openai-compatible": relay,
	"anthropic-compatible": relay,
	"gemini-compatible": relay,
};

type RoutingBehavior = Pick<
	ServiceTemplate,
	"isModelAvailable" | "hasAvailableCredentials" | "routingPreview"
>;
const customConfig = (group: SourceGroupView) =>
	settings.customApiProviders?.find((provider) => provider.id === group.id);
const relayRouting = keyRouting(
	customConfig,
	(config) => providerBalanceQuotaIdentity(config, settings.proxy),
	{ streamIdentity: customApiStreamQuotaIdentity },
);
const ROUTING: Partial<Record<ServiceTemplateId, RoutingBehavior>> = {
	// Codex's manager owns credits continuation and window policy, not the generic quota filter.
	codex: {
		hasAvailableCredentials: () => (peekCodexManager()?.availableCount ?? 0) > 0,
		routingPreview: () => peekCodexManager()?.routingPreview ?? null,
	},
	"kimi-code": keyRouting(customConfig, kimiQuotaIdentity, {
		streamIdentity: customApiStreamQuotaIdentity,
	}),
	"opencode-go": keyRouting(customConfig, opencodeQuotaIdentity, {
		probeBalanceIsFallback: true,
		streamIdentity: customApiStreamQuotaIdentity,
	}),
	deepseek: keyRouting(customConfig, deepSeekQuotaIdentity, {
		streamIdentity: customApiStreamQuotaIdentity,
	}),
	tokendance: keyRouting(() => settings.tokendance, tokenDanceQuotaIdentity),
	"command-code": keyRouting(
		() => ({ ...settings.commandCode, apiKey: settings.commandCode?.apiKey ?? "" }),
		commandCodeQuotaIdentity,
		{ allowUnconfigured: true },
	),
	nug: {
		...keyRouting(
			(group) => settings.nugProviders?.find((provider) => provider.id === group.id),
			nugQuotaIdentity,
			{ streamIdentity: nugQuotaIdentity, isEligible: isNugRelayEligible },
		),
		isModelAvailable: (group, value) => !resolveKnownUnavailableNugModel(value, group.prefix),
	},
	plugin: {
		hasAvailableCredentials: (group) =>
			pluginProviderRegistry.get(group.id)?.status === "available",
	},
	openai: relayRouting,
	anthropic: relayRouting,
	gemini: relayRouting,
	"openai-compatible": relayRouting,
	"anthropic-compatible": relayRouting,
	"gemini-compatible": relayRouting,
};

const KIMI_CODE = (host: string): ProtocolEndpoints => ({
	"anthropic-messages": `https://${host}/coding/v1`,
	"completions-compatible": `https://${host}/coding/v1`,
	"openai-responses": `https://${host}/coding/v1`,
});

const TEMPLATES: readonly Omit<ServiceTemplate, "listModels" | "dedupeKeys">[] = [
	{
		id: "codex",
		kind: "known",
		preferredPrefix: "codex",
		endpoints: { "openai-responses": "https://chatgpt.com/backend-api/codex" },
		authKinds: ["oauth", "pat", "agent_identity"],
		multiCredential: true,
		subscription: true,
		personal: true,
		projectQuota: (credentialId) => {
			const usage = getCodexManager().usageOf(credentialId);
			return usage ? projectCodexUsageSnapshot(usage) : undefined;
		},
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
		id: "tokendance",
		kind: "known",
		preferredPrefix: "tokendance",
		authKinds: ["api_key"],
		multiCredential: true,
		subscription: false,
		personal: false,
	},
	{
		id: "command-code",
		kind: "known",
		preferredPrefix: "CommandCode",
		authKinds: ["api_key"],
		multiCredential: true,
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
		id: "nug",
		kind: "api",
		preferredPrefix: "nug",
		authKinds: ["api_key"],
		multiCredential: true,
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

const fingerprint = (kind: string, value: unknown): string =>
	`${kind}:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;

function templateDedupeKeys(
	template: Pick<ServiceTemplate, "authKinds">,
): ServiceTemplate["dedupeKeys"] {
	return (credential) => {
		const { auth, target } = credential;
		if (!template.authKinds.includes(auth.kind)) return [];
		switch (auth.kind) {
			case "oauth":
			case "pat":
			case "agent_identity":
				return getCodexCredentialDedupeKeys({ ...credential.account, ...auth });
			case "api_key": {
				const key = auth.apiKey.trim();
				return key && target.groupId ? [fingerprint("api_key", [target.groupId, key])] : [];
			}
			case "opaque": {
				if (!target.pluginContributionId) return [];
				const fields = Object.keys(auth.fields)
					.sort()
					.map((name) => [name, auth.fields[name]]);
				return [fingerprint("opaque", [target.pluginContributionId, fields])];
			}
		}
	};
}

const byId = new Map<ServiceTemplateId, ServiceTemplate>(
	TEMPLATES.map((template) => {
		const probeQuota = QUOTA_PROBES[template.id];
		return [
			template.id,
			deepFreeze({
				...template,
				...(probeQuota ? { probeQuota } : {}),
				dedupeKeys: templateDedupeKeys(template),
				...ROUTING[template.id],
				listModels: async (
					group: SourceGroupView,
					_credential?: Credential,
					signal?: AbortSignal,
				) => {
					signal?.throwIfAborted();
					return readTemplateModelList(group);
				},
			}),
		];
	}),
);

export function listServiceTemplates(): readonly ServiceTemplate[] {
	return [...byId.values()];
}

/** Every id in `SERVICE_TEMPLATE_IDS` has a template (asserted by the tests). */
export function getServiceTemplate(id: ServiceTemplateId): ServiceTemplate {
	return byId.get(id) as ServiceTemplate;
}
