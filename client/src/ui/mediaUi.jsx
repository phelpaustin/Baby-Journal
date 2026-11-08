import { useEffect, useState } from "react";
import { pb } from "../lib/pb.js";
import { fileToken, fileUrl } from "../lib/files.js";
import { diag } from "../lib/diag.js";

// A protected file URL: needs a token, so it is built after the token arrives. The URL is
// kept once built, so an image that is already shown never flickers when the token rotates.
export function useFileUrl(record, field, thumb) {
  const [url, setUrl] = useState("");
  const name = record && record[field];
  useEffect(() => {
    let dead = false;
    if (!record || !name) { setUrl(""); return; }
    fileToken(pb).then((t) => { if (!dead) setUrl(fileUrl(pb, record, name, t, thumb)); }).catch(() => { if (!dead) setUrl(""); });
    return () => { dead = true; };
  }, [record?.id, name, thumb]); // eslint-disable-line
  return url;
}

// Thumbnail of one media row (photo display copy, or video poster).
export function MediaThumb({ media, size = "320x0", onClick, alt }) {
  const field = media.kind === "video" ? "poster" : "display";
  const url = useFileUrl(media, field, size);
  const preparing = media.derive_status !== "ready" && !media[field];
  return (
    <button className="thumb" onClick={onClick} aria-label={alt || media.caption || (media.kind === "video" ? "Video" : "Photo")}>
      {url ? <img src={url} alt={media.caption || ""} loading="lazy" onLoad={() => diag.markThumbnail()} /> : <span className="muted small">{preparing ? "Preparing…" : "Offline"}</span>}
      {media.kind === "video" && <span className="play" aria-hidden="true">▶</span>}
    </button>
  );
}

export function Lightbox({ media, onClose, onPrev, onNext, editor }) {
  const [caption, setCaption] = useState(media.caption || "");
  useEffect(() => setCaption(media.caption || ""), [media.id]); // eslint-disable-line
  const isVideo = media.kind === "video";
  const src = useFileUrl(media, isVideo ? "playback" : "display");
  const poster = useFileUrl(media, "poster", "800x0");
  useEffect(() => {
    const k = (e) => { if (e.key === "Escape") onClose(); if (e.key === "ArrowLeft" && onPrev) onPrev(); if (e.key === "ArrowRight" && onNext) onNext(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose, onPrev, onNext]);
  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label="Media viewer">
      <button className="close" onClick={onClose} aria-label="Close">✕</button>
      {onPrev && <button className="nav prev" onClick={onPrev} aria-label="Previous">‹</button>}
      {onNext && <button className="nav next" onClick={onNext} aria-label="Next">›</button>}
      <div className="stage">
        {!src ? <p className="muted">Loading…</p> : isVideo
          ? <video src={src} poster={poster} controls playsInline preload="metadata" />
          : <img src={src} alt={media.caption || ""} />}
        {editor ? (
          <div className="caption-edit">
            <input value={caption} maxLength={1000} placeholder="Add a caption" onChange={(e) => setCaption(e.target.value)} aria-label="Caption" />
            <button onClick={() => editor.onCaption(caption)}>Save caption</button>
            <button className="danger" onClick={editor.onRemove}>Remove</button>
          </div>
        ) : media.caption && <p className="caption">{media.caption}</p>}
      </div>
    </div>
  );
}
