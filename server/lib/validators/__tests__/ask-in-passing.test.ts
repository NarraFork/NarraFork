import { describe, expect, test } from "bun:test";
import { composerQuoteBlock, MAX_COMPOSER_QUOTE_CHARS } from "@shared/composer-document";
import { askInPassingSchema } from "../narrators";

describe("ask-in-passing resolve input", () => {
	test("a plain question needs no quote", () => {
		expect(askInPassingSchema.parse({ question: "Why?", pendingMessageId: "pending" })).toEqual({
			question: "Why?",
			pendingMessageId: "pending",
		});
	});

	test("accepts a selection quote with the composer's anchor grammar", () => {
		const quote = { label: "Assistant", text: "line one\nline two", anchor: "m:message1" };
		expect(
			askInPassingSchema.parse({ question: "Why?", pendingMessageId: "pending", quote }).quote,
		).toEqual(quote);
		expect(composerQuoteBlock(quote)).toBe(
			"> [quote] Assistant @@m:message1\n> line one\n> line two\n\n",
		);
	});

	test("rejects quotes the sent blockquote could not round-trip", () => {
		const base = { question: "Why?", pendingMessageId: "pending" };
		for (const quote of [
			{ label: "", text: "x" },
			{ label: " leading space", text: "x" },
			{ label: "two\nlines", text: "x" },
			{ label: "ok", text: "" },
			{ label: "ok", text: "x".repeat(MAX_COMPOSER_QUOTE_CHARS + 1) },
			{ label: "ok", text: "x", anchor: "bad anchor" },
		]) {
			expect(askInPassingSchema.safeParse({ ...base, quote }).success).toBe(false);
		}
	});
});
