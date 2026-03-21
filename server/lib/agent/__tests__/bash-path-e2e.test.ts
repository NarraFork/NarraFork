import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { resolvePermissionDecision } from "../../../services/narrator-session";
import { analyzeBashCommand } from "../bash-analyze";

const CWD = "/home/user/project";

/**
 * 端到端验证：analyzeBashCommand → resolvePermissionDecision
 * 模拟 handlePermission 中的完整链路
 */
async function fullChain(
	cmd: string,
	permMode = "default",
): Promise<"allow" | "deny" | "ask" | "fatal"> {
	const analysis = await analyzeBashCommand(cmd, CWD);
	return resolvePermissionDecision({
		toolName: "Bash",
		input: { command: cmd },
		permMode,
		cwd: CWD,
		bashAnalysis: analysis,
	});
}

describe("e2e: ls/grep pipe — project internal", () => {
	test("ls -la | grep .ts → allow (acceptEdits)", async () => {
		expect(await fullChain("ls -la | grep .ts", "acceptEdits")).toBe("allow");
	});

	test("ls src/ | grep -i test → allow (acceptEdits)", async () => {
		expect(await fullChain("ls src/ | grep -i test", "acceptEdits")).toBe("allow");
	});

	test("grep -r TODO src/ | sort → allow (acceptEdits)", async () => {
		expect(await fullChain("grep -r TODO src/ | sort", "acceptEdits")).toBe("allow");
	});

	test("grep -rn import src/ | head -20 → allow (acceptEdits)", async () => {
		expect(await fullChain("grep -rn import src/ | head -20", "acceptEdits")).toBe("allow");
	});

	test("cat package.json | grep version → allow (acceptEdits)", async () => {
		expect(await fullChain("cat package.json | grep version", "acceptEdits")).toBe("allow");
	});

	test("find . -name '*.ts' | grep -v node_modules → allow (acceptEdits)", async () => {
		expect(await fullChain("find . -name '*.ts' | grep -v node_modules", "acceptEdits")).toBe(
			"allow",
		);
	});

	test("find src/ -type f -name '*.ts' → allow (acceptEdits)", async () => {
		expect(await fullChain("find src/ -type f -name '*.ts'", "acceptEdits")).toBe("allow");
	});

	test("ls -R | grep -E '\\.(ts|tsx)$' → allow (acceptEdits)", async () => {
		expect(await fullChain("ls -R | grep -E '\\.(ts|tsx)$'", "acceptEdits")).toBe("allow");
	});

	test("default mode: safe internal bash → ask", async () => {
		expect(await fullChain("ls -la | grep .ts")).toBe("ask");
	});
});

describe("e2e: ls/grep — external directory → ask", () => {
	test("ls /etc/ → ask", async () => {
		expect(await fullChain("ls /etc/")).toBe("ask");
	});

	test("ls /tmp/some-dir → ask", async () => {
		expect(await fullChain("ls /tmp/some-dir")).toBe("ask");
	});

	test("grep -r password /etc/ → ask", async () => {
		expect(await fullChain("grep -r password /etc/")).toBe("ask");
	});

	test("cat /etc/passwd → ask", async () => {
		expect(await fullChain("cat /etc/passwd")).toBe("ask");
	});

	test("find /var/log -name '*.log' → ask", async () => {
		expect(await fullChain("find /var/log -name '*.log'")).toBe("ask");
	});

	test("grep -r secret /etc/ | head -5 → ask", async () => {
		expect(await fullChain("grep -r secret /etc/ | head -5")).toBe("ask");
	});

	test("head -20 /etc/hosts → ask", async () => {
		expect(await fullChain("head -20 /etc/hosts")).toBe("ask");
	});

	test("cat /etc/shadow | grep root → ask", async () => {
		expect(await fullChain("cat /etc/shadow | grep root")).toBe("ask");
	});
});

describe("e2e: path extraction correctness", () => {
	test("ls with no path → no filePaths (uses cwd)", async () => {
		const a = await analyzeBashCommand("ls -la", CWD);
		expect(a.filePaths).toHaveLength(0);
		expect(a.allWhitelisted).toBe(true);
	});

	test("ls with relative path → resolved to cwd", async () => {
		const a = await analyzeBashCommand("ls src/", CWD);
		expect(a.filePaths).toContain(resolve(CWD, "src"));
	});

	test("grep with path after pattern", async () => {
		const a = await analyzeBashCommand("grep -r TODO src/", CWD);
		expect(a.filePaths).toContain(resolve(CWD, "src"));
	});

	test("grep pattern only → no filePaths", async () => {
		const a = await analyzeBashCommand("grep -r TODO", CWD);
		expect(a.filePaths).toHaveLength(0);
	});

	test("find with path before expression", async () => {
		const a = await analyzeBashCommand("find src/ -name '*.ts'", CWD);
		expect(a.filePaths).toContain(resolve(CWD, "src"));
	});

	test("find with external path", async () => {
		const a = await analyzeBashCommand("find /var/log -name '*.log'", CWD);
		expect(a.filePaths).toContain("/var/log");
	});

	test("cat with external file", async () => {
		const a = await analyzeBashCommand("cat /etc/passwd", CWD);
		expect(a.filePaths).toContain("/etc/passwd");
	});
});

describe("e2e: git clone/init to external directory → ask", () => {
	test("git clone to external directory → ask (acceptEdits)", async () => {
		expect(
			await fullChain("git clone https://github.com/user/repo.git /tmp/my-clone", "acceptEdits"),
		).toBe("ask");
	});

	test("git clone to external directory → ask (default)", async () => {
		expect(await fullChain("git clone https://github.com/user/repo.git /tmp/my-clone")).toBe("ask");
	});

	test("git clone to project-internal directory → allow (acceptEdits)", async () => {
		expect(
			await fullChain("git clone https://github.com/user/repo.git ./vendor/repo", "acceptEdits"),
		).toBe("allow");
	});

	test("git clone without target directory → allow (acceptEdits)", async () => {
		expect(await fullChain("git clone https://github.com/user/repo.git", "acceptEdits")).toBe(
			"allow",
		);
	});

	test("git -C external dir → ask (acceptEdits)", async () => {
		expect(await fullChain("git -C /opt/other-project status", "acceptEdits")).toBe("ask");
	});

	test("git init external directory → ask (acceptEdits)", async () => {
		expect(await fullChain("git init /tmp/new-repo", "acceptEdits")).toBe("ask");
	});

	test("git init in cwd → allow (acceptEdits)", async () => {
		expect(await fullChain("git init", "acceptEdits")).toBe("allow");
	});

	test("git worktree add external path → ask (acceptEdits)", async () => {
		expect(await fullChain("git worktree add /tmp/wt feature", "acceptEdits")).toBe("ask");
	});

	test("git status (no external paths) → allow (acceptEdits)", async () => {
		expect(await fullChain("git status", "acceptEdits")).toBe("allow");
	});

	test("git log (no external paths) → allow (acceptEdits)", async () => {
		expect(await fullChain("git log --oneline", "acceptEdits")).toBe("allow");
	});
});
