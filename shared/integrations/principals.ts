import { z } from "zod";

export const INTEGRATION_ID_MAX_LENGTH = 128;

function boundedIdentifier(label: string) {
	return z
		.string()
		.min(1)
		.max(INTEGRATION_ID_MAX_LENGTH)
		.refine((value) => value === value.trim(), `${label} cannot contain surrounding whitespace`)
		.refine(
			(value) =>
				[...value].every((character) => {
					const codePoint = character.codePointAt(0) ?? 0;
					return codePoint >= 0x20 && codePoint !== 0x7f;
				}),
			`${label} cannot contain control characters`,
		);
}

export const PRINCIPAL_TYPES = [
	"user",
	"oauth_client",
	"oauth_grant",
	"plugin",
	"plugin_installation",
	"plugin_runtime",
	"device",
	"system",
] as const;
export type PrincipalType = (typeof PRINCIPAL_TYPES)[number];
export const principalTypeSchema = z.enum(PRINCIPAL_TYPES);

export const principalIdSchema = boundedIdentifier("Principal id");
const identifiedPrincipalTypeSchema = z.enum(
	PRINCIPAL_TYPES.filter((type) => type !== "system") as [
		Exclude<PrincipalType, "system">,
		...Exclude<PrincipalType, "system">[],
	],
);

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

/** Credentials authenticate principals but never become principals themselves. */
export const CREDENTIAL_TYPES = [
	"session",
	"oauth_token",
	"plugin_credential",
	"runtime_credential",
	"device_credential",
	"system",
] as const;
export type CredentialType = (typeof CREDENTIAL_TYPES)[number];
export const credentialTypeSchema = z.enum(CREDENTIAL_TYPES);
export const credentialIdSchema = boundedIdentifier("Credential id");

export const credentialRefSchema = z.discriminatedUnion("type", [
	z
		.object({
			type: z.enum(
				CREDENTIAL_TYPES.filter((type) => type !== "system") as [
					Exclude<CredentialType, "system">,
					...Exclude<CredentialType, "system">[],
				],
			),
			id: credentialIdSchema,
		})
		.strict(),
	z.object({ type: z.literal("system") }).strict(),
]);
export type CredentialRef = z.infer<typeof credentialRefSchema>;

export function principalRefKey(principal: PrincipalRef): string {
	const parsed = principalRefSchema.parse(principal);
	return parsed.type === "system" ? "system" : `${parsed.type}:${parsed.id}`;
}

export function credentialRefKey(credential: CredentialRef): string {
	const parsed = credentialRefSchema.parse(credential);
	return parsed.type === "system" ? "system" : `${parsed.type}:${parsed.id}`;
}
