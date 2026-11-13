import type { PaperDetail, PaperSummary, SeedGraph } from "./types";

// 分野・年代の切り替え（worker/db.ts の DB_REGISTRY に対応）。
export interface FieldInfo {
	field: number;
	name: string;
	yearRanges: string[]; // "2016-2026" 形式
	defaultYearRange: string | null; // yearRange 未指定時に実際に使われるレンジ
}

async function getJson<T>(url: string, timeoutMs?: number): Promise<T> {
	const controller = timeoutMs !== undefined ? new AbortController() : undefined;
	const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
	try {
		const res = await fetch(url, controller ? { signal: controller.signal } : undefined);
		if (!res.ok) {
			throw new Error(`request failed: ${res.status} ${url}`);
		}
		return (await res.json()) as T;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

function withYearRange(url: string, yearRange?: string): string {
	if (!yearRange) return url;
	const sep = url.includes("?") ? "&" : "?";
	return `${url}${sep}yearRange=${encodeURIComponent(yearRange)}`;
}

export function fetchFields(): Promise<{ fields: FieldInfo[] }> {
	return getJson("/api/fields");
}

export function fetchTop(field: number, yearRange: string | undefined, limit = 10): Promise<{ papers: PaperSummary[] }> {
	return getJson(withYearRange(`/api/fields/${field}/top?limit=${limit}`, yearRange));
}

export function fetchHubs(
	field: number,
	yearRange: string | undefined,
	minChild = 4,
	limit = 10,
): Promise<{ papers: PaperSummary[] }> {
	return getJson(withYearRange(`/api/fields/${field}/hubs?minChild=${minChild}&limit=${limit}`, yearRange));
}

export function fetchSeedGraph(
	field: number,
	yearRange: string | undefined,
	seedId: number,
	depth = 2,
	minCit = 0,
	timeoutMs?: number,
): Promise<SeedGraph> {
	return getJson(withYearRange(`/api/fields/${field}/seed/${seedId}?depth=${depth}&minCit=${minCit}`, yearRange), timeoutMs);
}

export function searchPapers(
	field: number,
	yearRange: string | undefined,
	q: string,
	limit = 20,
): Promise<{ papers: PaperSummary[] }> {
	return getJson(withYearRange(`/api/fields/${field}/search?q=${encodeURIComponent(q)}&limit=${limit}`, yearRange));
}

export function fetchPaper(field: number, yearRange: string | undefined, id: number): Promise<PaperDetail> {
	return getJson(withYearRange(`/api/fields/${field}/paper/${id}`, yearRange));
}

export interface AttributionSource {
	name: string;
	url: string;
	license: string;
	note: string;
}

export function fetchAttribution(): Promise<{ sources: AttributionSource[] }> {
	return getJson("/api/attribution");
}
