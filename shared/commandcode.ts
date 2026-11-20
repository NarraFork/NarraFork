/**
 * Command Code 的固定地址。
 *
 * 前后端共用：服务端用它做默认 Provider API 根，前端用它给新实例预填 baseUrl，
 * 两边不能各写一份，否则改上游地址时会漏掉一处。
 */

export const COMMAND_CODE_API_BASE = "https://api.commandcode.ai";
/** Provider API 根：各推理端点挂在其下（`/messages`、`/chat/completions`、`/responses`、`/models`）。 */
export const COMMAND_CODE_PROVIDER_BASE = `${COMMAND_CODE_API_BASE}/provider/v1`;
