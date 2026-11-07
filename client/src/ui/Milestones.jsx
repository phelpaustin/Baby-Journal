import { useSession, useLoader } from "./context.js";
import { useJournalInfo, JournalHeader } from "./journal.jsx";
import { MILESTONES, milestoneLabel } from "./constants.js";
import { formatDate, ageOn } from "../lib/age.js";

// Every milestone with the first date it was recorded (F14). Reached ones link to their entry.
export function Milestones({ jid }) {
  const { engine } = useSession();
  const info = useJournalInfo(jid);
  const [entries] = useLoader(() => engine.listEntries(jid), [jid], { watchEngine: true });

  const first = new Map();
  for (const e of entries || []) {
    if (e.deleted_at) continue;
    for (const m of e.milestones || []) {
      const cur = first.get(m);
      if (!cur || e.event_date < cur.event_date) first.set(m, e);
    }
  }
  const presets = MILESTONES.map(([id]) => id);
  const custom = [...first.keys()].filter((k) => !presets.includes(k)).sort((a, b) => first.get(a).event_date.localeCompare(first.get(b).event_date));
  const row = (id) => {
    const e = first.get(id);
    return (
      <li key={id} className={e ? "ms done" : "ms"}>
        <span className="tick" aria-hidden="true">{e ? "✓" : "○"}</span>
        <span className="name">{milestoneLabel(id)}</span>
        {e ? <a href={`#/j/${jid}/e/${e.client_id}`}>{formatDate(e.event_date)} <span className="muted small">{ageOn(e.event_date, info.journal || {})}</span></a> : <span className="muted small">Not yet</span>}
      </li>
    );
  };
  return (
    <div className="page">
      <JournalHeader jid={jid} journal={info.journal} active="Milestones" />
      {!entries && <p className="muted">Loading…</p>}
      <ul className="mlist">{presets.map(row)}{custom.map(row)}</ul>
      <p className="muted small">Tick a milestone when you add or edit an entry.</p>
    </div>
  );
}
