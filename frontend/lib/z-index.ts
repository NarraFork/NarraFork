/**
 * 全局浮层层叠层级的单一事实来源(single source of truth)。
 *
 * 本项目的 z-index 管理遵循"两层模型":
 *
 * 1. 局部层叠(组件内部) —— 在组件根容器上加 `isolation: isolate` 建立独立
 *    层叠上下文,内部子元素只用小数值(1/2/3/5/10)互相比较,被封闭在组件内,
 *    既不受父级/兄弟影响,也不会泄漏到全局。这类值**不要**使用本文件的 token。
 *
 * 2. 全局浮层(组件之间) —— 通过 React/Mantine Portal 或 `position: fixed`
 *    逃逸到 body / 视口级的浮层(Modal、菜单、通知、popover、拖拽跟随物等),
 *    必须使用本文件的语义化 token,确保跨组件叠放顺序可预测、可维护。
 *
 * 与 Mantine portal 组件层级对齐(基于 @mantine/core v7,getDefaultZIndex):
 *   app: 100 / modal: 200 / popover: 300 / overlay: 400 / max: 9999
 * Mantine 自管组件(未显式传 zIndex 的 <Modal>/<Drawer>=200、<Menu>/<Select>/
 * <Combobox>/<Popover>=300、<Notifications>=400)整体处于 100~400 低区间。
 * 本 token 体系刻意整体抬高到 1000 起步,确保手写视口级浮层稳定盖过这些 Mantine
 * 默认组件;各档之间留有间隔,便于未来在不重排全局的前提下插入新层级。
 *
 * 对齐策略:凡是需要参与本体系排序的 Mantine portal 组件(如全局 <Notifications>、
 * 需压过手写浮层的 Modal),都应显式传入对应的 Z token(见 main.tsx 的
 * <Notifications zIndex={Z.toast} />),而非沿用 Mantine 默认值,避免两套体系割裂。
 * 唯一例外:位于某个 Mantine <Modal> *内部* 的下拉/combobox,应继续沿用 Mantine
 * 自管层级(popover 300 高于 modal 200 的内部关系),不要套用本 token。
 */
export const Z = {
	/** isolate 容器内的"抬升"元素(粘性头、滚动到底按钮等)。仅在已 isolate 的容器内使用。 */
	raised: 10,
	/** 贴靠在内容边缘的粘性头部 / 改宽手柄等。 */
	stickyHeader: 100,
	/** 下拉、combobox、命令浮层、输入框上方的浮层。 */
	dropdown: 1000,
	/** 右键上下文菜单的遮罩层(置于菜单之下)。 */
	contextMenuBackdrop: 1999,
	/** 右键上下文菜单。 */
	contextMenu: 2000,
	/** 选区操作浮层、swipe 菜单、多选工具栏等贴近内容的浮层。 */
	popover: 3000,
	/** 故事网络图的视口级覆盖层(套索、选择连线、工具条)。 */
	graphOverlay: 3000,
	/** 抽屉。 */
	drawer: 4000,
	/** 普通 Modal(确认框、价格弹窗、目录浏览、节点内 Modal 等)。 */
	modal: 5000,
	/** 通知横幅、全局提示、悬浮恢复按钮(FAB)。 */
	toast: 6000,
	/** 拖拽跟随物,需盖过几乎一切内容。 */
	dragGhost: 8000,
	/** 强制阻断流程的全屏遮罩(如缺少 Git 的安装引导)。 */
	criticalOverlay: 9000,
	/** 强制阻断流程遮罩之上的 Modal。 */
	criticalModal: 9001,
} as const;

export type ZLayer = keyof typeof Z;
