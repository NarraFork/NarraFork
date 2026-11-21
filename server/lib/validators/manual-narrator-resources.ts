import { z } from "zod/v4";

export const MANUAL_RESOURCE_BODY_LIMIT = 64 * 1024;

export const manualBackgroundTaskSchema = z.strictObject({
	kind: z.enum(["task", "service"]),
	command: z
		.string()
		.max(8_192)
		.refine((value) => Boolean(value.trim()) && !value.includes("\0"), {
			message: "Enter a non-empty command without NUL characters",
		}),
	title: z.string().trim().min(1).max(120).optional(),
	timeoutMs: z.number().int().min(1).max(86_400_000).optional(),
});

export const manualBrowserSessionSchema = z.strictObject({
	url: z
		.string()
		.trim()
		.max(4_096)
		.refine((value) => {
			if (!/^https?:\/\//i.test(value)) return false;
			try {
				const url = new URL(value);
				return Boolean(url.hostname) && !url.username && !url.password;
			} catch {
				return false;
			}
		}, "Enter an HTTP(S) URL without embedded credentials"),
	ttlMs: z.number().int().min(1_000).max(86_400_000).optional(),
});
