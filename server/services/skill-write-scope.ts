import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileWrite } from "./file-write-queue";
// File trees can be visible through overlapping/nested project and global roots.
// One bounded write queue serializes only local commits, never network downloads.
export function withSkillCreation<T>(
	_skillsDir: string,
	body: () => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	return withFileWrite(
		{
			deviceId: "local",
			pathFlavor: process.platform === "win32" ? "windows" : "posix",
			canonicalPath: join(tmpdir(), ".narrafork-skill-writes"),
		},
		body,
		{ signal },
	);
}
