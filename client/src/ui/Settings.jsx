import { useState } from "react";
import { useSession, useLoader } from "./context.js";
import { useJournalInfo, JournalHeader } from "./journal.jsx";
import { pb } from "../lib/pb.js";
import { errorMessage, formatBytes } from "../lib/util.js";
import { diag } from "../lib/diag.js";
import { buildReport, reportText, deviceInfo } from "../lib/diagnostics.js";

export function Settings({ jid, signOut }) {
  const { data, persisted, db } = useSession();
  const info = useJournalInfo(jid);
  const [backup] = useLoader(() => data.backupStatus().catch(() => null), []);
  const [name, setName] = useState(null);
  const [emoji, setEmoji] = useState(null);
  const [due, setDue] = useState(null);
  const [dob, setDob] = useState(null);
  const [msg, setMsg] = useState("");
  const [saved, setSaved] = useState(false);
  const [usage, setUsage] = useState("");
  useLoader(async () => {
    if (navigator.storage?.estimate) { const e = await navigator.storage.estimate(); setUsage(`${formatBytes(e.usage || 0)} used on this phone`); }
    return 1;
  }, []);

  const j = info.journal || {};
  const save = async (e) => {
    e.preventDefault(); setMsg(""); setSaved(false);
    try {
      await pb.send("/api/bj/journals/update", { method: "POST", body: { journal: jid, name: name ?? j.name, emoji: emoji ?? j.emoji, due_date: due ?? j.due_date, dob: dob ?? j.dob } });
      await db.setCache("journal:" + jid, undefined);
      info.reload(); setSaved(true);
    } catch (err) { setMsg(errorMessage(err)); }
  };

  const exportJournal = async () => {
    setMsg("");
    try {
      const out = await pb.send(`/api/bj/journals/export?journal=${encodeURIComponent(jid)}`, { method: "GET" });
      const url = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url; a.download = `journal-export-${new Date().toISOString().slice(0, 10)}.json`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) { setMsg(errorMessage(err)); }
  };
  const signOutEverywhere = async () => {
    if (!window.confirm("Sign out on all your devices? You will need to sign in again everywhere.")) return;
    try { await pb.send("/api/bj/me/sign-out-everywhere", { method: "POST" }); pb.authStore.clear(); } catch (err) { setMsg(errorMessage(err)); }
  };

  const [diagTick, setDiagTick] = useState(0);
  const report = buildReport({ perf: diag.runs(), uploads: diag.events(), device: deviceInfo({ persisted }) });
  const copyReport = async () => {
    const text = reportText(report) + "\n\n" + JSON.stringify(report);
    try { await navigator.clipboard.writeText(text); setMsg("Diagnostics copied. Paste them into a message to the journal owner."); }
    catch (_) { window.prompt("Copy this text and send it to the journal owner:", text); }
  };
  const f = (n) => (n === null || n === undefined ? "n/a" : n + " ms");

  return (
    <div className="page" data-tick={diagTick}>
      <JournalHeader jid={jid} journal={info.journal} active="Settings" />
      {info.isOwner && (
        <form className="card" onSubmit={save}>
          <h2>Journal</h2>
          <label className="field"><span>Name</span><input value={name ?? j.name ?? ""} onChange={(e) => setName(e.target.value)} required /></label>
          <label className="field"><span>Emoji</span><input value={emoji ?? j.emoji ?? ""} maxLength={4} onChange={(e) => setEmoji(e.target.value)} /></label>
          <div className="two">
            <label className="field"><span>Due date</span><input type="date" value={due ?? j.due_date ?? ""} onChange={(e) => setDue(e.target.value)} /></label>
            <label className="field"><span>Date of birth</span><input type="date" value={dob ?? j.dob ?? ""} onChange={(e) => setDob(e.target.value)} /></label>
          </div>
          <button className="primary">Save</button> {saved && <span className="muted">Saved</span>}
        </form>
      )}
      {msg && <p className="error" role="alert">{msg}</p>}

      <section className="card">
        <h2>Backups</h2>
        {backup ? (
          <p className={backup.level === "ok" ? "ok" : backup.level === "warning" ? "warn" : "error"}>
            {backup.last_good_at ? `Last verified offsite backup: ${new Date(backup.last_good_at.replace(" ", "T")).toLocaleString()}` : "No verified offsite backup yet."}
            {backup.media_not_offsite > 0 && ` ${backup.media_not_offsite} photo(s) or video(s) are not in the offsite backup yet.`}
          </p>
        ) : <p className="muted">Backup status is not available right now.</p>}
        {info.isOwner && <><button onClick={exportJournal}>Download a copy of the journal text (JSON)</button><p className="muted small">Entries, history and people. Photos and videos are kept in the backup.</p></>}
      </section>

      <section className="card" aria-label="Pilot diagnostics">
        <h2>Pilot diagnostics</h2>
        <p className="muted small">Timings and upload results stay on this phone. Copy them and send them to the journal owner.</p>
        {["cold", "warm"].map((s) => (
          <p key={s} className="small">
            <strong>{s === "cold" ? "First open" : "Opened from the home screen"}</strong>: {report.startup[s].runs} run(s), median {f(report.startup[s].timeline_median_ms)}, worst {f(report.startup[s].timeline_worst_ms)}
            {report.startup[s].timeline_pass === null ? "" : report.startup[s].timeline_pass ? " (meets target)" : " (misses target)"}
          </p>
        ))}
        <p className="small"><strong>Uploads</strong>: {report.uploads.files} file(s), {report.uploads.done} done, {report.uploads.failed} failed, {report.uploads.restarted} restarted.
          {report.uploads.resumable_uploads_required ? " Resumable uploads are required by the pilot thresholds." : ""}</p>
        <div className="row">
          <button onClick={copyReport}>Copy diagnostics</button>
          <button onClick={() => { diag.clear(); setDiagTick((t) => t + 1); }}>Clear</button>
        </div>
      </section>

      <section className="card">
        <h2>This phone</h2>
        <p className="muted">{usage || "Storage information is not available."} {persisted === false && "The browser may clear unsent files if space runs low."}</p>
        <div className="row">
          <button onClick={signOutEverywhere}>Sign out everywhere</button>
          <button onClick={signOut}>Sign out</button>
        </div>
        <p className="muted small">Unsent changes: signing out asks before deleting them.</p>
      </section>
    </div>
  );
}
