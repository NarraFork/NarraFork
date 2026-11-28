import { MemoryProfileError } from "./memory-profile-constants";

interface AdmissionOwner {
	version: 1;
	profile: boolean;
	snapshots: number;
	garbageCollections: number;
}
const OWNER = Symbol.for("narrafork.browser.diagnostic-admission");
const globals = globalThis as typeof globalThis & { [OWNER]?: AdmissionOwner };
const previous = globals[OWNER];
if (
	previous &&
	(previous.version !== 1 ||
		typeof previous.profile !== "boolean" ||
		!Number.isSafeInteger(previous.snapshots) ||
		previous.snapshots < 0 ||
		!Number.isSafeInteger(previous.garbageCollections) ||
		previous.garbageCollections < 0)
)
	throw new Error("Browser diagnostic admission ownership cannot be recovered");
const owner: AdmissionOwner = previous ?? {
	version: 1,
	profile: false,
	snapshots: 0,
	garbageCollections: 0,
};
globals[OWNER] = owner;

/** No queue: natural-GC recordings must not overlap our own disruptive diagnostics. */
export function reserveDiagnostic(kind: "profile" | "snapshot" | "gc"): () => void {
	if (kind === "profile") {
		if (owner.profile || owner.snapshots || owner.garbageCollections)
			throw new MemoryProfileError("diagnostic_busy");
		owner.profile = true;
	} else {
		if (owner.profile || (kind === "snapshot" && owner.snapshots)) {
			throw new MemoryProfileError("diagnostic_busy");
		}
		if (kind === "snapshot") owner.snapshots++;
		else owner.garbageCollections++;
	}
	let released = false;
	return () => {
		if (released) return;
		released = true;
		if (kind === "profile") owner.profile = false;
		else if (kind === "snapshot") owner.snapshots--;
		else owner.garbageCollections--;
	};
}
