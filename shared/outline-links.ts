/**
 * App paths of what outline tool cards name: a block by its address, a commit by its seq. They
 * lead to the outline's reference route (`/outline/ref`), which asks the server where they point
 * (`GET /api/outline/resolve`, permission checked); inside a session they open an outline panel
 * instead (`frontend/lib/outline-href.ts` parses them). Paths are relative to the app's root,
 * without its mount prefix, which the browser side adds.
 */
import { parseAddress } from "./outline/address";

/** Path for a `key/sid` block address, or null when `address` is not one. */
export function outlineAddressPath(address: string | null | undefined): string | null {
	if (!address || !parseAddress(address)) return null;
	return `/outline/ref?${new URLSearchParams({ a: address.trim() }).toString()}`;
}

/** Path for commit `seq` of the space with key `spaceKey`. */
export function outlineCommitPath(spaceKey: string, seq: number): string | null {
	if (!spaceKey || !Number.isSafeInteger(seq) || seq < 0) return null;
	return `/outline/ref?${new URLSearchParams({ space: spaceKey, commit: String(seq) }).toString()}`;
}
