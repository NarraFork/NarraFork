import { expect, test } from "bun:test";
import { searchToolDocuments, tokenizeToolSearch } from "../tool-search-index";

test("tokenizes camel case, English fields and Chinese words", () => {
	expect(tokenizeToolSearch("ReadCalendar event_id 搜索日历")).toEqual(
		expect.arrayContaining(["read", "calendar", "event", "id", "搜索", "日历"]),
	);
});
test("ranks members then deduplicates by group before limit", async () => {
	const docs = [
		{ id: "calendar", text: "calendar meetings" },
		{ id: "calendar", text: "calendar dates" },
		{ id: "mail", text: "calendar invitations" },
		{ id: "unrelated", text: "browser screenshot" },
	];
	expect((await searchToolDocuments(docs, "calendar", 2)).map((hit) => hit.id)).toEqual([
		"calendar",
		"mail",
	]);
	expect(await searchToolDocuments(docs, "不存在")).toEqual([]);
});
test("exact member and server IDs win over textual frequency, fresh queries still cancel", async () => {
	const docs = [
		{ id: "text", text: "calendar calendar calendar" },
		{ id: "exact", text: "unrelated", exactNames: ["calendar"] },
	];
	expect((await searchToolDocuments(docs, "calendar", 1))[0]?.id).toBe("exact");
	await expect(searchToolDocuments(docs, "calendar", 1, AbortSignal.abort())).rejects.toThrow();
});
test("does not stringify the whole document catalog for a cache key", async () => {
	const documents = [
		{
			id: "calendar",
			text: "calendar meetings",
			toJSON: () => {
				throw new Error("catalog must not be stringified");
			},
		},
	];
	expect((await searchToolDocuments(documents, "calendar"))[0]?.id).toBe("calendar");
});

test("indexes Chinese, invalidates changed documents and observes cancellation", async () => {
	expect((await searchToolDocuments([{ id: "a", text: "搜索日历会议" }], "日历"))[0]?.id).toBe("a");
	expect(await searchToolDocuments([{ id: "a", text: "邮件" }], "日历")).toEqual([]);
	await expect(
		searchToolDocuments(
			[{ id: "cancel", text: "new unique document" }],
			"unique",
			3,
			AbortSignal.abort(),
		),
	).rejects.toThrow();
});
