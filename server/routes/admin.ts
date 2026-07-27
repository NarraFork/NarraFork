import { count, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db";
import { narrators, users } from "../db/schema";
import { revokeUserSessions } from "../lib/auth";
import { isMaskedSecret, maskAuthSettings } from "../lib/auth-settings";
import { AppError, formatZodError } from "../lib/errors";
import { getEventLoopLagSnapshot } from "../lib/event-loop-monitor";
import { logger } from "../lib/logger";
import { getOAuthRateLimitSnapshot } from "../lib/oauth-rate-limit";
import { getOAuthSecurityObservabilitySnapshot } from "../lib/oauth-security-observability";
import { saveSettings, settings } from "../lib/settings";
import type { OidcProviderConfig } from "../lib/settings/types";
import {
	adminAuthConfigSchema,
	adminUpdateSettingsSchema,
	adminUpdateUserSchema,
} from "../lib/validators";
import { invalidateUserCache, requireAdmin, requireAuth } from "../middleware/auth";
import { knowledgeAcl } from "../services/knowledge-acl";
import { prepareOAuthUserHardDeletion } from "../services/oauth-runtime-revocation";
import { terminalService } from "../services/terminal-service";
import { worktreeWatcher } from "../services/worktree-watcher";
import { ProcessSnapshot } from "../terminal/dtach-service";
import { getExternalNarratorConnectionSnapshot } from "../websocket/oauth-connection-registry";

export const adminRoutes = new Hono();

adminRoutes.use("*", requireAuth, requireAdmin);

adminRoutes.get("/users", async (c) => {
	const allUsers = await db.query.users.findMany({
		columns: {
			id: true,
			username: true,
			role: true,
			avatarColor: true,
			avatarImageId: true,
			createdAt: true,
		},
	});
	return c.json(allUsers);
});

adminRoutes.patch("/users/:id", async (c) => {
	const id = c.req.param("id");
	const caller = c.get("user");
	const parsed = adminUpdateUserSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new AppError(formatZodError(parsed.error), 400, "VALIDATION_ERROR");

	const { username, password, role } = parsed.data;
	if (!username && !password && !role) {
		throw new AppError("At least one field is required", 400, "VALIDATION_ERROR");
	}

	if (role && id === caller.sub && role !== "admin") {
		throw new AppError("Cannot demote yourself", 400, "SELF_DEMOTE");
	}

	// Prevent demoting the last administrator
	if (role === "user" && id !== caller.sub) {
		const target = await db.query.users.findFirst({
			where: eq(users.id, id),
			columns: { role: true },
		});
		if (target?.role === "admin") {
			const [{ value: adminCount }] = await db
				.select({ value: count() })
				.from(users)
				.where(eq(users.role, "admin"));
			if (adminCount <= 1) {
				throw new AppError("Cannot demote the last administrator", 400, "LAST_ADMIN");
			}
		}
	}

	const updates: Record<string, string> = {};

	if (role) {
		updates.role = role;
	}

	if (username) {
		const existing = await db.query.users.findFirst({
			where: eq(users.username, username),
		});
		if (existing && existing.id !== id) {
			throw new AppError("Username already taken", 409, "USERNAME_TAKEN");
		}
		updates.username = username;
	}

	if (password) {
		updates.passwordHash = await Bun.password.hash(password, {
			algorithm: "bcrypt",
			cost: 10,
		});
	}

	const [updated] = await db
		.update(users)
		.set(updates)
		.where(eq(users.id, id))
		.returning({ id: users.id, username: users.username, role: users.role });
	if (!updated) throw new AppError("User not found", 404, "NOT_FOUND");
	// An administrator resets a password when they believe the old one is compromised, so the
	// sessions opened with it must die too. Session JWTs are self-contained, so only bumping the
	// token generation can end them — a new password alone would leave a stolen token valid for
	// up to its remaining lifetime.
	if (password) {
		await revokeUserSessions(id);
	}
	// A role or password change must take effect on the next request rather than
	// after the 60s existence-cache window: the cache is what lets a request skip
	// the live `users` lookup, and sliding renewal re-reads the role from there.
	if (role || password) {
		invalidateUserCache(id);
	}
	return c.json(updated);
});

/**
 * Force-sign-out every device of one user. Separate from the PATCH above because revoking
 * sessions is a legitimate action on its own — a lost laptop needs no password change.
 */
adminRoutes.post("/users/:id/revoke-sessions", async (c) => {
	const id = c.req.param("id");
	const target = await db.query.users.findFirst({
		where: eq(users.id, id),
		columns: { id: true },
	});
	if (!target) throw new AppError("User not found", 404, "NOT_FOUND");
	const tokenVersion = await revokeUserSessions(id);
	invalidateUserCache(id);
	logger.info("Administrator revoked all sessions for a user", {
		userId: id,
		actorUserId: c.get("user").sub,
		tokenVersion,
	});
	return c.json({ ok: true });
});

adminRoutes.delete("/users/:id", async (c) => {
	const id = c.req.param("id");
	const caller = c.get("user");

	if (id === caller.sub) {
		throw new AppError("Cannot delete your own account", 400, "SELF_DELETE");
	}

	// Prevent deleting the last administrator
	const target = await db.query.users.findFirst({
		where: eq(users.id, id),
		columns: { role: true },
	});
	if (!target) throw new AppError("User not found", 404, "NOT_FOUND");
	if (target.role === "admin") {
		const [{ value: adminCount }] = await db
			.select({ value: count() })
			.from(users)
			.where(eq(users.role, "admin"));
		if (adminCount <= 1) {
			throw new AppError("Cannot delete the last administrator", 400, "LAST_ADMIN");
		}
	}

	await prepareOAuthUserHardDeletion(id);
	const [deleted] = await db.delete(users).where(eq(users.id, id)).returning();
	if (!deleted) throw new AppError("User not found", 404, "NOT_FOUND");
	// Drop the existence cache immediately; otherwise the deleted user's token
	// keeps passing (and renewing) for the rest of the cache window.
	invalidateUserCache(id);
	// Cascade: remove this user's knowledge-base grants (clearance/tags/review).
	await knowledgeAcl.purgeUserGrants(id);
	return c.json({ ok: true });
});

adminRoutes.patch("/settings", async (c) => {
	const parsed = adminUpdateSettingsSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new AppError(formatZodError(parsed.error), 400, "VALIDATION_ERROR");

	const current = settings;
	current.auth.registrationOpen = parsed.data.registrationOpen;
	saveSettings(current);
	return c.json({ registrationOpen: current.auth.registrationOpen });
});

// === Instance auth configuration (OIDC providers + WebAuthn) ===

/** Admin: read the instance SSO/WebAuthn config (client secrets masked). */
adminRoutes.get("/auth-config", (c) => {
	const masked = maskAuthSettings(settings.auth);
	return c.json({
		oidcProviders: masked.oidcProviders ?? [],
		webauthn: masked.webauthn ?? null,
	});
});

/** Admin: replace the instance SSO/WebAuthn config. */
adminRoutes.patch("/auth-config", async (c) => {
	const parsed = adminAuthConfigSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new AppError(formatZodError(parsed.error), 400, "VALIDATION_ERROR");

	// Reject duplicate provider ids.
	const ids = parsed.data.oidcProviders.map((p) => p.id);
	if (new Set(ids).size !== ids.length) {
		throw new AppError("Duplicate SSO provider id", 400, "DUPLICATE_PROVIDER_ID");
	}

	const current = settings;
	const existingById = new Map((current.auth.oidcProviders ?? []).map((p) => [p.id, p]));

	const providers: OidcProviderConfig[] = parsed.data.oidcProviders.map((p) => {
		// Preserve the stored secret when the UI sends an empty or masked value.
		const clientSecret = isMaskedSecret(p.clientSecret)
			? (existingById.get(p.id)?.clientSecret ?? "")
			: (p.clientSecret as string);
		return {
			id: p.id,
			name: p.name,
			issuer: p.issuer,
			clientId: p.clientId,
			clientSecret,
			scopes: p.scopes,
			allowSignup: p.allowSignup,
			allowedEmailDomains: p.allowedEmailDomains,
			enabled: p.enabled,
		};
	});

	current.auth.oidcProviders = providers;
	current.auth.webauthn = parsed.data.webauthn
		? {
				rpID: parsed.data.webauthn.rpID || undefined,
				rpName: parsed.data.webauthn.rpName || undefined,
				origins: parsed.data.webauthn.origins,
			}
		: undefined;
	saveSettings(current);

	const masked = maskAuthSettings(current.auth);
	return c.json({
		oidcProviders: masked.oidcProviders ?? [],
		webauthn: masked.webauthn ?? null,
	});
});

// === Terminal Management ===

adminRoutes.get("/terminals", async (c) => {
	const terminals = await terminalService.listAll();
	// Single process snapshot shared across orphan detection and process info
	const snapshot = await ProcessSnapshot.create();
	const orphanSockets = await terminalService.listOrphanSockets(snapshot);
	const attachedSet = terminalService.getAttachedSet();
	// Batch-fetch process info with a single ps snapshot
	const runningIds = terminals.filter((t) => t.status === "running").map((t) => t.id);
	const processMap = await terminalService.getProcessesBatch(runningIds, snapshot);
	const annotated = terminals.map((t) => ({
		...t,
		attached: attachedSet.has(t.id),
		processes: processMap.get(t.id) ?? [],
	}));
	return c.json({ terminals: annotated, orphanSockets });
});

adminRoutes.delete("/terminals/:id", async (c) => {
	const id = c.req.param("id");
	await terminalService.kill(id);
	return c.json({ ok: true });
});

adminRoutes.post("/terminals/batch-kill", async (c) => {
	const { ids } = await c.req.json();
	if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === "string")) {
		throw new AppError("ids must be a non-empty string array", 400, "VALIDATION_ERROR");
	}
	const results: { id: string; ok: boolean; error?: string }[] = [];
	for (const id of ids) {
		try {
			await terminalService.kill(id);
			results.push({ id, ok: true });
		} catch (e) {
			results.push({ id, ok: false, error: e instanceof Error ? e.message : "unknown" });
		}
	}
	return c.json({ results });
});

