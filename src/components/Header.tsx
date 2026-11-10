interface HeaderProps {
	isSample: boolean;
}

// SPEC.md 6.1: ヘッダー（タイトル、注意書き（サンプル表示時）、凡例（ハブ・非ハブ）。
export function Header({ isSample }: HeaderProps) {
	return (
		<header
			style={{
				display: "flex",
				alignItems: "center",
				gap: 16,
				padding: "12px 16px",
				borderBottom: "1px solid var(--border-color)",
				flexWrap: "wrap",
				background: "var(--surface)",
			}}
		>
			<h1 style={{ fontSize: 16, fontWeight: 650, margin: 0, letterSpacing: -0.2 }}>Citation Phylogeny — Computer Science</h1>
			{isSample && (
				<span style={{ fontSize: 12, color: "var(--warn-text)", background: "var(--warn-bg)", padding: "3px 10px", borderRadius: 999 }}>
					Showing sample data (API not connected)
				</span>
			)}
			<div style={{ display: "flex", alignItems: "center", gap: 12, marginLeft: "auto", fontSize: 12 }}>
				<Legend color="rgb(220, 38, 38)" label="Hub (many children)" />
				<Legend color="#9ca3af" label="Non-hub" />
			</div>
			{/* SPEC.md 7章「帰属表示」: 利用データの出典（OpenAlex、Semantic Scholar）を画面に表示する。 */}
			<span style={{ fontSize: 11, color: "var(--muted-text)", width: "100%" }}>
				Data source:{" "}
				<a href="https://openalex.org" target="_blank" rel="noreferrer" style={{ color: "inherit" }}>
					OpenAlex
				</a>{" "}
				(CC0)
			</span>
		</header>
	);
}

function Legend({ color, label }: { color: string; label: string }) {
	return (
		<span style={{ display: "flex", alignItems: "center", gap: 6 }}>
			<span style={{ width: 10, height: 10, borderRadius: "50%", background: color, display: "inline-block" }} />
			{label}
		</span>
	);
}
