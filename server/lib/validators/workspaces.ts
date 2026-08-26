import { z } from "zod";

/**
 * Ceiling on one workspace's serialized dockview layout (`workspaces.tree`).
 *
 * Measured in UTF-8 BYTES, which is what SQLite stores and what the request body
 * actually costs. The previous limit was a plain `z.string().max(500_000)`, and
 * zod counts UTF-16 code units — so a layout full of CJK panel titles could put
 * ~1.5 MB into the row while "passing a 500 KB limit". The stated bound and the
 * enforced bound have to be the same unit or the limit is decorative.
 *
 * 2 MiB is sized against what actually grows the payload: the layout skeleton is
 * tiny (~40 KB even with 120 panels), and the real weight comes from plugin
 * panels, each of which may carry up to 16 KiB of `viewState`
 * (`PLUGIN_UI_MAX_VIEW_STATE_BYTES`). 30 fully-loaded plugin panels already
 * reach ~500 KB, which is why the old ceiling was reachable in normal use. 2 MiB
 * leaves room for ~120 such panels while keeping the synchronous JSON work on
 * the server's single JS thread bounded (measured: ~3.6 ms parse / ~3.2 ms
 * stringify at 2 MB — acceptable for a debounced layout save, and the reason
 * this is not simply raised further).
 */
export const WORKSPACE_TREE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Cheap pre-check that runs before the byte count.
 *
 * UTF-8 length is always >= UTF-16 length (1 unit costs 1–3 bytes; a surrogate
 * pair costs 4 bytes for 2 units), so a string with more code units than the
 * byte budget cannot possibly fit — rejecting it here is never wrong, and it
 * avoids encoding a hostile multi-megabyte string just to learn it was too big.
 *
 * ⚠️ The load-bearing INVARIANT is `MAX_CHARS >= MAX_BYTES`, not that the two are
 * equal — they only happen to be the same number. Derived from the byte budget so
 * the relationship cannot be broken by editing one of two literals: lowering this
 * below the byte budget would make the pre-check refuse payloads the real limit
 * accepts, i.e. a 400 that claims a 2 MiB ceiling while rejecting 1.5 MiB of CJK.
 * Pinned by a test in `__tests__/workspaces.test.ts`.
 */
const WORKSPACE_TREE_MAX_CHARS = WORKSPACE_TREE_MAX_BYTES;

/** Exported for the test that pins the `chars >= bytes` invariant above. */
export const WORKSPACE_TREE_MAX_CHARS_FOR_TEST = WORKSPACE_TREE_MAX_CHARS;

/**
 * `Buffer.byteLength` rather than `new TextEncoder().encode(...).byteLength`:
 * the latter allocates a copy of the whole string as bytes, which is exactly
 * what we are trying to avoid for a payload this size.
 */
export function workspaceTreeByteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

const workspaceTreeSchema = z
	.string()
	.min(2)
	.max(WORKSPACE_TREE_MAX_CHARS)
	.refine((value) => workspaceTreeByteLength(value) <= WORKSPACE_TREE_MAX_BYTES, {
		message: `tree must not exceed ${WORKSPACE_TREE_MAX_BYTES} UTF-8 bytes`,
	});

export const createWorkspaceSchema = z.object({
	title: z.string().max(200).optional(),
	// JSON string: Dockview envelope, seed envelope, or legacy SplitNode.
	tree: workspaceTreeSchema,
});

export const updateWorkspaceSchema = z.object({
	title: z.string().max(200).optional(),
	tree: workspaceTreeSchema.optional(),
});

// === Project DB (backup/import) ===

export const importProjectSchema = z.object({
	gitPath: z.string().min(1),
});
