/**
 * Copying a block's subtree under a parent, in the same space or another (pageless outline,
 * A2), mounted inside the outline routes at `/api/outline` (so `outline.enabled` off answers
 * 404 here too). Wire types: `shared/outline-copy-api.ts`; the service:
 * `services/outline/subtree-copy.ts`.
 *
 *   - `POST /spaces/:spaceId/blocks/:blockId/copy`: copy the block (of `spaceId`) and its
 *     subtree under `parentId` of `targetSpaceId`. Call again with the returned `copyId` while
 *     `done` is false (a copy that stopped part way goes on where it stopped).
 *
 * ACCESS. Both sides are checked: the source space must be readable (404 otherwise, as one that
 * does not exist, and the block must be one of it), the target space readable (404) and
 * writable (403). A sibling named in `position` must be a live child of the parent (the write
 * path refuses it otherwise). The copy is the person's commit.
 *
 * ERRORS: 404 for a source or target that is not there (or not readable); 403; 400 for a copy
 * into the block's own subtree or a body outside the limits; the write path's errors when the
 * first commit is refused (nothing was written then).
 */
import { generateId } from "@server/lib/id";
import type { OutlineCopyResponse } from "@shared/outline-copy-api";
import { type Context, Hono } from "hono";
import { ForbiddenError, NotFoundError, ValidationError } from "../lib/errors";
import { getUserLanguage } from "../lib/i18n";
import { outlineCopyBodySchema } from "../lib/validators/outline/copy";
import { outlineIdSchema } from "../lib/validators/outline/index";
import { canReadSpace, canWriteSpace, type OutlinePrincipal } from "../services/outline/access";
import { delegationLocale } from "../services/outline/delegation-text";
import { outlineStore } from "../services/outline/store";
import { COPY_TEXT, copyOutlineSubtree } from "../services/outline/subtree-copy";
import type { OutlinePosition } from "../services/outline/write";

export const outlineCopyRoutes = new Hono();

function principalOf(c: Context): OutlinePrincipal {
	const user = c.get("user");
	return { userId: user.sub, isAdmin: user.role === "admin" };
}

function idParam(c: Context, name: string): string {
	const parsed = outlineIdSchema.safeParse(c.req.param(name));
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return parsed.data;
}

outlineCopyRoutes.post("/spaces/:spaceId/blocks/:blockId/copy", async (c) => {
	const principal = principalOf(c);
	const spaceId = idParam(c, "spaceId");
	const blockId = idParam(c, "blockId");
	let input: unknown;
	try {
		input = await c.req.json();
	} catch {
		throw new ValidationError("Invalid JSON body");
	}
	const parsed = outlineCopyBodySchema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const body = parsed.data;
	// The source: readable, and the block one of it (live).
	const source = await outlineStore.getSpace(spaceId);
	if (!source || !(await canReadSpace(principal, source)))
		throw new NotFoundError("Outline space", spaceId);
	const block = (await outlineStore.getBlockMetasByIds([blockId]))[0];
	if (!block || block.deleted || block.spaceId !== source.id)
		throw new NotFoundError("Outline block", blockId);
	// The target: readable (404) and writable (403).
	const target = await outlineStore.getSpace(body.targetSpaceId);
	if (!target || !(await canReadSpace(principal, target)))
		throw new NotFoundError("Outline space", body.targetSpaceId);
	if (!(await canWriteSpace(principal, target))) throw new ForbiddenError();
	const position: OutlinePosition =
		body.position === undefined || body.position === "last"
			? { last: true }
			: body.position === "first"
				? { first: true }
				: "after" in body.position
					? { after: { id: body.position.after } }
					: { before: { id: body.position.before } };
	const locale = delegationLocale(await getUserLanguage(principal.userId).catch(() => "en"));
	const result: OutlineCopyResponse = await copyOutlineSubtree({
		sourceBlockId: block.id,
		target: {
			space: target,
			parent: body.parentId === null ? null : { id: body.parentId },
			position,
		},
		copyId: body.copyId ?? generateId(),
		actor: { kind: "human", id: principal.userId },
		responsibleUserId: principal.userId,
		provenance: { text: (facts) => COPY_TEXT[locale].from(facts.source, facts.omitted) },
	});
	return c.json(result);
});
