import { Badge, Box, Group, Text } from "@mantine/core";
import { IconChevronRight } from "@tabler/icons-react";
import type { FocusStack } from "./focus-stack";

interface RulerBreadcrumbProps {
	focusStack: FocusStack;
	/** Labels for each depth level (index = depth). Falls back to "Level N". */
	labels?: Map<number, string>;
	onJumpTo: (depth: number) => void;
}

export function RulerBreadcrumb({ focusStack, labels, onJumpTo }: RulerBreadcrumbProps) {
	const { path, focusDepth } = focusStack;
	if (path.length <= 1) return null;

	const MAX_VISIBLE = 4;
	const items: Array<{ depth: number; label: string; collapsed?: boolean }> = [];

	if (path.length <= MAX_VISIBLE) {
		for (const entry of path) {
			items.push({
				depth: entry.depth,
				label: labels?.get(entry.depth) ?? (entry.depth === 0 ? "main" : `Level ${entry.depth}`),
			});
		}
	} else {
		items.push({
			depth: 0,
			label: labels?.get(0) ?? "main",
		});
		items.push({ depth: -1, label: "…", collapsed: true });
		for (let i = Math.max(1, focusDepth - 1); i <= focusDepth; i++) {
			if (i < path.length) {
				items.push({
					depth: path[i].depth,
					label: labels?.get(path[i].depth) ?? `Level ${path[i].depth}`,
				});
			}
		}
	}

	return (
		<Box
			style={{
				position: "absolute",
				top: 4,
				left: 8,
				zIndex: 20,
				pointerEvents: "auto",
			}}
		>
			<Group gap={4}>
				{items.map((item, i) => (
					<Group key={item.collapsed ? "collapsed" : item.depth} gap={2}>
						{i > 0 && <IconChevronRight size={12} style={{ opacity: 0.4 }} />}
						{item.collapsed ? (
							<Text size="xs" c="dimmed">
								…
							</Text>
						) : (
							<Badge
								size="sm"
								variant={item.depth === focusDepth ? "filled" : "light"}
								color={item.depth === focusDepth ? "indigo" : "gray"}
								style={{ cursor: "pointer" }}
								onClick={() => onJumpTo(item.depth)}
							>
								{item.label}
							</Badge>
						)}
					</Group>
				))}
			</Group>
		</Box>
	);
}
