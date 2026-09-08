import { type FileReferenceContext, MAX_FILE_REFERENCE_PATH_CHARS } from "./file-reference";
import { resolveLocalFilePath } from "./markdown-file-path";

/** A bounded copy of captured location metadata. Unknown history must never inherit today's cwd. */
export function normalizeFileReferenceContext(value: unknown): FileReferenceContext | null {
	if (!value || typeof value !== "object") return null;
	const { deviceId, cwd } = value as Partial<FileReferenceContext>;
	if (
		typeof deviceId !== "string" ||
		!deviceId ||
		deviceId.length > MAX_FILE_REFERENCE_PATH_CHARS ||
		/\p{Cc}/u.test(deviceId) ||
		typeof cwd !== "string" ||
		!cwd ||
		cwd.length > MAX_FILE_REFERENCE_PATH_CHARS ||
		/\p{Cc}/u.test(cwd) ||
		!resolveLocalFilePath(cwd)
	)
		return null;
	return { deviceId, cwd };
}