adminRoutes.post("/terminals/kill-orphan", async (c) => {
	const { terminalId } = await c.req.json();
	if (!terminalId || typeof terminalId !== "string") {
		throw new AppError("terminalId is required", 400, "VALIDATION_ERROR");
	}
	await terminalService.killOrphanSocket(terminalId);
	return c.json({ ok: true });
});

adminRoutes.post("/terminals/:id/reattach", async (c) => {
	const id = c.req.param("id");
	const success = await terminalService.reattach(id);
	if (!success) {
		throw new AppError("Failed to reattach terminal", 400, "REATTACH_FAILED");
	}
	return c.json({ ok: true });
});

adminRoutes.post("/terminals/reattach-orphan", async (c) => {
	const { terminalId } = await c.req.json();
	if (!terminalId || typeof terminalId !== "string") {
		throw new AppError("terminalId is required", 400, "VALIDATION_ERROR");
	}
	const terminal = await terminalService.reattachOrphan(terminalId);
	return c.json(terminal);
});

// === Diagnostics ===

adminRoutes.get("/diagnostics", async (c) => {
	const cpuUsage = process.cpuUsage();
	const memUsage = process.memoryUsage();

	// Active narrators (working/waiting status)
	const narratorStatusCounts = await db
		.select({ status: narrators.status, value: count() })
		.from(narrators)
		.where(inArray(narrators.status, ["working", "waiting"]))
		.groupBy(narrators.status);
	const narratorCountByStatus = new Map(narratorStatusCounts.map((row) => [row.status, row.value]));
	const workingNarratorCount = narratorCountByStatus.get("working") ?? 0;
	const waitingNarratorCount = narratorCountByStatus.get("waiting") ?? 0;

	// Worktree watchers
	const watcherPaths = worktreeWatcher.getActivePaths();

	// Terminals
	const allTerminals = await terminalService.listAll();
	const runningTerminals = allTerminals.filter((t) => t.status === "running");

	// Event loop lag: measure how long a setTimeout(0) takes to fire
	const loopLagMs = await new Promise<number>((resolve) => {
		const start = performance.now();
		setTimeout(() => resolve(Math.round((performance.now() - start) * 100) / 100), 0);
	});

	const eventLoopLag = getEventLoopLagSnapshot();

	return c.json({
		timestamp: new Date().toISOString(),
		uptime: Math.round(process.uptime()),
		eventLoopLagMs: loopLagMs,
		eventLoopLag,
		cpu: {
			userMs: Math.round(cpuUsage.user / 1000),
			systemMs: Math.round(cpuUsage.system / 1000),
		},
		memory: {
			rss: memUsage.rss,
			heapUsed: memUsage.heapUsed,
			heapTotal: memUsage.heapTotal,
		},
		narrators: {
			thinking: workingNarratorCount,
			waiting: waitingNarratorCount,
		},
		worktreeWatchers: {
			count: worktreeWatcher.getActiveCount(),
			paths: watcherPaths,
		},
		terminals: {
			total: allTerminals.length,
			running: runningTerminals.length,
		},
		oauthSecurity: {
			observability: getOAuthSecurityObservabilitySnapshot(),
			rateLimits: getOAuthRateLimitSnapshot(),
			externalWebSocket: getExternalNarratorConnectionSnapshot(),
		},
	});
});
