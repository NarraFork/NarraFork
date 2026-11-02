/**
 * 数据导入的共享上限。
 *
 * 前端先用它做本地预检（超限直接提示，不必上传），后端流式落盘时再按同一上限
 * 累计校验。`Bun.serve` 的 `maxRequestBodySize` 只能设一个全局值，所以它取这里的
 * 4 GB，让导入预览能收大包；其它请求在进入路由前按 `MAX_ORDINARY_BODY_BYTES` 拒绝。
 */
export const MAX_IMPORT_BYTES = 4 * 1024 ** 3;

/** 供界面与错误文案显示的可读大小。 */
export const MAX_IMPORT_LABEL = "4 GB";

/** 除导入预览以外的请求体上限，与 Bun 的默认值一致。 */
export const MAX_ORDINARY_BODY_BYTES = 128 * 1024 * 1024;

/**
 * 解压后的 snapshot.db 上限。压缩包本身停在 4 GB，这里再挡住展开后把磁盘写满的包。
 */
export const MAX_SNAPSHOT_UNCOMPRESSED_BYTES = 16 * 1024 ** 3;

export const MAX_SNAPSHOT_LABEL = "16 GB";

/** 只有这一条上传路径可以超过普通请求体上限。 */
export function isStorageImportUpload(method: string, pathname: string): boolean {
	return method.toUpperCase() === "POST" && /\/api\/storage\/import\/preview$/.test(pathname);
}

/** `Content-Length` 明确超过上限时为 true。缺省或非数字不算超过，交给流式计数。 */
export function declaredBodyExceeds(contentLength: string | null, limit: number): boolean {
	if (contentLength == null || contentLength.trim() === "") return false;
	const declared = Number(contentLength);
	return Number.isFinite(declared) && declared > limit;
}
