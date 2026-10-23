import { DatabaseSync } from "node:sqlite";
import { apply } from "@earendil-works/chord/delta";

type Revision = { document_id: number; seq: number; kind: string; content: string };

/**
 * pi-durable can commit a stale stream flush after a generation reset; the delta then never replays and every
 * Harness.open fails. Drop each document's tail from its first unreplayable delta (those are lost streaming partials).
 */
export function repairDocs(path: string) {
  const db = new DatabaseSync(path);
  try {
    const rows = db
      .prepare(
        `SELECT r.document_id, r.seq, r.kind, r.content FROM document_revisions r
         WHERE r.seq >= (SELECT MAX(b.seq) FROM document_revisions b WHERE b.document_id = r.document_id AND b.kind = 'base')
         ORDER BY r.document_id, r.seq`,
      )
      .all() as Revision[];
    const repaired: { documentId: number; fromSeq: number; dropped: number }[] = [];
    let doc: unknown;
    let broken: number | undefined;
    for (const r of rows) {
      if (r.kind === "base") {
        doc = JSON.parse(r.content);
        broken = undefined;
        continue;
      }
      if (broken === r.document_id) continue;
      try {
        doc = apply(doc as never, JSON.parse(r.content));
      } catch {
        broken = r.document_id;
        const { changes } = db.prepare("DELETE FROM document_revisions WHERE document_id = ? AND seq >= ?").run(r.document_id, r.seq);
        repaired.push({ documentId: r.document_id, fromSeq: r.seq, dropped: Number(changes) });
      }
    }
    return repaired;
  } finally {
    db.close();
  }
}
