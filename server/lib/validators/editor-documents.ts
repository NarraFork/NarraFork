import { z } from "zod";
import { EDITOR_FILE_MAX_BYTES } from "../../../shared/editor-document";

export const editorOperationMetadataSchema = z
	.object({
		version: z.literal(1),
		hashKind: z.literal("raw-sha256").optional(),
		userId: z.string().min(1).max(128),
		narratorId: z.string().min(1).max(128),
		operationId: z.string().uuid(),
		snapshotRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
		hash: z.string().regex(/^[a-f0-9]{64}$/),
		rawDigest: z.string().regex(/^[a-f0-9]{64}$/),
		bytes: z.number().int().min(0).max(EDITOR_FILE_MAX_BYTES),
		createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
	})
	.strict()
	.refine((value) => value.hashKind !== "raw-sha256" || value.hash === value.rawDigest, {
		message: "Raw receipt hash domain mismatch",
	});
export type EditorOperationMetadata = z.infer<typeof editorOperationMetadataSchema>;

const path = z
	.string()
	.trim()
	.min(1)
	.max(4096)
	.refine((value) => !value.includes("\0"));
const editorDocumentInputSchema = z
	.object({
		path,
		deviceId: z.string().min(1).max(128).optional(),
		origin: z.enum(["reference", "legacy"]),
	})
	.strict();
export const createEditorDocumentSchema = z.union([
	editorDocumentInputSchema.extend({ protocol: z.literal("text-v1").optional() }).strict(),
	editorDocumentInputSchema
		.extend({
			protocol: z.literal("raw-v2"),
			encodingHint: z.enum(["utf-8", "utf-16le", "utf-16be", "gbk", "gb18030"]).optional(),
		})
		.strict(),
]);
export const editorRawOpenSchema = z.object({ versionHandle: z.string().uuid() }).strict();
export const editorRawChunkSchema = z
	.object({
		offset: z.number().int().nonnegative().max(EDITOR_FILE_MAX_BYTES),
		maxBytes: z
			.number()
			.int()
			.min(1)
			.max(64 * 1024),
	})
	.strict();
export const editorRecoveryScopeSchema = editorDocumentInputSchema.omit({ path: true }).strict();
export const createEditorDraftAnchorSchema = editorRecoveryScopeSchema
	.extend({
		writerId: z.string().min(1).max(128),
		resourceKey: z.string().regex(/^[a-f0-9]{64}$/),
		revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
		modelLifetime: z.string().min(1).max(128),
		operation: z
			.object({
				operationId: z.string().uuid().optional(),
				snapshotRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
			})
			.strict()
			.optional(),
	})
	.strict();
export const createEditorUploadSchema = z
	.object({
		baseHash: z
			.string()
			.regex(/^[a-f0-9]{64}$/)
			.nullable(),
		encoding: z.string().min(1).max(64),
		snapshotRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
		protocol: z.literal("raw-v2").optional(),
		hashKind: z.literal("raw-sha256").optional(),
		bom: z.enum(["none", "utf8", "utf16le", "utf16be"]).optional(),
	})
	.strict()
	.refine((input) =>
		input.protocol === "raw-v2"
			? input.hashKind === "raw-sha256" && input.bom !== undefined
			: input.hashKind === undefined && input.bom === undefined,
	);
export const editorRawSealSchema = z
	.object({
		protocol: z.literal("raw-v2"),
		hashKind: z.literal("raw-sha256"),
		bytes: z.number().int().min(0).max(EDITOR_FILE_MAX_BYTES),
		rawDigest: z.string().regex(/^[a-f0-9]{64}$/),
		textDigest: z.string().regex(/^[a-f0-9]{64}$/),
		formatDigest: z.string().regex(/^[a-f0-9]{64}$/),
		textLength: z
			.number()
			.int()
			.min(0)
			.max(20 * 1024 * 1024),
		newlines: z.number().int().min(0).max(1_000_000),
	})
	.strict();
export const editorUploadChunkSchema = z
	.object({
		seq: z
			.number()
			.int()
			.min(0)
			.max(20 * 1024 * 1024),
		offset: z.number().int().min(0).max(EDITOR_FILE_MAX_BYTES),
		bytes: z
			.number()
			.int()
			.min(1)
			.max(256 * 1024),
		digest: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict();
export const commitEditorUploadSchema = z
	.object({
		confirmationToken: z.string().min(1).max(128).optional(),
		draftWriterId: z.string().min(1).max(128).optional(),
		draftModelLifetime: z.string().min(1).max(128).optional(),
	})
	.strict()
	.refine((input) => !!input.draftWriterId === !!input.draftModelLifetime, {
		message: "Draft writer and model lifetime must be provided together",
	});
