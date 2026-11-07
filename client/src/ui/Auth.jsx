import { useState } from "react";
import { pb } from "../lib/pb.js";
import { go } from "./context.js";
import { errorMessage } from "../lib/util.js";

function Field({ label, ...props }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input {...props} />
    </label>
  );
}

export function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      await pb.collection("users").authWithPassword(email.trim(), password);
      const pending = sessionStorage.getItem("pendingInvite");
      if (pending) { go("/join/" + pending); }
    } catch (err) {
      setError(err?.status === 0 ? "Can't reach the journal. Check your connection." : "That email or password is not right.");
    } finally { setBusy(false); }
  }
  return (
    <div className="card narrow">
      <h1>Baby Journal</h1>
      <p className="muted">Sign in to your family journal.</p>
      <form onSubmit={submit}>
        <Field label="Email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <Field label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
      </form>
      <p className="muted small">New here? Open the invite link you were sent.</p>
    </div>
  );
}

// Invite link: #/join/<token>. Creates an account (or uses the signed-in one) and joins the journal.
export function Join({ token, user, session }) {
  const [mode, setMode] = useState("register");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function afterJoin(res) {
    sessionStorage.removeItem("pendingInvite");
    go(res?.journal ? `/j/${res.journal}` : "/");
  }

  async function accept() {
    setBusy(true); setError("");
    try { afterJoin(await pb.send("/api/bj/invites/accept", { method: "POST", body: { token } })); }
    catch (err) { setError(errorMessage(err)); setBusy(false); }
  }

  async function register(e) {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      const res = await pb.send("/api/bj/auth/register", { method: "POST", body: { token, name, email, password } });
      await pb.collection("users").authWithPassword(email.trim(), password);
      afterJoin(res);
    } catch (err) {
      setError(err?.status === 400 ? errorMessage(err) : "Could not join. Check the link and try again.");
      setBusy(false);
    }
  }

  if (user) {
    return (
      <div className="card narrow">
        <h1>Join a journal</h1>
        <p>You are signed in as <strong>{user.name || user.email}</strong>.</p>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary" onClick={accept} disabled={busy || !session}>{busy ? "Joining…" : "Join this journal"}</button>
        <p className="muted small"><a href="#/">Not now</a></p>
      </div>
    );
  }
  return (
    <div className="card narrow">
      <h1>You are invited</h1>
      {mode === "register" ? (
        <form onSubmit={register}>
          <p className="muted">Create your account to open the journal.</p>
          <Field label="Your name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
          <Field label="Email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <Field label="Password (at least 10 characters)" type="password" autoComplete="new-password" minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} required />
          {error && <p className="error" role="alert">{error}</p>}
          <button className="primary" disabled={busy}>{busy ? "Creating…" : "Create account and join"}</button>
          <p className="small"><a href="#/join/" onClick={(e) => { e.preventDefault(); sessionStorage.setItem("pendingInvite", token); setMode("login"); }}>I already have an account</a></p>
        </form>
      ) : (
        <div>
          <p className="muted">Sign in, and the invite will be used for your existing account.</p>
          <Login />
        </div>
      )}
    </div>
  );
}
