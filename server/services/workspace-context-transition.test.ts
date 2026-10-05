import { describe, expect, test } from "bun:test";
import type { SwitchWorkingDirectoryRequest, WorkspaceContext } from "@shared/workspace-context";
import { AsyncMutex } from "../lib/async-mutex";
import {
	transitionWorkspaceContext,
	type WorkspaceTransitionPorts,
	workspaceConflict,
} from "./workspace-context-transition";

const initial: WorkspaceContext = {
	revision: 0,
	deviceId: "local",
	cwd: "/old",
	pathFlavor: "posix",
	contextKey: "old",
	contextProjectId: "project",
	capabilities: { switchDirectory: true },
};
const request: SwitchWorkingDirectoryRequest = {
	expectedRevision: 0,
	requestId: "one",
	target: { deviceId: "local", cwd: "/new" },
};
function fixture() {
	let persisted = initial;
	let installed = initial;
	let busy = false;
	let installFails = false;
	let paused = false;
	let casFails = false;
	const order: string[] = [];
	const lock = new AsyncMutex();
	const ports: WorkspaceTransitionPorts = {
		read: async () => persisted,
		prepare: async (previous, input) => {
			order.push("prepare");
			return { ...previous, cwd: input.target.cwd, contextKey: input.target.cwd };
		},
		admit: (action) => lock.acquire("narrator", action),
		checkAdmission: () => {
			if (busy) throw workspaceConflict("busy");
		},
		commit: async (previous, current) => {
			order.push("commit");
			if (casFails || persisted.revision !== previous.revision) return false;
			persisted = current;
			return true;
		},
		install: async (current) => {
			order.push("install");
			if (installFails) throw new Error("failed install");
			installed = current;
		},
		pause: () => {
			order.push("pause");
			paused = true;
		},
		publish: () => {
			order.push("publish");
		},
	};
	return {
		ports,
		order,
		persisted: () => persisted,
		installed: () => installed,
		paused: () => paused,
		busy: () => {
			busy = true;
		},
		failInstall: () => {
			installFails = true;
		},
		failCas: () => {
			casFails = true;
		},
	};
}

describe("workspace context transition", () => {
	test("two revision competitors have exactly one winner", async () => {
		const f = fixture();
		const outcomes = await Promise.allSettled([
			transitionWorkspaceContext(request, f.ports),
			transitionWorkspaceContext(
				{ ...request, requestId: "two", target: { deviceId: "local", cwd: "/other" } },
				f.ports,
			),
		]);
		expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
		expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
		expect(f.persisted().revision).toBe(1);
		expect(f.order.filter((step) => step === "publish")).toHaveLength(1);
	});
	test("prepare, commit, install, broadcast order and project context are preserved", async () => {
		const f = fixture();
		const result = await transitionWorkspaceContext(request, f.ports);
		expect(f.order).toEqual(["prepare", "commit", "install", "publish"]);
		expect(result.current.contextProjectId).toBe("project");
		expect(f.installed()).toEqual(f.persisted());
	});
	test("busy, permission wait and revert reservations reject rather than waiting for a loop", async () => {
		const f = fixture();
		f.busy();
		await expect(transitionWorkspaceContext(request, f.ports)).rejects.toThrow("busy");
		expect(f.persisted()).toBe(initial);
		expect(f.order).toEqual([]);
	});
	test("admission is checked again after asynchronous prepare", async () => {
		const f = fixture();
		const prepare = f.ports.prepare;
		f.ports.prepare = async (...args) => {
			const prepared = await prepare(...args);
			f.busy();
			return prepared;
		};
		await expect(transitionWorkspaceContext(request, f.ports)).rejects.toThrow("busy");
		expect(f.persisted()).toBe(initial);
	});
	test("failed target preparation and failed CAS leave runtime and persisted cwd unchanged", async () => {
		const f = fixture();
		f.ports.prepare = async () => {
			throw new Error("missing directory");
		};
		await expect(transitionWorkspaceContext(request, f.ports)).rejects.toThrow("missing directory");
		expect(f.persisted()).toBe(initial);
		expect(f.installed()).toBe(initial);
		const cas = fixture();
		cas.failCas();
		await expect(transitionWorkspaceContext(request, cas.ports)).rejects.toThrow(
			"revision changed",
		);
		expect(cas.persisted()).toBe(initial);
		expect(cas.installed()).toBe(initial);
	});
	test("durable commit plus install failure pauses and keeps committed recovery state", async () => {
		const f = fixture();
		f.failInstall();
		await expect(transitionWorkspaceContext(request, f.ports)).rejects.toThrow("runtime paused");
		expect(f.persisted().cwd).toBe("/new");
		expect(f.persisted().revision).toBe(1);
		expect(f.installed()).toBe(initial);
		expect(f.paused()).toBe(true);
		expect(f.order).toEqual(["prepare", "commit", "install", "pause"]);
	});
	test("same context is a no-op without increment or publication", async () => {
		const f = fixture();
		f.ports.prepare = async () => initial;
		const result = await transitionWorkspaceContext(request, f.ports);
		expect(result.changed).toBe(false);
		expect(result.current.revision).toBe(0);
		expect(f.order).toEqual([]);
	});
});
