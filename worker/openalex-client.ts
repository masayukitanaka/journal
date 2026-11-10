// OpenAlex API クライアント（ARCHITECT.md 3.1, 3.3）。
// Rate Limiter DO で呼び出しを直列化し、429 応答時はバックオフを延長してリトライする。

const OPENALEX_BASE_URL = "https://api.openalex.org/works";
const RATE_LIMITER_ID = "singleton";

export interface OpenAlexWork {
	id: string;
	title: string | null;
	publication_year: number;
	publication_date: string | null; // "YYYY-MM-DD"
	cited_by_count: number;
	fwci: number | null;
	doi: string | null; // 例: "https://doi.org/10.1109/..."
	primary_topic: {
		field: { id: string; display_name: string };
		subfield: { id: string; display_name: string } | null;
	} | null;
	referenced_works: string[];
}

export interface OpenAlexWorksPage {
	results: OpenAlexWork[];
	meta: { count: number; next_cursor: string | null };
}

// https://openalex.org/W2194775991 → 2194775991
export function openAlexIdToNumber(url: string): number {
	const match = /W(\d+)$/.exec(url);
	if (!match) {
		throw new Error(`Unexpected OpenAlex ID format: ${url}`);
	}
	return Number(match[1]);
}

async function sleep(ms: number): Promise<void> {
	if (ms <= 0) return;
	await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchWorksPage(
	env: Env,
	params: { field: number; fromDate: string; toDate: string; cursor: string; perPage?: number },
): Promise<OpenAlexWorksPage> {
	const limiter = env.RATE_LIMITER_OPENALEX.get(env.RATE_LIMITER_OPENALEX.idFromName(RATE_LIMITER_ID));

	const url = new URL(OPENALEX_BASE_URL);
	url.searchParams.set(
		"filter",
		`primary_topic.field.id:${params.field},from_publication_date:${params.fromDate},to_publication_date:${params.toDate}`,
	);
	url.searchParams.set("per_page", String(params.perPage ?? 200));
	url.searchParams.set("cursor", params.cursor);
	url.searchParams.set("api_key", env.OPENALEX_API_KEY);

	const maxRetries = 3;
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		const { waitMs } = await limiter.reserve();
		await sleep(waitMs);

		const response = await fetch(url);

		if (response.status === 429) {
			const retryAfterSec = Number(response.headers.get("retry-after") ?? "5");
			await limiter.extendBackoff(retryAfterSec * 1000);
			if (attempt === maxRetries) {
				throw new Error(`OpenAlex rate limited after ${maxRetries} retries`);
			}
			continue;
		}

		if (!response.ok) {
			throw new Error(`OpenAlex request failed: ${response.status} ${await response.text()}`);
		}

		return response.json() as Promise<OpenAlexWorksPage>;
	}

	throw new Error("unreachable");
}
