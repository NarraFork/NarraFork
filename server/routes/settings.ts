import { Hono } from "hono";
import { z } from "zod";
import { ValidationError } from "../lib/errors";
import { loadSettings, type NarraForkSettings, saveSettings } from "../lib/settings";

const modelOptionSchema = z.object({
	value: z.string().min(1),
	label: z.string().min(1),
	provider: z.string().optional(),
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
				extendedContext: z.boolean(),
				maxTurns: z.number().int().min(1).max(1000),
				subagentModels: z
					.object({
						explore: z.string(),
						plan: z.string(),
					})
					.partial(),
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
		openai: z
			.object({
				apiKey: z.string(),
				baseUrl: z.string(),
				defaultModel: z.string(),
			})
			.partial()
			.optional(),
	})
	.strict();

export const settingsRoutes = new Hono();

settingsRoutes.get("/", (c) => {
	const s = loadSettings();
	// Mask sensitive fields
	const result = {
		...s,
		auth: { ...s.auth, jwtSecret: undefined },
		openai: s.openai
			? {
					...s.openai,
					apiKey: s.openai.apiKey ? `${"*".repeat(8)}${s.openai.apiKey.slice(-4)}` : "",
				}
			: undefined,
	};
	return c.json(result);
});

settingsRoutes.patch("/", async (c) => {
	const body = await c.req.json();
	const parsed = updateSettingsSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	const current = loadSettings();
	const validated = parsed.data;

	// Preserve real API key if frontend sends back the masked value
	if (validated.openai?.apiKey?.startsWith("*")) {
		validated.openai.apiKey = current.openai?.apiKey ?? "";
	}

	// Deep merge: iterate top-level keys
	const merged = { ...current } as NarraForkSettings;
	for (const key of Object.keys(validated) as Array<keyof typeof validated>) {
		const val = validated[key];
		if (val && typeof val === "object" && !Array.isArray(val)) {
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
		openai: merged.openai
			? {
					...merged.openai,
					apiKey: merged.openai.apiKey ? `${"*".repeat(8)}${merged.openai.apiKey.slice(-4)}` : "",
				}
			: undefined,
	};
	return c.json(result);
});
