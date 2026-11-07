import { useMemo, useState } from "react";
import { useSession, useLoader, useQueueState } from "./context.js";
import { useJournalInfo, JournalHeader } from "./journal.jsx";
import { MediaThumb, Lightbox } from "./mediaUi.jsx";
import { formatDate } from "../lib/age.js";
import { pb } from "../lib/pb.js";
import { errorMessage } from "../lib/util.js";

export function Gallery({ jid }) {
  const { data } = useSession();
  const info = useJournalInfo(jid);
  const q = useQueueState();
  const [media, reload, error] = useLoader(async () => (await data.media(jid)).value, [jid]);
  const [open, setOpen] = useState(-1);
  const [msg, setMsg] = useState("");

  const items = useMemo(
    () => (media || []).filter((m) => !m.deleted_at).sort((a, b) => String(b.taken_at || b.created).localeCompare(String(a.taken_at || a.created))),
    [media]);
  const uploading = q.items.filter((i) => i.journal === jid);

  const saveCaption = async (m, caption) => {
    try { await pb.send("/api/bj/media/update", { method: "POST", body: { id: m.id, caption } }); reload(); } catch (err) { setMsg(errorMessage(err)); }
  };
  const remove = async (m) => {
    if (!window.confirm("Remove this? It goes to the trash and can be restored.")) return;
    try { await pb.send("/api/bj/media/update", { method: "POST", body: { id: m.id, op: "trash" } }); setOpen(-1); reload(); } catch (err) { setMsg(errorMessage(err)); }
  };

  return (
    <div className="page">
      <JournalHeader jid={jid} journal={info.journal} active="Photos" />
      {error && !media && <p className="error">Can't load photos. Check your connection.</p>}
      {!media && !error && <p className="muted">Loading…</p>}
      {media && !items.length && !uploading.length && <p className="muted">No photos or videos yet. Add them from an entry.</p>}
      {msg && <p className="error" role="alert">{msg}</p>}
      <div className="grid big">
        {uploading.map((w) => <div key={w.client_id} className="thumb pending"><span className="small">{w.status === "failed" ? "Failed" : w.status === "uploading" ? Math.round((w.progress || 0) * 100) + "%" : "Queued"}</span><span className="muted small">{w.name}</span></div>)}
        {items.map((m, i) => (
          <figure key={m.id}>
            <MediaThumb media={m} size="320x0" onClick={() => setOpen(i)} />
            <figcaption className="muted small">{formatDate((m.taken_at || m.created || "").slice(0, 10))}</figcaption>
          </figure>
        ))}
      </div>
      {open >= 0 && items[open] && (
        <Lightbox media={items[open]} onClose={() => setOpen(-1)}
          onPrev={open > 0 ? () => setOpen(open - 1) : null} onNext={open < items.length - 1 ? () => setOpen(open + 1) : null}
          editor={info.canEdit ? { onCaption: (c) => saveCaption(items[open], c), onRemove: () => remove(items[open]) } : null} />
      )}
    </div>
  );
}
