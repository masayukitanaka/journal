import { useCallback, useEffect, useMemo, useState } from "react";
import "./App.css";
import { Header } from "./components/Header";
import { OperationBar } from "./components/OperationBar";
import { GraphView } from "./components/GraphView";
import { SidePanel } from "./components/SidePanel";
import { fetchFields, fetchHubs, fetchPaper, fetchSeedGraph, fetchTop, type FieldInfo } from "./api";
import { HUB_MIN_CHILD_DEFAULT, resolveDirectNeighborIds, resolveLineageIds, resolveLineageSubtree, resolveSkeleton } from "./filters";
import { SAMPLE_GRAPH } from "./sampleData";
import type { GraphNode, KeywordInfo, PaperSummary, SeedGraph } from "./types";

const TOP_CITED_SEED_FALLBACK = 2194775991; // Deep Residual Learning（被引用 1 位、2026-11 時点）
const DEFAULT_FIELD = 17; // 計算機科学（SPEC.md 4.2）
// 初期表示のシードグラフ取得のタイムアウト（2026-11-12、docs/optimizing.md 2.2）。
// 超高被引用論文がデフォルトシードになった場合に D1 のレート制限で応答が数十秒〜振れることがあるため、
// 「メインページ・年代切り替え時の表示は遅くても10秒以内」の目標を確実に守るためのフロント側の安全弁。
const SEED_FETCH_TIMEOUT_MS = 8000;

