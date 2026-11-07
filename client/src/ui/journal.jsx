import { useEffect } from "react";
import { useSession, useLoader, go } from "./context.js";

// Journal profile, members and the signed-in person's role, with an offline fallback.
export function useJournalInfo(jid) {
  const { data, user, engine } = useSession();
  const [info, reload] = useLoader(async () => {
    const [j, m] = await Promise.all([data.journal(jid), data.members(jid)]);
    const mine = m.value.find((x) => x.user === user.id);
    return { journal: j.value, members: m.value, role: mine ? mine.role : "", fresh: j.fresh && m.fresh };
  }, [jid]);
  useEffect(() => { engine.pull(jid).then(() => reload()); }, [jid]); // eslint-disable-line
  const role = info?.role || "";
  return {
    ready: !!info, journal: info?.journal, members: info?.members || [], role,
    canEdit: role === "owner" || role === "editor", isOwner: role === "owner",
    nameOf: (uid) => (info?.members || []).find((m) => m.user === uid)?.name || "Someone",
    reload,
  };
}

const TABS = [["", "Timeline"], ["gallery", "Photos"], ["milestones", "Milestones"], ["people", "People"], ["settings", "Settings"]];

export function JournalHeader({ jid, journal, active }) {
  return (
    <header className="jheader">
      <div className="jtitle">
        <a href="#/" className="back" aria-label="All journals">‹</a>
        <h1>{journal?.emoji ? journal.emoji + " " : ""}{journal?.name || "Journal"}</h1>
      </div>
      <nav className="tabs" aria-label="Journal sections">
        {TABS.map(([path, label]) => (
          <a key={label} href={`#/j/${jid}${path ? "/" + path : ""}`} className={active === label ? "tab on" : "tab"} aria-current={active === label ? "page" : undefined}>{label}</a>
        ))}
      </nav>
    </header>
  );
}
