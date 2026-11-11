import { Hono } from "hono";
import { buildSeedGraph, graphKey } from "../graph.js";
import { listAdjacentDbs, resolveFieldDb } from "../db.js";
import { SEED_DEPTH_DEFAULT, SEED_DEPTH_MAX } from "../constants.js";

// GET /api/fields/:field/seed/{id} — シード周辺のグラフ（SPEC.md 5章）。
// R2 のキャッシュ済みグラフがあれば返し、無ければ D1 から直接計算して応答しつつ、
// Graph Build Queue へメッセージを送って R2 生成を後追いする（ARCHITECT.md 3.2, 4.3）。
export const seedRoute = new Hono<{ Bindings: Env }>()
	// DELETE /api/fields/:field/seed — その分野の R2 グラフキャッシュを一斉に削除する（開発用）。
	// 個別 seed 一斉削除と違い、どの seed がキャッシュされているか調べる手間が無い（2026-11-11、
	// ユーザー要望により追加）。R2 の list は1回最大1000件なので cursor でページングして全件集める。
	.delete("/fields/:field/seed", async (c) => {
		const field = Number(c.req.param("field"));
		if (!Number.isInteger(field) || field <= 0) {
			return c.json({ error: "invalid 'field' path parameter" }, 400);
		}
		const prefix = `graph/field${field}/`;
		const keys: string[] = [];
		let cursor: string | undefined;
		do {
			const listed = await c.env.BUCKET_FIELD17.list({ prefix, cursor });
			keys.push(...listed.objects.map((o) => o.key));
			cursor = listed.truncated ? listed.cursor : undefined;
		} while (cursor);

		// R2 の delete は1回最大1000件まで。1000件ずつに分割して削除する。
		for (let i = 0; i < keys.length; i += 1000) {
			await c.env.BUCKET_FIELD17.delete(keys.slice(i, i + 1000));
		}
		return c.json({ deletedCount: keys.length });
	})
	// DELETE /api/fields/:field/seed/{id} — 指定シードの R2 グラフキャッシュを削除する（開発用）。
	// グラフ構築ロジックやデータを変更した後、古いキャッシュ JSON がそのまま返り続ける問題への対応
	// （2026-11-11。本番運用での自動無効化ではなく、手動での強制再生成が目的）。
	// depth（1〜SEED_DEPTH_MAX）ごとにキーが分かれているため、該当する全てのキーをまとめて消す。
	.delete("/fields/:field/seed/:id", async (c) => {
		const field = Number(c.req.param("field"));
		if (!Number.isInteger(field) || field <= 0) {
			return c.json({ error: "invalid 'field' path parameter" }, 400);
		}
		const seed = Number(c.req.param("id"));
		if (!Number.isInteger(seed)) {
			return c.json({ error: "invalid seed id" }, 400);
		}
		const keys = Array.from({ length: SEED_DEPTH_MAX }, (_, i) => graphKey(field, seed, i + 1));
		await c.env.BUCKET_FIELD17.delete(keys);
		return c.json({ deleted: keys });
	})
	.get("/fields/:field/seed/:id", async (c) => {
	const resolved = resolveFieldDb(c.env, c.req.param("field"), c.req.query("yearRange"));
	if (!resolved.ok) {
		return c.json({ error: resolved.error }, resolved.status);
	}
	const { db: database, field, yearRange } = resolved;
	// 年代境界をまたぐ系譜を補完するため、隣接する年代レンジの DB も検索対象に含める（SPEC.md 4.4）。
	const adjacentDbs = listAdjacentDbs(c.env, field, yearRange);

	const seed = Number(c.req.param("id"));
	if (!Number.isInteger(seed)) {
		return c.json({ error: "invalid seed id" }, 400);
	}

	const depthParam = c.req.query("depth") ? Number(c.req.query("depth")) : SEED_DEPTH_DEFAULT;
	const minCitParam = c.req.query("minCit") ? Number(c.req.query("minCit")) : 0;

	if (!Number.isInteger(depthParam) || depthParam <= 0) {
		return c.json({ error: "invalid 'depth' parameter" }, 400);
	}
	if (!Number.isInteger(minCitParam) || minCitParam < 0) {
		return c.json({ error: "invalid 'minCit' parameter" }, 400);
	}
	const depth = Math.min(depthParam, SEED_DEPTH_MAX);

	const key = graphKey(field, seed, depth);
	const cached = await c.env.BUCKET_FIELD17.get(key);
	if (cached) {
		const graph = await cached.json();
		return c.json(graph, 200, { "Cache-Control": "public, max-age=604800", "X-Data-Source": "r2-cache" });
	}

	const graph = await buildSeedGraph(database, seed, depth, minCitParam, adjacentDbs);
	if (!graph) {
		return c.json({ error: "paper not found" }, 404);
	}

	// R2 生成を後追い（キューが未実装でも API 応答は継続できるよう失敗を無視しない形で分離）。
	await c.env.GRAPH_BUILD_QUEUE.send({ field, yearRange, seedId: seed, depth });

	return c.json(graph, 200, { "X-Data-Source": "d1-direct" });
});
