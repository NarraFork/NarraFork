/**
 * round-head-key.ts — 从「轮首 spec 的 key」还原 messageId。纯函数，零 DOM。
 *
 * 后端轮次索引 `GET /api/narrators/:id/rounds` 按 messageId 给出每一轮的用时与
 * token，而折叠条只拿得到 spec 的 key。两边的对应关系因此完全落在这一个函数上：
 * 还原错了，折叠条就只剩光秃秃的「已处理」——实测踩过两次。
 *
 * key 不是单纯 `${msgId}`，它被两层包裹：
 *
 *   1. **前缀**：轮首常常是 activity 单元的一部分（`activityUnitKey` 的产物），
 *      形如 `activity-a:auxiliary-<内部 key>` 或 `activity-t:<toolUseId>`。
 *      后者是工具行，永远不是轮首，直接判空。
 *
 *   2. **后缀**：`elementKey` 的块定位 `-blk[<blockId>]`（多元素块再跟 `+<offset>`），
 *      以及按形态加的 `-bubble`（用户气泡）/ `-origin`（来源卡）/
 *      `-m-legacy`（无结构化 injection 的老式 Send 行）。
 *
 * 顺序上必须先剥前缀再剥块定位：块定位里不含 `:`，但它含 `-`，先剥后缀会把
 * `+1` 这种偏移留在中间，后续匹配就全错。
 */

/** key 里表示「这是工具行」的前缀 —— 工具行不是轮首。 */
const TOOL_PREFIX = "activity-t:";

/** activity 单元给行加的前缀，长的先试（互相是前缀关系）。 */
const ACTIVITY_PREFIXES = [
	"activity-a:auxiliary-",
	"activity-a:segment-",
	"activity-a:",
	// 辅助内容自己的 key 也带 `auxiliary-` 前缀（`auxiliaryContentKey` 的产物）。
	// 轮首被投影成 auxiliary-content 时就是这个裸露形态 —— 实测子代理的派发任务
	// 正是如此，漏掉它折叠条就一直只剩「已处理」。
	"auxiliary-",
] as const;

/** 按形态加的末尾后缀。 */
const SHAPE_SUFFIXES = ["-bubble", "-origin", "-m-legacy"] as const;

/**
 * 轮首 spec 的 key → 发出这条消息的 messageId。
 *
 * 还原不出来（空串、工具行）返回 null —— 调用方据此让折叠条不显示这段数字，
 * 而不是显示一个查不到的 0。
 */
export function roundHeadMessageId(key: unknown): string | null {
	if (typeof key !== "string" || key.length === 0) return null;
	let id = key;

	if (id.startsWith(TOOL_PREFIX)) return null;
	for (const prefix of ACTIVITY_PREFIXES) {
		if (id.startsWith(prefix)) {
			id = id.slice(prefix.length);
			break;
		}
	}

	// `-blk[<blockId>]` 之后可能紧跟 `+<offset>`：同名块里的第 N 个元素。
	const blockAt = id.indexOf("-blk[");
	if (blockAt > 0) id = id.slice(0, blockAt);

	for (const suffix of SHAPE_SUFFIXES) {
		if (id.endsWith(suffix)) {
			id = id.slice(0, -suffix.length);
			break;
		}
	}

	return id.length > 0 ? id : null;
}
