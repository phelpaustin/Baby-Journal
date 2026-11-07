import { useSession, useLoader, useQueueState } from "./context.js";
import { typeLabel } from "./constants.js";
import { formatBytes } from "../lib/util.js";

// Everything that has not reached the server, with the reason. Nothing is ever dropped silently.
export function Problems() {
  const { engine, db, user, queue } = useSession();
  const q = useQueueState();
  const [ops] = useLoader(async () => (await db.allOps()).filter((o) => o.owner === user.id && o.status !== "pending"), [], { watchEngine: true });
  const files = q.items.filter((i) => i.status === "failed" || i.status === "paused");

  return (
    <div className="page">
      <p><a href="#/">‹ Back</a></p>
      <h1>Needs attention</h1>
      {!ops?.length && !files.length && <p className="muted">Nothing to review.</p>}
      {(ops || []).map((o) => (
        <div className="card" key={o.id}>
          <strong>{o.op === "upsert" ? (o.fields?.title || typeLabel(o.fields?.type) || "Entry") : o.op === "trash" ? "Move an entry to the trash" : o.op === "restore" ? "Restore an entry" : "Resolve an entry"}</strong>
          <p className="error">{o.error}</p>
          <div className="row">
            {o.op === "upsert" && <a className="button" href={`#/j/${o.journal}/e/${o.client_id}/edit`}>Edit</a>}
            <button onClick={() => engine.retryOp(o.id).then(() => engine.flush())}>Try again</button>
            <button className="danger" onClick={() => window.confirm("Delete this change from the phone?") && engine.discardOp(o.id)}>Delete</button>
          </div>
        </div>
      ))}
      {files.map((f) => (
        <div className="card" key={f.client_id}>
          <strong>{f.name}</strong> <span className="muted">({formatBytes(f.size)})</span>
          <p className="error">{f.error}</p>
          <p className="muted small">The file is still on this phone.</p>
          <div className="row">
            <button onClick={() => queue.retry(f.client_id)}>Try again</button>
            <button className="danger" onClick={() => window.confirm("Delete this file from the phone? It has not been saved to the journal.") && queue.discard(f.client_id)}>Delete</button>
          </div>
        </div>
      ))}
    </div>
  );
}
