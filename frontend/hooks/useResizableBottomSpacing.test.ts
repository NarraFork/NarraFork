import { afterEach, beforeEach, describe, expect, test } from "bun:test";

let restore: (() => void) | undefined;

beforeEach(async () => {
	const { parseHTML } = await import("linkedom");
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const key of ["window", "document", "localStorage"] as const) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
	}
	const { window } = parseHTML("<!doctype html><html><body /></html>");
	const storage = new Map<string, string>();
	const values = {
		window,
		document: window.document,
		localStorage: {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => storage.set(key, value),
			removeItem: (key: string) => storage.delete(key),
		},
	};
	for (const [key, value] of Object.entries(values)) {
		Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
	}
	restore = () => {
		for (const key of ["window", "document", "localStorage"] as const) {
			const descriptor = previous.get(key);
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	};
});

afterEach(() => {
	restore?.();
	restore = undefined;
});

function fire(type: string, clientY: number, pointerId = 1) {
	const event = document.createEvent("Event");
	event.initEvent(type, true, true);
	Object.defineProperty(event, "clientY", { value: clientY, configurable: true });
	Object.defineProperty(event, "pointerId", { value: pointerId, configurable: true });
	window.dispatchEvent(event);
}

describe("bottom spacing drag store", () => {
	test("starts at zero and permits a zero-height spacer", async () => {
		const { BOTTOM_SPACING_CONSTANTS, resetBottomSpacingStoreForTest } = await import(
			"./useResizableBottomSpacing"
		);
		resetBottomSpacingStoreForTest();
		expect(BOTTOM_SPACING_CONSTANTS.DEFAULT_SPACING).toBe(0);
		expect(BOTTOM_SPACING_CONSTANTS.MIN_SPACING).toBe(0);
	});

	test("increases when dragged upward and clamps to bounds", async () => {
		const { BOTTOM_SPACING_CONSTANTS, resetBottomSpacingStoreForTest, startBottomSpacingResize } =
			await import("./useResizableBottomSpacing");
		resetBottomSpacingStoreForTest(BOTTOM_SPACING_CONSTANTS.DEFAULT_SPACING);
		startBottomSpacingResize({ clientY: 100, pointerId: 1, preventDefault: () => {} });
		fire("pointermove", -200);
		fire("pointerup", -200);
		expect(localStorage.getItem("narrafork_narrator_bottom_spacing")).toBe(
			String(BOTTOM_SPACING_CONSTANTS.MAX_SPACING),
		);
	});

	test("decreases when dragged downward and clamps to the minimum", async () => {
		const { BOTTOM_SPACING_CONSTANTS, resetBottomSpacingStoreForTest, startBottomSpacingResize } =
			await import("./useResizableBottomSpacing");
		resetBottomSpacingStoreForTest(BOTTOM_SPACING_CONSTANTS.DEFAULT_SPACING);
		startBottomSpacingResize({ clientY: 100, pointerId: 1, preventDefault: () => {} });
		fire("pointermove", 400);
		fire("pointerup", 400);
		expect(localStorage.getItem("narrafork_narrator_bottom_spacing")).toBe(
			String(BOTTOM_SPACING_CONSTANTS.MIN_SPACING),
		);
	});

	test("reset clears an active drag's listeners and body styles", async () => {
		const { resetBottomSpacingStoreForTest, startBottomSpacingResize } = await import(
			"./useResizableBottomSpacing"
		);
		resetBottomSpacingStoreForTest(20);
		startBottomSpacingResize({ clientY: 100, pointerId: 7, preventDefault: () => {} });
		expect(document.body.style.cursor).toBe("ns-resize");
		expect(document.body.style.userSelect).toBe("none");

		resetBottomSpacingStoreForTest(20);

		expect(document.body.style.cursor).toBe("");
		expect(document.body.style.userSelect).toBe("");
		// A late event after reset must not persist a new drag position.
		fire("pointermove", 0, 7);
		expect(localStorage.getItem("narrafork_narrator_bottom_spacing")).toBeNull();
	});
});
