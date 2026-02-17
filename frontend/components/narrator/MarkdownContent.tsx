import { Anchor, Blockquote, Code, Divider, List, Table, Text, Title } from "@mantine/core";
import { memo, useMemo } from "react";
import type { Components } from "react-markdown";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import classes from "./MarkdownContent.module.css";

const MD_PATTERN =
	/(?:^#{1,6}\s|(?:^|\n)```|\*\*|__|\*(?!\s)|_(?!\s)|\[.+?\]\(.+?\)|^>\s|^[-*+]\s|^\d+\.\s|^\|.+\||!\[)/m;

function hasMarkdown(text: string): boolean {
	return MD_PATTERN.test(text);
}

const HEADING_ORDER: Record<string, 1 | 2 | 3 | 4 | 5 | 6> = {
	h1: 1,
	h2: 2,
	h3: 3,
	h4: 4,
	h5: 5,
	h6: 6,
};

const mdComponents: Components = {
	p({ children }) {
		return (
			<Text size="sm" style={{ marginTop: "0.35em", marginBottom: 0 }}>
				{children}
			</Text>
		);
	},
	h1: heading,
	h2: heading,
	h3: heading,
	h4: heading,
	h5: heading,
	h6: heading,
	ul({ children }) {
		return (
			<List size="sm" type="unordered" style={{ marginTop: "0.35em", marginBottom: 0 }}>
				{children}
			</List>
		);
	},
	ol({ children }) {
		return (
			<List size="sm" type="ordered" style={{ marginTop: "0.35em", marginBottom: 0 }}>
				{children}
			</List>
		);
	},
	li({ children }) {
		return <List.Item style={{ margin: 0 }}>{children}</List.Item>;
	},
	a({ href, children }) {
		return (
			<Anchor href={href} target="_blank" rel="noopener noreferrer" size="sm">
				{children}
			</Anchor>
		);
	},
	blockquote({ children }) {
		return (
			<Blockquote p="xs" my={0}>
				{children}
			</Blockquote>
		);
	},
	code({ children, className }) {
		const isBlock = className?.startsWith("language-");
		if (isBlock) {
			return (
				<Code block fz="xs" style={{ maxWidth: "100%", overflowX: "auto" }}>
					{children}
				</Code>
			);
		}
		return <Code fz="xs">{children}</Code>;
	},
	pre({ children }) {
		return <>{children}</>;
	},
	hr() {
		return <Divider my={4} />;
	},
	table({ children }) {
		return (
			<div style={{ maxWidth: "100%", overflowX: "auto" }}>
				<Table fz="sm" striped highlightOnHover style={{ margin: 0 }}>
					{children}
				</Table>
			</div>
		);
	},
	thead({ children }) {
		return <Table.Thead>{children}</Table.Thead>;
	},
	tbody({ children }) {
		return <Table.Tbody>{children}</Table.Tbody>;
	},
	tr({ children }) {
		return <Table.Tr>{children}</Table.Tr>;
	},
	th({ children }) {
		return <Table.Th>{children}</Table.Th>;
	},
	td({ children }) {
		return <Table.Td>{children}</Table.Td>;
	},
	strong({ children }) {
		return (
			<Text span fw={700} size="sm">
				{children}
			</Text>
		);
	},
	em({ children }) {
		return (
			<Text span fs="italic" size="sm">
				{children}
			</Text>
		);
	},
};

function heading({ children, node }: any) {
	const tag = node?.tagName ?? "h3";
	const order = HEADING_ORDER[tag] ?? 3;
	return (
		<Title order={order} mt="0.4em" mb={0}>
			{children}
		</Title>
	);
}

const remarkPlugins = [remarkGfm];

interface MarkdownContentProps {
	text: string;
}

export const MarkdownContent = memo(function MarkdownContent({ text }: MarkdownContentProps) {
	const trimmed = text.trim();
	const isMd = useMemo(() => hasMarkdown(trimmed), [trimmed]);

	if (!isMd) {
		return (
			<Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
				{trimmed}
			</Text>
		);
	}

	return (
		<div className={classes.root}>
			<Markdown remarkPlugins={remarkPlugins} components={mdComponents}>
				{trimmed}
			</Markdown>
		</div>
	);
});
