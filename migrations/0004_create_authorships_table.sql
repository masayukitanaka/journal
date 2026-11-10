-- Migration number: 0004 	 著者名検索（論文名の検索と合わせてヒットさせる）のための著者テーブル。
-- OpenAlex の `authorships[].author.display_name` を論文ごとに複数行で保存する（正規化、SPEC.md 4.4 参照）。
-- 投入は S3 からの ingest 実装時に行う（このマイグレーションはテーブル定義のみ先行で追加）。

CREATE TABLE authorships (
  paper_id    INTEGER NOT NULL,
  author_name TEXT NOT NULL
);
CREATE INDEX idx_authorships_paper ON authorships(paper_id);
CREATE INDEX idx_authorships_name  ON authorships(author_name);
