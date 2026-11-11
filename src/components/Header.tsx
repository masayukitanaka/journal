import type { FieldInfo } from "../api";

interface HeaderProps {
	isSample: boolean;
	availableFields: FieldInfo[];
	field: number;
	onFieldChange: (field: number) => void;
	yearRange: string | undefined;
	onYearRangeChange: (yearRange: string | undefined) => void;
}

// SPEC.md 6.1: ヘッダー（タイトル、注意書き（サンプル表示時）、凡例（ハブ・非ハブ）、分野・年代の切り替え）。
export function Header({ isSample, availableFields, field, onFieldChange, yearRange, onYearRangeChange }: HeaderProps) {
	const currentField = availableFields.find((f) => f.field === field);
	const yearRanges = currentField?.yearRanges ?? [];

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
			<h1 style={{ fontSize: 16, fontWeight: 650, margin: 0, letterSpacing: -0.2 }}>Citation Phylogeny</h1>

			<label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }} title="Switch the field (each field is backed by its own database)">
				<select
					className="ctl-select"
					value={field}
					onChange={(e) => {
						onFieldChange(Number(e.target.value));
						onYearRangeChange(undefined);
					}}
					disabled={availableFields.length === 0}
				>
					{availableFields.length === 0 ? (
						<option value={field}>{currentField?.name ?? `Field ${field}`}</option>
					) : (
						availableFields.map((f) => (
							<option key={f.field} value={f.field}>
								{f.name}
							</option>
						))
					)}
				</select>
			</label>

			{yearRanges.length > 0 && (
				<label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }} title="Switch the year range (each range is backed by its own database)">
					<select
						className="ctl-select"
						value={yearRange ?? yearRanges[0]}
						onChange={(e) => onYearRangeChange(e.target.value)}
					>
						{yearRanges.map((yr) => (
							<option key={yr} value={yr}>
								{yr}
							</option>
						))}
					</select>
				</label>
			)}

			{isSample && (
				<span style={{ fontSize: 12, color: "var(--warn-text)", background: "var(--warn-bg)", padding: "3px 10px", borderRadius: 999 }}>
					Showing sample data (API not connected)
				</span>
			)}
			<div style={{ display: "flex", alignItems: "center", gap: 12, marginLeft: "auto", fontSize: 12 }}>
				<Legend color="rgb(220, 38, 38)" label="Hub (many children)" />
				<Legend color="#9ca3af" label="Non-hub" />
				<span
					style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--muted-text)" }}
					title="The selected year range is highlighted; years outside it are shown plain — those papers are shown only for context"
				>
					<span style={{ width: 14, height: 10, background: "var(--lane-bg-main)", border: "1px solid var(--border-color)", display: "inline-block" }} />
					Selected range
				</span>
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
