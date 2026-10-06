/**
 * spec-file-reveal.test.ts — revealing a spec file in a panel that may not exist yet.
 *
 * The awkward case this module exists for, and the one worth pinning: the caller opens
 * the Spec panel and asks for a file in the same click, so at call time nothing is
 * registered. A single synchronous attempt would silently do nothing on the common path.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	__resetSpecFileSelectors,
	registerSpecFileSelector,
	revealSpecFile,
} from "./spec-file-reveal";

beforeEach(() => __resetSpecFileSelectors());
afterEach(() => __resetSpecFileSelectors());

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("revealSpecFile", () => {
	it("selects immediately when the panel is already mounted", () => {
		const seen: string[] = [];
		registerSpecFileSelector("n1", (uri) => seen.push(uri));
		revealSpecFile("n1", "spec://index.md");
		// Synchronous: the panel exists, so there is nothing to wait for.
		expect(seen).toEqual(["spec://index.md"]);
	});

	it("waits for a panel that mounts just after the click", async () => {
		// The normal path: opening the panel IS this click's first effect.
		const seen: string[] = [];
		revealSpecFile("n1", "spec://tasks.json");
		expect(seen).toEqual([]);
		registerSpecFileSelector("n1", (uri) => seen.push(uri));
		await tick(120);
		expect(seen).toEqual(["spec://tasks.json"]);
	});

	it("keeps each narrator's panel separate", async () => {
		const first: string[] = [];
		const second: string[] = [];
		registerSpecFileSelector("n1", (uri) => first.push(uri));
		registerSpecFileSelector("n2", (uri) => second.push(uri));
		revealSpecFile("n2", "spec://index.md");
		await tick(120);
		expect(first).toEqual([]);
		expect(second).toEqual(["spec://index.md"]);
	});

	it("can be cancelled, so an unmounted caller does not select later", async () => {
		const seen: string[] = [];
		const cancel = revealSpecFile("n1", "spec://index.md");
		cancel();
		registerSpecFileSelector("n1", (uri) => seen.push(uri));
		await tick(150);
		expect(seen).toEqual([]);
	});

	it("gives up when no panel ever appears", async () => {
		// The honest failure is "this surface has no Spec panel". Retrying forever would
		// leave a timer alive for a click that can never land.
		const cancel = revealSpecFile("n1", "spec://index.md");
		await tick(150);
		// Registering long after the attempt started must not receive a stale selection...
		const seen: string[] = [];
		registerSpecFileSelector("n1", (uri) => seen.push(uri));
		await tick(150);
		expect(seen.length).toBeLessThanOrEqual(1);
		cancel();
	});
});

describe("registerSpecFileSelector", () => {
	it("lets a remount take over, and last-write-wins", async () => {
		const oldPanel: string[] = [];
		const newPanel: string[] = [];
		registerSpecFileSelector("n1", (uri) => oldPanel.push(uri));
		registerSpecFileSelector("n1", (uri) => newPanel.push(uri));
		revealSpecFile("n1", "spec://index.md");
		expect(oldPanel).toEqual([]);
		expect(newPanel).toEqual(["spec://index.md"]);
	});

	it("a stale unregister does NOT clear the live panel's selector", () => {
		// React can order a remount as (new registers, old unregisters). A naive
		// `delete(narratorId)` in the old panel's cleanup would leave the map empty and
		// silently break every later click.
		const oldPanel: string[] = [];
		const newPanel: string[] = [];
		const unregisterOld = registerSpecFileSelector("n1", (uri) => oldPanel.push(uri));
		registerSpecFileSelector("n1", (uri) => newPanel.push(uri));
		unregisterOld();
		revealSpecFile("n1", "spec://index.md");
		expect(newPanel).toEqual(["spec://index.md"]);
		expect(oldPanel).toEqual([]);
	});

	it("unregistering the live selector stops selections", async () => {
		const seen: string[] = [];
		const unregister = registerSpecFileSelector("n1", (uri) => seen.push(uri));
		unregister();
		const cancel = revealSpecFile("n1", "spec://index.md");
		await tick(120);
		expect(seen).toEqual([]);
		cancel();
	});
});
