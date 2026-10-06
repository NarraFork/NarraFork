/**
 * Cross-platform dev runner — starts backend + frontend as child processes
 * and ensures both are killed on Ctrl+C / SIGTERM.
 *
 * On Windows, shell `&` background processes don't receive SIGINT from the
 * parent shell, leaving zombie Vite processes holding port 7778.
 * This script spawns both processes and forwards termination signals properly.
 *
 * Usage:
 *   bun server/dev-all.ts          # hot-reload backend
 *   bun server/dev-all.ts --cold   # no hot-reload
 */

import { type Subprocess, spawn, spawnSync } from "bun";

const isWindows = process.platform === "win32";
const isCold = process.argv.includes("--cold");

// Step 1: run migrations synchronously
const migrate = spawn(["bun", "run", "db:migrate"], {
	stdio: ["inherit", "inherit", "inherit"],
	env: { ...process.env },
});
const migrateCode = await migrate.exited;
if (migrateCode !== 0) {
	console.error("Migration failed, aborting.");
	process.exit(migrateCode);
}

// Step 2: start backend + frontend
const backendArgs = isCold
	? ["bun", "server/index.ts"]
	: ["bun", "run", "--hot", "server/index.ts"];
const backendEnv = {
	...process.env,
	PORT: "7779",
};

const backendProc = spawn(backendArgs, {
	stdio: ["inherit", "inherit", "inherit"],
	env: backendEnv,
});

const frontend = spawn(["bunx", "vite", "--config", "frontend/vite.config.ts"], {
	stdio: ["inherit", "inherit", "inherit"],
	env: { ...process.env },
});

const children: Subprocess[] = [backendProc, frontend];

function killAll() {
	for (const child of children) {
		try {
			if (child.exitCode === null) {
				if (isWindows && child.pid) {
					// On Windows, Subprocess.kill() only terminates the direct child.
					// Use taskkill /T /F to recursively kill the entire process tree
					// (e.g. bun → server/index.ts → shell → git, vite → esbuild, etc.)
					try {
						spawnSync(["taskkill", "/T", "/F", "/PID", String(child.pid)], {
							stdio: ["ignore", "ignore", "ignore"],
						});
					} catch {
						/* best effort */
					}
				} else {
					child.kill();
				}
			}
		} catch {
			// already dead
		}
	}
}

// On Windows, SIGINT may not fire — use "exit" as a fallback
process.on("SIGINT", () => {
	killAll();
	process.exit(0);
});
process.on("SIGTERM", () => {
	killAll();
	process.exit(0);
});
if (isWindows) {
	process.on("exit", killAll);
}

// Wait for either process to exit, then kill the other
const results = await Promise.race([
	backendProc.exited.then((code) => ({ who: "backend", code })),
	frontend.exited.then((code) => ({ who: "frontend", code })),
]);

console.log(`\n${results.who} exited with code ${results.code}, shutting down...`);
killAll();

// Give remaining processes a moment to clean up
await Promise.allSettled([backendProc.exited, frontend.exited]);
process.exit(results.code ?? 0);
