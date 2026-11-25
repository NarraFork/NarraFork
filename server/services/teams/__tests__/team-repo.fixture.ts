/**
 * A team's project needs a local git work tree whose base branch names a commit (`createTeam`
 * refuses anything else), so team tests give their project directory a real repository: one
 * commit on `branch`, nothing else.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function initTeamRepo(dir: string, branch = "main"): string {
	mkdirSync(dir, { recursive: true });
	const git = (...args: string[]) => {
		const result = spawnSync("git", args, {
			cwd: dir,
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "t",
				GIT_AUTHOR_EMAIL: "t@example.com",
				GIT_COMMITTER_NAME: "t",
				GIT_COMMITTER_EMAIL: "t@example.com",
			},
			encoding: "utf8",
			timeout: 30_000,
		});
		if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
	};
	git("init", "-q", "-b", branch);
	writeFileSync(join(dir, "README.md"), "team fixture\n");
	git("add", "README.md");
	git("-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", "init");
	return dir;
}
