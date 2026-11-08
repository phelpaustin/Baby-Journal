import { useEffect, useState } from "react";
import { pb } from "./lib/pb.js";
import { createDb } from "./lib/db.js";
import { createEngine } from "./lib/sync.js";
import { createMediaQueue } from "./lib/media.js";
import { createData } from "./lib/data.js";
import { forgetFileToken } from "./lib/files.js";
import { diag } from "./lib/diag.js";
import { SessionCtx, useHash, makeBus, go } from "./ui/context.js";
import { Login, Join } from "./ui/Auth.jsx";
import { Home } from "./ui/Home.jsx";
import { Timeline } from "./ui/Timeline.jsx";
import { EntryForm } from "./ui/EntryForm.jsx";
import { EntryView } from "./ui/EntryView.jsx";
import { Gallery } from "./ui/Gallery.jsx";
import { Milestones } from "./ui/Milestones.jsx";
import { People } from "./ui/People.jsx";
import { Settings } from "./ui/Settings.jsx";
import { Problems } from "./ui/Problems.jsx";
import { StatusBar } from "./ui/StatusBar.jsx";

// Creates the local database, sync engine and upload queue for the signed-in person.
function useSessionObjects(user) {
  const [session, setSession] = useState(null);
  useEffect(() => {
    if (!user) { setSession(null); return; }
    let dead = false;
    let cleanup = () => {};
    (async () => {
      const db = await createDb();
      const bus = makeBus();
      const engine = createEngine({ pb, db, userId: user.id });
      const queue = createMediaQueue({
        pb, db, userId: user.id, engine,
        onUploaded: async () => bus.emit("data-changed"),
        onAttempt: (ev) => diag.recordUpload(ev),
      });
      const data = createData({ pb, db });
      await queue.refresh();
      if (dead) { db.close(); return; }

      const wake = () => {
        engine.flush().then(() => queue.run()).catch(() => {});
      };
      const onVisible = () => { if (document.visibilityState === "visible") wake(); };
      window.addEventListener("online", wake);
      window.addEventListener("offline", wake);
      document.addEventListener("visibilitychange", onVisible);
      const interval = setInterval(wake, 30_000);
      // Ask the browser not to evict our storage: unsent entries and photos live there.
      const persisted = navigator.storage?.persist ? await navigator.storage.persist().catch(() => false) : false;
      queue.run();
      const syncDone = engine.subscribe(() => { if (engine.getState().pending === 0) queue.run(); });

      cleanup = () => {
        window.removeEventListener("online", wake);
        window.removeEventListener("offline", wake);
        document.removeEventListener("visibilitychange", onVisible);
        clearInterval(interval);
        syncDone();
        engine.stop(); queue.stop();
        db.close();
      };
      setSession({ user, db, engine, queue, data, bus, persisted });
    })();
    return () => { dead = true; cleanup(); };
  }, [user?.id]);
  return session;
}

export default function App() {
  const [user, setUser] = useState(() => (pb.authStore.isValid ? pb.authStore.record : null));
  const [booting, setBooting] = useState(true);
  const hash = useHash();

  useEffect(() => pb.authStore.onChange((_t, rec) => setUser(rec && pb.authStore.isValid ? rec : null)), []);

  // Renew the sign-in when the app opens. A network failure keeps the stored sign-in
  // (the app must open offline); only a real 401 signs the person out.
  useEffect(() => {
    (async () => {
      if (pb.authStore.isValid) {
        try { await pb.collection("users").authRefresh(); }
        catch (err) { if (err?.status === 401 || err?.status === 403 || err?.status === 404) pb.authStore.clear(); }
      }
      setBooting(false);
    })();
  }, []);

  const session = useSessionObjects(user);

  if (booting) return <div className="center muted">Opening…</div>;

  const parts = hash.split("/").filter(Boolean);
  if (parts[0] === "join") return <Join token={parts[1] || ""} user={user} session={session} />;
  if (!user) return <Login />;
  if (!session) return <div className="center muted">Opening your journal…</div>;

  const signOut = async () => {
    const pendingEntries = session.engine.getState().pending + session.engine.getState().rejected;
    const pendingMedia = session.queue.getState().items.length;
    if (pendingEntries + pendingMedia > 0 &&
        !window.confirm(`${pendingEntries + pendingMedia} item(s) have not reached the server yet. Signing out will delete them from this phone. Sign out anyway?`)) return;
    await session.db.clearAll();
    forgetFileToken();
    pb.authStore.clear();
    go("/");
  };

  let screen;
  if (parts[0] === "problems") screen = <Problems />;
  else if (parts[0] === "j" && parts[1]) {
    const jid = parts[1];
    const sub = parts[2];
    if (!sub) screen = <Timeline jid={jid} />;
    else if (sub === "new") screen = <EntryForm jid={jid} />;
    else if (sub === "e" && parts[4] === "edit") screen = <EntryForm jid={jid} cid={parts[3]} />;
    else if (sub === "e") screen = <EntryView jid={jid} cid={parts[3]} />;
    else if (sub === "gallery") screen = <Gallery jid={jid} />;
    else if (sub === "milestones") screen = <Milestones jid={jid} />;
    else if (sub === "people") screen = <People jid={jid} />;
    else if (sub === "settings") screen = <Settings jid={jid} signOut={signOut} />;
    else screen = <Timeline jid={jid} />;
  } else screen = <Home signOut={signOut} />;

  return (
    <SessionCtx.Provider value={session}>
      <StatusBar />
      <main>{screen}</main>
    </SessionCtx.Provider>
  );
}
