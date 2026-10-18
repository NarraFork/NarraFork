import { afterEach, expect, spyOn, test } from "bun:test";
import type { EditorDraftAnchorDescriptor } from "@shared/editor-document";
import { ApiError } from "../../../lib/api/client";
import { editorDocumentApi } from "../../../lib/api/editor-documents";
import { queryDraftOperation } from "./editor-draft-checkpoint";
import {
	claimDraftForRecovery,
	type RecoverableEditorDraft,
	recoverableDraftFormat,
	verifyDraftProvenance,
} from "./editor-draft-provenance";

const row: RecoverableEditorDraft = {
	id: "checkpoint",
	schemaVersion: 1,
	writerId: "old-realm",
	modelLifetime: "old-model",
	generation: "generation",
	scope: {
		recoveryKey: "owner",
		resourceKey: "resource",
		narratorId: "actual-narrator",
		deviceId: "local",
		origin: "reference",
		canonicalPath: "/repo/a",
	},
	anchor: { anchorId: "anchor", checkpointGeneration: "generation" },
	revision: 7,
	alternativeVersionId: 7,
	length: 5,
	baseVersion: { hash: "old-base", hashKind: "v1-decoded-sha256" },
	encoding: "utf-8",
	bodyCodec: "utf8-v1",
	protocol: "v1",
	digest: "0".repeat(64),
	bytes: 5,
	chunks: 1,
	updatedAt: 1,
	activeUntil: 30_000,
	complete: true,
};
const anchor: EditorDraftAnchorDescriptor = {
	anchorId: "anchor",
	checkpointGeneration: "generation",
	recoveryKey: "owner",
	resourceKey: "resource",
	writerId: "old-realm",
	modelLifetime: "old-model",
	revision: 7,
	status: "no-dispatch",
	retired: false,
	expiresAt: Date.now() + 60_000,
};
let cleanup: (() => void)[] = [];
afterEach(() => {
	for (const restore of cleanup.reverse()) restore();
	cleanup = [];
});
const signal = () => new AbortController().signal;
test("only matching fresh server coverage permits explicit claim; an old IDB marker alone never does", async () => {
	const get = spyOn(editorDocumentApi, "getDraftAnchor").mockResolvedValue(anchor);
	const claim = spyOn(editorDocumentApi, "claimDraftAnchor").mockResolvedValue({
		...anchor,
		retired: true,
	});
	cleanup.push(
		() => get.mockRestore(),
		() => claim.mockRestore(),
	);
	expect(recoverableDraftFormat(row)).toBe(false);
	const [verified] = await verifyDraftProvenance([row], signal());
	expect(recoverableDraftFormat(verified)).toBe(true);
	await claimDraftForRecovery(verified, signal());
	expect(claim).toHaveBeenCalledWith(
		"actual-narrator",
		"anchor",
		{ deviceId: "local", origin: "reference" },
		expect.any(AbortSignal),
	);
});
test("IDB marker/delete double failure still discovers and queries the original operation, never applies", async () => {
	const operation = { operationId: "original-operation", snapshotRevision: 9 };
	const get = spyOn(editorDocumentApi, "getDraftAnchor").mockResolvedValue({
		...anchor,
		status: "query-first",
		operation,
	});
	const query = spyOn(editorDocumentApi, "operation").mockResolvedValue({
		status: "uncertain",
		operationId: operation.operationId,
	});
	const commit = spyOn(editorDocumentApi, "commit");
	cleanup.push(
		() => get.mockRestore(),
		() => query.mockRestore(),
		() => commit.mockRestore(),
	);
	expect(row.operation).toBeUndefined();
	const [verified] = await verifyDraftProvenance([row], signal());
	expect(verified.operation).toMatchObject({ ...operation, status: "query-first" });
	expect(recoverableDraftFormat(verified)).toBe(false);
	await queryDraftOperation(verified, signal());
	await expect(claimDraftForRecovery(verified, signal())).rejects.toThrow("EDITOR_DRAFT_READ_ONLY");
	expect(query).toHaveBeenCalledTimes(1);
	expect(commit).not.toHaveBeenCalled();
});
test.each([
	"writerId",
	"resourceKey",
	"modelLifetime",
	"checkpointGeneration",
	"recoveryKey",
	"revision",
] as const)("mismatched %s cannot authorize ordinary restoration", async (field) => {
	const get = spyOn(editorDocumentApi, "getDraftAnchor").mockResolvedValue({
		...anchor,
		[field]: field === "revision" ? 99 : "other",
	});
	cleanup.push(() => get.mockRestore());
	const [verified] = await verifyDraftProvenance([row], signal());
	expect(recoverableDraftFormat(verified)).toBe(false);
});
test("missing, expired or failed provenance is not evidence of not-applied", async () => {
	const get = spyOn(editorDocumentApi, "getDraftAnchor").mockRejectedValue(
		new ApiError("missing", 404),
	);
	cleanup.push(() => get.mockRestore());
	const [verified] = await verifyDraftProvenance([row], signal());
	expect(recoverableDraftFormat(verified)).toBe(false);
	const [legacy] = await verifyDraftProvenance([{ ...row, anchor: undefined }], signal());
	expect(recoverableDraftFormat(legacy)).toBe(false);
	expect(get).toHaveBeenCalledTimes(1);
});
test("a dispatch racing after discovery makes claim query-first rather than editable", async () => {
	const claim = spyOn(editorDocumentApi, "claimDraftAnchor").mockResolvedValue({
		...anchor,
		status: "query-first",
		operation: { operationId: "late-op", snapshotRevision: 7 },
	});
	cleanup.push(() => claim.mockRestore());
	await expect(claimDraftForRecovery({ ...row, provenance: anchor }, signal())).rejects.toThrow(
		"EDITOR_DRAFT_QUERY_REQUIRED",
	);
});
test("known legacy codecs retain v1 save semantics; unknown schema/codec and raw-v2 remain read-only", () => {
	for (const encoding of [
		"utf-8",
		"UTF-16LE",
		"gbk",
		"gb18030",
		"big5",
		"shift_jis",
		"euc-jp",
		"windows-1252",
		"iso-8859-1",
	])
		expect(recoverableDraftFormat({ ...row, encoding, provenance: anchor })).toBe(true);
	for (const changed of [
		{ schemaVersion: 99 },
		{ encoding: "unknown-codec" },
		{ bodyCodec: "future" },
		{ protocol: "raw-v2" as const },
	])
		expect(recoverableDraftFormat({ ...row, ...changed, provenance: anchor })).toBe(false);
});
test("cancelled hidden discovery performs zero provenance requests", async () => {
	const get = spyOn(editorDocumentApi, "getDraftAnchor");
	cleanup.push(() => get.mockRestore());
	const controller = new AbortController();
	controller.abort();
	await expect(verifyDraftProvenance([row], controller.signal)).rejects.toThrow();
	expect(get).not.toHaveBeenCalled();
});
