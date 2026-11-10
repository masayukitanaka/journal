import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { fetchWorksPage, openAlexIdToNumber, type OpenAlexWork } from "./openalex-client.js";
import { FIELD_COMPUTER_SCIENCE } from "./constants.js";

// OpenAlex から分野 17・直近 10 年の論文を取り込む（ARCHITECT.md 3.1）。
// PoC では被引用上位 N 件（既定 50,000 件 = 200件 × 250ページ）に絞る。

const FIELD = FIELD_COMPUTER_SCIENCE;
const FROM_DATE = "2016-01-01";
const TO_DATE = "2026-12-31";
const PER_PAGE = 200;
const MAX_PAGES = 250;
const RAW_PREFIX = "raw/openalex/field17";

interface IngestWorkflowParams {
	maxPages?: number;
}

export class IngestWorkflow extends WorkflowEntrypoint<Env, IngestWorkflowParams> {
	async run(event: Readonly<WorkflowEvent<IngestWorkflowParams>>, step: WorkflowStep) {
		const maxPages = event.payload?.maxPages ?? MAX_PAGES;

		let cursor = "*";
		let pageCount = 0;
		let totalPapers = 0;

		while (cursor && pageCount < maxPages) {
			const pageIndex = pageCount;
			const result: { nextCursor: string | null; paperCount: number } = await step.do(
				`fetch-and-store-page-${pageIndex}`,
				async () => {
					const page = await fetchWorksPage(this.env, {
						field: FIELD,
						fromDate: FROM_DATE,
						toDate: TO_DATE,
						cursor,
						perPage: PER_PAGE,
					});

					await this.env.BUCKET_FIELD17.put(
						`${RAW_PREFIX}/page-${String(pageIndex).padStart(5, "0")}.json`,
						JSON.stringify(page),
					);

					await upsertPapers(this.env, page.results);

					return { nextCursor: page.meta.next_cursor, paperCount: page.results.length };
				},
			);

			cursor = result.nextCursor ?? "";
			pageCount++;
			totalPapers += result.paperCount;
		}

		await step.do("upsert-edges", async () => {
			await upsertEdgesFromRaw(this.env, pageCount);
		});

		await step.do("recompute-child-cnt", async () => {
			await recomputeChildCnt(this.env);
		});

		return { pagesIngested: pageCount, papersIngested: totalPapers };
	}
}

// year + (month-1)/12 の小数値にして、月単位の精度で X 軸に配置できるようにする（レーン表示用）。
// publication_date が欠損している場合、論文 ID から決定的に月を割り当てる（実データ再取り込み前提の暫定処置）。
function yearWithMonth(work: OpenAlexWork, id: number): number {
	const month = work.publication_date
		? Number(work.publication_date.slice(5, 7))
		: (id % 12) + 1;
	return work.publication_year + (month - 1) / 12;
}

async function upsertPapers(env: Env, works: OpenAlexWork[]): Promise<void> {
	if (works.length === 0) return;

	const statements = works.map((work) => {
		const id = openAlexIdToNumber(work.id);
		const subfieldId = work.primary_topic?.subfield?.id
			? extractNumericId(work.primary_topic.subfield.id)
			: null;

		return env.DB_FIELD17_2016_2026.prepare(
			`INSERT INTO papers (id, field, title, year, cit, fwci, subfield, child_cnt, doi)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
			 ON CONFLICT (id) DO UPDATE SET
			   title = excluded.title,
			   year = excluded.year,
			   cit = excluded.cit,
			   fwci = excluded.fwci,
			   subfield = excluded.subfield,
			   doi = excluded.doi`,
		).bind(
			id,
			FIELD,
			work.title ?? "(no title)",
			yearWithMonth(work, id),
			work.cited_by_count,
			work.fwci,
			subfieldId,
			work.doi,
		);
	});

	await env.DB_FIELD17_2016_2026.batch(statements);
}

// ページ処理完了後、R2 に保存した生データを読み直し、cited 側が papers に存在するエッジのみ投入する（ARCHITECT.md 3.1）。
async function upsertEdgesFromRaw(env: Env, pageCount: number): Promise<void> {
	const existingIds = await loadExistingPaperIds(env);

	for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
		const key = `${RAW_PREFIX}/page-${String(pageIndex).padStart(5, "0")}.json`;
		const object = await env.BUCKET_FIELD17.get(key);
		if (!object) continue;

		const page: { results: OpenAlexWork[] } = await object.json();
		const statements = [];

		for (const work of page.results) {
			const citing = openAlexIdToNumber(work.id);
			for (const refUrl of work.referenced_works) {
				const cited = openAlexIdToNumber(refUrl);
				if (!existingIds.has(cited)) continue;
				statements.push(
					env.DB_FIELD17_2016_2026.prepare(
						"INSERT INTO edges (cited, citing) VALUES (?, ?) ON CONFLICT (cited, citing) DO NOTHING",
					).bind(cited, citing),
				);
			}
		}

		await batchInChunks(env, statements);
	}
}

// D1 batch() の 1 回あたりの文数に明示的な上限は公式ドキュメントに記載がないため、
// 安全のため一定サイズごとに分割して投入する。
const BATCH_CHUNK_SIZE = 500;

async function batchInChunks(env: Env, statements: D1PreparedStatement[]): Promise<void> {
	for (let i = 0; i < statements.length; i += BATCH_CHUNK_SIZE) {
		const chunk = statements.slice(i, i + BATCH_CHUNK_SIZE);
		if (chunk.length > 0) {
			await env.DB_FIELD17_2016_2026.batch(chunk);
		}
	}
}

// N = 50,000 件規模なら id だけの一括取得でも D1 のクエリ結果上限（50MB）に十分収まる。
async function loadExistingPaperIds(env: Env): Promise<Set<number>> {
	const { results } = await env.DB_FIELD17_2016_2026.prepare("SELECT id FROM papers").all<{
		id: number;
	}>();
	return new Set(results.map((row) => row.id));
}

async function recomputeChildCnt(env: Env): Promise<void> {
	await env.DB_FIELD17_2016_2026.prepare(
		`UPDATE papers SET child_cnt = (
			SELECT COUNT(*) FROM edges WHERE edges.cited = papers.id
		)`,
	).run();
}

function extractNumericId(url: string): number {
	const match = /\/(\d+)$/.exec(url);
	return match ? Number(match[1]) : 0;
}
