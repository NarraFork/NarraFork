import { z } from "zod";

const URL_PROTOCOL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** HTTP(S) proxy address normalization shared by settings validation and UI. */
export function normalizeProxyUrl(value: string | null | undefined): string | undefined {
	const trimmed = value?.trim();
	// biome-ignore lint/suspicious/noControlCharactersInRegex: reject controls that the URL parser silently strips
	if (!trimmed || /[\u0000-\u0020\u007f]/.test(trimmed)) return undefined;
	const normalized = URL_PROTOCOL_RE.test(trimmed) ? trimmed : `http://${trimmed}`;
	try {
		const parsed = new URL(normalized);
		return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname
			? normalized
			: undefined;
	} catch {
		return undefined;
	}
}

/** Empty addresses are absent; malformed non-empty addresses must fail validation. */
export const proxyUrlSchema = z.preprocess(
	(value) => {
		if (typeof value !== "string") return value;
		const trimmed = value.trim();
		return trimmed ? (normalizeProxyUrl(trimmed) ?? trimmed) : undefined;
	},
	z
		.string()
		.max(500)
		.refine((value) => normalizeProxyUrl(value) === value, {
			message: "Proxy must use a valid HTTP or HTTPS URL",
		})
		.optional(),
);

/** Absent/default inherits the global policy; custom always requires a valid URL. */
export const proxyOverrideSchema = z
	.object({
		mode: z.enum(["default", "direct", "system", "custom"]),
		url: proxyUrlSchema,
	})
	.superRefine((value, ctx) => {
		if (value.mode === "custom" && !value.url) {
			ctx.addIssue({
				code: "custom",
				path: ["url"],
				message: "Custom proxy mode requires a valid HTTP or HTTPS URL",
			});
		}
	})
	.optional();
