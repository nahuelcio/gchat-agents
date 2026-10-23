import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { repairDocs } from "../harness/repair-docs.ts";

function seed(revisions: [number, string, unknown][]) {
  const path = join(mkdtempSync(join(tmpdir(), "repair-")), "h.sqlite");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE document_revisions (document_id INTEGER, seq INTEGER, kind TEXT, version INTEGER, content TEXT, PRIMARY KEY (document_id, seq))");
  const put = db.prepare("INSERT INTO document_revisions VALUES (96, ?, ?, 1, ?)");
  for (const [seq, kind, content] of revisions) put.run(seq, kind, JSON.stringify(content));
  db.close();
  return path;
}

const seqs = (path: string) =>
  new DatabaseSync(path).prepare("SELECT seq FROM document_revisions ORDER BY seq").all().map((r) => r.seq);

test("drops deltas from the first one that no longer applies", () => {
  const path = seed([
    [1, "base", { run: {} }],
    [2, "delta", [["s", ["generation"], { attempt: 1, message: { content: [{ thinking: "a" }] } }]]],
    [3, "delta", [["a", ["generation", "message", "content", 0, "thinking"], "b"]]],
    [4, "delta", [["s", ["generation"], { attempt: 1 }]]],
    [5, "delta", [["a", ["generation", "message", "content", 0, "thinking"], "late"]]],
    [6, "delta", [["a", ["generation", "message", "content", 0, "thinking"], "later"]]],
  ]);
  expect(repairDocs(path)).toEqual([{ documentId: 96, fromSeq: 5, dropped: 2 }]);
  expect(seqs(path)).toEqual([1, 2, 3, 4]);
});

test("leaves healthy documents alone", () => {
  const path = seed([
    [1, "base", { n: 1 }],
    [2, "delta", [["s", ["n"], 2]]],
  ]);
  expect(repairDocs(path)).toEqual([]);
  expect(seqs(path)).toEqual([1, 2]);
});
