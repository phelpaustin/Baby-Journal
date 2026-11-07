import { useMemo, useState } from "react";
import { useSession, useLoader, useQueueState } from "./context.js";
import { useJournalInfo, JournalHeader } from "./journal.jsx";
import { ENTRY_TYPES, typeLabel, milestoneLabel } from "./constants.js";
import { lifeStage, ageOn, formatDate } from "../lib/age.js";
import { MediaThumb } from "./mediaUi.jsx";

export function Timeline({ jid }) {
  const { engine, data } = useSession();
  const info = useJournalInfo(jid);
  const q = useQueueState();
  const [entries] = useLoader(() => engine.listEntries(jid), [jid], { watchEngine: true });
  const [media] = useLoader(async () => (await data.media(jid).catch(() => ({ value: [] }))).value, [jid]);
  const [type, setType] = useState("");
  const [search, setSearch] = useState("");
  const [trash, setTrash] = useState(false);

  const shown = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (entries || []).filter((e) => {
      if (!!e.deleted_at !== trash) return false;
      if (type && e.type !== type) return false;
      if (!s) return true;
      return [e.title, e.text, ...(e.milestones || []).map(milestoneLabel)].join(" ").toLowerCase().includes(s);
    });
  }, [entries, type, search, trash]);

  const mediaByEntry = useMemo(() => {
    const m = {};
    for (const x of media || []) if (!x.deleted_at) (m[x.entry] = m[x.entry] || []).push(x);
    return m;
  }, [media]);

  // Group consecutive entries with the same life-stage label (entries are newest first).
  const groups = [];
  for (const e of shown) {
    const st = lifeStage(e.event_date, info.journal || {});
    const last = groups[groups.length - 1];
    if (last && last.label === st.label) last.items.push(e);
    else groups.push({ label: st.label, items: [e] });
  }
  const needsReview = (entries || []).filter((e) => e.needs_review && !e.deleted_at).length;

  return (
    <div className="page">
      <JournalHeader jid={jid} journal={info.journal} active="Timeline" />
      {needsReview > 0 && info.canEdit && <p className="notice warn">{needsReview} entr{needsReview === 1 ? "y has" : "ies have"} two versions waiting for a decision. Open the marked entries to choose.</p>}
      <div className="filters">
        <input type="search" placeholder="Search the journal" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search" />
        <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Filter by type">
          <option value="">All types</option>
          {ENTRY_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
        {info.canEdit && <label className="check"><input type="checkbox" checked={trash} onChange={(e) => setTrash(e.target.checked)} /> Trash</label>}
      </div>
      {!entries && <p className="muted">Loading…</p>}
      {entries && !shown.length && <p className="muted">{trash ? "The trash is empty." : search || type ? "Nothing matches." : info.canEdit ? "No entries yet. Add the first memory." : "No entries yet."}</p>}
      {groups.map((g, gi) => (
        <section key={gi} className="group">
          <h2 className="stage">{g.label}</h2>
          {g.items.map((e) => {
            const ms = mediaByEntry[e.id] || [];
            const waiting = q.items.filter((i) => i.entry_client_id === e.client_id).length;
            return (
              <a key={e.client_id} className="entry" href={`#/j/${jid}/e/${e.client_id}`}>
                <div className="meta">
                  <span>{formatDate(e.event_date)}</span>
                  <span className="muted">{ageOn(e.event_date, info.journal || {})}</span>
                  <span className="tag">{typeLabel(e.type)}</span>
                  {e.needs_review && !e.deleted_at && <span className="tag warn">Two versions</span>}
                  {e._pending && <span className="tag info">Waiting to send</span>}
                  {e._problem && <span className="tag bad">Not saved</span>}
                  {waiting > 0 && <span className="tag info">{waiting} file{waiting === 1 ? "" : "s"} uploading</span>}
                </div>
                {e.title && <h3>{e.title}</h3>}
                {e.text && <p className="snippet">{e.text.length > 180 ? e.text.slice(0, 180) + "…" : e.text}</p>}
                {!!(e.milestones || []).length && <p className="chips">{e.milestones.map((m) => <span key={m} className="chip on">{milestoneLabel(m)}</span>)}</p>}
                {ms.length > 0 && <div className="strip" onClick={(ev) => ev.preventDefault()}>{ms.slice(0, 4).map((m) => <MediaThumb key={m.id} media={m} onClick={() => { window.location.hash = `/j/${jid}/e/${e.client_id}`; }} />)}{ms.length > 4 && <span className="muted">+{ms.length - 4}</span>}</div>}
              </a>
            );
          })}
        </section>
      ))}
      {info.canEdit && <a className="fab" href={`#/j/${jid}/new`} aria-label="New entry">+ New entry</a>}
    </div>
  );
}
