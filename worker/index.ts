import { Hono } from "hono";
import { topRoute } from "./api/top.js";
import { hubsRoute } from "./api/hubs.js";
import { seedRoute } from "./api/seed.js";
import { searchRoute } from "./api/search.js";
import { paperRoute } from "./api/paper.js";
import { attributionRoute } from "./api/attribution.js";
import { buildSeedGraph, graphKey } from "./graph.js";

export { IngestWorkflow } from "./ingest-workflow.js";
export { RateLimiterOpenAlex, RateLimiterSemanticScholar } from "./rate-limiter.js";

const app = new Hono<{ Bindings: Env }>();

app.route("/api/fields/17/top", topRoute);
app.route("/api/fields/17/hubs", hubsRoute);
app.route("/api/fields/17/seed", seedRoute);
app.route("/api/fields/17/search", searchRoute);
app.route("/api/fields/17/paper", paperRoute);
app.route("/api/attribution", attributionRoute);

app.notFound((c) => c.json({ error: "not found" }, 404));
app.onError((err, c) => {
	console.error(err);
	return c.json({ error: "internal error" }, 503);
});

interface GraphBuildMessage {
	seedId: number;
	depth: number;
}

export default {
	fetch: app.fetch,
	// Graph Builder（ARCHITECT.md 3.2）。シード周辺グラフを R2 に事前構築する。
	async queue(batch, env) {
		for (const message of batch.messages) {
			const { seedId, depth } = message.body;
			const graph = await buildSeedGraph(env, seedId, depth, 0);
			if (graph) {
				await env.BUCKET_FIELD17.put(graphKey(seedId, depth), JSON.stringify(graph));
			}
			message.ack();
		}
	},
	// Cron Trigger（日次）から Ingest Workflow を起動する（ARCHITECT.md 3.1）。
	async scheduled(_controller, env) {
		await env.INGEST_WORKFLOW.create({ params: { maxPages: 250 } });
	},
} satisfies ExportedHandler<Env, GraphBuildMessage>;
