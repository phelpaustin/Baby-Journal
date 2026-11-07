import { useEffect, useState } from "react";
import { useSession, useEngineState, useQueueState } from "./context.js";
import { ST } from "../lib/sync.js";
import { pb } from "../lib/pb.js";

export function StatusBar() {
  const { data, persisted } = useSession();
  const s = useEngineState();
  const q = useQueueState();
  const [backup, setBackup] = useState(null);

  useEffect(() => {
    let dead = false;
    const load = () => data.backupStatus().then((b) => { if (!dead) setBackup(b); }).catch(() => {});
    load();
    const t = setInterval(load, 10 * 60_000);
    return () => { dead = true; clearInterval(t); };
  }, [data]);

  const msgs = [];
  if (s.status === ST.AUTH) {
    msgs.push({ cls: "bad", text: "Your sign-in has expired. Your changes are saved on this phone. Sign in again to send them.", action: ["Sign in", () => pb.authStore.clear()] });
  } else if (s.status === ST.OFFLINE) {
    msgs.push({ cls: "warn", text: "No internet. Your changes are saved on this phone and will be sent when you are back online." });
  } else if (s.status === ST.SERVER_DOWN) {
    msgs.push({ cls: "warn", text: "Can't reach the journal right now. Your changes are safe on this phone and will be sent automatically." });
  } else if (s.pending > 0) {
    msgs.push({ cls: "info", text: `Sending ${s.pending} change${s.pending === 1 ? "" : "s"}…` });
  }
  if (s.rejected + s.blocked > 0) {
    msgs.push({ cls: "bad", text: `${s.rejected + s.blocked} change${s.rejected + s.blocked === 1 ? "" : "s"} could not be saved.`, link: ["#/problems", "Review"] });
  }
  const failed = q.items.filter((i) => i.status === "failed" || i.status === "paused");
  if (failed.length) msgs.push({ cls: "bad", text: `${failed.length} file${failed.length === 1 ? "" : "s"} could not be uploaded yet.`, link: ["#/problems", "Review"] });
  const active = q.items.filter((i) => ["queued", "hashing", "uploading", "waiting_entry"].includes(i.status));
  if (active.length) {
    const cur = active.find((i) => i.status === "uploading") || active[0];
    const pct = cur.status === "uploading" ? ` ${Math.round((cur.progress || 0) * 100)}%` : "";
    msgs.push({ cls: "info", text: `Uploading ${active.length} file${active.length === 1 ? "" : "s"}${pct}. Keep the app open until it finishes.` });
  }
  if (backup && backup.level === "critical") msgs.push({ cls: "bad", text: "There has been no verified offsite backup for over 24 hours. Tell the journal owner." });
  else if (backup && backup.level === "warning") msgs.push({ cls: "warn", text: "The last offsite backup was over 18 hours ago." });
  if (persisted === false) msgs.push({ cls: "info", text: "This browser may clear unsent photos if storage runs low. Installing the app to your home screen helps." });

  if (!msgs.length) return null;
  return (
    <div className="statusbar" role="status" aria-live="polite">
      {msgs.map((m, i) => (
        <div key={i} className={"msg " + m.cls}>
          <span>{m.text}</span>
          {m.link && <a href={m.link[0]}>{m.link[1]}</a>}
          {m.action && <button onClick={m.action[1]}>{m.action[0]}</button>}
        </div>
      ))}
    </div>
  );
}
