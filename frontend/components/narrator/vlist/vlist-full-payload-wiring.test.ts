/**
 * vlist-full-payload-wiring.test.ts — Guards the wiring that lets a truncated
 * body reach its un-truncated payload.
 *
 * The regression this pins: the shell passed `getLoadFullPayload` — a per-key
 * THUNK FACTORY built for a (since removed) row prop that invoked the returned
 * handler — into `useVListContentView`, whose `requestFullPayload` contract is
 * fire-and-forget. The factory was called and its thunk discarded, so
 * `markVListFullPayloadRequested` never ran: scrolling past the halfway mark and
 * opening fullscreen were both silent no-ops, the fetch never started, and the
 * fullscreen modal kept showing the static "[preview truncated]" notice because
 * the request mark never existed (`loadingFullPayload` stayed false).
 *
 * Why source scanning: the mismatch is type-compatible both ways (a thunk
 * factory is assignable to a `=> void` slot), so the type checker cannot see it,
 * and hook-level tests pass whatever spy shape they like — the existing
 * `useVListContentView` tests use a direct marker spy and never exercised the
 * factory shape the real shell supplied. The invariant with no runtime
 * representation here is "the shell's callback marks SYNCHRONOUSLY", which is
 * exactly the checklist case source scanning exists for (see
 * vlist-live-wiring.test.ts's header note).
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (file: string) => readFileSync(join(import.meta.dir, file), "utf8");
const SHELL = read("PretextExactMessageList.tsx");

describe("full-payload request wiring (inline auto-load + fullscreen)", () => {
	it("hands useVListContentView a synchronous marker, not a thunk factory", () => {
		// The broken wiring, verbatim: a factory whose returned thunk was discarded.
		expect(SHELL).not.toContain("getLoadFullPayload");
		// The fixed wiring: a direct, stable marker callback.
		expect(SHELL).toContain("useVListContentView({ requestFullPayload: requestRowFullPayload })");
		expect(SHELL).toContain("const requestRowFullPayload = useCallback((key: string) => {");
		// …whose body marks immediately. Anything returned-but-not-invoked here is the bug.
		expect(SHELL).toContain("setInteraction((prev) => markVListFullPayloadRequested(prev, key))");
	});
});
