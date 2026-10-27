import type {
	TokenProtocolResolution,
	TokenRecalculationProtocol,
} from "@shared/token-recalculation";
import { selectTokenDanceProtocol } from "@shared/tokendance";
import { openAIFamilyProtocol } from "../lib/agent/protocol-override";
import {
	bareCommandCodeModelId,
	COMMAND_CODE_PREFIX,
	type CommandCodeEndpoint,
	selectCommandCodeEndpoint,
} from "../lib/commandcode-protocol";

interface Connection {
	id: string;
	prefix: string;
	disabled?: boolean;
}

interface ProtocolSettings {
	customApiProviders?: (Connection & { protocol: string })[];
	anthropicProviders?: Connection[];
	openaiProviders?: (Connection & { apiMode?: string; responsesApi?: boolean })[];
	geminiProviders?: Connection[];
	nugProviders?: Connection[];
	commandCode?: { endpoints?: Record<string, CommandCodeEndpoint> };
}

/** Narrow, fully injectable read-only dependencies: tests need no live settings or providers. */
export interface TokenRecalculationProtocolDependencies {
	getSettings(): ProtocolSettings;
	resolveModelProtocol(prefix: string, model: string): string | undefined;
	resolveNugModelMeta(id: string, prefix: string, model: string): { channelType: string };
	getTokenDanceCatalogModels(): { id: string; supported_protocols: string[] }[];
	getCachedCommandCodeModel(model: string): { endpoints: string[] } | undefined;
}

/**
 * Runtime dependencies for production: settings and catalog caches are loaded on demand.
 * `import()` specifiers are literal, so the executable bundler still bundles all four;
 * `require` is not an option because this graph transitively reaches modules with a
 * top-level await (settings → codex-manager → codex-pat → user-agent → version).
 */
export async function createRuntimeTokenRecalculationProtocolResolver() {
	const [config, nug, tokenDance, commandCode] = await Promise.all([
		import("../lib/settings"),
		import("../lib/nug-model-cache"),
		import("../lib/tokendance-runtime"),
		import("../lib/commandcode-models"),
	]);
	return createTokenRecalculationProtocolResolver({
		getSettings: () => config.settings,
		resolveModelProtocol: config.resolveModelProtocol,
		resolveNugModelMeta: nug.resolveNugModelMeta,
		getTokenDanceCatalogModels: tokenDance.getTokenDanceCatalogModels,
		getCachedCommandCodeModel: commandCode.getCachedCommandCodeModel,
	});
}

function protocolFamily(protocol: string | undefined): TokenRecalculationProtocol | undefined {
	switch (protocol) {
		case "anthropic-messages":
			return "anthropic";
		case "openai-responses":
		case "completions-compatible":
			return "openai";
		case "gemini-compatible":
			return "gemini";
		default:
			return undefined;
	}
}

type HistoricalProtocolRow = {
	provider: string | null;
	model: string | null;
	credential_id: string | null;
};
type ResolvedConnection = Connection & { protocol?: string; nug?: boolean };
const MAX_CACHE_ENTRIES = 4096;

/** One resolver/cache per recalculation job; never creates providers or requests model catalogs. */
export function createTokenRecalculationProtocolResolver(
	deps: TokenRecalculationProtocolDependencies,
): (row: HistoricalProtocolRow) => TokenProtocolResolution {
	const settings = deps.getSettings();
	// Do not filter disabled connections: they still identify historical traffic. Canonical
	// custom connections win over their derived legacy copies, even after a protocol switch.
	const connections: ResolvedConnection[] = [
		...(settings.customApiProviders ?? []),
		...(settings.anthropicProviders ?? []).map((config) => ({
			...config,
			protocol: "anthropic-messages",
		})),
		...(settings.openaiProviders ?? []).map((config) => ({
			...config,
			protocol: openAIFamilyProtocol(config),
		})),
		...(settings.geminiProviders ?? []).map((config) => ({
			...config,
			protocol: "gemini-compatible",
		})),
		...(settings.nugProviders ?? []).map((config) => ({ ...config, nug: true })),
	];
	const cache = new Map<string, TokenProtocolResolution>();

	function resolve(row: HistoricalProtocolRow): TokenRecalculationProtocol | undefined {
		const connection =
			(row.credential_id && connections.find((config) => config.id === row.credential_id)) ||
			connections.find((config) => config.prefix === row.provider);
		const prefix = connection?.prefix ?? row.provider ?? "";
		const model = row.model ?? "";
		// Codex is registered before configurable API families and never applies model protocol
		// overrides. A same-prefix API config must not shadow that fixed builtin route. A
		// credential matched to a different prefix still identifies that historical connection.
		if (prefix === "codex") return "openai";
		const supportsOverride =
			!!connection ||
			[COMMAND_CODE_PREFIX, "tokendance", "anthropic", "gemini", "openai"].includes(prefix);
		const override = supportsOverride ? deps.resolveModelProtocol(prefix, model) : undefined;
		// CommandCode is also registered ahead of configurable API families; its selector
		// deliberately ignores unsupported protocol overrides (e.g. gemini-compatible).
		if (prefix === COMMAND_CODE_PREFIX) {
			const endpoint = selectCommandCodeEndpoint(model, {
				protocol: override,
				overrides: settings.commandCode?.endpoints,
				supportedEndpoints: deps.getCachedCommandCodeModel(bareCommandCodeModelId(model))
					?.endpoints,
			});
			return endpoint === "messages" ? "anthropic" : "openai";
		}
		if (override) return protocolFamily(override);
		if (connection?.nug) {
			try {
				const { channelType } = deps.resolveNugModelMeta(connection.id, prefix, model);
				if (channelType === "anthropic") return "anthropic";
				if (["openai", "codex", "responses"].includes(channelType)) return "openai";
			} catch {
				// Missing local metadata is expected for old/deleted channels; never fetch it.
			}
			return undefined;
		}
		if (connection) return protocolFamily(connection.protocol);
		if (prefix === "tokendance") {
			const bare = model.startsWith("tokendance:") ? model.slice("tokendance:".length) : model;
			const catalog = deps.getTokenDanceCatalogModels().find((entry) => entry.id === bare);
			return protocolFamily(selectTokenDanceProtocol(catalog?.supported_protocols ?? []));
		}
		// These are protocol identities, not model-name heuristics. An unknown prefix cannot
		// become Anthropic merely because its model happens to be named "claude".
		if (prefix === "anthropic" || prefix === "gemini" || prefix === "openai") return prefix;
		return undefined;
	}

	return (row) => {
		const key = JSON.stringify([row.provider, row.model, row.credential_id]);
		const hit = cache.get(key);
		if (hit) return hit;
		const protocol = resolve(row);
		const result: TokenProtocolResolution = {
			protocol: protocol ?? "openai",
			fallback: protocol === undefined,
		};
		if (cache.size >= MAX_CACHE_ENTRIES) cache.clear();
		cache.set(key, result);
		return result;
	};
}
