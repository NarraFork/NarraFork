import {
	handleMarkdownAnchorClick,
	markdownLinkTargetProps,
} from "@frontend/lib/markdown-anchor-scroll";
import {
	fileLinkLineSuffix,
	filePathFromHref,
	fileSelectionLineSuffix,
	fileTargetFromHref,
	isLocalFileHref,
	localFileHref,
} from "@shared/markdown-file-path";
import type { ComponentPropsWithoutRef } from "react";
import { useFileReferenceScope } from "./FileReferenceScope";

/** Shared by flowing markdown and every measured visual fragment of a vlist link. */
export function MarkdownLink({
	href,
	children,
	className,
	linkClassName,
	style,
	title,
	labelText = "",
	lineNumbersInChildren = false,
}: Pick<ComponentPropsWithoutRef<"a">, "href" | "children" | "className" | "style" | "title"> & {
	linkClassName?: string;
	/** Original visible label, before streaming animation wraps its text nodes. */
	labelText?: string;
	/** The exact renderer appended the suffix before measurement; never decorate fragments again. */
	lineNumbersInChildren?: boolean;
}) {
	const scope = useFileReferenceScope();
	const target = fileTargetFromHref(href, scope.context);
	const fileCandidate = filePathFromHref(href) !== null;
	const fileScoped = scope.context !== undefined || !!scope.narratorId || !!scope.openFile;
	const lineSuffix = lineNumbersInChildren ? "" : fileLinkLineSuffix(href, labelText);
	const content = (
		<>
			{children}
			{lineSuffix && <span data-file-line-suffix="">{lineSuffix}</span>}
		</>
	);
	// The same bytes can be an application route or a local path. Only a known
	// file target in a file-capable host is intercepted; ordinary anchors/URLs
	// keep their original navigation. Internal references never reach a browser.
	if (isLocalFileHref(href) || (fileScoped && (target || fileCandidate))) {
		if (!target || !scope.openFile) {
			return (
				<span className={className?.replace(/\bis-link\b/g, "").trim()} style={style}>
					{content}
				</span>
			);
		}
		const openFile = scope.openFile;
		return (
			<a
				href={localFileHref(target)}
				className={linkClassName ?? className}
				style={style}
				title={`${target.path}${fileSelectionLineSuffix(target.selection)}`}
				onClick={(event) => {
					event.preventDefault();
					event.stopPropagation();
					openFile(target);
				}}
				onAuxClick={(event) => event.preventDefault()}
			>
				{content}
			</a>
		);
	}
	return (
		<a
			href={href}
			className={linkClassName ?? className}
			style={style}
			title={title}
			{...markdownLinkTargetProps(href)}
			onClick={(event) => {
				handleMarkdownAnchorClick(event, href, event.currentTarget.closest("[data-md-body]"));
			}}
		>
			{content}
		</a>
	);
}
