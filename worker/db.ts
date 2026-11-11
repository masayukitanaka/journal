// D1 アクセスヘルパー（ARCHITECT.md 3.4, 3.4.2）。
// 分野・年代レンジごとに D1 データベースを分割する方針に従い、どの binding を使うかを
// このレジストリで一元管理する。新しい分野・年代レンジの DB を追加する手順:
//   1. `wrangler d1 create field{N}_{開始年}_{終了年}` で DB を作成する
//   2. wrangler.jsonc の d1_databases に binding（命名規則: DB_FIELD{N}_{開始年}_{終了年}）を追加する
//   3. `wrangler types` で worker-configuration.d.ts（Env 型）を再生成する
//   4. 下記 DB_REGISTRY に 1 行追加する
// 同一分野を複数の年代レンジに分割した場合、複数 DB を横断するクエリ（系譜追跡など）は
// SPEC.md 4.4「分野 DB の結合ルール」に従い UNION ALL で結合する（未実装、2026-11-10 時点ではレジストリ基盤のみ）。

export interface PaperRow {
	id: number;
	field: number;
	title: string;
	year: number;
	cit: number;
	fwci: number | null;
	subfield: number | null;
	child_cnt: number;
	doi: string | null;
}

export interface YearRange {
	start: number;
	end: number;
}

interface DbRegistryEntry {
	field: number;
	yearRange: YearRange;
	binding: keyof Env;
}

// 分野・年代レンジ → D1 binding 名の対応表。新しい DB を追加したらここに 1 行足す。
const DB_REGISTRY: DbRegistryEntry[] = [
	// 先頭が既定（yearRange 省略時）。旧方針の仮 DB。5 年単位 DB へのデータ投入・動作確認後に廃止する。
	{ field: 17, yearRange: { start: 2016, end: 2026 }, binding: "DB_FIELD17_2016_2026" },
	// 5 年単位の年代 DB（SPEC.md 4.3、ARCHITECT.md 3.4.2、2026-11-11 追加）
	{ field: 17, yearRange: { start: 2006, end: 2010 }, binding: "DB_FIELD17_2006_2010" },
	{ field: 17, yearRange: { start: 2011, end: 2015 }, binding: "DB_FIELD17_2011_2015" },
	{ field: 17, yearRange: { start: 2016, end: 2020 }, binding: "DB_FIELD17_2016_2020" },
	{ field: 17, yearRange: { start: 2021, end: 2025 }, binding: "DB_FIELD17_2021_2025" },
	{ field: 17, yearRange: { start: 2026, end: 2030 }, binding: "DB_FIELD17_2026_2030" },
];

export function listFields(): number[] {
	return [...new Set(DB_REGISTRY.map((e) => e.field))].sort((a, b) => a - b);
}

export function listYearRanges(field: number): YearRange[] {
	return DB_REGISTRY.filter((e) => e.field === field).map((e) => e.yearRange);
}

// "2016-2026" の形式の文字列を YearRange にパースする。
export function parseYearRange(value: string): YearRange | null {
	const match = /^(\d{4})-(\d{4})$/.exec(value);
	if (!match) return null;
	return { start: Number(match[1]), end: Number(match[2]) };
}

export function formatYearRange(range: YearRange): string {
	return `${range.start}-${range.end}`;
}

// 分野・年代レンジに対応する D1 データベースを返す。レジストリに無ければ null。
// yearRange 省略時は、その分野で登録されている最初の（通常は唯一の）レンジを使う。
export function resolveDb(env: Env, field: number, yearRange?: YearRange): D1Database | null {
	const entry = yearRange
		? DB_REGISTRY.find((e) => e.field === field && e.yearRange.start === yearRange.start && e.yearRange.end === yearRange.end)
		: DB_REGISTRY.find((e) => e.field === field);
	if (!entry) return null;
	return env[entry.binding] as D1Database;
}

// 後方互換用: 分野 17 のデフォルト DB（既存コードの db(env) 呼び出し箇所を段階的に置き換えるまでの橋渡し）。
export function db(env: Env): D1Database {
	const found = resolveDb(env, 17);
	if (!found) throw new Error("default D1 database (field 17) is not registered in DB_REGISTRY");
	return found;
}

export type ResolveFieldDbResult =
	| { ok: true; db: D1Database; field: number }
	| { ok: false; status: 400 | 404; error: string };

// API ルートの共通処理: パスパラメータ "field" を数値として検証し、対応する D1 を解決する。
// yearRange クエリパラメータ（"2016-2026" 形式）が指定されていれば、そのレンジの DB を探す。
export function resolveFieldDb(env: Env, fieldParam: string, yearRangeParam?: string): ResolveFieldDbResult {
	const field = Number(fieldParam);
	if (!Number.isInteger(field) || field <= 0) {
		return { ok: false, status: 400, error: "invalid 'field' path parameter" };
	}

	let yearRange: YearRange | undefined;
	if (yearRangeParam !== undefined) {
		const parsed = parseYearRange(yearRangeParam);
		if (!parsed) {
			return { ok: false, status: 400, error: "invalid 'yearRange' parameter (expected 'YYYY-YYYY')" };
		}
		yearRange = parsed;
	}

	const found = resolveDb(env, field, yearRange);
	if (!found) {
		return { ok: false, status: 404, error: `no database registered for field=${field}${yearRange ? ` yearRange=${formatYearRange(yearRange)}` : ""}` };
	}
	return { ok: true, db: found, field };
}
