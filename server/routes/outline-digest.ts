/**
 * The reports API (汇报, outline P2 PR 11), mounted at `/api/outline/digests` inside the outline
 * routes (so `outline.enabled` off answers 404 here too). Every route is the signed-in person's
 * own: another person's report is 404, exactly like one that does not exist.
 *
 *   - `GET /`: the person's daily reports, latest day first (`before`, `limit`), and the current
 *     "today so far" preview: heads only, never the items.
 *   - `GET /:id`: one report as the person may see it now (`services/outline/digest-view.ts`).
 *   - `POST /now`: ask for "today so far" (queued for the background job; 202).
 *   - `POST /seen`: the person read these reports (`ids`), or all their unread ones (`all`).
 *   - `POST /undo`: take back a decision made in the person's name, by reverting its commit
 *     (only the person it was made for, only while they may write the space and while it can
 *     still be taken back).
 */
import type {
	OutlineDigestDetailResponse,
	OutlineDigestListResponse,
	OutlineDigestNowResponse,
	OutlineDigestUndoResponse,
} from "@shared/outline-digest";
import { type Context, Hono } from "hono";
import { ValidationError } from "../lib/errors";
import {
	outlineDigestListQuerySchema,
	outlineDigestsSeenBodySchema,
	outlineDigestUndoBodySchema,
} from "../lib/validators/outline/digest";
import { outlineIdSchema } from "../lib/validators/outline/index";
import type { OutlinePrincipal } from "../services/outline/access";
import {
	listOutlineDigests,
	markOutlineDigestsSeen,
	readOutlineDigestDetail,
	requestOutlineDigestNow,
	undoOutlineDelegatedDecision,
} from "../services/outline/digest-view";

export const outlineDigestRoutes = new Hono();

function principalOf(c: Context): OutlinePrincipal {
	const user = c.get("user");
	return { userId: user.sub, isAdmin: user.role === "admin" };
}

function parse<T>(
	schema: {
		safeParse(input: unknown): { success: true; data: T } | { success: false; error: Error };
	},
	input: unknown,
): T {
	const parsed = schema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return parsed.data;
}

outlineDigestRoutes.get("/", async (c) => {
	const query = parse(outlineDigestListQuerySchema, c.req.query());
	const body: OutlineDigestListResponse = await listOutlineDigests(principalOf(c), query);
	return c.json(body);
});

outlineDigestRoutes.post("/now", async (c) => {
	const body: OutlineDigestNowResponse = await requestOutlineDigestNow(principalOf(c));
	return c.json(body, 202);
});

outlineDigestRoutes.post("/seen", async (c) => {
	const input = parse(outlineDigestsSeenBodySchema, await c.req.json().catch(() => ({})));
	const marked = await markOutlineDigestsSeen(principalOf(c), "all" in input ? "all" : input.ids);
	return c.json({ marked });
});

outlineDigestRoutes.post("/undo", async (c) => {
	const input = parse(outlineDigestUndoBodySchema, await c.req.json().catch(() => ({})));
	const body: OutlineDigestUndoResponse = await undoOutlineDelegatedDecision(
		principalOf(c),
		input.commitId,
	);
	return c.json(body);
});

outlineDigestRoutes.get("/:id", async (c) => {
	const id = parse(outlineIdSchema, c.req.param("id"));
	const body: OutlineDigestDetailResponse = await readOutlineDigestDetail(principalOf(c), id);
	return c.json(body);
});
