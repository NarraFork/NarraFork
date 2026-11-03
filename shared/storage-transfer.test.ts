import { describe, expect, test } from "bun:test";
import {
	declaredBodyExceeds,
	isStorageImportUpload,
	MAX_ORDINARY_BODY_BYTES,
} from "./storage-transfer";

describe("storage transfer body limits", () => {
	test("只有导入预览可以超过普通请求体上限", () => {
		expect(isStorageImportUpload("POST", "/api/storage/import/preview")).toBe(true);
		expect(isStorageImportUpload("post", "/api/storage/import/preview")).toBe(true);
		expect(isStorageImportUpload("PUT", "/api/storage/import/preview")).toBe(false);
		expect(isStorageImportUpload("POST", "/api/storage/import/apply")).toBe(false);
		expect(isStorageImportUpload("POST", "/api/storage/export")).toBe(false);
	});

	test("Content-Length 明确超限才算超限", () => {
		expect(declaredBodyExceeds(null, MAX_ORDINARY_BODY_BYTES)).toBe(false);
		expect(declaredBodyExceeds("", MAX_ORDINARY_BODY_BYTES)).toBe(false);
		expect(declaredBodyExceeds("nope", MAX_ORDINARY_BODY_BYTES)).toBe(false);
		expect(declaredBodyExceeds(String(MAX_ORDINARY_BODY_BYTES), MAX_ORDINARY_BODY_BYTES)).toBe(
			false,
		);
		expect(declaredBodyExceeds(String(MAX_ORDINARY_BODY_BYTES + 1), MAX_ORDINARY_BODY_BYTES)).toBe(
			true,
		);
	});
});