function App() {
	const [graph, setGraph] = useState<SeedGraph>(SAMPLE_GRAPH);
	const [isSample, setIsSample] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);
	// 分野・年代の切り替え時、top/hubs/シードグラフの再取得が終わるまでの読み込み中フラグ
	// （2026-11-11。切り替え後にグラフが切り替わるまで数秒かかることがあり、何も起きていないように
	// 見えて分かりにくいとのユーザー指摘を受けて追加。グラフ表示エリアにスピナーを重ねる）。
	const [isLoadingGraph, setIsLoadingGraph] = useState(false);

	// 分野・年代の切り替え（D1 を分野・年代レンジで分割する方針、ARCHITECT.md 3.4.2 に対応）。
	// 選択肢自体は /api/fields から取得する（worker/db.ts の DB_REGISTRY が真実の情報源）。
	const [availableFields, setAvailableFields] = useState<FieldInfo[]>([]);
	const [field, setField] = useState<number>(DEFAULT_FIELD);
	const [yearRange, setYearRange] = useState<string | undefined>(undefined);

	const [topPapers, setTopPapers] = useState<PaperSummary[]>([]);
	const [hubPapers, setHubPapers] = useState<PaperSummary[]>([]);

	const [displayLimit, setDisplayLimit] = useState<number>(500);
	const [skeletonOnly, setSkeletonOnly] = useState(false);

	const [selectedId, setSelectedId] = useState<number | null>(null);
	const [focusId, setFocusId] = useState<number | null>(null);
	const [collapsedIds, setCollapsedIds] = useState<Set<number>>(new Set());
	const [lineage, setLineage] = useState<PaperSummary[]>([]);
	// 選択中論文の詳細（doi 等、GraphNode には持たせていない情報。/api/.../paper/{id} から取得）。
	const [selectedPaper, setSelectedPaper] = useState<PaperSummary | null>(null);
	// 選択中論文の著者・キーワード（2026-11-11、SPEC.md 4.4。authorships/keywords テーブルから取得）。
	const [selectedAuthors, setSelectedAuthors] = useState<string[]>([]);
	const [selectedKeywords, setSelectedKeywords] = useState<KeywordInfo[]>([]);
	// 選択中論文の詳細（fetchPaper）の取得中・失敗状態。本番 D1 への重いクエリがタイムアウト・一時エラーに
	// なることがあり、何も表示されないまま待たされると分かりにくいとのユーザー指摘を受けて追加（2026-11-12）。
	const [isLoadingDetail, setIsLoadingDetail] = useState(false);
	const [detailError, setDetailError] = useState(false);
	// サイドパネルはデフォルト非表示。論文選択時に自動で開く、または手動トグルで開閉する（表示エリアを広く保つため）。
	const [panelOpen, setPanelOpen] = useState(false);
	// 検索結果・top/hubs 一覧からの選択時に、GraphView へ「このノードへパン・ズームを強制的に合わせ直せ」と
	// 伝えるためのリクエスト番号。選択するたびにインクリメントする（2026-11-11、別グラフに切り替わった後も
	// 直前の transform が残り、選択ノードが画面外・極端なスケールで見えなくなるバグの修正）。
	const [viewFocusRequestId, setViewFocusRequestId] = useState(0);

	// 利用可能な分野・年代レンジの一覧を取得する（Header のセレクトボックス用）。失敗しても致命的ではない
	// （DEFAULT_FIELD・yearRange 未指定のまま動作を続けられる）。
	// yearRange はここで明示的に defaultYearRange をセットする。未指定（undefined）のままだと、実際に
	// 読み込まれるデータ（API 側の既定レンジ）とドロップダウンの表示（選択肢の先頭）が食い違うため
	// （2026-11-11、ユーザー指摘により修正）。
	useEffect(() => {
		let cancelled = false;
		fetchFields()
			.then((res) => {
				if (cancelled) return;
				setAvailableFields(res.fields);
				const defaultField = res.fields.find((f) => f.field === DEFAULT_FIELD);
				if (defaultField?.defaultYearRange) {
					setYearRange(defaultField.defaultYearRange);
				}
			})
			.catch(() => {
				/* セレクトボックスの選択肢が増えないだけなので致命的ではない */
			});
		return () => {
			cancelled = true;
		};
	}, []);

	// SPEC.md 10章 P3: フロントエンドを実データに接続。失敗時はサンプルデータのまま表示を継続する（SPEC.md 7章「障害時」）。
	// 分野・年代を切り替えた場合もここで再読み込みする。別 DB のデータに切り替わるため、
	// 古い選択・フォーカス・折りたたみ状態は意味を持たなくなるのでリセットする。
	useEffect(() => {
		let cancelled = false;
		setSelectedId(null);
		setFocusId(null);
		setCollapsedIds(new Set());
		setLineage([]);
		setSelectedPaper(null);
		setIsLoadingGraph(true);

		async function load() {
			try {
				const [topRes, hubsRes] = await Promise.all([
					fetchTop(field, yearRange, 10),
					fetchHubs(field, yearRange, HUB_MIN_CHILD_DEFAULT, 10),
				]);
				if (cancelled) return;
				setTopPapers(topRes.papers);
				setHubPapers(hubsRes.papers);

				const seedId = topRes.papers[0]?.id ?? TOP_CITED_SEED_FALLBACK;
				// 初期表示は depth=1 + タイムアウト（2026-11-12、パフォーマンス改善。docs/optimizing.md 2.2
				// 「未解決の既知の制約」）。depth=2 だと、年代によってはデフォルトシードが超高被引用のハブ論文
				// （例: field17_2006_2010 の ImageNet、直接の子44,573件）になり、D1のレート制限に抵触して
				// 初期表示が10秒を大きく超えることを実測で確認した（24.8秒）。depth=1 でも一部の年代
				// （例: field17_2011_2015、Top cited 上位が軒並み数万件規模の子を持つ）では D1 のレート制限
				// による不安定性が残り、7〜93秒まで振れることを確認したため、SEED_FETCH_TIMEOUT_MS で
				// 確実に打ち切り、タイムアウト時はサンプルデータ表示にフォールバックする。
				const seedGraph = await fetchSeedGraph(field, yearRange, seedId, 1, 0, SEED_FETCH_TIMEOUT_MS);
				if (cancelled) return;

				setGraph(seedGraph);
				setIsSample(false);
				setLoadError(null);
			} catch (err) {
				if (!cancelled) {
					const isTimeout = err instanceof DOMException && err.name === "AbortError";
					// タイムアウト・失敗時は前の年代のグラフを表示し続けると誤解を招くため、
					// サンプルデータ表示に明示的に戻す（2026-11-12）。
					setGraph(SAMPLE_GRAPH);
					setIsSample(true);
					setLoadError(
						isTimeout
							? `seed graph request timed out after ${SEED_FETCH_TIMEOUT_MS / 1000}s`
							: err instanceof Error
								? err.message
								: String(err),
					);
				}
			} finally {
				if (!cancelled) setIsLoadingGraph(false);
			}
		}

		load();
		return () => {
			cancelled = true;
		};
	}, [field, yearRange]);

	// SPEC.md 6.3: 表示の絞り込みルール。
	const visibleNodes = useMemo<GraphNode[]>(() => {
		let candidates = graph.nodes;

		if (focusId !== null) {
			const subtreeIds = resolveLineageSubtree(focusId, graph.edges);
			candidates = candidates.filter((n) => subtreeIds.has(n.id));
		} else if (skeletonOnly) {
			const { hubIds, ancestorIds } = resolveSkeleton(candidates, graph.edges, HUB_MIN_CHILD_DEFAULT);
			const selectedLineageIds = selectedId !== null ? resolveLineageIds(selectedId, candidates, graph.edges) : new Set<number>();
			candidates = candidates.filter((n) => hubIds.has(n.id) || ancestorIds.has(n.id) || selectedLineageIds.has(n.id));
		} else {
			candidates = [...candidates].sort((a, b) => b.c - a.c).slice(0, displayLimit);
		}

		// 折りたたまれた祖先の子孫を除外する（SPEC.md 6.3 条件4、6.4「子を折りたたむ」）。
		if (collapsedIds.size > 0) {
			const hiddenDescendants = new Set<number>();
			const descendantsOf = new Map<number, number[]>();
			for (const [cited, citing] of graph.edges) {
				if (!descendantsOf.has(cited)) descendantsOf.set(cited, []);
				descendantsOf.get(cited)!.push(citing);
			}
			for (const collapsedId of collapsedIds) {
				const queue = [...(descendantsOf.get(collapsedId) ?? [])];
				while (queue.length > 0) {
					const current = queue.pop()!;
					if (!hiddenDescendants.has(current)) {
						hiddenDescendants.add(current);
						queue.push(...(descendantsOf.get(current) ?? []));
					}
				}
			}
			candidates = candidates.filter((n) => !hiddenDescendants.has(n.id));
		}

		return candidates;
	}, [graph, displayLimit, skeletonOnly, focusId, collapsedIds, selectedId]);

	const visibleIds = useMemo(() => new Set(visibleNodes.map((n) => n.id)), [visibleNodes]);
	const visibleEdges = useMemo(
		() => graph.edges.filter(([cited, citing]) => visibleIds.has(cited) && visibleIds.has(citing)),
		[graph.edges, visibleIds],
	);

	// キーボードナビゲーションが表示件数などの絞り込み範囲外へ出た場合に備え、グラフ全体も GraphView に渡す。
	const allNodesById = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph.nodes]);

	// グラフ上のハイライト対象: 選択ノード自身 + 直接の親・子（1ホップ）。詳細パネルの表示対象
	// （選択ノードのみ）とは別で、ハイライト表示だけ親子も含めるようユーザーが要望（2026-11-12）。
	const lineageIds = useMemo(
		() => (selectedId !== null ? resolveDirectNeighborIds(selectedId, graph.edges) : new Set<number>()),
		[selectedId, graph],
	);

	// "2016-2020" 形式の yearRange を GraphView のレーン背景色分け用に {start, end} へパースする
	// （2026-11-11、SPEC.md 4.4。未選択時は undefined のままで全レーンがメイン扱いになる）。
	const mainYearRange = useMemo(() => {
		if (!yearRange) return undefined;
		const match = /^(\d{4})-(\d{4})$/.exec(yearRange);
		if (!match) return undefined;
		return { start: Number(match[1]), end: Number(match[2]) };
	}, [yearRange]);

	const selectedNode = useMemo(
		() => (selectedId !== null ? graph.nodes.find((n) => n.id === selectedId) ?? null : null),
		[selectedId, graph],
	);

	// SPEC.md 6.4: 円をクリック→論文を選択、系譜を強調、祖先の折りたたみを解除。
	const handleSelect = useCallback(
		async (id: number) => {
			setSelectedId(id);
			setPanelOpen(true);
			setCollapsedIds((prev) => {
				const next = new Set(prev);
				next.delete(id);
				return next;
			});

			if (!isSample) {
				setIsLoadingDetail(true);
				setDetailError(false);
				try {
					const detail = await fetchPaper(field, yearRange, id);
					setLineage(detail.lineage);
					setSelectedPaper(detail.paper);
					setSelectedAuthors(detail.authors);
					setSelectedKeywords(detail.keywords);
				} catch {
					setLineage([]);
					setSelectedPaper(null);
					setSelectedAuthors([]);
					setSelectedKeywords([]);
					setDetailError(true);
				} finally {
					setIsLoadingDetail(false);
				}
			} else {
				setSelectedPaper(null);
				setSelectedAuthors([]);
				setSelectedKeywords([]);
			}
		},
		[isSample, field, yearRange],
	);

	const handleDeselect = useCallback(() => {
		setSelectedId(null);
		setLineage([]);
		setSelectedPaper(null);
		setSelectedAuthors([]);
		setSelectedKeywords([]);
		setIsLoadingDetail(false);
		setDetailError(false);
	}, []);

	const handleResetView = useCallback(() => {
		setFocusId(null);
		setSelectedId(null);
		setLineage([]);
	}, []);

	const handleFocusLineage = useCallback(() => {
		if (selectedId === null) return;
		setFocusId(selectedId);
		setDisplayLimit(graph.nodes.length);
	}, [selectedId, graph.nodes.length]);

	const handleToggleCollapseDescendants = useCallback(() => {
		if (selectedId === null) return;
		setCollapsedIds((prev) => {
			const next = new Set(prev);
			if (next.has(selectedId)) next.delete(selectedId);
			else next.add(selectedId);
			return next;
		});
	}, [selectedId]);

	// top/hubs/検索結果は現在のグラフ範囲外の場合がある。その場合はそのシードで新たにグラフを読み込む。
	// いずれの場合も、選択後に GraphView 側のパン・ズームを選択ノードへ強制的に合わせ直す
	// （2026-11-11。一覧からの選択はマウスクリックの通常選択と違い、現在の画面外・別の年代レンジだった
	// 可能性があるため、直前の transform のままだとノードが見えない・極端に縮小されたままになるバグがあった）。
	const handleSelectFromList = useCallback(
		async (id: number) => {
			const node = graph.nodes.find((n) => n.id === id);
			if (node) {
				handleSelect(id);
				setViewFocusRequestId((n) => n + 1);
				return;
			}
			if (isSample) return;
			try {
				const seedGraph = await fetchSeedGraph(field, yearRange, id, 2);
				setGraph(seedGraph);
				setFocusId(null);
				setCollapsedIds(new Set());
				await handleSelect(id);
				setViewFocusRequestId((n) => n + 1);
			} catch (err) {
				setLoadError(err instanceof Error ? err.message : String(err));
			}
		},
		[graph, handleSelect, isSample, field, yearRange],
	);

	return (
		<div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
			<Header
				isSample={isSample}
				availableFields={availableFields}
				field={field}
				onFieldChange={setField}
				yearRange={yearRange}
				onYearRangeChange={setYearRange}
			/>
			{loadError && (
				<div
					style={{
						padding: "6px 16px",
						fontSize: 12,
						color: "var(--warn-text)",
						background: "var(--warn-bg)",
					}}
				>
					Failed to fetch from the API, showing sample data instead ({loadError})
				</div>
			)}
			<OperationBar
				displayLimit={displayLimit}
				onDisplayLimitChange={setDisplayLimit}
				skeletonOnly={skeletonOnly}
				onSkeletonOnlyChange={setSkeletonOnly}
				onResetView={handleResetView}
				isFocused={focusId !== null}
				panelOpen={panelOpen}
				onTogglePanel={() => setPanelOpen((v) => !v)}
			/>
			<div style={{ display: "flex", flex: 1, minHeight: 0 }}>
				<main style={{ flex: 1, minWidth: 0, position: "relative" }}>
					<GraphView
						nodes={visibleNodes}
						edges={visibleEdges}
						allNodesById={allNodesById}
						allEdges={graph.edges}
						selectedId={selectedId}
						lineageIds={lineageIds}
						onSelect={handleSelect}
						onDeselect={handleDeselect}
						mainYearRange={mainYearRange}
						focusRequestId={viewFocusRequestId}
					/>
					{isLoadingGraph && (
						<div
							style={{
								position: "absolute",
								inset: 0,
								display: "flex",
								flexDirection: "column",
								alignItems: "center",
								justifyContent: "center",
								gap: 12,
								background: "var(--graph-bg)",
								opacity: 0.85,
							}}
						>
							<div className="loading-spinner" />
							<div style={{ fontSize: 13, color: "var(--muted-text)" }}>Loading...</div>
						</div>
					)}
				</main>
				{panelOpen && (
					<SidePanel
						selectedNode={selectedNode}
						selectedPaper={selectedPaper}
						selectedAuthors={selectedAuthors}
						selectedKeywords={selectedKeywords}
						isLoadingDetail={isLoadingDetail}
						detailError={detailError}
						lineage={lineage}
						topPapers={topPapers}
						hubPapers={hubPapers}
						collapsedDescendants={selectedId !== null && collapsedIds.has(selectedId)}
						onToggleCollapseDescendants={handleToggleCollapseDescendants}
						onFocusLineage={handleFocusLineage}
						onDeselect={handleDeselect}
						onSelectPaperId={handleSelectFromList}
						searchEnabled={!isSample}
						onClose={() => setPanelOpen(false)}
						field={field}
						yearRange={yearRange}
					/>
				)}
			</div>
		</div>
	);
}

export default App;
