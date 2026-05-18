import { spawn, spawnSync } from "bun";

import { GO_ROOT } from "./go-backend-shared";

const args = process.argv.slice(2);
const command = args[0] ?? "";
const rest = args.slice(1);

function exitWithResult(exitCode: number | null | undefined): never {
	process.exit(exitCode ?? 0);
}

if (!command) {
	console.error("Usage: bun scripts/go-task.ts <test|run> [args...]");
	process.exit(1);
}

if (command === "test") {
	const proc = spawnSync(["go", "test", "./..."], {
		cwd: GO_ROOT,
		env: { ...process.env },
		stdout: "inherit",
		stderr: "inherit",
		stdin: "inherit",
	});
	exitWithResult(proc.exitCode);
}

if (command === "run") {
	const proc = spawn(["go", "run", "./cmd/narrafork-go", ...rest], {
		cwd: GO_ROOT,
		env: { ...process.env },
		stdio: ["inherit", "inherit", "inherit"],
	});
	const kill = () => {
		try {
			if (proc.exitCode === null) {
				proc.kill();
			}
		} catch {
			// ignore
		}
	};
	process.on("SIGINT", () => {
		kill();
		process.exit(0);
	});
	process.on("SIGTERM", () => {
		kill();
		process.exit(0);
	});
	process.on("exit", kill);
	const code = await proc.exited;
	exitWithResult(code);
}

if (command === "build-smoke") {
	const proc = spawnSync(["go", "test", "-c", "-o", "/dev/null", "./cmd/narrafork-go"], {
		cwd: GO_ROOT,
		env: { ...process.env },
		stdout: "inherit",
		stderr: "inherit",
		stdin: "inherit",
	});
	exitWithResult(proc.exitCode);
}

console.error(`Unknown go-task command: ${command}`);
process.exit(1);
