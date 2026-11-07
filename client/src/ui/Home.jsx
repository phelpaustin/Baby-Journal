import { useState } from "react";
import { useSession, useLoader, go } from "./context.js";
import { pb } from "../lib/pb.js";
import { errorMessage } from "../lib/util.js";

export function Home({ signOut }) {
  const { data, user } = useSession();
  const [res, reload, error] = useLoader(() => data.journals(), []);
  const [name, setName] = useState("");
  const [due, setDue] = useState("");
  const [dob, setDob] = useState("");
  const [msg, setMsg] = useState("");

  if (error && !res) return <div className="page"><p className="error">Can't load your journals. Check your connection.</p><button onClick={reload}>Try again</button></div>;
  if (!res) return <div className="center muted">Loading…</div>;
  const list = res.value;
  if (list.length === 1 && !sessionStorage.getItem("homeSeen")) { sessionStorage.setItem("homeSeen", "1"); go(`/j/${list[0].id}`); return null; }

  async function create(e) {
    e.preventDefault();
    setMsg("");
    try {
      const r = await pb.send("/api/bj/journals/create", { method: "POST", body: { name, due_date: due || undefined, dob: dob || undefined } });
      go(`/j/${r.journal.id}`);
    } catch (err) { setMsg(errorMessage(err)); }
  }

  return (
    <div className="page">
      <h1>Hello{user.name ? ", " + user.name : ""}</h1>
      {list.map((j) => <a key={j.id} className="card link" href={`#/j/${j.id}`}><strong>{j.emoji} {j.name}</strong></a>)}
      {!list.length && (
        <form className="card" onSubmit={create}>
          <h2>Create the journal</h2>
          <p className="muted">If someone invited you, open their invite link instead.</p>
          <label className="field"><span>Child's name</span><input value={name} onChange={(e) => setName(e.target.value)} required /></label>
          <label className="field"><span>Due date (optional)</span><input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label>
          <label className="field"><span>Date of birth (once born)</span><input type="date" value={dob} onChange={(e) => setDob(e.target.value)} /></label>
          {msg && <p className="error" role="alert">{msg}</p>}
          <button className="primary">Create journal</button>
        </form>
      )}
      <p><button onClick={signOut}>Sign out</button></p>
    </div>
  );
}
