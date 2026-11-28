/**
 * Which service template a configured endpoint belongs to, shared by server and frontend.
 *
 * One exact host + path table (docs/PROVIDER-SOURCING-DESIGN.md §15.2, §15.8). A match only
 * picks defaults and quota probing; requests still go to the endpoint saved on the source,
 * so an unrecognised endpoint simply falls back to its protocol's `*-compatible` template.
 *
 * The strict rows (https, default port, no credentials, query or hash) are strict because a
 * match makes the server send the source's key to that service's quota endpoint.
 */
import { isOpencodeGoBaseUrl } from "../opencode-go-endpoint";

export const SERVICE_TEMPLATE_IDS = [
	"codex",
	"kimi-code",
	"opencode-go",
	"deepseek",
	"openai",
	"anthropic",
	"gemini",
	"tokendance",
	"command-code",
	"openai-compatible",
	"anthropic-compatible",
	"gemini-compatible",
	"nug",
	"plugin",
] as const;

export type ServiceTemplateId = (typeof SERVICE_TEMPLATE_IDS)[number];

export type SourceProtocol =
	| "anthropic-messages"
	| "openai-responses"
	| "completions-compatible"
	| "gemini-compatible";

export type SourceRegion = "china" | "international";

export interface IdentifiedService {
	templateId: ServiceTemplateId;
	region?: SourceRegion;
}

interface IdentifyRule {
	templateId: ServiceTemplateId;
	region?: SourceRegion;
	matches(url: URL, baseUrl: string): boolean;
}

/** The domain or any subdomain, on any scheme, port or path. */
function onDomain(domain: string): IdentifyRule["matches"] {
	return (url) => {
		// Non-special schemes keep the host's case.
		const host = url.hostname.toLowerCase();
		return host === domain || host.endsWith(`.${domain}`);
	};
}

/** Exactly `https://<host><path>` with one of `paths` (one trailing slash ignored). */
function officialRoot(host: string, paths: readonly string[]): IdentifyRule["matches"] {
	return (url) =>
		url.protocol === "https:" &&
		url.hostname === host &&
		!url.port &&
		!url.username &&
		!url.password &&
		!url.search &&
		!url.hash &&
		paths.includes(url.pathname.replace(/\/$/, "") || "/");
}

/**
 * Kimi Code is the coding plan on `api.kimi.{com,ai}/coding/v1`. Moonshot's own hosts
 * (`api.moonshot.{cn,ai}`) are its pay-as-you-go platform, not the plan, so they stay
 * `*-compatible`.
 */
const RULES: readonly IdentifyRule[] = [
	{ templateId: "kimi-code", region: "china", matches: onDomain("kimi.com") },
	{ templateId: "kimi-code", region: "international", matches: onDomain("kimi.ai") },
	{ templateId: "opencode-go", matches: (_url, baseUrl) => isOpencodeGoBaseUrl(baseUrl) },
	{
		templateId: "deepseek",
		// `/anthropic/v1` is the add page's Anthropic preset.
		matches: officialRoot("api.deepseek.com", ["/", "/v1", "/anthropic", "/anthropic/v1"]),
	},
	{ templateId: "openai", matches: officialRoot("api.openai.com", ["/", "/v1"]) },
	{ templateId: "anthropic", matches: officialRoot("api.anthropic.com", ["/", "/v1"]) },
	{
		templateId: "gemini",
		matches: officialRoot("generativelanguage.googleapis.com", ["/", "/v1", "/v1beta"]),
	},
];

function compatibleTemplate(protocol: SourceProtocol | undefined): ServiceTemplateId {
	if (protocol === "anthropic-messages") return "anthropic-compatible";
	if (protocol === "gemini-compatible") return "gemini-compatible";
	return "openai-compatible";
}

/** `protocol: "nug"` is a NUG connection, which is always the `nug` template. */
export function identifyService(input: {
	baseUrl?: string;
	protocol?: SourceProtocol | "nug";
}): IdentifiedService {
	const { baseUrl, protocol } = input;
	if (protocol === "nug") return { templateId: "nug" };
	if (baseUrl) {
		let url: URL | undefined;
		try {
			url = new URL(baseUrl);
		} catch {
			url = undefined;
		}
		const rule = url && RULES.find((candidate) => candidate.matches(url, baseUrl));
		if (rule) {
			return rule.region
				? { templateId: rule.templateId, region: rule.region }
				: { templateId: rule.templateId };
		}
	}
	return { templateId: compatibleTemplate(protocol) };
}
