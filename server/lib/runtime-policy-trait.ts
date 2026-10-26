/**
 * Runtime capability ceiling carried by narrator traits.
 *
 * The policy is a CEILING, not an identity: every declaring layer can only narrow
 * what the layers below allowed, so the merge is an order-independent intersection.
 * A narrator with no declaration keeps the full built-in capability set, which is
 * the existing behaviour of an ordinary session. Delegation templates (research,
 * implementation, review, ...) are compiled into this trait when a narrator is
 * created; nothing at run time asks what template a narrator came from.
 */
import { z } from "zod";
import { parseTraits } from "./narrator-utils";

export const RUNTIME_POLICY_TRAIT_PREFIX = "custom-runtime-policy:";

/** Capabilities a layer may deny; `agent-runtime/policy.ts` merges declarations. */
const CAPABILITY_KEYS = [
	"spawnAgent",
	"awaitAgent",
	"askUserQuestion",
	"planApproval",
	"stopHooks",
	"switchWorkingDirectory",
] as const;

export type RuntimeCapabilityKey = (typeof CAPABILITY_KEYS)[number];

/** Retired capabilities older stored ceilings may still deny; read and dropped. */
const RETIRED_CAPABILITY_KEYS = ["sendAwait"] as const;
const retiredCapability = new Set<string>(RETIRED_CAPABILITY_KEYS);

const toolNames = z.array(z.string().min(1).max(256)).max(512);

/** One declared ceiling. Omitted fields mean "no additional narrowing". */
const runtimePolicyTraitSchema = z.strictObject({
	version: z.literal(1),
	/** Built-in tool allowlist. Omitted = every built-in tool. */
	tools: toolNames.optional(),
	/** MCP visibility ceiling. Omitted = non-denied MCP tools. */
	mcp: z.enum(["none", "readOnly", "nonDenied"]).optional(),
	/** MCP tool allowlist (exact `mcp__server__tool` names). Omitted = all. */
	mcpNames: toolNames.optional(),
	/** File and MCP writes are unavailable. */
	readOnly: z.boolean().optional(),
	/** Search tools call the selected provider directly. */
	searchOnly: z.boolean().optional(),
	/** Shell is limited to the constrained local read-only Git policy. */
	readOnlyGitShell: z.boolean().optional(),
	/** Capabilities explicitly removed by this layer. */
	deny: z
		.array(z.enum([...CAPABILITY_KEYS, ...RETIRED_CAPABILITY_KEYS]))
		.max(CAPABILITY_KEYS.length + RETIRED_CAPABILITY_KEYS.length)
		.transform((keys) =>
			keys.filter((key): key is RuntimeCapabilityKey => !retiredCapability.has(key)),
		)
		.optional(),
	/** Self-continuation ceiling. Omitted = promote todo, unlimited progress passes. */
	continuation: z
		.strictObject({
			promoteTodo: z.boolean().optional(),
			maxPasses: z.number().int().nonnegative().max(1_000_000).optional(),
		})
		.optional(),
});

export type RuntimePolicyTrait = z.infer<typeof runtimePolicyTraitSchema>;

function encode(policy: RuntimePolicyTrait): string {
	const payload = JSON.stringify(runtimePolicyTraitSchema.parse(policy));
	return `${RUNTIME_POLICY_TRAIT_PREFIX}${Buffer.from(payload, "utf-8").toString("base64url")}`;
}

/**
 * Parse every policy entry in one traits array. A malformed entry is an explicit
 * error: a ceiling that cannot be read must never silently become "no ceiling".
 */
export function parseRuntimePolicyTraits(traits: unknown): RuntimePolicyTrait[] {
	const out: RuntimePolicyTrait[] = [];
	for (const entry of parseTraits(traits)) {
		if (!entry.startsWith(RUNTIME_POLICY_TRAIT_PREFIX)) continue;
		let decoded: unknown;
		try {
			const json = Buffer.from(entry.slice(RUNTIME_POLICY_TRAIT_PREFIX.length), "base64url");
			decoded = JSON.parse(json.toString("utf-8"));
		} catch {
			throw new Error("Unreadable runtime policy trait");
		}
		const parsed = runtimePolicyTraitSchema.safeParse(decoded);
		if (!parsed.success) throw new Error("Invalid runtime policy trait");
		out.push(parsed.data);
	}
	return out;
}

export function hasRuntimePolicyTrait(traits: unknown): boolean {
	return parseTraits(traits).some((entry) => entry.startsWith(RUNTIME_POLICY_TRAIT_PREFIX));
}

/** Add a ceiling without removing any existing declarations; resolution intersects all of them. */
export function appendRuntimePolicyTrait(traits: unknown, policy: RuntimePolicyTrait): string[] {
	parseRuntimePolicyTraits(traits); // Never preserve an unreadable ceiling as an ignored declaration.
	return [...parseTraits(traits), encode(policy)];
}

/** Store exactly one ceiling on a layer (replacing any previous one). */
export function withRuntimePolicyTrait(
	traits: unknown,
	policy: RuntimePolicyTrait | null,
): string[] {
	const rest = parseTraits(traits).filter(
		(entry) => !entry.startsWith(RUNTIME_POLICY_TRAIT_PREFIX),
	);
	return policy ? [...rest, encode(policy)] : rest;
}
