/**
 * legacy-browser-polyfills.ts — Runtime built-ins missing on older Safari/WebKit.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `frontend/vite.config.ts` sets `build.target = ["es2020", "safari14"]` so the app
 * runs in iPadOS / older macOS WebKit views (PWA and in-app browsers). But a build
 * target only DOWN-LEVELS SYNTAX — it never injects runtime APIs. A method added
 * after es2020 therefore ships as a plain call that simply is not there, and the
 * failure is a `TypeError` at the first call site rather than anything the build
 * or type-checker can see.
 *
 * That gap already bit once: `Object.hasOwn` (ES2022, Safari 15.4+) is reached
 * through @xyflow/react and was patched ad hoc at the top of `hmr-guard.ts`. The
 * same class of bug then took down the narrator VIRTUAL LIST on Safari 14, and the
 * symptom is worth recording because it is so far from the cause:
 *
 *   `shared/pretext-layout/parse-markdown.ts` uses `lines.at(-1)` while measuring
 *   every markdown body. `Array.prototype.at` is ES2022 (Safari 15.4+), so on
 *   Safari 14 the measure pass threw `TypeError: t.at is not a function`. That
 *   throw happens inside `usePretextDocument`'s effect, which calls
 *   `coordinator.rebuild()` SYNCHRONOUSLY and lets it rethrow — so the error
 *   escaped to the route's CatchBoundary, which remounted the subtree, which re-ran
 *   the effect, which threw again. The user saw the list flickering forever with
 *   not a single message rendered, and the list's own error card never appeared
 *   (the throw bypassed `pretextDocument.error` entirely).
 *
 * WHAT BELONGS HERE
 * -----------------
 * Only ADDITIVE, spec-faithful shims for built-ins the app actually calls. Each
 * one is feature-detected, so a modern engine keeps its native implementation and
 * pays nothing but a `typeof` check at startup.
 *
 * Deliberately NOT here: APIs whose absence is handled at the call site instead.
 * `crypto.randomUUID` is one — `split-tree.ts` already avoids it on purpose (it is
 * unavailable over plain HTTP regardless of engine version), so a polyfill would
 * paper over a decision rather than restore a missing built-in.
 *
 * LOAD ORDER IS LOAD-BEARING: `main.tsx` imports this module FIRST, before any
 * other app or vendor module, because a shim installed after a module has already
 * executed a top-level call is too late.
 *
 * The `legacy-builtins.guard.test.ts` sibling test enforces that every ES2022+
 * built-in used under `frontend/` or `shared/` is either listed below or explicitly
 * acknowledged, so the next `.at(-1)` cannot reach a release unnoticed.
 */

/**
 * ToIntegerOrInfinity (ECMA-262 7.1.5) — the coercion every relative-index and
 * length argument in this file runs.
 *
 * ⚠️ `Number.isFinite` does NOT coerce, so testing it FIRST silently mishandles
 * every non-number the spec accepts. That is how the original `relativeIndex`
 * produced `[10,20,30].at(-Infinity) === 10` (native: `undefined`) and
 * `.at("1") === 10` (native: `20`): `-Infinity` and `"1"` both fail
 * `Number.isFinite` and fell into the `: 0` branch. Returning the WRONG ELEMENT
 * with no error is the exact failure class this module exists to prevent, so the
 * order here is the spec's: ToNumber, then NaN, then ±∞, then truncate.
 */
function toIntegerOrInfinity(value: unknown): number {
	const number = Number(value);
	if (Number.isNaN(number)) return 0;
	if (number === Infinity || number === -Infinity) return number;
	// `Math.trunc` also normalises -0 to -0, which indexes as 0 — same as the spec.
	return Math.trunc(number);
}

/**
 * LengthOfArrayLike (ECMA-262 7.3.18): ToLength of `.length`, i.e. clamped to an
 * integer in [0, 2^53 − 1].
 *
 * Only observable through `.call()` on an array-like whose `length` is fractional
 * or negative — a real array's is always a clamped integer. Included because the
 * shims below already honour `thisArg` and array-likes, so the one remaining
 * coercion gap would be an odd place to stop: with a `length` of 2.7 the loop
 * started at index 1.7 and `findLastIndex` returned `1.7`.
 */
function lengthOfArrayLike(target: { length?: unknown }): number {
	const integer = toIntegerOrInfinity(target.length);
	if (integer <= 0) return 0;
	return Math.min(integer, Number.MAX_SAFE_INTEGER);
}

/**
 * Resolve a relative index the way `Array.prototype.at` / `String.prototype.at`
 * do: truncate toward zero, count negatives from the end, and return `undefined`
 * for anything still out of range.
 */
