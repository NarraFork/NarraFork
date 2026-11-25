import { afterEach, expect, mock, test } from "bun:test";
import {
	installPretextDocumentCacheInvalidator,
	invalidateCachedPretextDocument,
} from "./pretext-document-cache-invalidation";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function install(invalidate: (narratorId: string) => void) {
	const cleanup = installPretextDocumentCacheInvalidator(invalidate);
	cleanups.push(cleanup);
	return cleanup;
}

test("no loaded cache owner makes invalidation a synchronous no-op", () => {
	expect(invalidateCachedPretextDocument("never-loaded")).toBeUndefined();
});

test("the loaded cache receives invalidation synchronously and cleanup releases it", () => {
	const invalidator = mock((_id: string) => {});
	const cleanup = install(invalidator);
	invalidateCachedPretextDocument("room");
	expect(invalidator).toHaveBeenCalledTimes(1);
	expect(invalidator).toHaveBeenLastCalledWith("room");
	cleanup();
	invalidateCachedPretextDocument("room");
	expect(invalidator).toHaveBeenCalledTimes(1);
});

test("replacement owns the only callback and stale HMR cleanup cannot remove it", () => {
	const oldOwner = mock((_id: string) => {});
	const replacement = mock((_id: string) => {});
	const cleanupOld = install(oldOwner);
	const cleanupNew = install(replacement);
	cleanupOld();
	invalidateCachedPretextDocument("after-replacement");
	expect(oldOwner).not.toHaveBeenCalled();
	expect(replacement).toHaveBeenCalledTimes(1);
	cleanupNew();
	cleanupNew();
	invalidateCachedPretextDocument("after-dispose");
	expect(replacement).toHaveBeenCalledTimes(1);
});
