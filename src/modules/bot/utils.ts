import { locales } from "../../locales/locales.ts";
import type { Custom, CustomContext } from "./types.ts";

export function createReplyWithTextFunc(ctx: CustomContext): Custom["text"] {
	return (resourceKey, _templateData, extra = {}) => {
		extra.parse_mode = "HTML";
		extra.link_preview_options = {
			is_disabled: true,
		};
		return ctx.reply(
			locales[ctx.from?.language_code ?? "en"]?.[resourceKey] ??
				`{{resourceKey}}`,
			extra,
		);
	};
}
