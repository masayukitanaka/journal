import { Hono } from "hono";
import { formatYearRange, listDefaultYearRange, listFields, listYearRanges } from "../db.js";

// OpenAlex の Domain/Field 階層のうち、PoC で登録しているものの表示名（SPEC.md 4.2）。
// DB_REGISTRY（worker/db.ts）に新しい分野を追加したら、ここにも表示名を足す。
const FIELD_NAMES: Record<number, string> = {
	17: "Computer Science",
	12: "Arts and Humanities",
};

// GET /api/fields — 現在 D1 に登録済みの分野・年代レンジの一覧（フロントの切り替え UI 用）。
// defaultYearRange: yearRange 未指定時に実際に使われるレンジ。フロントが起動時にこれを yearRange state
// へ明示的にセットすることで、ドロップダウンの表示と実際に読み込まれたデータを一致させる（2026-11-11）。
export const fieldsRoute = new Hono<{ Bindings: Env }>().get("/", (c) => {
	const fields = listFields().map((field) => {
		const defaultYearRange = listDefaultYearRange(field);
		return {
			field,
			name: FIELD_NAMES[field] ?? `Field ${field}`,
			yearRanges: listYearRanges(field).map(formatYearRange),
			defaultYearRange: defaultYearRange ? formatYearRange(defaultYearRange) : null,
		};
	});
	return c.json({ fields });
});
