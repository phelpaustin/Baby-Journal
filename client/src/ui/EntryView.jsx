import { useState } from "react";
import { useSession, useLoader, useQueueState, go } from "./context.js";
import { useJournalInfo, JournalHeader } from "./journal.jsx";
import { typeLabel, milestoneLabel, measurementLabel } from "./constants.js";
import { ageOn, formatDate } from "../lib/age.js";
import { MediaThumb, Lightbox } from "./mediaUi.jsx";
import { pb } from "../lib/pb.js";
import { errorMessage, formatBytes } from "../lib/util.js";
import { kindOf } from "../lib/media.js";

function Values({ values }) {
  const keys = Object.keys(values || {});
  if (!keys.length) return null;
  return (
    <dl className="values">
      {keys.map((k) => { const m = measurementLabel(k); return <div key={k}><dt>{m.label}</dt><dd>{values[k]} {m.unit}</dd></div>; })}
    </dl>
  );
}

export function EntryView({ jid, cid }) {
  const { engine, data, queue } = useSession();
  const info = useJournalInfo(jid);
  const q = useQueueState();
  const [entry] = useLoader(() => engine.getEntry(jid, cid), [jid, cid], { watchEngine: true });
  const [allMedia, reloadMedia] = useLoader(async () => (await data.media(jid).catch(() => ({ value: [] }))).value, [jid]);
  const [open, setOpen] = useState(-1);
  const [msg, setMsg] = useState("");

  if (entry === undefined) return <div className="center muted">Loading…</div>;
  if (!entry) return <div className="page"><p className="error">That entry was not found.</p><a href={`#/j/${jid}`}>Back</a></div>;

  const media = (allMedia || []).filter((m) => entry.id && m.entry === entry.id && !m.deleted_at).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || String(a.taken_at || a.created).localeCompare(String(b.taken_at || b.created)));
  const waiting = q.items.filter((i) => i.entry_client_id === cid);
  const trashed = !!entry.deleted_at;

  const trash = async () => {
    if (!window.confirm("Move this entry to the trash? You can restore it later.")) return;
    await engine.trashEntry(jid, cid, entry.revision);
    go(`/j/${jid}`);
  };
  const restore = () => engine.restoreEntry(jid, cid, entry.revision);
  const addFiles = async (ev) => {
    setMsg("");
    for (const f of ev.target.files) {
      if (!kindOf(f)) { setMsg(`${f.name} is not a photo or video.`); continue; }
      await queue.add({ journal: jid, entryClientId: cid, file: f });
    }
    ev.target.value = "";
  };
  const saveCaption = async (m, caption) => {
    try { await pb.send("/api/bj/media/update", { method: "POST", body: { id: m.id, caption } }); reloadMedia(); }
    catch (err) { setMsg(errorMessage(err)); }
  };
  const removeMedia = async (m) => {
    if (!window.confirm("Remove this from the entry? It goes to the trash and can be restored.")) return;
    try { await pb.send("/api/bj/media/update", { method: "POST", body: { id: m.id, op: "trash" } }); setOpen(-1); reloadMedia(); }
    catch (err) { setMsg(errorMessage(err)); }
  };

  return (
    <div className="page">
      <JournalHeader jid={jid} journal={info.journal} active="Timeline" />
      <p><a href={`#/j/${jid}`}>‹ Timeline</a></p>
      {trashed && <p className="notice warn">This entry is in the trash. {info.canEdit && <button onClick={restore}>Restore</button>}</p>}
      {entry._pending && <p className="notice info">Saved on this phone. Waiting to be sent to the journal.</p>}
      {entry._problem && <p className="notice bad">This change could not be saved: {entry._problem} <a href="#/problems">Review</a></p>}

      <article className="card">
        <div className="meta">
          <span>{formatDate(entry.event_date)}</span>
          <span className="muted">{ageOn(entry.event_date, info.journal || {})}</span>
          <span className="tag">{typeLabel(entry.type)}</span>
          {entry.author && <span className="muted small">by {info.nameOf(entry.author)}</span>}
        </div>
        {entry.title && <h2>{entry.title}</h2>}
        {entry.text && <p className="body">{entry.text}</p>}
        <Values values={entry.values} />
        {!!(entry.milestones || []).length && <p className="chips">{entry.milestones.map((m) => <span key={m} className="chip on">{milestoneLabel(m)}</span>)}</p>}
      </article>

      {entry.needs_review && !trashed && info.canEdit && entry.id && <Conflicts jid={jid} entry={entry} info={info} />}
      {entry.needs_review && !trashed && info.canEdit && !entry.id && null}

      {(media.length > 0 || waiting.length > 0) && (
        <section>
          <h3>Photos and videos</h3>
          <div className="grid">
            {media.map((m, i) => <MediaThumb key={m.id} media={m} onClick={() => setOpen(i)} />)}
            {waiting.map((w) => (
              <div key={w.client_id} className="thumb pending" title={w.error || ""}>
                <span className="small">{w.status === "failed" ? "Failed" : w.status === "waiting_entry" ? "Waiting" : w.status === "uploading" ? Math.round((w.progress || 0) * 100) + "%" : "Queued"}</span>
                <span className="muted small">{w.name} · {formatBytes(w.size)}</span>
              </div>
            ))}
          </div>
        </section>
      )}
      {msg && <p className="error" role="alert">{msg}</p>}

      {info.canEdit && !trashed && (
        <div className="row">
          <a className="button primary" href={`#/j/${jid}/e/${cid}/edit`}>Edit</a>
          <label className="button">Add photos or videos<input hidden type="file" accept="image/*,video/*" multiple onChange={addFiles} /></label>
          <button className="danger" onClick={trash}>Move to trash</button>
        </div>
      )}
      {open >= 0 && media[open] && (
        <Lightbox media={media[open]} onClose={() => setOpen(-1)}
          onPrev={open > 0 ? () => setOpen(open - 1) : null} onNext={open < media.length - 1 ? () => setOpen(open + 1) : null}
          editor={info.canEdit ? { onCaption: (c) => saveCaption(media[open], c), onRemove: () => removeMedia(media[open]) } : null} />
      )}
    </div>
  );
}

