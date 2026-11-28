import { expect, test } from "bun:test";
import {
	killGitStatusPageWindowsTree,
	terminateGitStatusPageChild,
} from "./git-status-page-process";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

test("Windows cleanup targets only the owned PID, requests descendants, and awaits taskkill exit", async () => {
	const exited = deferred<number>();
	let command: string[] = [];
	let options: unknown;
	let finished = false;
	const stopping = killGitStatusPageWindowsTree(23456, (args, opts) => {
		command = args;
		options = opts;
		return { exited: exited.promise };
	}).then(() => {
		finished = true;
	});
	expect(command).toEqual(["taskkill", "/T", "/F", "/PID", "23456"]);
	expect(options).toEqual({
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
		timeout: 5000,
		windowsHide: true,
	});
	await Promise.resolve();
	expect(finished).toBe(false);
	exited.resolve(0);
	await stopping;
	expect(finished).toBe(true);
});

test("Windows parent kill follows descendant cleanup and service can await the complete operation", async () => {
	const descendantsClosed = deferred<void>();
	const events: string[] = [];
	const stopping = terminateGitStatusPageChild(
		{
			pid: 12345,
			kill: (signal) => {
				events.push(signal);
			},
		},
		"win32",
		async (pid) => {
			events.push(`tree:${pid}`);
			await descendantsClosed.promise;
			events.push("descendant pipes closed");
		},
	);
	expect(events).toEqual(["tree:12345"]);
	descendantsClosed.resolve();
	await stopping;
	expect(events).toEqual(["tree:12345", "descendant pipes closed", "SIGKILL"]);
});

test("failed taskkill still falls back to the owned direct child and invalid PIDs are ignored", async () => {
	let directKills = 0;
	await terminateGitStatusPageChild(
		{
			pid: 12345,
			kill: () => {
				directKills++;
			},
		},
		"win32",
		(pid) =>
			killGitStatusPageWindowsTree(pid, () => {
				throw new Error("already gone");
			}),
	);
	expect(directKills).toBe(1);
	await terminateGitStatusPageChild(
		{
			pid: 0,
			kill: () => {
				directKills++;
			},
		},
		"win32",
		async () => {
			throw new Error("must not target shared PID");
		},
	);
	expect(directKills).toBe(1);
});
