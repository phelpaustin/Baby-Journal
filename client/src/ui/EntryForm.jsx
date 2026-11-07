import { useEffect, useState } from "react";
import { useSession, useLoader, go } from "./context.js";
import { useJournalInfo, JournalHeader } from "./journal.jsx";
import { ENTRY_TYPES, MILESTONES, MEASUREMENTS, milestoneLabel } from "./constants.js";
import { uuid, todayLocal, formatBytes } from "../lib/util.js";
import { kindOf } from "../lib/media.js";

const num = (s) => parseFloat(String(s).trim().replace(",", ".")); // Swedish keyboards type 4,2

export function EntryForm({ jid, cid }) {
  const { engine, queue } = useSession();
  const info = useJournalInfo(jid);
  const [existing, , loadError] = useLoader(async () => (cid ? (await engine.getEntry(jid, cid)) || null : null), [jid, cid]);
  if (cid && existing === undefined && !loadError) return <div className="center muted">Loading…</div>;
  if (info.ready && !info.canEdit) return <div className="page"><p className="error">You can look at this journal but not add to it.</p><a href={`#/j/${jid}`}>Back</a></div>;
  if (cid && !existing) return <div className="page"><p className="error">That entry was not found.</p><a href={`#/j/${jid}`}>Back</a></div>;
  return <Form key={cid || "new"} jid={jid} cid={cid} existing={existing} info={info} engine={engine} queue={queue} />;
}

function Form({ jid, cid, existing, info, engine, queue }) {
  // The revision the person started from: kept for the whole edit, so a change made by someone
  // else in the meantime is detected as a conflict instead of being overwritten.
  const [baseRevision] = useState(existing ? existing.revision : 0);
  const [clientId] = useState(cid || uuid());
  const [date, setDate] = useState(existing?.event_date || todayLocal());
  const [type, setType] = useState(existing?.type || "memory");
  const [title, setTitle] = useState(existing?.title || "");
  const [text, setText] = useState(existing?.text || "");
  const [milestones, setMilestones] = useState(existing?.milestones || []);
  const [custom, setCustom] = useState("");
  const [vals, setVals] = useState(() => Object.fromEntries(Object.entries(existing?.values || {}).map(([k, v]) => [k, String(v)])));
  const [files, setFiles] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const measures = MEASUREMENTS[type] || [];

  const toggleMilestone = (id) => setMilestones((m) => (m.includes(id) ? m.filter((x) => x !== id) : [...m, id]));
  const addCustom = () => {
    const c = custom.trim().slice(0, 60);
    if (c && !milestones.includes(c)) setMilestones([...milestones, c]);
    setCustom("");
  };

  async function save(e) {
    e.preventDefault();
    setError("");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return setError("Choose a date.");
    if (!title.trim() && !text.trim() && !files.length && !milestones.length && !Object.keys(vals).length) return setError("Write something, add a photo, or pick a milestone.");
    const values = { ...(existing?.values || {}) };
    for (const [key, label] of measures.map((m) => [m[0], m[1]])) {
      const raw = (vals[key] ?? "").trim();
      if (!raw) { delete values[key]; continue; }
      const n = num(raw);
      if (!isFinite(n) || n <= 0) return setError(`${label} must be a number above zero.`);
      values[key] = n;
    }
    setBusy(true);
    try {
      await engine.saveEntry(jid, clientId, baseRevision, { event_date: date, type, title: title.trim(), text, milestones, values });
      for (const f of files) await queue.add({ journal: jid, entryClientId: clientId, file: f });
      go(`/j/${jid}/e/${clientId}`);
    } catch (err) {
      setError(err.message || "Could not save on this phone.");
      setBusy(false);
    }
  }

  const pick = (ev) => {
    const chosen = [...ev.target.files];
    const bad = chosen.filter((f) => !kindOf(f));
    if (bad.length) setError(`Not a photo or video: ${bad.map((b) => b.name).join(", ")}`);
    setFiles((cur) => [...cur, ...chosen.filter((f) => kindOf(f))]);
    ev.target.value = "";
  };

  return (
    <div className="page">
      <JournalHeader jid={jid} journal={info.journal} active="Timeline" />
      <h2>{existing ? "Edit entry" : "New entry"}</h2>
      <form onSubmit={save} className="card">
        <div className="two">
          <label className="field"><span>Date of the event</span><input type="date" value={date} onChange={(e) => setDate(e.target.value)} required /></label>
          <label className="field"><span>Type</span>
            <select value={type} onChange={(e) => setType(e.target.value)}>{ENTRY_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</select>
          </label>
        </div>
        <label className="field"><span>Title (optional)</span><input value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} /></label>
        <label className="field"><span>What happened</span><textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} /></label>

        {measures.length > 0 && (
          <fieldset>
            <legend>Measurements</legend>
            <div className="two">
              {measures.map(([key, label, unit]) => (
                <label className="field" key={key}><span>{label} ({unit})</span>
                  <input inputMode="decimal" value={vals[key] ?? ""} onChange={(e) => setVals({ ...vals, [key]: e.target.value })} /></label>
              ))}
            </div>
          </fieldset>
        )}

        <fieldset>
          <legend>Milestones</legend>
          <div className="chips">
            {MILESTONES.map(([id, label]) => <button type="button" key={id} className={milestones.includes(id) ? "chip on" : "chip"} aria-pressed={milestones.includes(id)} onClick={() => toggleMilestone(id)}>{label}</button>)}
            {milestones.filter((m) => !MILESTONES.some((p) => p[0] === m)).map((m) => <button type="button" key={m} className="chip on" aria-pressed="true" onClick={() => toggleMilestone(m)}>{milestoneLabel(m)} ✕</button>)}
          </div>
          <div className="row">
            <input placeholder="Add your own" value={custom} maxLength={60} onChange={(e) => setCustom(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addCustom(); } }} aria-label="Custom milestone" />
            <button type="button" onClick={addCustom}>Add</button>
          </div>
        </fieldset>

        <fieldset>
          <legend>Photos and videos</legend>
          <input type="file" accept="image/*,video/*" multiple onChange={pick} aria-label="Add photos or videos" />
          {files.map((f, i) => (
            <p key={i} className="row small">{f.name} <span className="muted">({formatBytes(f.size)})</span>
              <button type="button" onClick={() => setFiles(files.filter((_, j) => j !== i))}>Remove</button></p>
          ))}
          <p className="muted small">Photos and videos are saved on this phone first and uploaded in the background.</p>
        </fieldset>

        {error && <p className="error" role="alert">{error}</p>}
        <div className="row">
          <button className="primary" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
          <a className="button" href={existing ? `#/j/${jid}/e/${clientId}` : `#/j/${jid}`}>Cancel</a>
        </div>
      </form>
    </div>
  );
}
