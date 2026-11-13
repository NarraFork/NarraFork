import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	buildRemoteFrontendArtifact,
	type RemoteFrontendArtifactTarget,
} from "../../scripts/lib/remote-frontend-artifact";
import { REMOTE_FRONTEND_CAPABILITY } from "../../shared/remote-access/application";
import { remoteFrontendArtifactNames } from "../../shared/remote-access/frontend-manifest";

/** Real deterministic tar/gzip bytes, not a mocked verifier. Parent owns root cleanup. */
export async function remoteReleaseFixture(
	root: string,
	identity: { repository: string; version: string; commit: string },
	outputDir = join(root, "remote-assets"),
) {
	const inputDir = await mkdtemp(join(root, "remote-input-"));
	await mkdir(join(inputDir, ".vite"));
	await writeFile(join(inputDir, "bootstrap.js"), "export const bootstrap = true;");
	await writeFile(join(inputDir, "mount.js"), "export function mount() { return 'immutable'; }");
	await writeFile(
		join(inputDir, ".vite", "manifest.json"),
		JSON.stringify({
			"remote/bootstrap.ts": { name: "bootstrap", file: "bootstrap.js", isEntry: true },
			"remote/mount.tsx": { name: "mount", file: "mount.js", isEntry: true },
		}),
	);
	const target: RemoteFrontendArtifactTarget = {
		...identity,
		capability: REMOTE_FRONTEND_CAPABILITY,
	};
	const manifest = await buildRemoteFrontendArtifact({ root, inputDir, outputDir, target });
	return {
		directory: outputDir,
		target,
		manifest,
		names: remoteFrontendArtifactNames(identity.version),
	};
}
