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
// 先頭に書いたエントリが、yearRange 未指定時のその分野の既定値になる（resolveDb 参照）。
// field17_2021_2025 を既定にする（2026-11-11、S3 ingest で実データが投入済み。実データの無い
// 旧 DB field17_2016_2026 は wrangler.jsonc の binding は残すがレジストリからは外してある）。
const DB_REGISTRY: DbRegistryEntry[] = [
	// 5 年単位の年代 DB（SPEC.md 4.3、ARCHITECT.md 3.4.2、2026-11-11 作成）。先頭の field17_2021_2025 が
	// 既定（yearRange 省略時）。旧方針の仮 DB（field17_2016_2026）は実データ投入・動作確認後に廃止済みで、
	// wrangler.jsonc の binding は残すがこのレジストリからは外してある。
	{ field: 17, yearRange: { start: 2021, end: 2025 }, binding: "DB_FIELD17_2021_2025" },
	{ field: 17, yearRange: { start: 2006, end: 2010 }, binding: "DB_FIELD17_2006_2010" },
	{ field: 17, yearRange: { start: 2011, end: 2015 }, binding: "DB_FIELD17_2011_2015" },
	{ field: 17, yearRange: { start: 2016, end: 2020 }, binding: "DB_FIELD17_2016_2020" },
	{ field: 17, yearRange: { start: 2026, end: 2030 }, binding: "DB_FIELD17_2026_2030" },
];

export function listFields(): number[] {
	return [...new Set(DB_REGISTRY.map((e) => e.field))].sort((a, b) => a - b);
}

// 年代順（開始年の昇順）に並べて返す。DB_REGISTRY 自体の並び順は「既定値（先頭）が分かりやすい」
// ことを優先しているため登録順はバラバラだが、UI の選択肢は年代順の方が分かりやすい（2026-11-11）。
export function listYearRanges(field: number): YearRange[] {
	return DB_REGISTRY.filter((e) => e.field === field)
		.map((e) => e.yearRange)
		.sort((a, b) => a.start - b.start);
}

// yearRange 未指定時に実際に使われる既定レンジ（DB_REGISTRY のその分野の先頭エントリ）。
// フロントの初期表示でドロップダウンを実際に読み込んだデータと一致させるために使う
// （2026-11-11、/api/fields のレスポンスに含める）。
export function listDefaultYearRange(field: number): YearRange | null {
	return DB_REGISTRY.find((e) => e.field === field)?.yearRange ?? null;
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

// 分野・年代レンジに対応するレジストリのエントリを返す（yearRange も含む。null はレジストリに無い場合）。
// yearRange 省略時は、その分野で登録されている最初の（通常は唯一の）レンジを使う。
function resolveDbEntry(field: number, yearRange?: YearRange): DbRegistryEntry | null {
	return (
		(yearRange
			? DB_REGISTRY.find((e) => e.field === field && e.yearRange.start === yearRange.start && e.yearRange.end === yearRange.end)
			: DB_REGISTRY.find((e) => e.field === field)) ?? null
	);
}

// 分野・年代レンジに対応する D1 データベースを返す。レジストリに無ければ null。
// yearRange 省略時は、その分野で登録されている最初の（通常は唯一の）レンジを使う。
export function resolveDb(env: Env, field: number, yearRange?: YearRange): D1Database | null {
	const entry = resolveDbEntry(field, yearRange);
	if (!entry) return null;
	return env[entry.binding] as D1Database;
}

// 後方互換用: 分野 17 のデフォルト DB（既存コードの db(env) 呼び出し箇所を段階的に置き換えるまでの橋渡し）。
export function db(env: Env): D1Database {
	const found = resolveDb(env, 17);
	if (!found) throw new Error("default D1 database (field 17) is not registered in DB_REGISTRY");
	return found;
}

// 年代境界をまたぐ引用関係（SPEC.md 4.4「分野 DB の結合ルール」）への最小対応。
// edges は citing 側の DB に保存されるため、祖先（cited）が 1 つ前の年代レンジの DB にいる
// ケースがある（2026-11-11、field17_2021_2025 で実測 1,950 件）。登録済み全 DB を毎回横断するのではなく、
// 前後 1 年代レンジ分だけを「隣接 DB」として返し、BFS がそこも検索できるようにする。
export function listAdjacentDbs(env: Env, field: number, yearRange: YearRange): D1Database[] {
	const adjacent: D1Database[] = [];
	for (const entry of DB_REGISTRY) {
		if (entry.field !== field) continue;
		const isPrev = entry.yearRange.end === yearRange.start - 1;
		const isNext = entry.yearRange.start === yearRange.end + 1;
		if (isPrev || isNext) adjacent.push(env[entry.binding] as D1Database);
	}
	return adjacent;
}

export type ResolveFieldDbResult =
	| { ok: true; db: D1Database; field: number; yearRange: YearRange }
	| { ok: false; status: 400 | 404; error: string };

// API ルートの共通処理: パスパラメータ "field" を数値として検証し、対応する D1 を解決する。
// yearRange クエリパラメータ（"2016-2026" 形式）が指定されていれば、そのレンジの DB を探す。
// 戻り値の yearRange は、未指定時に実際に選ばれた既定レンジも含む（listAdjacentDbs に渡すため）。
export function resolveFieldDb(env: Env, fieldParam: string, yearRangeParam?: string): ResolveFieldDbResult {
	const field = Number(fieldParam);
	if (!Number.isInteger(field) || field <= 0) {
		return { ok: false, status: 400, error: "invalid 'field' path parameter" };
	}

	let yearRangeQuery: YearRange | undefined;
	if (yearRangeParam !== undefined) {
		const parsed = parseYearRange(yearRangeParam);
		if (!parsed) {
			return { ok: false, status: 400, error: "invalid 'yearRange' parameter (expected 'YYYY-YYYY')" };
		}
		yearRangeQuery = parsed;
	}

	const entry = resolveDbEntry(field, yearRangeQuery);
	if (!entry) {
		return {
			ok: false,
			status: 404,
			error: `no database registered for field=${field}${yearRangeQuery ? ` yearRange=${formatYearRange(yearRangeQuery)}` : ""}`,
		};
	}
	return { ok: true, db: env[entry.binding] as D1Database, field, yearRange: entry.yearRange };
}
