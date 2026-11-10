import type { PaperDetail, PaperSummary, SeedGraph } from "./types";

const BASE = "/api/fields/17";

async function getJson<T>(url: string): Promise<T> {
	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(`request failed: ${res.status} ${url}`);
	}
	return res.json() as Promise<T>;
}

export function fetchTop(limit = 10): Promise<{ papers: PaperSummary[] }> {
	return getJson(`${BASE}/top?limit=${limit}`);
}

export function fetchHubs(minChild = 4, limit = 10): Promise<{ papers: PaperSummary[] }> {
	return getJson(`${BASE}/hubs?minChild=${minChild}&limit=${limit}`);
}

export function fetchSeedGraph(seedId: number, depth = 2, minCit = 0): Promise<SeedGraph> {
	return getJson(`${BASE}/seed/${seedId}?depth=${depth}&minCit=${minCit}`);
}

export function searchPapers(q: string, limit = 20): Promise<{ papers: PaperSummary[] }> {
	return getJson(`${BASE}/search?q=${encodeURIComponent(q)}&limit=${limit}`);
}

export function fetchPaper(id: number): Promise<PaperDetail> {
	return getJson(`${BASE}/paper/${id}`);
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
