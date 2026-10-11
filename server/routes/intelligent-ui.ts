import {
	type IntelligentUiFileReference,
	type IntelligentUiPreview,
	readIntelligentUiFileReference,
} from "@shared/intelligent-ui-files";
import type { IntelligentUiKitBundle } from "@shared/intelligent-ui-kit";
import { INTELLIGENT_UI_TOOL_NAME } from "@shared/intelligent-ui-tool-policy";
import { type Context, Hono } from "hono";
import { AppError } from "../lib/errors";
import type { KitOverview } from "../services/intelligent-ui/kit-service";

export interface IntelligentUiRouteDependencies {
	authorize(c: Context, narratorId: string): Promise<string>;
	tool(
		narratorId: string,
		toolUseId: string,
		toolCallId: string,
	): Promise<{
		id: string;
		toolName: string;
		outputJson: unknown;
		executionOriginToolCallId?: string | null;
	}>;
	preview(
		narratorId: string,
		userId: string,
		reference: IntelligentUiFileReference,
		signal: AbortSignal,
	): Promise<IntelligentUiPreview>;
	kit: {
		overview(narratorId: string, userId: string, signal: AbortSignal): Promise<KitOverview>;
		bundle(
			narratorId: string,
			userId: string,
			signal: AbortSignal,
		): Promise<IntelligentUiKitBundle>;
		approve(narratorId: string, userId: string, requestId: string): Promise<KitOverview>;
		dismiss(narratorId: string, requestId: string): Promise<{ dismissed: boolean }>;
	};
}
const defaults: IntelligentUiRouteDependencies = {
	async authorize(c, narratorId) {
		const { narratorPrincipalOf, requireNarratorAccess } = await import("../lib/narrator-access");
		const { canWriteNarrator } = await import("../services/narrator-acl");
		const principal = narratorPrincipalOf(c);
		const narrator = await requireNarratorAccess(c, narratorId, "read");
		if (!principal.userId || !(await canWriteNarrator(narrator, principal)))
			throw new AppError(
				"Public/read-only readers cannot access live UI workspace files",
				403,
				"UI_PRIVATE_FILES",
			);
		return principal.userId;
	},
	async tool(narratorId, toolUseId, toolCallId) {
		const { narratorService } = await import("../services/narrator-service");
		return narratorService.getToolCallDetail(narratorId, toolUseId, { toolCallId });
	},
	async preview(...args) {
		const { buildIntelligentUiPreview } = await import("../services/intelligent-ui/preview");
		return buildIntelligentUiPreview(...args);
	},
	kit: {
		async overview(...args) {
			const { kitService } = await import("../services/intelligent-ui/kit-service");
			return kitService.overview(...args);
		},
		async bundle(...args) {
			const { kitService } = await import("../services/intelligent-ui/kit-service");
			return kitService.bundle(...args);
		},
		async approve(...args) {
			const { kitService } = await import("../services/intelligent-ui/kit-service");
			return kitService.approve(...args);
		},
		async dismiss(...args) {
			const { kitService } = await import("../services/intelligent-ui/kit-service");
			return kitService.dismiss(...args);
		},
	},
};

export function createIntelligentUiRoutes(overrides: Partial<IntelligentUiRouteDependencies> = {}) {
	const deps = { ...defaults, ...overrides };
	const app = new Hono();
	app.onError((error, c) => {
		if (error instanceof AppError)
			return c.json({ error: error.message, code: error.code }, error.statusCode as 400);
		return c.json(
			{ error: "UI preview could not be built safely", code: "UI_PREVIEW_FAILED" },
			422,
		);
	});
	app.get("/:id/intelligent-ui/preview/:toolUseId", async (c) => {
		c.header("Cache-Control", "no-store");
		c.header("X-Content-Type-Options", "nosniff");
		const narratorId = c.req.param("id");
		const toolUseId = c.req.param("toolUseId");
		const toolCallId = c.req.query("toolCallId");
		if (
			!toolCallId ||
			[narratorId, toolUseId, toolCallId].some((id) => id.length > 200) ||
			Object.keys(c.req.query()).some((key) => key !== "toolCallId")
		)
			throw new AppError(
				"Only toolCallId may select a UI preview; source paths are not accepted",
				400,
				"UI_REFERENCE_REQUIRED",
			);
		const userId = await deps.authorize(c, narratorId);
		const tool = await deps.tool(narratorId, toolUseId, toolCallId);
		const output = tool.outputJson;
		const metadata =
			output && typeof output === "object" && "_metadata" in output ? output._metadata : null;
		const reference = readIntelligentUiFileReference(
			metadata && typeof metadata === "object" && "intelligentUi" in metadata
				? metadata.intelligentUi
				: null,
		);
		if (
			tool.toolName !== INTELLIGENT_UI_TOOL_NAME ||
			tool.id !== toolCallId ||
			!reference ||
			reference.toolUseId !== toolUseId ||
			(reference.toolCallId !== tool.id && reference.toolCallId !== tool.executionOriginToolCallId)
		)
			throw new AppError(
				"The selected tool result is not an IntelligentUI file reference",
				404,
				"UI_REFERENCE_NOT_FOUND",
			);
		// COW preserves output bytes and records the original PK in a trusted column.
		// Never fall back to an invisible origin row or accept provenance from client input.
		const preview = await deps.preview(
			narratorId,
			userId,
			{ ...reference, toolCallId: tool.id },
			c.req.raw.signal,
		);
		// Re-check narrator access as well as filesystem policy before releasing source.
		if ((await deps.authorize(c, narratorId)) !== userId)
			throw new AppError("Preview principal changed", 403, "UI_PRIVATE_FILES");
		return c.json(preview);
	});
	// Component kit: state for the chat UI, the built bundle, and the user's confirmation
	// of a build. Same audience as previews: the files are the workspace's own.
	app.get("/:id/intelligent-ui/kit", async (c) => {
		c.header("Cache-Control", "no-store");
		const narratorId = c.req.param("id");
		const userId = await deps.authorize(c, narratorId);
		return c.json(await deps.kit.overview(narratorId, userId, c.req.raw.signal));
	});
	app.get("/:id/intelligent-ui/kit/bundle", async (c) => {
		c.header("Cache-Control", "no-store");
		c.header("X-Content-Type-Options", "nosniff");
		const narratorId = c.req.param("id");
		const userId = await deps.authorize(c, narratorId);
		const bundle = await deps.kit.bundle(narratorId, userId, c.req.raw.signal);
		if ((await deps.authorize(c, narratorId)) !== userId)
			throw new AppError("Kit principal changed", 403, "UI_PRIVATE_FILES");
		return c.json(bundle);
	});
	const requestId = async (c: Context): Promise<string> => {
		const body: unknown = await c.req.json().catch(() => null);
		const id =
			body && typeof body === "object" ? (body as { requestId?: unknown }).requestId : null;
		if (typeof id !== "string" || id.length === 0 || id.length > 64)
			throw new AppError("requestId is required", 400, "UI_KIT_REQUEST_REQUIRED");
		return id;
	};
	app.post("/:id/intelligent-ui/kit/approve", async (c) => {
		const narratorId = c.req.param("id");
		const userId = await deps.authorize(c, narratorId);
		return c.json(await deps.kit.approve(narratorId, userId, await requestId(c)));
	});
	app.post("/:id/intelligent-ui/kit/dismiss", async (c) => {
		const narratorId = c.req.param("id");
		await deps.authorize(c, narratorId);
		return c.json(await deps.kit.dismiss(narratorId, await requestId(c)));
	});
	return app;
}
export const intelligentUiRoutes = createIntelligentUiRoutes();
