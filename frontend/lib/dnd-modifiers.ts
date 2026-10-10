import type { Modifier } from "@dnd-kit/core";

/**
 * 把拖动限制在纵轴上——水平位移一律归零。
 *
 * `verticalListSortingStrategy` 只决定排序时其他项如何让位，**不限制指针移动**：
 * 不加约束时被拖动的行会跟着指针左右平移，看起来像可以横向拖动。在垂直列表里
 * 横向位移没有任何语义，只会让行滑出菜单边界。
 *
 * 凡是用 `verticalListSortingStrategy` 的 `DndContext` 都应挂上它。
 */
export const restrictToVerticalAxis: Modifier = ({ transform }) => ({
	...transform,
	x: 0,
});

/**
 * 把拖动限制在横轴上——垂直位移一律归零。用途和理由与
 * {@link restrictToVerticalAxis} 对称，供 `horizontalListSortingStrategy` 的
 * 列表（如终端标签栏）使用。
 */
export const restrictToHorizontalAxis: Modifier = ({ transform }) => ({
	...transform,
	y: 0,
});
