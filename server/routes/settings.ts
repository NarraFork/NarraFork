import { Hono } from "hono";
import { z } from "zod";
import { ValidationError } from "../lib/errors";
import { loadSettings, type NarraForkSettings, saveSettings } from "../lib/settings";
import { getAnthropicCachedModelsGrouped } from "./anthropic";
import { getOpenaiCachedModels, getOpenaiCachedModelsGrouped } from "./openai";

const modelOptionSchema = z.object({
	value: z.string().min(1),
	label: z.string().min(1),
	provider: z.string().optional(),
});

const openaiProviderSchema = z.object({
	id: z.string().min(1),
	name: z.string(),
	prefix: z.string().min(1),
	apiKey: z.string(),
	baseUrl: z.string(),
	defaultModel: z.string(),
	responsesApi: z.boolean().optional(),
	apiMode: z.enum(["responses", "completions", "codex"]).optional(),
	codexAccountId: z.string().optional(),
});

const anthropicProviderSchema = z.object({
	id: z.string().min(1),
	name: z.string(),
	prefix: z.string().min(1),
	apiKey: z.string(),
	baseUrl: z.string(),
	defaultModel: z.string(),
	maxMode: z.boolean().optional(),
});

/** Only non-sensitive, user-editable fields are allowed. auth.jwtSecret is excluded. */
const updateSettingsSchema = z
	.object({
		server: z
			.object({ port: z.number().int().min(1).max(65535) })
			.partial()
			.optional(),
		paths: z
			.object({ defaultProjectDir: z.string().min(1) })
			.partial()
			.optional(),
		agent: z
			.object({
				defaultModel: z.string().min(1),
				defaultPermissionMode: z.string().min(1),
				summaryModel: z.string().min(1),
				customModels: z.array(modelOptionSchema),
				hiddenModels: z.array(z.string()),
				maxTurns: z.number().int().min(1).max(1000),
				subagentModels: z
					.object({
						explore: z.string(),
						plan: z.string(),
					})
					.partial(),
				legacyEncoding: z.boolean(),
				planTimeoutAction: z.enum(["deny", "auto_approve"]),
			})
			.partial()
			.optional(),
		chapters: z
			.object({
				maxActiveWorktrees: z.number().int().min(1),
				maxActiveContainers: z.number().int().min(0),
				worktreeSizeWarningMb: z.number().int().min(0),
				autoSaveOnDormant: z.boolean(),
				dormantAfterMinutes: z.number().int().min(0),
			})
			.partial()
			.optional(),
		containers: z
			.object({
				portRangeStart: z.number().int().min(1).max(65535),
				portRangeEnd: z.number().int().min(1).max(65535),
				proxy: z
					.object({
						enabled: z.boolean(),
						port: z.number().int().min(1).max(65535),
					})
					.partial()
					.optional(),
			})
			.partial()
			.optional(),
		editor: z
			.object({
				type: z.enum(["vscode", "cursor", "windsurf", "zed"]),
			})
			.partial()
			.optional(),
		auth: z
			.object({
				registrationOpen: z.boolean(),
			})
			.partial()
			.optional(),
		openaiProviders: z.array(openaiProviderSchema).optional(),
		anthropicProviders: z.array(anthropicProviderSchema).optional(),
	})
	.strict();

export const settingsRoutes = new Hono();

/** Mask an API key for safe display (show last 4 chars). */
function maskApiKey(key?: string): string {
	if (!key) return "";
	if (key.length <= 4) return "*".repeat(key.length);
	return `${"*".repeat(8)}${key.slice(-4)}`;
}

settingsRoutes.get("/", (c) => {
	const s = loadSettings();
	const result = {
		...s,
		auth: { ...s.auth, jwtSecret: undefined },
		// Multi-provider — mask all keys
		openaiProviders: (s.openaiProviders ?? []).map((p) => ({
			...p,
			apiKey: p.apiKey ? maskApiKey(p.apiKey) : "",
		})),
		anthropicProviders: (s.anthropicProviders ?? []).map((p) => ({
			...p,
			apiKey: p.apiKey ? maskApiKey(p.apiKey) : "",
		})),
		openaiModels: getOpenaiCachedModels(),
		openaiModelsGrouped: getOpenaiCachedModelsGrouped(),
		anthropicModelsGrouped: getAnthropicCachedModelsGrouped(),
	};
	return c.json(result);
});

settingsRoutes.patch("/", async (c) => {
	const body = await c.req.json();
	const parsed = updateSettingsSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	const current = loadSettings();
	const validated = parsed.data;

	// Preserve real API keys for multi-provider
	if (validated.openaiProviders) {
		const currentProviders = current.openaiProviders ?? [];
		for (const p of validated.openaiProviders) {
			if (p.apiKey?.startsWith("*")) {
				const existing = currentProviders.find((cp) => cp.id === p.id);
				p.apiKey = existing?.apiKey ?? "";
			}
		}
	}

	// Preserve real API keys for Anthropic providers
	if (validated.anthropicProviders) {
		const currentProviders = current.anthropicProviders ?? [];
		for (const p of validated.anthropicProviders) {
			if (p.apiKey?.startsWith("*")) {
				const existing = currentProviders.find((cp) => cp.id === p.id);
				p.apiKey = existing?.apiKey ?? "";
			}
		}
	}

	// Deep merge: iterate top-level keys
	const merged = { ...current } as NarraForkSettings;
	for (const key of Object.keys(validated) as Array<keyof typeof validated>) {
		const val = validated[key];
		if (key === "openaiProviders" || key === "anthropicProviders") {
			// Array — replace entirely, don't merge
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			(merged as any)[key] = val;
		} else if (val && typeof val === "object" && !Array.isArray(val)) {
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			(merged as any)[key] = { ...(current as any)[key], ...val };
		} else {
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			(merged as any)[key] = val;
		}
	}

	saveSettings(merged);
	// Mask sensitive fields before returning (same logic as GET)
	const result = {
		...merged,
		auth: { ...merged.auth, jwtSecret: undefined },
		openaiProviders: (merged.openaiProviders ?? []).map((p) => ({
			...p,
			apiKey: p.apiKey ? maskApiKey(p.apiKey) : "",
		})),
		anthropicProviders: (merged.anthropicProviders ?? []).map((p) => ({
			...p,
			apiKey: p.apiKey ? maskApiKey(p.apiKey) : "",
		})),
	};
	return c.json(result);
});
