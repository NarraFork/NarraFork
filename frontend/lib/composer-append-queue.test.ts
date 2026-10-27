import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import {
	listenComposerAppend,
	requestComposerAppend,
	resetComposerAppendsForTest,
} from "./composer-append-queue";

afterEach(() => {
	resetComposerAppendsForTest();
	setSystemTime();
});

describe("composer append queue", () => {
	test("waits for the session's composer, then hands it over once", () => {
		requestComposerAppend("n1", "link to the page");
		const got: string[] = [];
		const stop = listenComposerAppend("n1", (text) => got.push(text));
		expect(got).toEqual(["link to the page"]);
		stop();
		listenComposerAppend("n1", (text) => got.push(text));
		expect(got).toEqual(["link to the page"]);
	});

	test("a listening composer gets requests at once; the latest listener of a session wins", () => {
		const first: string[] = [];
		const second: string[] = [];
		const stopFirst = listenComposerAppend("n1", (text) => first.push(text));
		const stopSecond = listenComposerAppend("n1", (text) => second.push(text));
		requestComposerAppend("n1", "a");
		expect(first).toEqual([]);
		expect(second).toEqual(["a"]);
		// The older listener leaving does not unregister the newer one.
		stopFirst();
		requestComposerAppend("n1", "b");
		expect(second).toEqual(["a", "b"]);
		stopSecond();
	});

	test("when the newest composer of a session goes, an older one still mounted takes over", () => {
		const first: string[] = [];
		const second: string[] = [];
		const stopFirst = listenComposerAppend("n1", (text) => first.push(text));
		const stopSecond = listenComposerAppend("n1", (text) => second.push(text));
		stopSecond();
		requestComposerAppend("n1", "a");
		expect(first).toEqual(["a"]);
		expect(second).toEqual([]);
		// With none left, requests wait again.
		stopFirst();
		requestComposerAppend("n1", "b");
		const later: string[] = [];
		listenComposerAppend("n1", (text) => later.push(text));
		expect(later).toEqual(["b"]);
	});

	test("bounded: a few requests per session, expiring, never another session's", () => {
		for (let i = 0; i < 10; i++) requestComposerAppend("n1", `t${i}`);
		requestComposerAppend("n2", "other");
		const got: string[] = [];
		listenComposerAppend("n1", (text) => got.push(text));
		expect(got).toEqual(["t6", "t7", "t8", "t9"]);
		setSystemTime(new Date(Date.now() + 3 * 60 * 1000));
		const late: string[] = [];
		listenComposerAppend("n2", (text) => late.push(text));
		expect(late).toEqual([]);
	});
});
