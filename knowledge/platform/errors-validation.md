---
id: platform.errors-validation
title: 错误与校验
summary: AppError 子类与全局序列化、Zod 校验器目录约定。
anchors:
  - server/lib/errors.ts
  - server/lib/app-error-response.ts
  - shared/error-catalog.ts
  - server/lib/__tests__/error-catalog-reachability.test.ts
  - server/lib/validators/common.ts
  - server/lib/validators/index.ts
  - shared/__tests__/error-catalog.test.ts
  - frontend/locales/__tests__/errors-parity.test.ts
  - server/lib/__tests__/specific-prose-preserved.test.ts
  - frontend/components/narrator/error-localization.ts
keywords:
  - AppError
  - ERROR_CATALOG
  - messageCode
  - messageParams
  - catalogError
  - zodValidationError
  - VALIDATION_FAILED
  - INTERNAL_ERROR
  - PAYLOAD_TOO_LARGE
  - DISK_FULL
  - errors.json
  - Retry-After
  - 错误码
  - 错误本地化
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 错误与校验

后端用 `AppError` 家族表达可预期的失败，由全局处理器统一序列化成 JSON；请求体用 Zod schema 校验。

## 关键规则
- `AppError(message, statusCode=500, code="INTERNAL_ERROR", localization?, details?)`；子类有 `RateLimitError`(429)、`NotFoundError`(404)、`ValidationError`(400)、`ForbiddenError`(403)、`GitError`/`UnbornHeadError`/`GitAuthError`、容器类等（`server/lib/errors.ts`）。
- 两条正交轴：`code` 决定客户端行为，`messageCode` 决定本地化措辞。`messageCode` 取自 `shared/error-catalog.ts` 的 `ERROR_CATALOG`；`catalogError(messageCode, params)` 从同一条目取状态码、code 和英文文案（`errors.ts:catalogError`）。
- `ForbiddenError`、`RateLimitError` 只在使用默认文案时才附带 catalog 的 `messageCode`；调用方自带文案则不本地化，避免用泛化文案覆盖具体原因（`errors.ts` 对应构造函数）。
- 线上格式：`{ error, code, details?, messageCode?, messageParams? }`；`error` 始终是英文渲染文本（`server/lib/app-error-response.ts:toErrorPayload`）。
- 全局处理器 `app.onError`：先识别磁盘满（转 `DiskSpaceError`）、`AppError`、`RateLimitError`（带 `Retry-After` 和 `retryAfterSeconds`）、数据库读取暂不可用（503 + `Retry-After`）；客户端中断的 `AbortError` 返回 499；其余记日志并返回通用 `INTERNAL_ERROR` 500，不暴露内部信息（`server/app.ts:app.onError`、`buildAppErrorResponse`）。
- 校验失败用 `zodValidationError(parsed.error)` 抛出：frame 本地化为 `VALIDATION_FAILED`，字段明细保持 Zod 原文（`errors.ts:zodValidationError`；路由示例 `server/routes/auth.ts`）。`formatZodError` 只拼 `path: message`。
- Zod schema 按资源拆在 `server/lib/validators/*.ts`（如 `auth.ts`、`narrators.ts`、`projects.ts`），`validators/index.ts` 是桶式再导出；路由处理器内 `safeParse`。
- 有测试守卫：每个 catalog 的 `messageCode` 都必须在源码里被 `catalogError("X")` 或 `messageCode: "X"` 引用（`server/lib/__tests__/error-catalog-reachability.test.ts`）。

- 参数上限：`messageParams` 最多 `MAX_PARAM_KEYS = 12` 个键、值最长 `MAX_PARAM_VALUE_CHARS = 200` 字符，超出截断；对象和数组不允许（错误响应与其他请求共用主线程，不能带大载荷）（`shared/error-catalog.ts`）。
- 前端按 `messageCode` 在 `locales/{en,zh-CN}/errors.json` 里取本地化文案，没有的退回服务端带的英文 `error`（`frontend/components/narrator/error-localization.ts`、`components/common/ErrorDetail.tsx`）。
- `code` 决定客户端行为（例如会话失效码会让前端清掉登录态），`messageCode` 只决定措辞；新增文案不得改变 `code`（`error-catalog.ts` 头部）。

## 从哪读起
- `server/lib/errors.ts`：错误类与 `catalogError`、`zodValidationError`。
- `server/lib/app-error-response.ts`：序列化。
- `shared/error-catalog.ts`：错误目录（前后端共享）。
- `server/lib/validators/`：各资源的 Zod schema。

## 改它时
- 新增可本地化错误：在 `shared/error-catalog.ts` 的 `ERROR_CATALOG` 加条目，用 `catalogError("X", params)` 抛出，并在 `frontend/locales/en/errors.json` 与 `zh-CN/errors.json` 同时加同名键；`frontend/locales/__tests__/errors-parity.test.ts` 检查目录与两份文案一致，`server/lib/__tests__/error-catalog-reachability.test.ts` 要求每个 `messageCode` 在源码里被引用，缺一就失败。
- 想保留具体原因的文案时不要套用泛化的目录文案（`specific-prose-preserved.test.ts` 钉着这一点）。
- 新增 Zod 校验器：放进 `server/lib/validators/<资源>.ts`，在 `validators/index.ts` 再导出，路由里 `safeParse` 失败用 `zodValidationError`。
- 不变量：500 响应不暴露内部信息；`error` 字段永远是英文渲染文本。

## 相关
- [HTTP 路由与 WebSocket](http-ws.md)
- [主线程性能规则](main-thread.md)
