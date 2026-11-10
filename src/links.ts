// 論文の外部ページへのリンクを組み立てる。

// OpenAlex の論文ページ（id は openAlexIdToNumber 済みの数値、SPEC.md 4.4）。
export function openAlexPageUrl(id: number): string {
	return `https://openalex.org/W${id}`;
}

// DOI 解決サービス（https://doi.org/...）。doi 列は OpenAlex の `doi` フィールドをそのまま保存しており、
// 既に "https://doi.org/..." の形式なのでそのまま使う。欠損している論文もある（migrations/0003）。
export function doiUrl(doi: string | null | undefined): string | null {
	return doi ?? null;
}