function relativeIndex(length: number, index: unknown): number | undefined {
	const integer = toIntegerOrInfinity(index);
	const resolved = integer < 0 ? length + integer : integer;
	if (resolved < 0 || resolved >= length) return undefined;
	return resolved;
}

/** `Array.prototype.at` + `String.prototype.at` (ES2022 — Safari 15.4+). */
function installAt(): void {
	if (typeof Array.prototype.at !== "function") {
		Object.defineProperty(Array.prototype, "at", {
			value: function at(this: unknown[], index: number) {
				const resolved = relativeIndex(lengthOfArrayLike(this), index);
				return resolved === undefined ? undefined : this[resolved];
			},
			writable: true,
			configurable: true,
			enumerable: false,
		});
	}

	if (typeof String.prototype.at !== "function") {
		Object.defineProperty(String.prototype, "at", {
			value: function at(this: string, index: number) {
				// RequireObjectCoercible, which `String(this)` alone would skip: the
				// native method throws here, and returning `"n"` from `at.call(null, 0)`
				// would be another silently-wrong character.
				if (this == null) {
					throw new TypeError("String.prototype.at called on null or undefined");
				}
				const value = String(this);
				const resolved = relativeIndex(value.length, index);
				return resolved === undefined ? undefined : value[resolved];
			},
			writable: true,
			configurable: true,
			enumerable: false,
		});
	}
}

/**
 * `Array.prototype.findLast` / `findLastIndex` (ES2023 — Safari 15.4+).
 *
 * Reached from the narrator diff viewer, which BOTH render paths mount, so an
 * absent implementation breaks the chunked list too — not only the virtual one.
 */
function installFindLast(): void {
	if (typeof Array.prototype.findLastIndex !== "function") {
		Object.defineProperty(Array.prototype, "findLastIndex", {
			value: function findLastIndex(
				this: unknown[],
				predicate: (value: unknown, index: number, array: unknown[]) => unknown,
				thisArg?: unknown,
			) {
				if (typeof predicate !== "function") {
					throw new TypeError(`${String(predicate)} is not a function`);
				}
				for (let index = lengthOfArrayLike(this) - 1; index >= 0; index--) {
					if (predicate.call(thisArg, this[index], index, this)) return index;
				}
				return -1;
			},
			writable: true,
			configurable: true,
			enumerable: false,
		});
	}

	if (typeof Array.prototype.findLast !== "function") {
		Object.defineProperty(Array.prototype, "findLast", {
			value: function findLast(
				this: unknown[],
				predicate: (value: unknown, index: number, array: unknown[]) => unknown,
				thisArg?: unknown,
			) {
				if (typeof predicate !== "function") {
					throw new TypeError(`${String(predicate)} is not a function`);
				}
				for (let index = lengthOfArrayLike(this) - 1; index >= 0; index--) {
					const value = this[index];
					if (predicate.call(thisArg, value, index, this)) return value;
				}
				return undefined;
			},
			writable: true,
			configurable: true,
			enumerable: false,
		});
	}
}

/**
 * `Object.hasOwn` (ES2022 — Safari 15.4+).
 *
 * Used directly by the tool-call inspector and the Shiki language resolver, and
 * indirectly by @xyflow/react. Previously shimmed at the top of `hmr-guard.ts`;
 * consolidated here so every gap of this class has one home.
 */
function installObjectHasOwn(): void {
	if (typeof Object.hasOwn === "function") return;
	// Captured from the prototype rather than read off the target at call time: a
	// target may shadow `hasOwnProperty` with its own (possibly non-callable) key,
	// which is exactly the case `Object.hasOwn` exists to make safe.
	const ownProperty = Object.prototype.hasOwnProperty;
	Object.defineProperty(Object, "hasOwn", {
		value: function hasOwn(target: object, key: PropertyKey) {
			if (target == null) throw new TypeError("Cannot convert undefined or null to object");
			return ownProperty.call(Object(target), key);
		},
		writable: true,
		configurable: true,
		enumerable: false,
	});
}

/**
 * Reject anything a JSON round-trip cannot reproduce FAITHFULLY.
 *
 * ⚠️ `JSON.stringify` only throws for cycles and BigInt. Everything else it
 * mishandles, it mishandles QUIETLY, which is worse than throwing because the
 * caller persists the damage:
 *
 *   `new Map([[1, 2]])`   → `{}`          (all entries gone)
 *   `new Date(0)`         → `"1970-…Z"`   (a string, not a Date)
 *   `NaN` / `Infinity`    → `null`
 *   `() => {}` / `Symbol` → key dropped entirely
 *
 * Native `structuredClone` preserves Map/Set/Date/RegExp/NaN and throws
 * DataCloneError for functions and symbols, so a silent JSON round-trip is not a
 * substitute — it is the "silently returns the wrong thing" failure this whole
 * module exists to prevent. This walk makes the fallback's contract true: the
 * payloads it CAN clone exactly, it clones; everything else fails loudly.
 */
