import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readArtifactObject, readNarratorBackupArtifact } from "./artifact";
import { treeEntries } from "./objects";

/** Test-only byte oracle. Takes NO destination path and can never restore a user worktree.
 * No Git/Bash/Write/Edit replay: every output byte is read from the offline SQLite artifact.
 */
export async function createOfflineBackupFixture(artifactPath: string) {
	if (process.env.NODE_ENV !== "test")
		throw new Error("Offline fixture restore is test-only; production disk restore is forbidden");
	const { manifest } = readNarratorBackupArtifact(artifactPath, () => {});
	if (manifest.profile !== "conversation-tree-v1")
		throw new Error("State-only artifacts do not promise workspace bytes");
	const root = await mkdtemp(join(tmpdir(), "nf-backup-offline-fixture-"));
	const workspace = join(root, "workspace");
	const known = new Map(manifest.objects.map((object) => [object.key, object]));
	async function tree(oid: string, directory: string, depth = 0): Promise<void> {
		if (depth > 256 || known.get(`git:${oid}`)?.kind !== "git-tree")
			throw new Error("Missing or excessive offline tree");
		await mkdir(directory, { recursive: true, mode: 0o700 });
		for (const entry of treeEntries(readArtifactObject(artifactPath, `git:${oid}`))) {
			const path = join(directory, entry.name);
			if (entry.mode === "40000") await tree(entry.oid, path, depth + 1);
			else {
				if (known.get(`git:${entry.oid}`)?.kind !== "git-blob")
					throw new Error("Missing offline blob");
				const bytes = readArtifactObject(artifactPath, `git:${entry.oid}`);
				if (entry.mode === "120000") await symlink(bytes.toString("utf8"), path);
				else {
					await writeFile(path, bytes);
					await chmod(path, entry.mode === "100755" ? 0o755 : 0o644);
				}
			}
		}
	}
	return {
		workspace,
		async apply(treeOid: string) {
			// This directory was created by THIS function, never supplied by HTTP or a caller.
			await rm(workspace, { recursive: true, force: true });
			await tree(treeOid, workspace);
		},
		objectBytes(key: string) {
			return readArtifactObject(artifactPath, key);
		},
		async dispose() {
			await rm(root, { recursive: true, force: true });
		},
	};
}
