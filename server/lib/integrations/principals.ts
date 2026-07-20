import { z } from "zod";

export const PRINCIPAL_TYPES = [
	"user",
	"oauth_client",
	"oauth_grant",
	"plugin",
	"plugin_background",
	"device",
	"system",
] as const;
export type PrincipalType = (typeof PRINCIPAL_TYPES)[number];
export const principalTypeSchema = z.enum(PRINCIPAL_TYPES);

export const principalIdSchema = z
	.string()
	.min(1)
	.max(128)
	.refine((value) => value === value.trim(), "Principal id cannot contain surrounding whitespace")
	.refine(
		(value) =>
			[...value].every((character) => {
				const codePoint = character.codePointAt(0) ?? 0;
				return codePoint >= 0x20 && codePoint !== 0x7f;
			}),
		"Principal id cannot contain control characters",
	);

const identifiedPrincipalTypeSchema = z.enum([
	"user",
	"oauth_client",
	"oauth_grant",
	"plugin",
	"plugin_background",
	"device",
]);

export const principalRefSchema = z.discriminatedUnion("type", [
	z
		.object({
			type: identifiedPrincipalTypeSchema,
			id: principalIdSchema,
		})
		.strict(),
	z.object({ type: z.literal("system") }).strict(),
]);
export type PrincipalRef = z.infer<typeof principalRefSchema>;

export function assertPrincipalRef(value: unknown): PrincipalRef {
	return principalRefSchema.parse(value);
}

/** Stable, non-secret key suitable for maps, cache partitions, and audit correlation. */
export function principalRefKey(principal: PrincipalRef): string {
	const parsed = assertPrincipalRef(principal);
	return parsed.type === "system" ? "system" : `${parsed.type}:${parsed.id}`;
}
