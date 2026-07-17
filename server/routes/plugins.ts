import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { z } from "zod/v4";
import { AppError, formatZodError, NotFoundError, ValidationError } from "../lib/errors";
import { getNarraforkPath } from "../lib/narrafork-home";
import { pluginIdSchema } from "../lib/plugins/manifest";
import { pluginManager as corePluginManager } from "../services/plugin-manager";

const MAX_DIAGNOSTIC_TEXT = 1_000;
const MAX_INSTALL_PATH = 4_096;
const SAFE_ARCHIVE_EXTENSIONS = new Set([".zip", ".nfplugin"]);

export type PluginDesiredState = "disabled" | "enabled" | "uninstalling";

export interface PluginManager {
	readonly disabled?: boolean;
	isEnabled?(): boolean;
	list(): Promise<unknown> | unknown;
	getStatus(pluginId: string): Promise<unknown> | unknown;
	getDiagnostics?(pluginId: string): Promise<unknown> | unknown;
	install(source: string): Promise<unknown>;
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
}

const pluginIdParamSchema = z.object({
	pluginId: pluginIdSchema,
});

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
	return value === "1" || value?.toLowerCase() === "true";
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
	for (const key of ["id", "fullId", "kind", "title", "topic"]) {
		if (typeof item[key] === "string") result[key] = String(item[key]).slice(0, 500);
	}
	if (typeof item.hasSchema === "boolean") result.hasSchema = item.hasSchema;
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
	const installRoots = options.installRoots ?? [getNarraforkPath("plugin-imports")];

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

	app.post("/install", admin, async (c) => {
		try {
			requirePluginsEnabled();
			let body: unknown;
			try {
				body = await c.req.json();
			} catch (error) {
				throw parseBodyError(error);
			}
			const parsed = installSchema.safeParse(body);
			if (!parsed.success) throw new ValidationError(formatZodError(parsed.error));
			const source = resolveInstallPath(parsed.data.path, installRoots);
			return c.json(sanitizeSummary(await manager.install(source)), 201);
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
		app.post(`/:pluginId/${path}`, admin, async (c) => {
			try {
				requirePluginsEnabled();
				const pluginId = parsePluginId(c);
				return c.json(statusEnvelope(await invokeLifecycle(manager, method, pluginId), pluginId));
			} catch (error) {
				return errorResponse(c, error);
			}
		});
	}

	return app;
}

export const pluginRoutes = createPluginRoutes();
