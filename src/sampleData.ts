import type { SeedGraph } from "./types";

// API 接続前・接続失敗時のフォールバック用の架空データ（SPEC.md 3章）。
// 実データのような分布（少数のハブ + 多数の非ハブ）を模す。
function generateSampleGraph(): SeedGraph {
	const nodes: SeedGraph["nodes"] = [];
	const edges: SeedGraph["edges"] = [];

	// y は year + (month-1)/12 の小数値（SPEC.md 4.4）。テスト用にランダムな月を付与する。
	function randomYearMonth(year: number): number {
		const month = Math.floor(Math.random() * 12);
		return year + month / 12;
	}

	nodes.push({ id: 1, y: randomYearMonth(2016), t: "Sample Paper A (seed)", c: 5000, k: 8 });

	let nextId = 2;
	const hubIds = [1];
	for (let year = 2017; year <= 2026; year++) {
		const hubsThisYear: number[] = [];
		for (let i = 0; i < 2; i++) {
			const id = nextId++;
			const childCount = Math.random() < 0.3 ? Math.floor(4 + Math.random() * 10) : Math.floor(Math.random() * 3);
			nodes.push({
				id,
				y: randomYearMonth(year),
				t: `Sample Paper ${id}`,
				c: Math.floor(100 + Math.random() * 3000 * (2027 - year) / 10),
				k: childCount,
			});
			const parent = hubIds[Math.floor(Math.random() * hubIds.length)];
			edges.push([parent, id]);
			if (childCount >= 4) hubsThisYear.push(id);
		}
		hubIds.push(...hubsThisYear);
	}

	return {
		seed: 1,
		field: 17,
		generatedAt: new Date().toISOString(),
		nodes,
		edges,
	};
}

export const SAMPLE_GRAPH = generateSampleGraph();
