import { MemoryProfileError } from "./memory-profile-constants";

let profile = false;
let snapshots = 0;
let garbageCollections = 0;

/** No queue: natural-GC recordings must not overlap our own disruptive diagnostics. */
export function reserveDiagnostic(kind: "profile" | "snapshot" | "gc"): () => void {
	if (kind === "profile") {
		if (profile || snapshots || garbageCollections) throw new MemoryProfileError("diagnostic_busy");
		profile = true;
	} else {
		if (profile || (kind === "snapshot" && snapshots)) {
			throw new MemoryProfileError("diagnostic_busy");
		}
		if (kind === "snapshot") snapshots++;
		else garbageCollections++;
	}
	let released = false;
	return () => {
		if (released) return;
		released = true;
		if (kind === "profile") profile = false;
		else if (kind === "snapshot") snapshots--;
		else garbageCollections--;
	};
}
