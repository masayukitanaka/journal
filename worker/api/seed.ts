import { Hono } from "hono";
import { buildSeedGraph, graphKey } from "../graph.js";
import { SEED_DEPTH_DEFAULT, SEED_DEPTH_MAX } from "../constants.js";

// GET /api/fields/17/seed/{id} — シード周辺のグラフ（SPEC.md 5章）。
// R2 のキャッシュ済みグラフがあれば返し、無ければ D1 から直接計算して応答しつつ、
// Graph Build Queue へメッセージを送って R2 生成を後追いする（ARCHITECT.md 3.2, 4.3）。
export const seedRoute = new Hono<{ Bindings: Env }>().get("/:id", async (c) => {
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

	const key = graphKey(seed, depth);
	const cached = await c.env.BUCKET_FIELD17.get(key);
	if (cached) {
		const graph = await cached.json();
		return c.json(graph, 200, { "Cache-Control": "public, max-age=604800", "X-Data-Source": "r2-cache" });
	}

	const graph = await buildSeedGraph(c.env, seed, depth, minCitParam);
	if (!graph) {
		return c.json({ error: "paper not found" }, 404);
	}

	// R2 生成を後追い（キューが未実装でも API 応答は継続できるよう失敗を無視しない形で分離）。
	await c.env.GRAPH_BUILD_QUEUE.send({ seedId: seed, depth });

	return c.json(graph, 200, { "X-Data-Source": "d1-direct" });
});
