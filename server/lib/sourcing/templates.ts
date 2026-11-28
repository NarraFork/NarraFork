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
import { providerQuotaService, toQuotaSnapshot } from "../../services/provider-quota-service";
import {
	getTokenDanceQuotaSnapshot,
	refreshTokenDanceBalance,
	tokenDanceQuotaIdentity,
} from "../../services/tokendance-service";
import { isNugRelayEligible } from "../agent/nug-delegate-config";
import { getCodexCredentialDedupeKeys } from "../codex-credential-dedupe";
import { getCodexManager, peekCodexManager } from "../codex-manager";
import { projectCodexUsageSnapshot } from "../codex-usage";
import {
	commandCodeQuotaIdentity,
	getCommandCodeQuotaSnapshot,
	refreshCommandCodeQuota,
} from "../commandcode-usage";
import type { Credential, CredentialAuth } from "../credential-store";
import { customApiStreamQuotaIdentity } from "../custom-api-quota-cache";
import {
	deepSeekQuotaIdentity,
	getDeepSeekQuotaSnapshot,
	refreshDeepSeekBalance,
} from "../deepseek-balance-cache";
import { getKimiQuotaSnapshot, kimiQuotaIdentity, refreshKimiKeyUsage } from "../kimi-usage-cache";
import { resolveKnownUnavailableNugModel } from "../nug-model-availability";
import {
	getNugQuotaSnapshot,
	nugQuotaBalanceSources,
	nugQuotaIdentity,
	refreshNugQuota,
} from "../nug-quota-cache";
import {
	getOpencodeQuotaSnapshot,
	opencodeQuotaIdentity,
	refreshOpencodeKeyUsage,
} from "../opencode-usage-cache";
import { providerBalanceQuotaIdentity } from "../provider-balance-cache";
import { settings } from "../settings";
import type { CustomApiProviderConfig } from "../settings/types";
import { readTemplateModelList, type SourceModel } from "./model-list-readers";
import { type CredentialRouting, keyRouting, type RoutingPreview } from "./routing";
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
	/** Delegate to the source owner, preserving its cache, in-flight work and identity checks. */
	probeQuota?: (group: SourceGroupView, credentialId: string) => Promise<QuotaSnapshot | undefined>;
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
 * Sources own credential-specific probes and retain their legacy first-key views.
 * Relay balances still follow their selected credential. Relays are probed on every
 * endpoint that is not a dedicated service, official APIs included, as before.
 */
const relay: ProbeQuota = async (group, credentialId) => {
	const source = providerQuotaService.peekKey(credentialId);
	if (source?.providerId !== group.id) return;
	return toQuotaSnapshot(await providerQuotaService.refreshKey(credentialId, { mode: "refresh" }));
};
const QUOTA_PROBES: Partial<Record<ServiceTemplateId, ProbeQuota>> = {
	"kimi-code": async (_group, credentialId) => {
		await refreshKimiKeyUsage(credentialId);
		return getKimiQuotaSnapshot(credentialId);
	},
	"opencode-go": async (_group, credentialId) => {
		await refreshOpencodeKeyUsage(credentialId);
		return getOpencodeQuotaSnapshot(credentialId);
	},
	deepseek: async (group, credentialId) => {
		await refreshDeepSeekBalance(group.id, credentialId);
		return getDeepSeekQuotaSnapshot(group.id, credentialId);
	},
	tokendance: async (_group, credentialId) => {
		await refreshTokenDanceBalance(true, credentialId);
		return getTokenDanceQuotaSnapshot(credentialId)?.snapshot;
	},
	"command-code": async (_group, credentialId) => {
		await refreshCommandCodeQuota(true, credentialId);
		return getCommandCodeQuotaSnapshot(credentialId)?.snapshot;
	},
	nug: async (group, credentialId) => {
		await refreshNugQuota(group.id, credentialId);
		const quota = getNugQuotaSnapshot(group.id, credentialId);
		return quota?.credentialId === credentialId ? quota.snapshot : undefined;
	},
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
const customQuotaRouting = {
	probeSnapshot: (credentialId: string) =>
		toQuotaSnapshot(providerQuotaService.peekKeyForSelection(credentialId)),
	streamCurrent: (credentialId: string, snapshot: QuotaSnapshot) =>
		providerQuotaService.isStreamSnapshotCurrent(
			credentialId,
			(snapshot.detail as { generation?: string } | undefined)?.generation,
		),
	streamIdentity: customApiStreamQuotaIdentity,
};
const relayRouting = keyRouting(
	customConfig,
	(config) => providerBalanceQuotaIdentity(config, settings.proxy),
	customQuotaRouting,
);
const ROUTING: Partial<Record<ServiceTemplateId, RoutingBehavior>> = {
	// Codex's manager owns credits continuation and window policy, not the generic quota filter.
	codex: {
		hasAvailableCredentials: () => (peekCodexManager()?.availableCount ?? 0) > 0,
		routingPreview: () => peekCodexManager()?.routingPreview ?? null,
	},
	"kimi-code": keyRouting(customConfig, kimiQuotaIdentity, customQuotaRouting),
	"opencode-go": keyRouting(customConfig, opencodeQuotaIdentity, {
		...customQuotaRouting,
		probeBalanceIsFallback: true,
	}),
	deepseek: keyRouting(customConfig, deepSeekQuotaIdentity, customQuotaRouting),
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
			{
				streamIdentity: nugQuotaIdentity,
				isEligible: isNugRelayEligible,
				balanceSources: nugQuotaBalanceSources,
			},
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
