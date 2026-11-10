import { Hono } from "hono";
import { topRoute } from "./api/top.js";
import { hubsRoute } from "./api/hubs.js";
import { seedRoute } from "./api/seed.js";
import { searchRoute } from "./api/search.js";
import { paperRoute } from "./api/paper.js";
import { attributionRoute } from "./api/attribution.js";
import { fieldsRoute } from "./api/fields.js";
import { buildSeedGraph, graphKey } from "./graph.js";
import { resolveDb } from "./db.js";

export { IngestWorkflow } from "./ingest-workflow.js";
export { RateLimiterOpenAlex, RateLimiterSemanticScholar } from "./rate-limiter.js";

const app = new Hono<{ Bindings: Env }>();

// :field は分野 ID（例: 17 = 計算機科学）。年代レンジは各ルート内で yearRange クエリパラメータとして受け取る
// （SPEC.md 4.4「分野 DB の結合ルール」、ARCHITECT.md 3.4.2、worker/db.ts の DB_REGISTRY 参照）。
// 各ルートは自身のフルパス（例: /fields/:field/top）を知っている必要があるため（Hono のサブルーター
// には親でマウントしたパスパラメータ名が型として伝播しないため）、/api 配下にそのままマウントする。
app.route("/api", topRoute);
app.route("/api", hubsRoute);
app.route("/api", seedRoute);
app.route("/api", searchRoute);
app.route("/api", paperRoute);
app.route("/api/fields", fieldsRoute);
app.route("/api/attribution", attributionRoute);

app.notFound((c) => c.json({ error: "not found" }, 404));
app.onError((err, c) => {
	console.error(err);
	return c.json({ error: "internal error" }, 503);
});

interface GraphBuildMessage {
	field: number;
	seedId: number;
	depth: number;
}

export default {
	fetch: app.fetch,
	// Graph Builder（ARCHITECT.md 3.2）。シード周辺グラフを R2 に事前構築する。
	async queue(batch, env) {
		for (const message of batch.messages) {
			const { field, seedId, depth } = message.body;
			const database = resolveDb(env, field);
			if (!database) {
				message.ack();
				continue;
			}
			const graph = await buildSeedGraph(database, seedId, depth, 0);
			if (graph) {
				await env.BUCKET_FIELD17.put(graphKey(field, seedId, depth), JSON.stringify(graph));
			}
			message.ack();
		}
	},
	// Cron Trigger（日次）から Ingest Workflow を起動する（ARCHITECT.md 3.1）。
	async scheduled(_controller, env) {
		await env.INGEST_WORKFLOW.create({ params: { maxPages: 250 } });
	},
} satisfies ExportedHandler<Env, GraphBuildMessage>;
