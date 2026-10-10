import { z } from "zod";
import { localeSchema } from "./common";

const usernameSchema = z
	.string()
	.min(3)
	.max(50)
	.regex(/^[a-zA-Z0-9_-]+$/, "Alphanumeric, hyphens, underscores only");

/**
 * bcrypt only hashes the first 72 BYTES of its input, silently ignoring the rest.
 *
 * Past that point extra characters contribute nothing while looking like they do:
 * two passwords differing only after byte 72 are the same credential. The limit is
 * in bytes, not characters, which matters for non-ASCII — a CJK password reaches it
 * at roughly 24 characters under UTF-8.
 */
const BCRYPT_MAX_PASSWORD_BYTES = 72;

/**
 * A password being SET.
 *
 * Capped at bcrypt's real input limit so nobody chooses a passphrase whose tail is
 * discarded. Applied only where a password is chosen (registration, admin create,
 * admin update) — deliberately NOT to login, where a longer value must keep working:
 * accounts created before this limit may hold one, and bcrypt will truncate and match
 * exactly as it did when the hash was written.
 */
const passwordSchema = z
	.string()
	.min(8)
	.max(128)
	.refine((value) => new TextEncoder().encode(value).byteLength <= BCRYPT_MAX_PASSWORD_BYTES, {
		message: `Password must be at most ${BCRYPT_MAX_PASSWORD_BYTES} bytes (bcrypt ignores anything beyond that)`,
	});

export const registerSchema = z.object({
	username: usernameSchema,
	password: passwordSchema,
	language: localeSchema.optional(),
	/** Single-use invitation issued by an administrator (see registration codes). */
	code: z.string().trim().min(8).max(128).optional(),
});

export const loginSchema = z.object({
	username: z.string().min(1).max(50),
	password: z.string().min(1).max(128),
});

export const adminUpdateSettingsSchema = z.object({
	registrationOpen: z.boolean(),
});

export const adminUpdateUserSchema = z.object({
	username: usernameSchema.optional(),
	password: passwordSchema.optional(),
	role: z.enum(["admin", "user"]).optional(),
});

/** Admin: create an account directly, choosing its initial password. */
export const adminCreateUserSchema = z.object({
	username: usernameSchema,
	password: passwordSchema,
	role: z.enum(["admin", "user"]).optional(),
	language: localeSchema.optional(),
});

/** Admin: mint a single-use registration code. */
export const adminCreateRegistrationCodeSchema = z.object({
	note: z.string().trim().max(200).optional(),
	role: z.enum(["admin", "user"]).optional(),
	/** Restrict the code to one username; omit to let the recipient choose. */
	username: usernameSchema.optional(),
	/** 1 hour to 1 year; defaults to one week in the service. */
	expiresInHours: z.number().int().min(1).max(8760).optional(),
});

export const updateProfileSchema = z.object({
	gitUsername: z.string().max(100).optional(),
	gitEmail: z.string().email().max(254).optional().or(z.literal("")),
});

// === Git commit identities ===
// A user keeps several named identities and picks, per narrator, which one their
// own turns commit under. The service layer re-applies these rules (it is the
// last gate before git), so the two must stay in step.

const gitIdentityNameSchema = z.string().trim().min(1).max(100);
const gitIdentityEmailSchema = z.string().trim().email().max(254);

export const createGitIdentitySchema = z.object({
	name: gitIdentityNameSchema,
	email: gitIdentityEmailSchema,
});

export const updateGitIdentitySchema = z
	.object({
		name: gitIdentityNameSchema.optional(),
		email: gitIdentityEmailSchema.optional(),
		/** Only promotion is offered; "no default" is not a state the service allows. */
		isDefault: z.literal(true).optional(),
	})
	.refine((value) => Object.keys(value).length > 0, { message: "Nothing to update" });

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
