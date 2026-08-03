import { readdir, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { z } from "zod/v4";
import { AppError, formatZodError, NotFoundError, ValidationError } from "../lib/errors";
import { getNarraforkPath } from "../lib/narrafork-home";
import { pluginIdSchema } from "../lib/plugins/manifest";
import { permissionGrantSchema } from "../lib/plugins/permissions";
import type { JsonValue } from "../lib/plugins/protocol";
import { settings } from "../lib/settings";
import { assertAdmin } from "../middleware/auth";
import { pluginManager as corePluginManager } from "../services/plugin-manager";
import { pluginPlatformServices } from "../services/plugin-platform-services";

const MAX_DIAGNOSTIC_TEXT = 1_000;
const MAX_PERMISSION_RESPONSE_BYTES = 512 * 1024;
const MAX_INSTALL_PATH = 4_096;
const SAFE_ARCHIVE_EXTENSIONS = new Set([".zip", ".nfplugin"]);
/** Upload size ceiling, aligned with the package store's maxArchiveBytes (100 MB). */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export type PluginDesiredState = "disabled" | "enabled" | "uninstalling";

export interface PluginManager {
	readonly disabled?: boolean;
	isEnabled?(): boolean;
	list(): Promise<unknown> | unknown;
	getStatus(pluginId: string): Promise<unknown> | unknown;
	getDiagnostics?(pluginId: string): Promise<unknown> | unknown;
	getPermissions?(pluginId: string): Promise<unknown> | unknown;
	replacePermissions?(pluginId: string, input: unknown): Promise<unknown> | unknown;
	revokePermissions?(pluginId: string, input: unknown): Promise<unknown> | unknown;
	install(source: string | File | Uint8Array): Promise<unknown>;
	enable(pluginId: string): Promise<unknown>;
	disable(pluginId: string): Promise<unknown>;
	activate(pluginId: string): Promise<unknown>;
	uninstall(pluginId: string): Promise<unknown>;
	retry?(pluginId: string): Promise<unknown>;
}

export interface PluginRouteOptions {
	/** Feature flag / emergency kill switch. Defaults to NF_PLUGINS_ENABLED. */
	enabled?: boolean;
	/** Import roots for local package paths. Relative paths resolve below the first root. */
	installRoots?: string[];
	/** Injectable admin middleware for route-only tests. */
	adminMiddleware?: MiddlewareHandler;
	/**
	 * Injectable session (login-only) middleware for route-only tests. In
	 * production these routes rely on the global `/api/*` session auth, so this
	 * is unset; tests use it to seed `c.get("user")` for the tier gate.
	 */
	authMiddleware?: MiddlewareHandler;
	/**
	 * Provider config read/write surface. Injectable so route tests can run without
	 * the whole platform-services graph; defaults to the shared instance.
	 */
	providerConfigService?: ProviderConfigRouteService;
}

/**
 * Narrow view of `PluginProviderConfigService` the routes actually need. Keeping it
 * structural avoids importing platform services into route-only tests.
 */
export interface ProviderConfigRouteService {
	list(pluginId: string): Promise<unknown> | unknown;
	update(
		pluginId: string,
		providerInstanceId: string,
		config: Record<string, JsonValue>,
	): Promise<unknown> | unknown;
	updatePrefix(
		pluginId: string,
		providerInstanceId: string,
		prefix: string,
	): Promise<unknown> | unknown;
}

const pluginIdParamSchema = z.object({
	pluginId: pluginIdSchema,
});

const permissionRevisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const permissionGrantMutationSchema = permissionGrantSchema
	.extend({ revision: permissionRevisionSchema.optional() })
	.strict();
const permissionReplaceSchema = z
	.object({
		expectedRevision: permissionRevisionSchema,
		grants: z.array(permissionGrantMutationSchema).max(512),
	})
	.strict();
const permissionRevokeSchema = z
	.object({
		expectedRevision: permissionRevisionSchema,
		grantIds: z.array(z.string().trim().min(1).max(256)).max(512),
	})
	.strict();

/**
 * Provider config bodies are validated twice: this shape check only enforces the JSON
 * object envelope and a size ceiling, while the authoritative per-field validation
 * happens against the provider's own JSON Schema inside the config service.
 */
const providerConfigUpdateSchema = z
	.object({
		providerInstanceId: z.string().trim().min(1).max(256),
		config: z
			.record(z.string().max(256), z.unknown())
			.refine((value) => Object.keys(value).length <= 128, {
				message: "config has too many fields",
			}),
	})
	.strict();

/**
 * Prefix bodies are shape-checked here and authoritatively validated by the registry,
 * which owns both the character rules and global conflict detection.
 */
const providerPrefixUpdateSchema = z
	.object({
		providerInstanceId: z.string().trim().min(1).max(256),
		providerPrefix: z.string().trim().min(1).max(32),
	})
	.strict();

const installSchema = z
	.object({
		path: z
			.string()
			.min(1)
			.max(MAX_INSTALL_PATH)
			.refine((value) => !value.includes("\0"), "path contains a NUL character")
			.refine(
				(value) => !value.split(/[\\/]/).some((segment) => segment === "." || segment === ".."),
				"path traversal is not allowed",
			)
			.refine(
				(value) => !value.startsWith("//") && !/^\\\\/.test(value),
				"network paths are not allowed",
			),
	})
	.strict();

type RouteResult = Record<string, unknown> | unknown[] | unknown;

function defaultEnabled(): boolean {
	const value = process.env.NF_PLUGINS_ENABLED ?? process.env.NARRAFORK_PLUGINS_ENABLED;
	if (value !== undefined) {
		return value === "1" || value.toLowerCase() === "true";
	}
	return settings.plugins?.enabled ?? true;
}

const defaultAdminMiddleware: MiddlewareHandler = async (c, next) => {
	const { requireAdmin } = await import("../middleware/auth");
	await requireAdmin(c, next);
};

function isContained(root: string, candidate: string): boolean {
	const remainder = relative(resolve(root), resolve(candidate));
	return remainder === "" || (remainder !== ".." && !remainder.startsWith(`..${sep}`));
}

function sanitizeText(value: unknown, max = MAX_DIAGNOSTIC_TEXT): string | undefined {
	if (typeof value !== "string") return undefined;
	return value
		.replace(/(?:Bearer\s+)[A-Za-z0-9._~-]+/gi, "Bearer <redacted>")
		.replace(/(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=<redacted>")
		.slice(-max);
}

function sanitizeDiagnostic(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { code: "UNKNOWN", message: "Unknown plugin diagnostic" };
	}
	const item = value as Record<string, unknown>;
	const result: Record<string, unknown> = {
		code: typeof item.code === "string" ? item.code.slice(0, 128) : "UNKNOWN",
		message: sanitizeText(item.message) ?? "Plugin diagnostic",
	};
	if (typeof item.phase === "string") result.phase = item.phase.slice(0, 64);
	return result;
}

function sanitizeContribution(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const item = value as Record<string, unknown>;
	const result: Record<string, unknown> = {};
	for (const key of [
		"id",
		"fullId",
		"kind",
		"title",
		"topic",
		"entryPath",
		"stylePath",
		"entry",
		"style",
		"execution",
	]) {
		if (typeof item[key] === "string") result[key] = String(item[key]).slice(0, 500);
	}
	if (typeof item.allowBackground === "boolean") result.allowBackground = item.allowBackground;
	if (typeof item.hasSchema === "boolean") result.hasSchema = item.hasSchema;
	// Surfaces let the detail page decide whether to offer the settings surface tab. The
	// loop above only copies strings, so this array needs its own bounded projection;
	// unknown names are dropped because the host routes on these values.
	if (Array.isArray(item.surfaces)) {
		const surfaces = item.surfaces.filter(
			(surface): surface is string =>
				surface === "workspace" ||
				surface === "director" ||
				surface === "focus" ||
				surface === "settings",
		);
		if (surfaces.length > 0) result.surfaces = surfaces;
	}
	return result;
}

function sanitizePluginListItem(value: unknown): Record<string, unknown> {
	const summary = sanitizeSummary(value) as Record<string, unknown>;
	if (!value || typeof value !== "object" || Array.isArray(value)) return summary;
	const item = value as Record<string, unknown>;
	delete summary.packages;
	if (Array.isArray(item.packages)) {
		summary.packageCount = item.packages.length;
		const currentPackage = item.packages.find(
			(entry) =>
				entry && typeof entry === "object" && (entry as Record<string, unknown>).isCurrent === true,
		) as Record<string, unknown> | undefined;
		if (currentPackage) {
			if (typeof currentPackage.version === "string") summary.version = currentPackage.version;
			const manifest = currentPackage.manifest;
			if (manifest && typeof manifest === "object" && !Array.isArray(manifest)) {
				const manifestSummary = manifest as Record<string, unknown>;
				if (typeof manifestSummary.displayName === "string") {
					summary.displayName = manifestSummary.displayName.slice(0, 120);
				}
			}
		}
	}
	if (Array.isArray(item.diagnostics)) {
		summary.diagnosticCount = item.diagnostics.length;
		summary.diagnostics = item.diagnostics.slice(0, 20).map(sanitizeDiagnostic);
	}
	return summary;
}

function sanitizeList(value: unknown): RouteResult {
	if (Array.isArray(value)) return value.map(sanitizePluginListItem);
	if (!value || typeof value !== "object") return value;
	const item = value as Record<string, unknown>;
	if (!Array.isArray(item.plugins)) return sanitizeSummary(value);
	return {
		...(typeof item.generatedAt === "string" ? { generatedAt: item.generatedAt } : {}),
		plugins: item.plugins.map(sanitizePluginListItem),
		...(Array.isArray(item.diagnostics)
			? { diagnostics: item.diagnostics.slice(0, 20).map(sanitizeDiagnostic) }
			: {}),
	};
}

/**
 * Bounded serializer for provider config views.
 *
 * `sanitizeSummary` is an allowlist shaped for catalog entries and would strip every
 * field here, so provider config needs its own explicit projection. The config
 * service already replaced secret values with a placeholder; this only pins the wire
 * shape and caps the free-form parts so a hostile manifest cannot inflate a response.
 */
function sanitizeProviderConfigView(value: unknown): RouteResult {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const view = value as Record<string, unknown>;
	const stringArray = (input: unknown, max: number): string[] =>
		Array.isArray(input)
			? input.filter((item): item is string => typeof item === "string").slice(0, max)
			: [];
	return {
		providerInstanceId: sanitizeText(view.providerInstanceId, 256),
		providerTypeId: sanitizeText(view.providerTypeId, 256),
		pluginId: sanitizeText(view.pluginId, 256),
		contributionId: sanitizeText(view.contributionId, 256),
		providerPrefix: sanitizeText(view.providerPrefix, 64),
		displayName: sanitizeText(view.displayName, 200),
		// Schema and values are JSON from an already size-bounded manifest / state file.
		configSchema:
			typeof view.configSchema === "boolean" ? view.configSchema : (view.configSchema ?? null),
		config: view.config && typeof view.config === "object" ? view.config : {},
		secretFields: stringArray(view.secretFields, 64),
		secretsSet: stringArray(view.secretsSet, 64),
	} as RouteResult;
}

/** Convert catalog/manager data to a bounded public summary. */
function sanitizeSummary(value: unknown): RouteResult {
	if (!value || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map(sanitizeSummary);
	const item = value as Record<string, unknown>;
	const result: Record<string, unknown> = {};
	for (const key of [
		"pluginId",
		"status",
		"desiredState",
		"runtimeState",
		"compatibility",
		"trustTier",
		"version",
		"hash",
		"isCurrent",
		"displayName",
		"description",
		"generatedAt",
		"current",
		"crashCount",
		"restartCount",
		"consecutiveFailures",
		"runtimeGeneration",
		"queueBytes",
		"queueBytesPeak",
		"protocolErrors",
	]) {
		if (item[key] !== undefined) {
			if (key === "description") result[key] = sanitizeText(item[key], 500);
			else if (key === "current" && item[key] && typeof item[key] === "object") {
				const current = item[key] as Record<string, unknown>;
				result.current = {
					...(typeof current.version === "string" ? { version: current.version } : {}),
					...(typeof current.hash === "string" ? { hash: current.hash } : {}),
				};
			} else result[key] = item[key];
		}
	}
	if (Array.isArray(item.contributions))
		result.contributions = item.contributions.map(sanitizeContribution);
	if (Array.isArray(item.plugins)) result.plugins = item.plugins.map(sanitizeSummary);
	if (Array.isArray(item.packages)) {
		result.packages = item.packages.map((entry) => {
			const summary = sanitizeSummary(entry) as Record<string, unknown>;
			if (entry && typeof entry === "object") {
				const source = entry as Record<string, unknown>;
				if (typeof source.status === "string") summary.status = source.status;
				summary.isCurrent = source.isCurrent === true;
			}
			return summary;
		});
	}
	if (Array.isArray(item.diagnostics))
		result.diagnostics = item.diagnostics.map(sanitizeDiagnostic);
	if (typeof item.diagnosticCount === "number") result.diagnosticCount = item.diagnosticCount;
	if (typeof item.runtimeId === "string") result.runtimeId = item.runtimeId;
	if (typeof item.generation === "number") result.generation = item.generation;
	if (typeof item.inFlight === "number") result.inFlight = item.inFlight;
	if (typeof item.lateMessages === "number") result.lateMessages = item.lateMessages;
	if (typeof item.startedAt === "string") result.startedAt = item.startedAt;
	if (typeof item.stoppedAt === "string") result.stoppedAt = item.stoppedAt;
	if (item.lastError && typeof item.lastError === "object")
		result.lastError = sanitizeDiagnostic(item.lastError);
	if (item.stderr !== undefined) result.stderrSummary = sanitizeText(item.stderr);
	if (item.stderrSummary !== undefined) result.stderrSummary = sanitizeText(item.stderrSummary);
	return result;
}

function sanitizePermissionSet(value: unknown): RouteResult {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { grants: [], revision: 0 };
	}
	const item = value as Record<string, unknown>;
	const result: Record<string, unknown> = {};
	for (const key of ["pluginId", "installationId", "revision", "updatedAt"]) {
		if (item[key] !== undefined) result[key] = item[key];
	}
	if (Array.isArray(item.grants)) {
		const grants: Record<string, unknown>[] = [];
		let responseBytes = 0;
		for (const grant of item.grants.slice(0, 100)) {
			if (!grant || typeof grant !== "object" || Array.isArray(grant)) continue;
			const source = grant as Record<string, unknown>;
			const sanitized: Record<string, unknown> = {};
			for (const key of [
				"grantId",
				"capability",
				"scope",
				"constraints",
				"expiresAt",
				"grantedBy",
				"revision",
			]) {
				if (source[key] !== undefined) sanitized[key] = source[key];
			}
			const grantBytes = Buffer.byteLength(JSON.stringify(sanitized), "utf8");
			if (responseBytes + grantBytes > MAX_PERMISSION_RESPONSE_BYTES) break;
			grants.push(sanitized);
			responseBytes += grantBytes;
		}
		result.grants = grants;
		result.grantCount = item.grants.length;
		result.returnedGrantCount = grants.length;
		result.hasMore = grants.length < item.grants.length;
	} else {
		result.grants = [];
		result.grantCount = 0;
		result.hasMore = false;
	}
	return result;
}

function adminActor(c: Context): string {
	const user = c.get("user") as { sub?: unknown } | undefined;
	if (typeof user?.sub === "string" && user.sub.trim()) return user.sub.slice(0, 256);
	return "admin";
}

/**
 * Whether the current session belongs to an admin. Delegates to the canonical
 * `assertAdmin` (which correctly rejects OAuth tokens even when the underlying
 * user row is admin, and enforces `role === "admin"`).
 */
function isAdminActor(c: Context): boolean {
	try {
		assertAdmin(c);
		return true;
	} catch {
		return false;
	}
}

/**
 * Plugin lifecycle operations require an administrator.
 *
 * This replaces a three-tier scheme (`theme-only` / `frontend` / `backend`) that let any
 * logged-in user install and enable a plugin with no server entry and no views. The tiering
 * did not survive scrutiny: a "frontend" plugin runs arbitrary JavaScript in the user's
 * browser against their own session, so calling it lower-risk than a backend plugin drew a
 * line in the wrong place, and classifying by *shape* meant a plugin changed risk class by
 * adding a view.
 *
 * The admin requirement itself stays, and is the one install-time gate this whole
 * open-capability change deliberately keeps: installing a plugin puts third-party code on
 * the server, which is a different decision from what an installed plugin may then do.
 */
function assertPluginAdmin(c: Context): void {
	if (isAdminActor(c)) return;
	throw new AppError(
		"Plugin lifecycle operations require an administrator",
		403,
		"PLUGIN_REQUIRES_ADMIN",
	);
}

function toError(error: unknown): AppError {
	if (error instanceof AppError) return error;
	return new AppError("Plugin operation failed", 500, "PLUGIN_OPERATION_FAILED");
}

function errorResponse(c: Context, error: unknown): Response {
	const appError = toError(error);
	// biome-ignore lint/suspicious/noExplicitAny: Hono requires a literal status union.
	return c.json({ error: appError.message, code: appError.code }, appError.statusCode as any);
}

function parseBodyError(error: unknown): ValidationError {
	if (error instanceof z.ZodError) return new ValidationError(formatZodError(error));
	return new ValidationError("Invalid JSON request body");
}

function parsePluginId(c: Context): string {
	const parsed = pluginIdParamSchema.safeParse(c.req.param());
	if (!parsed.success) throw new ValidationError(formatZodError(parsed.error));
	return parsed.data.pluginId;
}

function resolveInstallPath(input: string, roots: string[]): string {
	if (roots.length === 0) throw new ValidationError("No plugin import root is configured");
	const root = resolve(roots[0]);
	const candidate = isAbsolute(input) ? resolve(input) : resolve(root, input);
	if (!roots.some((allowed) => isContained(resolve(allowed), candidate))) {
		throw new ValidationError("Plugin package path is outside the allowed import roots");
	}
	if (!SAFE_ARCHIVE_EXTENSIONS.has(extname(candidate).toLowerCase())) {
		throw new ValidationError("Plugin package must be a .nfplugin or .zip file");
	}
	return candidate;
}

function statusEnvelope(result: unknown, fallbackPluginId: string): RouteResult {
	if (result && typeof result === "object" && !Array.isArray(result)) {
		return {
			pluginId: fallbackPluginId,
			...((sanitizeSummary(result) as Record<string, unknown>) ?? {}),
		};
	}
	return { pluginId: fallbackPluginId, result: sanitizeSummary(result) };
}

export const pluginManager = corePluginManager as PluginManager;

async function invokeLifecycle(
	manager: PluginManager,
	method: "enable" | "disable" | "activate" | "uninstall" | "retry",
	pluginId: string,
): Promise<unknown> {
	if (method === "retry")
		return manager.retry ? manager.retry(pluginId) : manager.activate(pluginId);
	return manager[method](pluginId);
}

export function createPluginRoutes(
	manager: PluginManager = pluginManager,
	options: PluginRouteOptions = {},
): Hono {
	const app = new Hono();
	const enabled =
		options.enabled ??
		manager.isEnabled?.() ??
		(typeof manager.disabled === "boolean" ? !manager.disabled : defaultEnabled());
	const admin = options.adminMiddleware ?? defaultAdminMiddleware;
	// Login-only middleware for tier-gated routes. Production relies on the
	// global /api/* session auth (so this is a no-op passthrough); tests inject
	// a middleware that seeds c.get("user") for the tier gate.
	const auth: MiddlewareHandler = options.authMiddleware ?? (async (_c, next) => next());
	const installRoots = options.installRoots ?? [getNarraforkPath("plugin-imports")];
	const providerConfig =
		options.providerConfigService ?? pluginPlatformServices.providerConfigService;

	const requirePluginsEnabled = (): void => {
		if (!enabled) throw new AppError("Plugin system is disabled", 503, "PLUGINS_DISABLED");
	};

	app.get("/", async (c) => {
		try {
			return c.json(sanitizeList(await manager.list()));
		} catch (error) {
			return errorResponse(c, error);
		}
	});

	app.get("/:pluginId", async (c) => {
		try {
			const pluginId = parsePluginId(c);
			const result = await manager.getStatus(pluginId);
			if (result == null) throw new NotFoundError("Plugin", pluginId);
			return c.json(sanitizeSummary(result));
		} catch (error) {
			return errorResponse(c, error);
		}
	});

	app.get("/:pluginId/diagnostics", async (c) => {
		try {
			const pluginId = parsePluginId(c);
			const result = await (manager.getDiagnostics
				? manager.getDiagnostics(pluginId)
				: manager.getStatus(pluginId));
			if (result == null) throw new NotFoundError("Plugin", pluginId);
			return c.json(sanitizeSummary(result));
		} catch (error) {
			return errorResponse(c, error);
		}
	});

	app.get("/:pluginId/grants", admin, async (c) => {
		try {
			const pluginId = parsePluginId(c);
			if (!manager.getPermissions) {
				throw new AppError("Plugin permission management is unavailable", 501, "NOT_IMPLEMENTED");
			}
			return c.json(sanitizePermissionSet(await manager.getPermissions(pluginId)));
		} catch (error) {
			return errorResponse(c, error);
		}
	});

	app.put("/:pluginId/grants", admin, async (c) => {
		try {
			requirePluginsEnabled();
			if (!manager.replacePermissions) {
				throw new AppError("Plugin permission management is unavailable", 501, "NOT_IMPLEMENTED");
			}
			const pluginId = parsePluginId(c);
			let rawBody: unknown;
			try {
				rawBody = await c.req.json();
			} catch (error) {
				throw parseBodyError(error);
			}
			const parsed = permissionReplaceSchema.safeParse(rawBody);
			if (!parsed.success) throw new ValidationError(formatZodError(parsed.error));
			const grantedBy = adminActor(c);
			const mutation = await manager.replacePermissions(pluginId, {
				expectedRevision: parsed.data.expectedRevision,
				grants: parsed.data.grants.map((grant) => ({ ...grant, grantedBy })),
				grantedBy,
			});
			if (!mutation || typeof mutation !== "object" || Array.isArray(mutation)) {
				return c.json(sanitizeSummary(mutation));
			}
			const result = mutation as Record<string, unknown>;
			return c.json({
				status: sanitizeSummary(result.status),
				permissions: sanitizePermissionSet(result.permissions),
			});
		} catch (error) {
			return errorResponse(c, error);
		}
	});

	app.get("/:pluginId/providers/config", admin, async (c) => {
		try {
			const pluginId = parsePluginId(c);
			const views = await providerConfig.list(pluginId);
			const providers = Array.isArray(views) ? views.map(sanitizeProviderConfigView) : [];
			return c.json({ pluginId, providers });
		} catch (error) {
			return errorResponse(c, error);
		}
	});

	app.put("/:pluginId/providers/config", admin, async (c) => {
		try {
			requirePluginsEnabled();
			const pluginId = parsePluginId(c);
			let rawBody: unknown;
			try {
				rawBody = await c.req.json();
			} catch (error) {
				throw parseBodyError(error);
			}
			const parsed = providerConfigUpdateSchema.safeParse(rawBody);
			if (!parsed.success) throw new ValidationError(formatZodError(parsed.error));
			const updated = await providerConfig.update(
				pluginId,
				parsed.data.providerInstanceId,
				parsed.data.config as Record<string, JsonValue>,
			);
			return c.json({ pluginId, provider: sanitizeProviderConfigView(updated) });
		} catch (error) {
			return errorResponse(c, error);
		}
	});

	app.put("/:pluginId/providers/prefix", admin, async (c) => {
		try {
			requirePluginsEnabled();
			const pluginId = parsePluginId(c);
			let rawBody: unknown;
			try {
				rawBody = await c.req.json();
			} catch (error) {
				throw parseBodyError(error);
			}
			const parsed = providerPrefixUpdateSchema.safeParse(rawBody);
			if (!parsed.success) throw new ValidationError(formatZodError(parsed.error));
			const updated = await providerConfig.updatePrefix(
				pluginId,
				parsed.data.providerInstanceId,
				parsed.data.providerPrefix,
			);
			return c.json({ pluginId, provider: sanitizeProviderConfigView(updated) });
		} catch (error) {
			return errorResponse(c, error);
		}
	});

	app.post("/:pluginId/grants/revoke", admin, async (c) => {
		try {
			requirePluginsEnabled();
			if (!manager.revokePermissions) {
				throw new AppError("Plugin permission management is unavailable", 501, "NOT_IMPLEMENTED");
			}
			const pluginId = parsePluginId(c);
			let rawBody: unknown;
			try {
				rawBody = await c.req.json();
			} catch (error) {
				throw parseBodyError(error);
			}
			const parsed = permissionRevokeSchema.safeParse(rawBody);
			if (!parsed.success) throw new ValidationError(formatZodError(parsed.error));
			const mutation = await manager.revokePermissions(pluginId, {
				...parsed.data,
				grantedBy: adminActor(c),
			});
			if (!mutation || typeof mutation !== "object" || Array.isArray(mutation)) {
				return c.json(sanitizeSummary(mutation));
			}
			const result = mutation as Record<string, unknown>;
			return c.json({
				status: sanitizeSummary(result.status),
				permissions: sanitizePermissionSet(result.permissions),
			});
		} catch (error) {
			return errorResponse(c, error);
		}
	});

	// List installable package files that already sit in the import roots. This
	// is deliberately confined to the import roots and only reports archive files
	// directly inside them — it never exposes the wider server filesystem. Used by
	// the install modal's "pick an existing package" control. Login-only.
	app.get("/install/sources", async (c) => {
		try {
			requirePluginsEnabled();
			const sources: Array<{ name: string; path: string; size: number }> = [];
			const MAX_SOURCES = 200;
			for (const root of installRoots) {
				const resolvedRoot = resolve(root);
				let entries: string[];
				try {
					entries = await readdir(resolvedRoot);
				} catch {
					continue; // Root does not exist yet or is unreadable; skip.
				}
				for (const entry of entries) {
					if (sources.length >= MAX_SOURCES) break;
					if (!SAFE_ARCHIVE_EXTENSIONS.has(extname(entry).toLowerCase())) continue;
					const full = join(resolvedRoot, entry);
					// Guard against symlinks pointing outside the root.
					if (!isContained(resolvedRoot, full)) continue;
					try {
						const info = await stat(full);
						if (!info.isFile()) continue;
						sources.push({ name: basename(entry), path: entry, size: info.size });
					} catch {
						// Unreadable entry; skip.
					}
				}
				if (sources.length >= MAX_SOURCES) break;
			}
			sources.sort((a, b) => a.name.localeCompare(b.name));
			return c.json(sources);
		} catch (error) {
			return errorResponse(c, error);
		}
	});

	app.post("/install", auth, async (c) => {
		try {
			requirePluginsEnabled();
			// Checked before installing, not after. The old flow had to install first because
			// the risk tier was only knowable from a parsed manifest, then roll back and 403 a
			// non-admin — which meant an unauthorized request still wrote to disk. A flat admin
			// rule is decidable from the request alone, so nothing is staged for a caller who
			// was never allowed to install.
			assertPluginAdmin(c);
			const contentType = c.req.header("content-type") ?? "";

			// Multipart upload: install directly from the uploaded bytes (no
			// intermediate on-disk copy; the package store streams it to a staging
			// dir, validates, then discards on failure). install never executes
			// plugin code, so the tier is only known after static parsing.
			if (contentType.includes("multipart/form-data")) {
				const form = await c.req.formData();
				const archive = form.get("archive") ?? form.get("file");
				if (!(archive instanceof File)) {
					throw new ValidationError("No plugin package uploaded (field 'archive')");
				}
				const name = archive.name.toLowerCase();
				if (!name.endsWith(".zip") && !name.endsWith(".nfplugin")) {
					throw new ValidationError("Plugin package must be a .zip or .nfplugin file");
				}
				if (archive.size > MAX_UPLOAD_BYTES) {
					throw new AppError(
						`Plugin package exceeds the ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB upload limit`,
						413,
						"PAYLOAD_TOO_LARGE",
					);
				}
				const status = await manager.install(archive);
				return c.json(sanitizeSummary(status), 201);
			}

			// JSON path: install an already-present package under an import root.
			let body: unknown;
			try {
				body = await c.req.json();
			} catch (error) {
				throw parseBodyError(error);
			}
			const parsed = installSchema.safeParse(body);
			if (!parsed.success) throw new ValidationError(formatZodError(parsed.error));
			const source = resolveInstallPath(parsed.data.path, installRoots);
			const status = await manager.install(source);
			return c.json(sanitizeSummary(status), 201);
		} catch (error) {
			return errorResponse(c, error);
		}
	});

	const lifecycle = [
		["enable", "enable"],
		["disable", "disable"],
		["activate", "activate"],
		["uninstall", "uninstall"],
		["retry", "retry"],
	] as const;
	for (const [path, method] of lifecycle) {
		// Every lifecycle transition requires an admin, regardless of what the plugin
		// contributes. Previously a non-admin could enable/disable/uninstall a plugin the
		// host classified as theme-only.
		app.post(`/:pluginId/${path}`, auth, async (c) => {
			try {
				requirePluginsEnabled();
				assertPluginAdmin(c);
				const pluginId = parsePluginId(c);
				const current = await manager.getStatus(pluginId);
				if (current == null) throw new NotFoundError("Plugin", pluginId);
				return c.json(statusEnvelope(await invokeLifecycle(manager, method, pluginId), pluginId));
			} catch (error) {
				return errorResponse(c, error);
			}
		});
	}

	return app;
}

export const pluginRoutes = createPluginRoutes();
