import { Hono } from "hono";
import { z } from "zod";
import { loadSettings, type NarraForkSettings, saveSettings } from "../lib/settings";
import { ValidationError } from "../lib/errors";

const modelOptionSchema = z.object({
	value: z.string().min(1),
	label: z.string().min(1),
});

/** Only non-sensitive, user-editable fields are allowed. auth.jwtSecret is excluded. */
const updateSettingsSchema = z
	.object({
		server: z.object({ port: z.number().int().min(1).max(65535) }).partial().optional(),
		paths: z.object({ defaultProjectDir: z.string().min(1) }).partial().optional(),
		agent: z
			.object({
				defaultModel: z.string().min(1),
				defaultPermissionMode: z.string().min(1),
				summaryModel: z.string().min(1),
				customModels: z.array(modelOptionSchema),
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
	})
	.strict();

export const settingsRoutes = new Hono();

settingsRoutes.get("/", (c) => {
	return c.json(loadSettings());
});

settingsRoutes.patch("/", async (c) => {
	const body = await c.req.json();
	const parsed = updateSettingsSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	const current = loadSettings();
	const validated = parsed.data;
	// Deep merge: iterate top-level keys
	const merged = { ...current } as NarraForkSettings;
	for (const key of Object.keys(validated) as Array<keyof typeof validated>) {
		const val = validated[key];
		if (val && typeof val === "object" && !Array.isArray(val)) {
			(merged as any)[key] = { ...(current as any)[key], ...val };
		} else {
			(merged as any)[key] = val;
		}
	}
	saveSettings(merged);
	return c.json(merged);
});
