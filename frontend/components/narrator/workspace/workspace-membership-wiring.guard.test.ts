/**
 * workspace-membership-wiring.guard.test.ts — membership must be written on the server
 * for every user action that adds or removes a workspace panel.
 *
 * Membership (`workspace_panels`) is the authority for "which panels does this workspace
 * contain"; the layout blob only records positions. That inversion is only true if every
 * user action goes through the server. Three regressions proved the wiring itself has to be
 * pinned, because all were wiring gaps rather than logic errors — every unit test passed:
 *
 *  1. **Closing did not detach.** `useRemoveWorkspacePanel` existed, was exported, and had
 *     ZERO call sites. Closing a panel removed it from dockview only, so the row survived
 *     and the next membership refresh re-added the panel the user had just closed. Symptom:
 *     "the panel won't close / it comes back."
 *
 *  2. **Creating did not persist.** Terminal and webview panels were created with a bare
 *     `api.addPanel`, so no row was ever written. They were then classified as stale
 *     members and closed by the sync, and pruned from the layout on the next open —
 *     the original "listed but invisible" bug, reintroduced for those kinds.
 *
 *  3. **Dropping did not persist.** The same bare `api.addPanel`, in the two canvas drop
 *     handlers. Dropping a narrator onto the sidebar's workspace row wrote a row; dropping
 *     it onto the canvas did not, so the panel appeared and the sync closed it moments
 *     later. This file existed at the time and did not catch it: the assertions below were
 *     scoped to the creation helpers, and nothing looked at the drop handlers or at
 *     `panels.tsx` — where a webview's own config editor was likewise layout-only.
 *
 * All three are invisible to unit tests that call the service directly, which is exactly
 * what the existing suites do. Filesystem-only, zero runtime.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const WORKSPACE_DIR = import.meta.dir;
const FRONTEND_ROOT = resolve(WORKSPACE_DIR, "..", "..", "..");
const REPO_ROOT = resolve(FRONTEND_ROOT, "..");

function read(...segments: string[]): string {
	return readFileSync(join(...segments), "utf8");
}

const surface = () => read(WORKSPACE_DIR, "DockviewWorkspace.tsx");
const panelTypes = () => read(WORKSPACE_DIR, "panel-types.ts");
const dndBridge = () => read(WORKSPACE_DIR, "dnd-bridge.ts");
const dockviewLayout = () => read(WORKSPACE_DIR, "dockview-layout.ts");
const sharedVocabulary = () => read(REPO_ROOT, "shared", "workspace-panels.ts");
const panelValidators = () => read(REPO_ROOT, "server", "lib", "validators", "workspaces.ts");

describe("closing a member panel detaches it from membership", () => {
	// The listener is where a user close becomes a server DELETE. Without it the row
	// outlives the panel and the sync resurrects it.
	it("the surface reacts to panel removal by detaching", () => {
		const source = surface();
		expect(source).toContain("onDidRemovePanel");
		expect(source).toContain("detachClosedMemberPanelRef.current");
	});

	it("detaching calls the membership endpoint", () => {
		expect(surface()).toContain("removeWorkspacePanel(workspaceId");
	});

	// Self-inflicted closes (the sync pruning a panel whose row is already gone) must not
	// be reported as user removals, or a prune would delete the membership it is rendering.
	it("programmatic closes are excluded from detaching", () => {
		const source = surface();
		expect(source).toContain("selfClosedPanelIdsRef");
		expect(source).toContain("closePanelInternally");
	});

	it("the membership sync closes stale panels internally, never bare", () => {
		const source = surface();
		const syncBody = source.slice(source.indexOf("const liveByIdentity"));
		// A bare `.api.close()` here would re-enter the detach path.
		expect(syncBody).toContain("closePanelInternally(panel)");
	});
});

describe("membership panels cannot be created without a row", () => {
	// `panelRowId` is what makes "add a terminal without creating its row" unrepresentable.
	// If it ever becomes optional, the compiler stops catching the second regression above.
	it("non-narrator member params require a panelRowId", () => {
		const source = panelTypes();
		expect(source).toContain("panelRowId: string");
		expect(source).not.toContain("panelRowId?:");
	});

	it("terminal and webview params carry the row reference", () => {
		const source = panelTypes();
		expect(source).toMatch(/interface TerminalPanelParams extends WorkspaceMemberRowRef/);
		expect(source).toMatch(/interface WebviewPanelParams extends WorkspaceMemberRowRef/);
	});

	// These builders assembled member params on the client, with no row behind them.
	it("the drag bridge no longer fabricates member params", () => {
		const source = dndBridge();
		expect(source).not.toContain("export function terminalDropPayload");
		expect(source).not.toContain("export function webviewDropPayload");
	});

	// Client-side legacy migration produced panels with no row, which the surface pruned.
	it("the client no longer migrates legacy layouts into panels", () => {
		const source = dockviewLayout();
		expect(source).not.toContain("export function migrateLegacyTree");
		expect(source).not.toContain("export function applyResolvedLayout");
	});
});

describe("plugin panels are resources, not membership", () => {
	// A workspace plugin panel binds to an owning narrator, so no row is ever created for
	// it. Listing it as a membership kind made the sync close every live plugin panel.
	it("the shared vocabulary excludes plugin", () => {
		expect(sharedVocabulary()).toContain(
			'export const WORKSPACE_PANEL_KINDS = ["narrator", "terminal", "webview"] as const',
		);
	});

	it("the create schema rejects plugin", () => {
		expect(panelValidators()).toContain('kind: z.enum(["terminal", "webview"])');
	});

	// `isDirectorRenderablePanel` includes plugin, so the sync must NOT use it to decide
	// membership — that is precisely how live plugin panels got closed.
	it("the surface distinguishes membership from director-renderable", () => {
		const source = surface();
		expect(source).toContain("function isMembershipPanel");
		const syncBody = source.slice(source.indexOf("const liveByIdentity"));
		expect(syncBody).toContain("isMembershipPanel(params)");
		expect(syncBody).not.toContain("isDirectorRenderablePanel(params)");
	});
});

describe("identity is computed in exactly one place", () => {
	// Two matching rules (dom id vs identity) collapsed a restored multi-pane layout into
	// a single pane: every member read as absent and every restored panel as a non-member.
	it("the surface resolves panels through the shared identity helpers", () => {
		const source = surface();
		expect(source).toContain("livePanelIdentity");
		expect(source).toContain("memberIdentity");
	});

	it("addMemberPanel searches by identity, not by expected dom id", () => {
		const source = surface();
		const body = source.slice(
			source.indexOf("const addMemberPanel"),
			source.indexOf("const buildSurface"),
		);
		expect(body).toContain("memberIdentity(member)");
		// `getPanel(panelDomId(member))` would miss a panel restored under a synthetic id.
		expect(body).not.toContain("api.getPanel(panelDomId");
	});
});

describe("dropping a narrator onto the canvas writes membership", () => {
	/** A drop handler's body, sliced between its declaration and the next one. */
	function handlerBody(name: string): string {
		const source = surface();
		const start = source.indexOf(`const ${name} = useCallback`);
		if (start < 0) throw new Error(`${name} not found — rename or removal breaks this guard`);
		// Bounded by the next top-level `const ... = useCallback` / `useEffect`, whichever
		// comes first, so the slice cannot silently swallow unrelated code.
		const rest = source.slice(start + 1);
		const nextConst = rest.indexOf("\n\tconst ");
		const nextEffect = rest.indexOf("\n\tuseEffect(");
		const candidates = [nextConst, nextEffect].filter((i) => i >= 0);
		const end = candidates.length > 0 ? Math.min(...candidates) : rest.length;
		return rest.slice(0, end);
	}

	// The shared helper: creates the row, awaits the refetch, then positions the panel the
	// sync produced. Both handlers must go through it.
	it("the surface has a membership-first helper for dropped narrators", () => {
		const source = surface();
		expect(source).toContain("const addDroppedNarrator");
		expect(source).toContain('addWorkspacePanel(workspaceId, { kind: "narrator", narratorId })');
		// The refetch is what makes the surface converge on server state instead of a guess.
		const body = handlerBody("addDroppedNarrator");
		expect(body).toContain("onMembershipChanged?.()");
	});

	for (const handler of ["handleDidDrop", "handleDropSubject"]) {
		it(`${handler} creates a narrator through membership, never with a bare addPanel`, () => {
			const body = handlerBody(handler);
			expect(body).toContain("addDroppedNarrator(");
			// `handleDidDrop` still calls `addPanel` for NON-member payloads (tool/plugin
			// cells own no row), so the assertion is that no `addPanel` sits in a branch
			// holding a narratorId — checked by requiring the narrator branch to return
			// before the generic add is reached.
			const narratorBranch = body.slice(0, body.indexOf("addDroppedNarrator("));
			expect(narratorBranch).not.toContain("api.addPanel({");
		});
	}

	it("handleDropSubject has no addPanel at all", () => {
		// Unlike `handleDidDrop`, this one only ever materialises narrators, so any
		// `addPanel` here is by definition a rowless creation.
		expect(handlerBody("handleDropSubject")).not.toContain("api.addPanel(");
	});
});

