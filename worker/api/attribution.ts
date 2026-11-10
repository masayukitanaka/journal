import { Hono } from "hono";

// GET /api/attribution — 利用データの出典表示（SPEC.md 7章「帰属表示」）。
export const attributionRoute = new Hono<{ Bindings: Env }>().get("/", (c) =>
	c.json({
		sources: [
			{
				name: "OpenAlex",
				url: "https://openalex.org",
				license: "CC0",
				note: "論文・分野・被引用の基本データ",
			},
			{
				name: "Semantic Scholar",
				url: "https://www.semanticscholar.org",
				license: "利用条件は個別確認",
				note: "引用意図・影響力のある引用の判定（補助データ、未連携）",
			},
		],
	}),
);
