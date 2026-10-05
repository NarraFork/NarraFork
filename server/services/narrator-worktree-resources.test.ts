import { afterEach, beforeAll, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { db, sqlite } from "../db";
import { narrators } from "../db/schema";
import { localPathSemantics } from "../lib/agent/execution/path-semantics";
import { generateId } from "../lib/id";
import { narratorService } from "./narrator-service";
import { readLegacyNarratorWorktreeProtection } from "./narrator-worktree-resources";

beforeAll(() => {
	if (process.env.NARRAFORK_TEST !== "1")
		throw new Error("Only isolated preload fixture DB is allowed");
});
const ids: string[] = [];
afterEach(async () => {
	if (ids.length) await db.delete(narrators).where(inArray(narrators.id, ids.splice(0)));
});
async function legacyRow(
	cwd: string | null,
	defaultDeviceId: string | null,
	context: unknown = null,
) {
	const id = generateId();
	ids.push(id);
	const now = new Date().toISOString();
	await db.insert(narrators).values({ id, cwd, defaultDeviceId, createdAt: now, updatedAt: now });
	if (context !== null)
		sqlite
			.prepare("UPDATE narrators SET workspace_context = ? WHERE id = ?")
			.run(JSON.stringify(context), id);
	return id;
}
const read = () => readLegacyNarratorWorktreeProtection(performance.now() + 5000);
test("actual narratorService.create cwd '.' stays literal, but legacy protection is complete and absolute", async () => {
	const row = await narratorService.create({
		cwd: ".",
		title: "relative cwd compatibility fixture",
	});
	ids.push(row.id);
	expect(
		(await db.select({ cwd: narrators.cwd }).from(narrators).where(eq(narrators.id, row.id)).get())
			?.cwd,
	).toBe(".");
	const result = await read();
	expect(result.complete).toBe(true);
	expect(result.owners).toContainEqual({
		narratorId: row.id,
		deviceId: "local",
		path: localPathSemantics.resolve(process.cwd(), "."),
	});
});
test("known local raw and committed context relative paths resolve against the trusted process cwd", async () => {
	const id = await legacyRow("./raw-workspace", null, {
		cwd: "./context-workspace",
		deviceId: "local",
	});
	const result = await read();
	expect(result.complete).toBe(true);
	expect(result.owners).toContainEqual({
		narratorId: id,
		deviceId: "local",
		path: localPathSemantics.resolve(process.cwd(), "./raw-workspace"),
	});
	expect(result.owners).toContainEqual({
		narratorId: id,
		deviceId: "local",
		path: localPathSemantics.resolve(process.cwd(), "./context-workspace"),
	});
});
test("known remote raw and context paths remain device-qualified and are never host-resolved", async () => {
	const id = await legacyRow(".", "fixture-remote", {
		cwd: "./remote-context",
		deviceId: "fixture-remote",
	});
	const result = await read();
	expect(result.complete).toBe(true);
	expect(result.owners.filter((owner) => owner.narratorId === id)).toEqual([
		{ narratorId: id, deviceId: "fixture-remote", path: "." },
		{ narratorId: id, deviceId: "fixture-remote", path: "./remote-context" },
	]);
	expect(result.owners.some((owner) => owner.narratorId === id && owner.deviceId === "local")).toBe(
		false,
	);
});
test("absolute legacy host cwd remains protected after SwitchDevice changes the default", async () => {
	const path = localPathSemantics.resolve(process.cwd(), "./previous-host-workspace");
	const id = await legacyRow(path, "fixture-remote", {
		cwd: "./remote-context",
		deviceId: "fixture-remote",
	});
	const result = await read();
	expect(result.complete).toBe(true);
	expect(result.owners).toContainEqual({ narratorId: id, deviceId: "local", path });
	expect(result.owners).toContainEqual({
		narratorId: id,
		deviceId: "fixture-remote",
		path: "./remote-context",
	});
});
test("relative raw can use explicit committed remote device evidence when the default is absent", async () => {
	const id = await legacyRow(".", null, { cwd: "./remote-context", deviceId: "fixture-remote" });
	const result = await read();
	expect(result.complete).toBe(true);
	expect(result.owners.find((owner) => owner.narratorId === id)?.deviceId).toBe("fixture-remote");
});
test("ambiguous/malformed device or cwd evidence fails closed instead of hiding a possible local owner", async () => {
	for (const context of [
		{ cwd: "." },
		{ cwd: ".", deviceId: 3 },
		{ cwd: ".", deviceId: [] },
		{ cwd: {}, deviceId: "local" },
	]) {
		const id = await legacyRow(".", "fixture-remote", context);
		expect((await read()).complete).toBe(false);
		await db.delete(narrators).where(eq(narrators.id, id));
		ids.splice(ids.indexOf(id), 1);
	}
});
test("expired deadlines and cancellation remain incomplete ownership sets", async () => {
	const controller = new AbortController();
	controller.abort();
	expect(
		(await readLegacyNarratorWorktreeProtection(performance.now() + 5000, controller.signal))
			.complete,
	).toBe(false);
	expect((await readLegacyNarratorWorktreeProtection(performance.now() - 1)).complete).toBe(false);
});
