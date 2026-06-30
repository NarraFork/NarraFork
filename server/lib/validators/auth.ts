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
