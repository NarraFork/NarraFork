import { describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settings } from "../../lib/settings";
import * as spawn from "../../lib/spawn";
import {
	buildReferencedUploadOwnerIds,
	repackTreeSnapshots,
	storageService,
} from "../storage-service";
import { treeSnapshotPhysicalDir } from "../tree-snapshot-paths";
import { worktreeTreeSnapshot } from "../worktree-tree-snapshot";

describe("buildReferencedUploadOwnerIds", () => {
	test("preserves active narrators and deleted owners with surviving image messages", () => {
		const ownerIds = buildReferencedUploadOwnerIds(
			["active-narrator"],
			[
				{
					narratorId: "deleted-image-owner",
					contentJson: [
						{ type: "image", imageId: "img_1", filename: "shot.png", mediaType: "image/png" },
					],
				},
				{
					narratorId: "deleted-text-owner",
					contentJson: [{ type: "text", text: "no images here" }],
				},
			],
		);

		expect([...ownerIds].sort()).toEqual(["active-narrator", "deleted-image-owner"]);
	});
});

describe("local snapshot maintenance disabled", () => {
	test("startup preserves legacy file snapshots while keeping message-prefix maintenance", async () => {
		const startup = await Bun.file(new URL("../../main.ts", import.meta.url)).text();
		expect(startup).not.toContain('getNarraforkPath("snapshots")');
		expect(startup).toContain("startPrefixSnapshotMaintenance()");
	});

	test("repack does not enter GC or touch existing content even with the legacy setting enabled", async () => {
		const previous = settings.workspace.treeSnapshotsEnabled;
		settings.workspace.treeSnapshotsEnabled = true;
		const root = await mkdtemp(join(tmpdir(), "nf-preserved-tree-history-"));
		const shadow = treeSnapshotPhysicalDir("local", root);
		await mkdir(shadow, { recursive: true });
		const marker = join(shadow, "existing-object");
		await writeFile(marker, "historical content");
		const gc = spyOn(worktreeTreeSnapshot, "gcAll").mockRejectedValue(new Error("must not run"));
		const git = spyOn(spawn, "safeSpawn");
		try {
			expect(await repackTreeSnapshots()).toEqual({ removed: 0, freedBytes: 0 });
			expect(gc).not.toHaveBeenCalled();
			expect(git).not.toHaveBeenCalled();
			expect(await readFile(marker, "utf8")).toBe("historical content");
		} finally {
			gc.mockRestore();
			git.mockRestore();
			settings.workspace.treeSnapshotsEnabled = previous;
			await rm(shadow, { recursive: true, force: true });
			await rm(root, { recursive: true, force: true });
		}
	});

	test("independent container maintenance still executes", async () => {
		const run = spyOn(spawn, "safeSpawn").mockResolvedValue({
			exitCode: 0,
			stdout: "pruned dangling image",
			stderr: "",
		});
		try {
			expect(await storageService.pruneContainerImages()).toEqual({
				success: true,
				output: "pruned dangling image",
			});
			expect(run).toHaveBeenCalledWith({
				cmd: ["podman", "image", "prune", "-f"],
				timeout: 60_000,
			});
		} finally {
			run.mockRestore();
		}
	});
});
