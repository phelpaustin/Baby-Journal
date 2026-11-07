import { useState } from "react";
import { useSession, useLoader } from "./context.js";
import { useJournalInfo, JournalHeader } from "./journal.jsx";
import { pb } from "../lib/pb.js";
import { errorMessage } from "../lib/util.js";

const ROLE_HELP = { owner: "Owner: everything, including people and settings", editor: "Editor: add and change entries and photos", viewer: "Viewer: look only" };

export function People({ jid }) {
  const { user, db } = useSession();
  const info = useJournalInfo(jid);
  const [role, setRole] = useState("viewer");
  const [invite, setInvite] = useState(null);
  const [msg, setMsg] = useState("");
  const [copied, setCopied] = useState(false);

  const call = async (path, body, after) => {
    setMsg("");
    try { await pb.send(path, { method: "POST", body }); await db.setCache("members:" + jid, undefined); info.reload(); if (after) after(); }
    catch (err) { setMsg(errorMessage(err)); }
  };

  const makeInvite = async () => {
    setMsg(""); setCopied(false);
    try {
      const r = await pb.send("/api/bj/invites/create", { method: "POST", body: { journal: jid, role } });
      setInvite({ link: `${window.location.origin}/#/join/${r.token}`, role: r.role, expires: r.expires_at });
    } catch (err) { setMsg(errorMessage(err)); }
  };
  const share = async () => {
    if (navigator.share) { try { await navigator.share({ title: "Join our baby journal", url: invite.link }); return; } catch (_) {} }
    await navigator.clipboard?.writeText(invite.link);
    setCopied(true);
  };

  return (
    <div className="page">
      <JournalHeader jid={jid} journal={info.journal} active="People" />
      <ul className="people">
        {info.members.map((m) => (
          <li key={m.id} className="card">
            <strong>{m.name || "Member"}</strong>{m.user === user.id && <span className="muted"> (you)</span>}
            {info.isOwner ? (
              <div className="row">
                <select value={m.role} aria-label={`Role of ${m.name}`} onChange={(e) => call("/api/bj/members/role", { journal: jid, user: m.user, role: e.target.value })}>
                  <option value="owner">Owner</option><option value="editor">Editor</option><option value="viewer">Viewer</option>
                </select>
                {m.user !== user.id && <>
                  <button onClick={() => window.confirm(`Sign ${m.name} out on all their devices?`) && call("/api/bj/members/sign-out", { journal: jid, user: m.user })}>Sign out everywhere</button>
                  <button className="danger" onClick={() => window.confirm(`Remove ${m.name} from this journal?`) && call("/api/bj/members/remove", { journal: jid, user: m.user })}>Remove</button>
                </>}
              </div>
            ) : <span className="tag">{m.role}</span>}
          </li>
        ))}
      </ul>
      {msg && <p className="error" role="alert">{msg}</p>}

      {info.isOwner && (
        <section className="card">
          <h2>Invite someone</h2>
          <label className="field"><span>They can</span>
            <select value={role} onChange={(e) => setRole(e.target.value)}>{Object.entries(ROLE_HELP).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          </label>
          <button className="primary" onClick={makeInvite}>Create invite link</button>
          {invite && (
            <div className="invite">
              <p className="small">Send this link to them. It works once and expires in 7 days.</p>
              <input readOnly value={invite.link} onFocus={(e) => e.target.select()} aria-label="Invite link" />
              <button onClick={share}>{copied ? "Copied" : "Share or copy"}</button>
            </div>
          )}
        </section>
      )}
      <p><button onClick={() => window.confirm("Leave this journal?") && call("/api/bj/members/remove", { journal: jid }, () => { window.location.hash = "/"; })}>Leave this journal</button></p>
    </div>
  );
}
