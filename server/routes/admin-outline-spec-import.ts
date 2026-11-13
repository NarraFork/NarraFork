/**
 * The Dynamic Spec import as administrators run it (outline P2 PR 12b2), mounted under
 * `/api/admin/outline/spec-import` (`routes/admin.ts`; administrators only):
 *
 *   GET  /                           one state's sessions, a page at a time, and the count per state
 *   POST /:narratorId/reimport       attention and failed attempts cleared, imported now (202)
 *   POST /:narratorId/revert         moved back to Dynamic Spec (`spec-import/admin.ts`)
 *
 * Content the old Spec panel may have swallowed (outline P2 PR 12c, `spec-import/loss-*.ts`):
 *
 *   GET  /loss                       one status's findings of every session, and the scan's state
 *   GET  /loss/:findingId            one finding with the lost text
 *   POST /loss/:findingId            a decision: attach to the imported page, dismiss, reopen
 *   POST /loss-scan                  start a scan pass in the background (202)
 *
 * A session's owner keeps the Spec panel's "Import now" and its retry
 * (`POST /api/outline/narrators/:narratorId/spec-import`); a session moved back is imported again
 * by an administrator only.
 */
import type { OutlineSpecImportStatus } from "@shared/outline-spec-import";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { formatZodError, ValidationError } from "../lib/errors";
import {
	outlineIdSchema,
	outlineSpecImportAdminQuerySchema,
	outlineSpecLossActionSchema,
	outlineSpecLossQuerySchema,
} from "../lib/validators/outline";
import { requireAdmin } from "../middleware/auth";
import { isOutlineEnabled } from "../services/outline/feature";

export const outlineSpecImportAdminRoutes = new Hono();

// `adminRoutes` authenticates and requires an administrator for everything it mounts; the live
// role is checked here again, so the page is administrators' however it is mounted.
outlineSpecImportAdminRoutes.use("*", requireAdmin);
// The outline's routes answer 404 while it is off; so does this page's.
outlineSpecImportAdminRoutes.use("*", async (c, next) => {
	if (!isOutlineEnabled()) return c.notFound();
	await next();
});

function narratorIdOf(raw: string | undefined): string {
	const parsed = outlineIdSchema.safeParse(raw);
	if (!parsed.success) throw new ValidationError(formatZodError(parsed.error));
	return parsed.data;
}

outlineSpecImportAdminRoutes.get("/", async (c) => {
	const parsed = outlineSpecImportAdminQuerySchema.safeParse(c.req.query());
	if (!parsed.success) throw new ValidationError(formatZodError(parsed.error));
	const { specImportAdminPage } = await import("../services/outline/spec-import/admin");
	return c.json(await specImportAdminPage(parsed.data));
});

outlineSpecImportAdminRoutes.get("/loss", async (c) => {
	const parsed = outlineSpecLossQuerySchema.safeParse(c.req.query());
	if (!parsed.success) throw new ValidationError(formatZodError(parsed.error));
	const { specLossPage } = await import("../services/outline/spec-import/loss-findings");
	return c.json(await specLossPage({ ...parsed.data, narratorId: null, canAct: true }));
});

outlineSpecImportAdminRoutes.get("/loss/:findingId", async (c) => {
	const findingId = narratorIdOf(c.req.param("findingId"));
	const { specLossDetail } = await import("../services/outline/spec-import/loss-findings");
	return c.json(await specLossDetail(findingId, null));
});

outlineSpecImportAdminRoutes.post("/loss/:findingId", bodyLimit({ maxSize: 1024 }), async (c) => {
	const findingId = narratorIdOf(c.req.param("findingId"));
	const parsed = outlineSpecLossActionSchema.safeParse(await c.req.json().catch(() => ({})));
	if (!parsed.success) throw new ValidationError(formatZodError(parsed.error));
	const { decideSpecLossFinding } = await import("../services/outline/spec-import/loss-findings");
	return c.json(
		await decideSpecLossFinding({
			id: findingId,
			narratorId: null,
			action: parsed.data.action,
			userId: c.get("user").sub,
		}),
	);
});

// Only starts the pass: it runs in the background, one session at a time.
outlineSpecImportAdminRoutes.post("/loss-scan", async (c) => {
	const { requestSpecLossPass } = await import("../services/outline/spec-import/loss-scan");
	return c.json(requestSpecLossPass(), 202);
});

outlineSpecImportAdminRoutes.post("/:narratorId/reimport", async (c) => {
	const narratorId = narratorIdOf(c.req.param("narratorId"));
	const { reimportSpecSession } = await import("../services/outline/spec-import/admin");
	const status = await reimportSpecSession(narratorId, c.get("user").sub);
	const body: OutlineSpecImportStatus = { ...status, canImport: true };
	return c.json(body, 202);
});

outlineSpecImportAdminRoutes.post("/:narratorId/revert", async (c) => {
	const narratorId = narratorIdOf(c.req.param("narratorId"));
	const { revertSpecImport } = await import("../services/outline/spec-import/admin");
	return c.json(await revertSpecImport(narratorId, c.get("user").sub));
});
