import { z } from "zod";

export const registerSchema = z.object({
	username: z
		.string()
		.min(3)
		.max(50)
		.regex(/^[a-zA-Z0-9_-]+$/, "Alphanumeric, hyphens, underscores only"),
	password: z.string().min(8).max(128),
	language: z.string().min(1).max(10).optional(),
});

export const loginSchema = z.object({
	username: z.string().min(1),
	password: z.string().min(1),
});

export const adminUpdateSettingsSchema = z.object({
	registrationOpen: z.boolean(),
});

export const adminUpdateUserSchema = z.object({
	username: z
		.string()
		.min(3)
		.max(50)
		.regex(/^[a-zA-Z0-9_-]+$/, "Alphanumeric, hyphens, underscores only")
		.optional(),
	password: z.string().min(8).max(128).optional(),
	role: z.enum(["admin", "user"]).optional(),
});

export const updateProfileSchema = z.object({
	gitUsername: z.string().max(100).optional(),
	gitEmail: z.string().email().max(254).optional().or(z.literal("")),
});

// === Multi-factor authentication ===

/** A 6-digit TOTP code (whitespace tolerated by the verifier). */
const totpCodeSchema = z
	.string()
	.trim()
	.regex(/^\d{6}$/, "Must be a 6-digit code");

/** A backup recovery code, e.g. "abcd-efgh" (case-insensitive, dash optional). */
const backupCodeSchema = z.string().trim().min(8).max(20);

/** Step 2 of login: redeem the MFA challenge token with a second factor. */
export const mfaVerifySchema = z.object({
	mfaToken: z.string().min(1),
	method: z.enum(["totp", "backup_code"]),
	code: z.string().trim().min(1).max(20),
});

/** Toggle the login-time second-factor requirement (settings → security). */
export const mfaToggleSchema = z.object({
	enabled: z.boolean(),
});

/** Confirm TOTP enrollment by submitting the first valid code. */
export const totpActivateSchema = z.object({
	code: totpCodeSchema,
});

/**
 * Disable TOTP. Requires proof of identity — either a current TOTP code, a
 * backup code, or the account password.
 */
export const totpDisableSchema = z
	.object({
		code: z.union([totpCodeSchema, backupCodeSchema]).optional(),
		password: z.string().min(1).max(128).optional(),
	})
	.refine((d) => !!d.code || !!d.password, {
		message: "A current code or your password is required",
	});

// === Passkey / WebAuthn ===

/**
 * The browser's WebAuthn response is a complex nested structure that the
 * @simplewebauthn/server library validates strictly during verification, so the
 * route layer only needs to confirm it is a non-null object.
 */
const webauthnResponseSchema = z.record(z.string(), z.unknown());

/** Persist + name a freshly registered passkey. */
export const passkeyRegisterSchema = z.object({
	response: webauthnResponseSchema,
	name: z.string().trim().max(60).optional(),
});

/** Usernameless passkey login: ask for options, optionally hinting a username. */
export const passkeyLoginOptionsSchema = z.object({
	username: z.string().trim().min(1).max(50).optional(),
});

/** Complete a usernameless passkey login. */
export const passkeyLoginVerifySchema = z.object({
	response: webauthnResponseSchema,
});

/** Complete a passkey second-factor step (after password). */
export const passkeyMfaVerifySchema = z.object({
	mfaToken: z.string().min(1),
	response: webauthnResponseSchema,
});

/** Rename a passkey. */
export const passkeyRenameSchema = z.object({
	name: z.string().trim().min(1).max(60),
});

// === SSO / OIDC ===

/** Exchange a single-use SSO code (from the callback redirect) for a session. */
export const oidcExchangeSchema = z.object({
	code: z.string().min(1).max(256),
});

// === Admin: instance auth configuration (OIDC providers + WebAuthn) ===

/** A provider id usable as a stable key and URL path segment. */
const providerIdSchema = z
	.string()
	.trim()
	.min(1)
	.max(40)
	.regex(/^[a-z0-9][a-z0-9_-]*$/, "Lowercase letters, digits, hyphens and underscores only");

/** One OIDC provider as submitted by the admin UI. */
export const oidcProviderInputSchema = z.object({
	id: providerIdSchema,
	name: z.string().trim().min(1).max(80),
	issuer: z.string().trim().url().max(512),
	clientId: z.string().trim().min(1).max(256),
	// Optional on update: empty or a masked value means "keep the stored secret".
	clientSecret: z.string().max(512).optional(),
	scopes: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
	allowSignup: z.boolean().optional(),
	allowedEmailDomains: z.array(z.string().trim().min(1).max(253)).max(50).optional(),
	enabled: z.boolean().optional(),
});

/** Full admin auth-config payload. */
export const adminAuthConfigSchema = z.object({
	oidcProviders: z.array(oidcProviderInputSchema).max(20),
	webauthn: z
		.object({
			rpID: z.string().trim().max(253).optional(),
			rpName: z.string().trim().max(80).optional(),
			origins: z.array(z.string().trim().url().max(512)).max(20).optional(),
		})
		.optional(),
});