function assertJsonCloneable(value: unknown, seen: Set<object>): void {
	if (value === null) return;
	const type = typeof value;
	if (type === "string" || type === "boolean" || type === "undefined") return;
	if (type === "number") {
		// A non-finite number survives structuredClone but JSON turns it into null.
		if (!Number.isFinite(value as number)) {
			throw new TypeError("structuredClone fallback cannot clone NaN or Infinity");
		}
		return;
	}
	if (type === "function" || type === "symbol" || type === "bigint") {
		throw new TypeError(`structuredClone fallback cannot clone a ${type}`);
	}
	const object = value as object;
	if (seen.has(object)) {
		throw new TypeError("structuredClone fallback cannot clone a cyclic structure");
	}
	seen.add(object);
	if (Array.isArray(object)) {
		for (const entry of object) assertJsonCloneable(entry, seen);
		seen.delete(object);
		return;
	}
	// Only PLAIN objects round-trip: a Map/Set/Date/RegExp/Blob/class instance either
	// loses its contents or changes type. `Object.getPrototypeOf` rather than a
	// constructor-name check, which a bundler's mangling can change.
	const proto = Object.getPrototypeOf(object);
	if (proto !== Object.prototype && proto !== null) {
		throw new TypeError(
			"structuredClone fallback clones plain objects only (got a " +
				`${(object as { constructor?: { name?: string } }).constructor?.name ?? "non-plain"} )`,
		);
	}
	for (const key of Object.keys(object)) {
		assertJsonCloneable((object as Record<string, unknown>)[key], seen);
	}
	seen.delete(object);
}

/**
 * `structuredClone` (Safari 15.4+).
 *
 * The only caller is the narrator dock layout, which clones a plain
 * JSON-serializable dockview envelope before stripping identity fields from it.
 * A JSON round-trip is an exact substitute for THAT payload; for anything else the
 * guard above throws rather than handing back a mangled clone.
 *
 * The `options.transfer` list is REJECTED rather than ignored. Transferring detaches
 * the source object (an ArrayBuffer/MessagePort becomes unusable) and moves it into
 * the clone; a JSON round-trip can do neither, so honouring the call halfway would
 * leave the caller with a copy it believes is a transfer and a source it believes is
 * detached — a silent divergence in the one browser that needs this shim. Nothing
 * passes `transfer` today, so this only ever fires on a future call site.
 */
function installStructuredClone(): void {
	if (typeof globalThis.structuredClone === "function") return;
	Object.defineProperty(globalThis, "structuredClone", {
		value: function structuredClone<T>(value: T, options?: { transfer?: unknown[] }): T {
			// Only a NON-EMPTY list is a real request: `{ transfer: [] }` is what several
			// libraries pass unconditionally, and native treats it as a plain clone.
			if (options?.transfer != null && options.transfer.length > 0) {
				throw new TypeError(
					"structuredClone fallback does not support transferables: the `transfer` " +
						"option cannot be emulated by a JSON round-trip (nothing is detached or " +
						"moved). See frontend/lib/legacy-browser-polyfills.ts",
				);
			}
			// Native returns `undefined` for `undefined`; JSON.stringify yields the
			// string `undefined`, which JSON.parse then rejects — so the old fallback
			// THREW on the one value the real API handles trivially.
			if (value === undefined) return undefined as T;
			assertJsonCloneable(value, new Set());
			try {
				return JSON.parse(JSON.stringify(value)) as T;
			} catch (cause) {
				throw new Error(
					"structuredClone fallback supports JSON-serializable values only " +
						"(see frontend/lib/legacy-browser-polyfills.ts)",
					{ cause },
				);
			}
		},
		writable: true,
		configurable: true,
		enumerable: false,
	});
}

/**
 * Install every shim. Idempotent and safe to call more than once (each installer
 * feature-detects), which keeps module re-evaluation under HMR harmless.
 *
 * Exported so the guard test can run it against a stripped-down global and assert
 * the shims behave like the spec, rather than trusting the import side effect.
 */
export function installLegacyBrowserPolyfills(): void {
	installAt();
	installFindLast();
	installObjectHasOwn();
	installStructuredClone();
}

installLegacyBrowserPolyfills();
