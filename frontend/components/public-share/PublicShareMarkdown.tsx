import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import { publicShareExternalHref } from "../../lib/public-share-api";

/** No remark/rehype IO, raw HTML, file resolvers, image fetches or internal navigation. */
export function PublicShareMarkdown({ text }: { text: string }) {
	const { t } = useTranslation("publicShare");
	const origin = typeof window === "undefined" ? "" : window.location.origin;
	return (
		<div className="public-share-markdown">
			<ReactMarkdown
				skipHtml
				components={{
					img: () => <span className="public-share-placeholder">{t("mediaOmitted")}</span>,
					a: ({ href, children }) => {
						const external = publicShareExternalHref(href, origin);
						return external ? (
							<a
								href={external}
								target="_blank"
								rel="noopener noreferrer"
								referrerPolicy="no-referrer"
							>
								{children}
							</a>
						) : (
							<span>{children}</span>
						);
					},
				}}
			>
				{text}
			</ReactMarkdown>
		</div>
	);
}
