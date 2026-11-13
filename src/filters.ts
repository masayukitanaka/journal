import type { GraphNode } from "./types";

// ハブ判定の基準（分岐数の下限）。SPEC.md 6.2: 既定 4。
// 当初は操作バーでユーザーが調整できたが、調整しても骨格のみ表示の絞り込みとツールチップの
// 「ハブ」ラベルにしか反映されず（円の色・大きさは分岐数の連続値のまま）、見た目が変わらないように
// 見えて分かりにくかったため、固定値に戻した（2026-11-10）。
export const HUB_MIN_CHILD_DEFAULT = 4;

export function isHub(node: GraphNode, hubMinChild: number = HUB_MIN_CHILD_DEFAULT): boolean {
	return node.k >= hubMinChild;
}

// シードから起点（親のいないノード）までの祖先の列を辿る（SPEC.md 2章「系譜」）。
// 複数祖先がある場合は被引用数最大の経路を 1 本選ぶ（PoC の簡易仕様、worker/api/paper.ts と同じ方針）。
export function resolveLineageIds(
	startId: number,
	nodes: GraphNode[],
	edges: [number, number][],
): Set<number> {
	const citById = new Map(nodes.map((n) => [n.id, n.c]));
	const ancestorsOf = new Map<number, number[]>();
	for (const [cited, citing] of edges) {
		if (!ancestorsOf.has(citing)) ancestorsOf.set(citing, []);
		ancestorsOf.get(citing)!.push(cited);
	}

	const lineage = new Set<number>([startId]);
	let current = startId;

	for (let depth = 0; depth < 50; depth++) {
		const ancestors = ancestorsOf.get(current);
		if (!ancestors || ancestors.length === 0) break;

		const next = ancestors.reduce((best, id) =>
			(citById.get(id) ?? 0) > (citById.get(best) ?? 0) ? id : best,
		);
		if (lineage.has(next)) break;
		lineage.add(next);
		current = next;
	}

	return lineage;
}

// 選択ノード自身 + 直接の親（1ホップ、cited 側）・直接の子（1ホップ、citing 側）。
// グラフのハイライト表示用（2026-11-12、ユーザー要望。resolveLineageIds が返す「被引用数最大の
// 1本の祖先経路」だけでは子孫方向が含まれず分かりにくいとの指摘を受けて追加。詳細パネルの表示対象
// （選択ノードのみ）とは独立した、ハイライト表示専用の集合）。
export function resolveDirectNeighborIds(selectedId: number, edges: [number, number][]): Set<number> {
	const result = new Set<number>([selectedId]);
	for (const [cited, citing] of edges) {
		if (citing === selectedId) result.add(cited);
		if (cited === selectedId) result.add(citing);
	}
	return result;
}

// フォーカス論文の祖先・子孫（系統）をすべて辿る（SPEC.md 6.3「この系統に集中」）。
export function resolveLineageSubtree(
	focusId: number,
	edges: [number, number][],
): Set<number> {
	const result = new Set<number>([focusId]);
	const ancestorsOf = new Map<number, number[]>();
	const descendantsOf = new Map<number, number[]>();
	for (const [cited, citing] of edges) {
		if (!ancestorsOf.has(citing)) ancestorsOf.set(citing, []);
		ancestorsOf.get(citing)!.push(cited);
		if (!descendantsOf.has(cited)) descendantsOf.set(cited, []);
		descendantsOf.get(cited)!.push(citing);
	}

	const queue = [focusId];
	while (queue.length > 0) {
		const current = queue.pop()!;
		for (const id of [...(ancestorsOf.get(current) ?? []), ...(descendantsOf.get(current) ?? [])]) {
			if (!result.has(id)) {
				result.add(id);
				queue.push(id);
			}
		}
	}
	return result;
}

// キーボードナビゲーション（GraphView）: ノードの親・子一覧を得る。
export function getParentIds(nodeId: number, edges: [number, number][]): number[] {
	return edges.filter(([, citing]) => citing === nodeId).map(([cited]) => cited);
}

export function getChildIds(nodeId: number, edges: [number, number][]): number[] {
	return edges.filter(([cited]) => cited === nodeId).map(([, citing]) => citing);
}

export interface SkeletonResult {
	hubIds: Set<number>;
	ancestorIds: Set<number>;
}

// SPEC.md 2章「骨格」: すべてのハブとその祖先だけからなる部分木。
export function resolveSkeleton(
	nodes: GraphNode[],
	edges: [number, number][],
	hubMinChild: number,
): SkeletonResult {
	const hubIds = new Set(nodes.filter((n) => isHub(n, hubMinChild)).map((n) => n.id));
	const ancestorsOf = new Map<number, number[]>();
	for (const [cited, citing] of edges) {
		if (!ancestorsOf.has(citing)) ancestorsOf.set(citing, []);
		ancestorsOf.get(citing)!.push(cited);
	}

	const ancestorIds = new Set<number>();
	for (const hubId of hubIds) {
		let queue = [hubId];
		while (queue.length > 0) {
			const current = queue.pop()!;
			for (const id of ancestorsOf.get(current) ?? []) {
				if (!ancestorIds.has(id) && !hubIds.has(id)) {
					ancestorIds.add(id);
					queue.push(id);
				}
			}
		}
	}

	return { hubIds, ancestorIds };
}
