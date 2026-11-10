import duckdb
f = "/Users/mtanaka/Dev/WebProjects/journal/data/openalex/part_0048.parquet"  # 手元のパスに変更
con = duckdb.connect()
print(con.execute(f"""
SELECT split_part(path_in_schema, ', ', 1) AS col,
       ROUND(100.0 * SUM(total_compressed_size) / SUM(SUM(total_compressed_size)) OVER (), 1) AS pct
FROM parquet_metadata('{f}')
WHERE split_part(path_in_schema, ', ', 1) IN ('id','title','publication_year','cited_by_count','primary_topic','referenced_works')
GROUP BY 1 ORDER BY 2 DESC
""").fetchall())
print(con.execute(f"""
SELECT COUNT(*) AS 分野17_全年,
       SUM(CASE WHEN len(referenced_works) > 0 THEN 1 ELSE 0 END) AS 参考文献ありの件数
FROM read_parquet('{f}')
WHERE regexp_extract(primary_topic.field.id, '([0-9]+)$', 1) = '17'
""").fetchone())