describe("row-owned config is persisted to the row, not just the layout", () => {
	const panels = () => read(WORKSPACE_DIR, "panels.tsx");

	// A webview's config is row state. Writing only `updateParameters` kept the edit until
	// the layout was next discarded (a revision conflict, a corrupt tree), then reverted it.
	it("the webview panel adapter persists config edits to its row", () => {
		const source = panels();
		expect(source).toContain("updateWorkspacePanelConfig(workspaceId, panelRowId");
	});

	// Rebuilding the params object from scratch drops `panelRowId`, after which the panel
	// can no longer find the row that owns its config.
	it("the webview panel adapter preserves panelRowId when updating params", () => {
		const source = panels();
		expect(source).toContain("updateParameters({ ...props.params");
		expect(source).not.toContain('updateParameters({ panelType: "webview"');
	});

	// Same rule on the director side.
	it("the director's config writer spreads the live params", () => {
		const source = surface();
		expect(source).toContain("updateParameters({ ...current, webviewConfig: config })");
	});

	// `panelRowId` is required by the type, but these params can come from a restored
	// layout — interpolating `undefined` produced a request to `/panels/undefined`, whose
	// 404 landed in a catch and read as a transient failure.
	it("a missing row id is refused instead of interpolated into the URL", () => {
		expect(surface()).toContain("if (!current.panelRowId)");
	});

	// The row id must come from the row, never from stored config.
	it("paramsForMember stamps the row id onto member params", () => {
		expect(surface()).toContain("panelRowId: member.id");
	});
});
