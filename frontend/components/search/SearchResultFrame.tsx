import { Group, Paper, Text } from "@mantine/core";
import type { ReactNode } from "react";
import classes from "./Search.module.css";

/**
 * The one shape every search result has: the title (and a count on the right), one grey
 * line of where and when, then what matched. Sessions and knowledge entries both render
 * through it, so the list reads as one list.
 */
export function SearchResultFrame({
	title,
	aside,
	meta,
	children,
}: {
	title: ReactNode;
	/** Right of the title, e.g. "137 hits". */
	aside?: string;
	/** Joined with " · "; empty parts are skipped. */
	meta: (string | null | undefined)[];
	children?: ReactNode;
}) {
	const line = meta.filter(Boolean).join(" · ");
	return (
		<Paper withBorder radius="md" px="md" py="sm" className={classes.result}>
			<Group gap="sm" justify="space-between" wrap="nowrap">
				{title}
				{aside && (
					<Text size="xs" c="dimmed" style={{ flexShrink: 0, whiteSpace: "nowrap" }}>
						{aside}
					</Text>
				)}
			</Group>
			{line && (
				<Text size="xs" c="dimmed" mt={2} truncate>
					{line}
				</Text>
			)}
			{children}
		</Paper>
	);
}
