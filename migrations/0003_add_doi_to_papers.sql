-- Migration number: 0003 	 論文詳細パネルから出版元・DOI解決サービスへ直接ジャンプできるよう、doi 列を追加する。
-- OpenAlex API の `doi` フィールド（例: "https://doi.org/10.1109/..."）をそのまま保存する想定。
-- 欠損する論文もあるため NULL 許容。

ALTER TABLE papers ADD COLUMN doi TEXT;