// Two versions of the same entry exist (two phones edited it from the same starting point).
// Nothing is lost: pick the one to keep, or combine them, and save the final version.
function Conflicts({ jid, entry, info }) {
  const { engine } = useSession();
  const [versions, , error] = useLoader(() => engine.conflictVersions(entry.id), [entry.id, entry.revision]);
  const [choice, setChoice] = useState("current");
  const [title, setTitle] = useState(null);
  const [text, setText] = useState(null);
  const [busy, setBusy] = useState(false);

  if (error) return <p className="notice warn">Two versions of this entry exist. Connect to the journal to compare them.</p>;
  if (!versions) return null;
  const options = [{ id: "current", label: "The version saved first", v: entry }, ...versions.map((v) => ({ id: v.id, label: `Another version by ${info.nameOf(v.author)}`, v }))];
  const picked = options.find((o) => o.id === choice) || options[0];
  const curTitle = title ?? picked.v.title ?? "";
  const curText = text ?? picked.v.text ?? "";

  const choose = (o) => { setChoice(o.id); setTitle(null); setText(null); };
  const combine = () => { setChoice("combined"); setTitle(entry.title || ""); setText([entry.text, ...versions.map((v) => v.text)].filter(Boolean).join("\n\n")); };
  const save = async () => {
    setBusy(true);
    await engine.resolveConflict(jid, entry.client_id, entry.revision, {
      event_date: entry.event_date, type: entry.type, title: curTitle, text: curText,
      milestones: entry.milestones || [], values: entry.values || {},
    });
    setBusy(false);
  };

  return (
    <section className="card conflict" aria-label="Two versions">
      <h3>Two versions of this entry</h3>
      <p className="muted">Two people edited this at the same time. Both are saved. Choose what the final version says.</p>
      {options.map((o) => (
        <label key={o.id} className="option">
          <input type="radio" name="ver" checked={choice === o.id} onChange={() => choose(o)} />
          <span><strong>{o.label}</strong><br /><span className="snippet">{o.v.title ? o.v.title + " — " : ""}{o.v.text || "(no text)"}</span></span>
        </label>
      ))}
      <button type="button" onClick={combine}>Combine all texts</button>
      <label className="field"><span>Final title</span><input value={curTitle} onChange={(e) => setTitle(e.target.value)} /></label>
      <label className="field"><span>Final text</span><textarea rows={5} value={curText} onChange={(e) => setText(e.target.value)} /></label>
      <button className="primary" onClick={save} disabled={busy}>Save as the final version</button>
    </section>
  );
}
