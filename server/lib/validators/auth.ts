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
