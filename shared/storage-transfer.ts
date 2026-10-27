/**
 * 数据导入的共享上限。
 *
 * 前端先用它做本地预检（超限直接提示，不必上传），后端流式落盘时再按同一上限
 * 累计校验，并给 `Bun.serve` 的 `maxRequestBodySize` 提供取值——三处必须一致。
 */
export const MAX_IMPORT_BYTES = 4 * 1024 ** 3;

/** 供界面与错误文案显示的可读大小。 */
export const MAX_IMPORT_LABEL = "4 GB";
