import { describe, expect, it } from "bun:test";
import { workspaceFilePanelId } from "../workspace/workspace-dock";
import { fileDockPanelId, hashFilePath } from "./dock-panel-types";

/**
 * A file panel's dockview id is derived from a HASH of its path, never from the
 * path itself: paths carry separators, spaces and non-ASCII and can be long, all
 * of which are unsafe / unbounded in an id. These tests pin the properties the
 * two surfaces rely on — stability (re-opening focuses instead of duplicating),
 * uniqueness, and id safety.
 */
describe("hashFilePath", () => {
	it("is deterministic", () => {
		const path = "/home/user/projects/app/src/index.ts";
		expect(hashFilePath(path)).toBe(hashFilePath(path));
	});

	it("produces id-safe output (no separators, spaces or non-ASCII)", () => {
		const paths = [
			"/home/user/a b/c.json",
			"C:\\Users\\me\\Documents\\说明.md",
			"/tmp/файл.toml",
			"/tmp/emoji-🎉.txt",
			`${"/very/deep/".repeat(40)}leaf.ini`,
		];
		for (const path of paths) {
			expect(hashFilePath(path)).toMatch(/^[0-9a-z]+$/);
		}
	});

	it("distinguishes paths that differ only in one segment", () => {
		const ids = new Set(
			[
				"/a/b/c.ts",
				"/a/b/d.ts",
				"/a/c/c.ts",
				"/a/b/c.tsx",
				"/a/b/c.ts ",
				"a/b/c.ts",
				"/A/b/c.ts",
			].map(hashFilePath),
		);
		expect(ids.size).toBe(7);
	});
});

describe("fileDockPanelId", () => {
	it("is stable for the same path and distinct across paths", () => {
		const a = fileDockPanelId("/repo/README.md");
		expect(a).toBe(fileDockPanelId("/repo/README.md"));
		expect(a).not.toBe(fileDockPanelId("/repo/CHANGELOG.md"));
	});

	it("namespaces the focus dock and never embeds the raw path", () => {
		const id = fileDockPanelId("/repo/src/a b/index.ts");
		expect(id.startsWith("ndock-file-")).toBe(true);
		expect(id).not.toContain("/");
		expect(id).not.toContain(" ");
	});

	it("does not collide with the singleton tool panel ids", () => {
		// Singleton panels use `ndock-<kind>`; a file panel must never produce one.
		for (const kind of ["chat", "terminal", "details", "filemod", "spec", "git"]) {
			expect(fileDockPanelId(`/x/${kind}`)).not.toBe(`ndock-${kind}`);
		}
	});
});

describe("focus file panel editing ownership", () => {
	it("stamps the owning narrator on new and already-open file panels", async () => {
		const source = await Bun.file(new URL("./NarratorDockContext.tsx", import.meta.url)).text();
		const start = source.indexOf("const openFilePanel");
		const end = source.indexOf("const openKnowledgePanel", start);
		const body = source.slice(start, end);

		expect(body).toContain("hostNarratorId: narratorId");
		expect(body).toContain(
			"existing.api.updateParameters({ ...current, hostNarratorId: narratorId })",
		);
	});

	it("hydrates restored focus panels from the live dock context", async () => {
		const source = await Bun.file(new URL("./panels.tsx", import.meta.url)).text();
		const start = source.indexOf("export function FileDockPanel");
		const end = source.indexOf("// ── File tree", start);
		const body = source.slice(start, end);

		expect(body).toContain("dock?.narratorId ?? props.params.hostNarratorId");
		expect(body).toContain("props.api.updateParameters({ ...props.params, hostNarratorId })");
		expect(body).toContain("hostNarratorId ? (");
	});
});

describe("workspaceFilePanelId", () => {
	it("scopes the id to the host narrator", () => {
		const path = "/repo/package.json";
		expect(workspaceFilePanelId("nA", path)).not.toBe(workspaceFilePanelId("nB", path));
	});

	it("reuses the focus dock's hash so both surfaces agree on identity", () => {
		const path = "/repo/package.json";
		expect(workspaceFilePanelId("nA", path)).toBe(`wfile_nA_${hashFilePath(path)}`);
	});

	it("is stable for the same host + path and distinct across paths", () => {
		expect(workspaceFilePanelId("nA", "/x/a.json")).toBe(workspaceFilePanelId("nA", "/x/a.json"));
		expect(workspaceFilePanelId("nA", "/x/a.json")).not.toBe(
			workspaceFilePanelId("nA", "/x/b.json"),
		);
	});
});
