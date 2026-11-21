import { expect, mock, test } from "bun:test";
import { saveProviderSettings } from "./provider-settings-save";

const connection = {
	connected: true,
	disabled: false,
	name: "TokenDance",
	generation: 1,
	models: [],
	toolResultImages: "separate" as const,
};

test("settings validation failure never applies TokenDance changes", async () => {
	const saveConnection = mock(async () => connection);
	await expect(
		saveProviderSettings(async () => {
			throw new Error("reserved prefix");
		}, saveConnection),
	).rejects.toThrow("reserved prefix");
	expect(saveConnection).not.toHaveBeenCalled();
});

test("saves settings first and synchronizes the returned connection preference", async () => {
	const order: string[] = [];
	const response = await saveProviderSettings(
		async () => {
			order.push("settings");
			return { tokendance: { ...connection, toolResultImages: "off" }, customApiProviders: [] };
		},
		async () => {
			order.push("connection");
			return connection;
		},
	);
	expect(order).toEqual(["settings", "connection"]);
	expect(response.tokendance).toEqual(connection);
	expect(response.customApiProviders).toEqual([]);
});

test("unchanged connection needs no second save", async () => {
	const response = { customApiProviders: [] };
	expect(await saveProviderSettings(async () => response)).toBe(response);
});

test("connection failure does not return a falsely successful saved snapshot", async () => {
	await expect(
		saveProviderSettings(
			async () => ({}),
			async () => {
				throw new Error("connection failed");
			},
		),
	).rejects.toThrow("connection failed");
});
