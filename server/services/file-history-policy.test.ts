import { afterEach, describe, expect, test } from "bun:test";
import { isFileHistoryEnabledForDevice } from "@shared/file-change-protocol";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { narrators } from "../db/schema";
import { generateId } from "../lib/id";
import {
	assertFileHistoryEnabledForDevice,
	isNarratorFileHistoryEnabled,
	resolveNarratorMessageOnlyRevert,
} from "./file-history-policy";

const ids: string[] = [];
function narrator(deviceId: string | null) {
	const id = generateId();
	const now = new Date().toISOString();
	db.insert(narrators)
		.values({ id, defaultDeviceId: deviceId, createdAt: now, updatedAt: now })
		.run();
	ids.push(id);
	return id;
}
afterEach(() => {
	for (const id of ids.splice(0)) db.delete(narrators).where(eq(narrators.id, id)).run();
});

describe("file history device policy", () => {
	test.each([undefined, null, "", "local"])("%s has no local history", (deviceId) => {
		expect(isFileHistoryEnabledForDevice(deviceId)).toBe(false);
		expect(() => assertFileHistoryEnabledForDevice(deviceId)).toThrow(
			expect.objectContaining({ statusCode: 409, code: "FILE_HISTORY_DISABLED" }),
		);
	});
	test.each([
		null,
		"",
		"local",
	])("persisted device %s defaults to messages only", async (deviceId) => {
		const id = narrator(deviceId);
		expect(await isNarratorFileHistoryEnabled(id)).toBe(false);
		expect(await resolveNarratorMessageOnlyRevert(id, undefined)).toBe(true);
		expect(await resolveNarratorMessageOnlyRevert(id, true)).toBe(true);
		for (const [skipRevert, explicitRestore] of [
			[false, false],
			[undefined, true],
			[true, true],
		] as const) {
			const error = await resolveNarratorMessageOnlyRevert(id, skipRevert, explicitRestore).catch(
				(error: unknown) => error,
			);
			expect(error).toMatchObject({ statusCode: 409, code: "FILE_HISTORY_DISABLED" });
		}
	});
	test("explicitly remote devices retain file recovery defaults and message-only opt-in", async () => {
		const id = narrator("remote-device");
		expect(isFileHistoryEnabledForDevice("remote-device")).toBe(true);
		expect(() => assertFileHistoryEnabledForDevice("remote-device")).not.toThrow();
		expect(await isNarratorFileHistoryEnabled(id)).toBe(true);
		expect(await resolveNarratorMessageOnlyRevert(id, undefined)).toBe(false);
		expect(await resolveNarratorMessageOnlyRevert(id, false, true)).toBe(false);
		expect(await resolveNarratorMessageOnlyRevert(id, true)).toBe(true);
	});
	test("missing narrator is not interpreted as a local message-only action", async () => {
		const error = await resolveNarratorMessageOnlyRevert(generateId(), undefined).catch(
			(error: unknown) => error,
		);
		expect(error).toMatchObject({ statusCode: 404, code: "NOT_FOUND" });
	});
});
