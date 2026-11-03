/**
 * What a right-click resolves to. The interesting cases are the ones that must NOT produce a
 * target: an ordinary link, a marker with no device, a relative path. A menu action that guesses
 * would offer to copy a file the user never pointed at.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fileTargetFromHref, localFileHref } from "@shared/markdown-file-path";
import { parseHTML } from "linkedom";
import { fileLinkTargetFromEvent } from "../file-link-target";

let document: Document;
let previousDocument: PropertyDescriptor | undefined;

beforeEach(() => {
	previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
	const parsed = parseHTML("<!doctype html><html><body></body></html>");
	document = parsed.document as unknown as Document;
	Object.defineProperty(globalThis, "document", { value: document, configurable: true });
	document.body.innerHTML = "";
});

afterEach(() => {
	if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
	else Reflect.deleteProperty(globalThis, "document");
});

/** Build the anchor `MarkdownLink` renders for a resolved target, plus the span inside it. */
function renderFileLink(target: { deviceId: string; path: string }): {
	anchor: HTMLAnchorElement;
	label: HTMLElement;
} {
	document.body.innerHTML = `<p><a href="${localFileHref(target)}"><span data-file-line-suffix=""></span><span>label</span></a></p>`;
	const anchor = document.querySelector("a") as unknown as HTMLAnchorElement;
	const label = anchor.querySelector("span:last-child") as unknown as HTMLElement;
	return { anchor, label };
}

describe("fileLinkTargetFromEvent", () => {
	test("a right-click on the label resolves the file the link carries", () => {
		const { anchor, label } = renderFileLink({ deviceId: "local", path: "E:/build/libs/a.jar" });
		expect(fileLinkTargetFromEvent(label)).toEqual({
			deviceId: "local",
			path: "E:/build/libs/a.jar",
		});
		// The anchor itself answers the same: the check walks up from whatever was hit.
		expect(fileLinkTargetFromEvent(anchor)).toEqual({
			deviceId: "local",
			path: "E:/build/libs/a.jar",
		});
	});

	test("the line suffix inside the link is part of the link, not a separate target", () => {
		const href = `${localFileHref({ deviceId: "local", path: "/repo/a.ts" })}`;
		document.body.innerHTML = `<a href="${href}"><span data-file-line-suffix="">:12</span></a>`;
		const suffix = document.querySelector("[data-file-line-suffix]") as unknown as Element;
		expect(fileLinkTargetFromEvent(suffix)?.path).toBe("/repo/a.ts");
	});

	test("an ordinary prose right-click yields nothing", () => {
		document.body.innerHTML = `<p><span>just words</span></p>`;
		const text = document.querySelector("span") as unknown as Element;
		expect(fileLinkTargetFromEvent(text)).toBeNull();
	});

	test("a normal web link is not a file", () => {
		document.body.innerHTML = `<a href="https://example.com/a.ts">a.ts</a>`;
		const anchor = document.querySelector("a") as unknown as Element;
		expect(fileLinkTargetFromEvent(anchor)).toBeNull();
	});

	test("a target with no device and a relative path is refused rather than guessed", () => {
		// `fileTargetFromHref` without a context cannot bind this, so no action may be offered.
		expect(fileTargetFromHref("src/a.ts")).toBeNull();
		const href = `#nf-local-file=${encodeURIComponent(JSON.stringify({ path: "src/a.ts" }))}`;
		document.body.innerHTML = `<a href="${href}">a.ts</a>`;
		const anchor = document.querySelector("a") as unknown as Element;
		expect(fileLinkTargetFromEvent(anchor)).toBeNull();
	});

	test("a malformed marker is not a file", () => {
		document.body.innerHTML = `<a href="#nf-local-file=%7Bnot-json">a.ts</a>`;
		const anchor = document.querySelector("a") as unknown as Element;
		expect(fileLinkTargetFromEvent(anchor)).toBeNull();
	});

	test("a non-element event target is ignored", () => {
		expect(fileLinkTargetFromEvent(null)).toBeNull();
		expect(fileLinkTargetFromEvent(undefined)).toBeNull();
		expect(fileLinkTargetFromEvent({} as EventTarget)).toBeNull();
	});
});
