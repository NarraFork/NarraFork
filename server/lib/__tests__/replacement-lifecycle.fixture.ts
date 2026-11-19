// Compiled, database-free native regression. Every role has its own hard deadline.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnReplacementProcess } from "../replacement-launch";

const [role, mode, root] = process.argv.slice(2);
if (!role || !mode || !root) throw new Error("Expected role, mode and isolated root");
const path = (name: string) => join(root, name);
const log = (message: string) =>
	appendFileSync(path("events.log"), `${Date.now()} ${role} ${process.pid} ${message}\n`);
const save = (name: string, value: unknown) => writeFileSync(path(name), JSON.stringify(value));
const read = (name: string) => JSON.parse(readFileSync(path(name), "utf8"));
const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const waitFor = async (label: string, check: () => boolean, timeout = 20_000) => {
	const deadline = Date.now() + timeout;
	while (!check()) {
		if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
		await Bun.sleep(50);
	}
};
const self = (...args: string[]) => [process.execPath, ...args];
const literalArgs = ['中文 & %PATH% "quoted"', "", "C:\\space path\\", 'slash\\"quote'];
const guard = setTimeout(() => {
	log("hard deadline");
	process.exit(90);
}, 35_000);

try {
	log("start");
	if (role === "check") {
		const manager = Bun.spawn(self("manager", mode, root), {
			cwd: root,
			env: { ...process.env, NARRAFORK_HOME: root, LIFECYCLE_SENTINEL: "中文 & %PATH%" },
			stdio: ["ignore", "ignore", "ignore"],
		});
		if ((await manager.exited) !== 0) throw new Error("Old manager failed");
		log("old manager exited");
		const pids = [read("replacement-pid.json"), read("leaf-pid.json")] as number[];
		if (mode === "legacy") {
			await waitFor("legacy descendants terminated", () => pids.every((pid) => !alive(pid)));
			if (existsSync(path("survived.json"))) throw new Error("Legacy control did not fail");
		} else {
			await waitFor("replacement survives retiring manager", () =>
				existsSync(path("survived.json")),
			);
			const result = read("survived.json");
			if (!result.leafSurvived || result.sentinel !== "中文 & %PATH%" || result.cwd !== root) {
				throw new Error("Replacement lost child, environment or working directory");
			}
			if (JSON.stringify(result.args) !== JSON.stringify(literalArgs)) {
				throw new Error("Argument was reinterpreted");
			}
			await waitFor("replacement descendants exit cleanly", () => pids.every((pid) => !alive(pid)));
		}
		save("result.json", { ok: true, mode, bun: Bun.version, platform: process.platform });
	} else if (role === "manager") {
		const server = Bun.spawn(self("server", mode, root), {
			env: { ...process.env, LIFECYCLE_OLD_MANAGER: String(process.pid) },
			stdio: ["ignore", "ignore", "ignore"],
		});
		if ((await server.exited) !== 0) throw new Error("Old server failed");
		log("old server exited; retiring immediately");
		// Deliberately exits immediately, just like handOverToNewManager, not after a grace sleep.
		process.exit(0);
	} else if (role === "server") {
		const { initWindowsChildJob } = await import("../windows-child-job");
		if (process.platform === "win32" && !initWindowsChildJob())
			throw new Error("Missing Windows job");
		const args = ["replacement", mode, root, ...literalArgs];
		if (mode === "legacy") {
			// The 0.9.13/0.9.14 initiator, with exactly the same receiving roles as the fixed case.
			const launcher = Bun.spawn(
				["cmd.exe", "/d", "/c", "start", "", "/D", root, process.execPath, ...args],
				{
					cwd: root,
					env: process.env,
					stdio: ["ignore", "ignore", "ignore"],
					windowsHide: true,
				},
			);
			launcher.unref();
		} else {
			spawnReplacementProcess({ execPath: process.execPath, args, cwd: root, env: process.env });
		}
		await waitFor("new service ready for handoff", () => existsSync(path("leaf-pid.json")));
		log("handoff complete");
		process.exit(0);
	} else if (role === "replacement") {
		save("replacement-pid.json", process.pid);
		const leaf = Bun.spawn(self("leaf", mode, root), { stdio: ["ignore", "ignore", "ignore"] });
		if ((await leaf.exited) !== 0) throw new Error("New service failed");
		save("survived.json", {
			leafSurvived: existsSync(path("leaf-survived.json")),
			sentinel: process.env.LIFECYCLE_SENTINEL,
			args: process.argv.slice(5),
			cwd: process.cwd(),
		});
		log("new manager and service survived; clean exit");
	} else if (role === "leaf") {
		const { initWindowsChildJob } = await import("../windows-child-job");
		if (process.platform === "win32" && !initWindowsChildJob())
			throw new Error("Missing replacement job");
		save("leaf-pid.json", process.pid);
		const oldManager = Number(process.env.LIFECYCLE_OLD_MANAGER);
		if (!oldManager) throw new Error("Missing old manager identity");
		await waitFor("old manager actually exits", () => !alive(oldManager));
		for (let heartbeat = 0; heartbeat < 5; heartbeat++) {
			log("alive after old manager exit");
			await Bun.sleep(250);
		}
		save("leaf-survived.json", { ok: true });
	} else {
		throw new Error("Unknown role");
	}
	clearTimeout(guard);
	process.exit(0);
} catch (error) {
	mkdirSync(root, { recursive: true });
	log(`failure: ${String(error)}`);
	clearTimeout(guard);
	process.exit(1);
}
