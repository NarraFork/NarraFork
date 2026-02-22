import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { resolvePermissionDecision } from "../../../services/narrator-session";
import { analyzeBashCommand } from "../bash-analyze";

const CWD = "/home/user/project";

/**
 * 端到端验证：analyzeBashCommand → resolvePermissionDecision
 * 模拟 handlePermission 中的完整链路
 */
async function fullChain(cmd: string, permMode = "default"): Promise<"allow" | "deny" | "ask"> {
	const analysis = await analyzeBashCommand(cmd, CWD);
	return resolvePermissionDecision("Bash", { command: cmd }, permMode, CWD, false, analysis);
}

describe("e2e: ls/grep pipe — project internal", () => {
	test("ls -la | grep .ts → allow", async () => {
		expect(await fullChain("ls -la | grep .ts")).toBe("allow");
	});

	test("ls src/ | grep -i test → allow", async () => {
		expect(await fullChain("ls src/ | grep -i test")).toBe("allow");
	});

	test("grep -r TODO src/ | sort → allow", async () => {
		expect(await fullChain("grep -r TODO src/ | sort")).toBe("allow");
	});

	test("grep -rn import src/ | head -20 → allow", async () => {
		expect(await fullChain("grep -rn import src/ | head -20")).toBe("allow");
	});

	test("cat package.json | grep version → allow", async () => {
		expect(await fullChain("cat package.json | grep version")).toBe("allow");
	});

	test("find . -name '*.ts' | grep -v node_modules → allow", async () => {
		expect(await fullChain("find . -name '*.ts' | grep -v node_modules")).toBe("allow");
	});

	test("find src/ -type f -name '*.ts' → allow", async () => {
		expect(await fullChain("find src/ -type f -name '*.ts'")).toBe("allow");
	});

	test("ls -R | grep -E '\\.(ts|tsx)$' → allow", async () => {
		expect(await fullChain("ls -R | grep -E '\\.(ts|tsx)$'")).toBe("allow");
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
