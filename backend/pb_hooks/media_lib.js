// Media helpers (architecture v7, section 6). Not auto-loaded; require inside handlers.
//
// External tools: exiftool, ffmpeg, ffprobe, ImageMagick `convert`. All of them parse
// untrusted files, so every call runs under `nice` and, where a `timeout` binary exists
// (GNU timeout, or gtimeout from `brew install coreutils`), under a time limit.
// Production should also run PocketBase as a dedicated low-privilege user (section 6.2).

const ALLOWED = {
  "image/jpeg": "image", "image/png": "image", "image/webp": "image", "image/heic": "image", "image/heif": "image",
  "video/mp4": "video", "video/quicktime": "video", "video/webm": "video",
};
const IMAGE_SECONDS = 60;
const VIDEO_SECONDS = 3600;

let _timeoutBin;
function timeoutBin() {
  if (_timeoutBin !== undefined) return _timeoutBin;
  _timeoutBin = "";
  for (const name of ["timeout", "gtimeout"]) {
    try {
      toString($os.cmd("sh", "-c", "command -v " + name).output());
      _timeoutBin = name;
      break;
    } catch (_) {}
  }
  return _timeoutBin;
}

// Runs a command and returns stdout. Throws with the tool name on failure.
function run(argv, seconds) {
  const full = ["nice", "-n", "10"];
  const tb = seconds ? timeoutBin() : "";
  if (tb) full.push(tb, String(seconds));
  const cmd = $os.cmd(full[0], ...full.slice(1), ...argv);
  try {
    return toString(cmd.output());
  } catch (err) {
    throw new Error(argv[0] + " failed: " + String(err).slice(0, 300));
  }
}

function storagePath(rec, field) {
  return $filepath.join($app.dataDir(), "storage", rec.collection().id, rec.id, rec.getString(field));
}

function sha256File(path) {
  let out;
  try {
    out = run(["sha256sum", path], 600);
  } catch (_) {
    out = run(["shasum", "-a", "256", path], 600); // macOS
  }
  return out.trim().split(/\s+/)[0].toLowerCase();
}

function sniffMime(path) {
  return run(["exiftool", "-s3", "-MIMEType", path], IMAGE_SECONDS).trim().toLowerCase();
}

function exifJSON(path) {
  const out = run(["exiftool", "-json", "-G0", "-n", path], IMAGE_SECONDS);
  const o = JSON.parse(out)[0] || {};
  delete o["SourceFile"];
  return o;
}

// "2026:10:18 14:03:22" -> "2026-10-18 14:03:22.000Z" (no zone in the file: treated as UTC).
function exifDate(s) {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(s || ""));
  if (!m || m[1] === "0000") return "";
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}.000Z`;
}

function pick(meta, names) {
  for (const n of names) {
    for (const k of Object.keys(meta)) {
      if (k.split(":").pop() === n && meta[k] !== undefined && meta[k] !== "") return meta[k];
    }
  }
  return undefined;
}

// Free-space guard (section 6.2). `df -k` has the use percentage in column 5 on Linux and macOS.
function diskUsedPercent() {
  const out = run(["df", "-k", $app.dataDir()], 10).trim().split("\n").pop().trim().split(/\s+/);
  const n = parseInt(String(out[4]).replace("%", ""), 10);
  return isNaN(n) ? 0 : n;
}

// Device and location details that must never appear in a viewer-visible file.
const LEAK_KEY = /^(GPS.*|Location|Coordinates|Make|Model|LensMake|LensModel|LensID|HostComputer|Software|DeviceManufacturer|DeviceModelName|.*SerialNumber)$/i;
function leakedKeys(path) {
  return Object.keys(exifJSON(path)).filter((k) => LEAK_KEY.test(k.split(":").pop()));
}

function probeVideo(path) {
  const j = JSON.parse(run(["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", path], IMAGE_SECONDS));
  const streams = j.streams || [];
  const v = streams.filter((s) => s.codec_type === "video" && !(s.disposition && s.disposition.attached_pic))[0];
  const a = streams.filter((s) => s.codec_type === "audio")[0];
  if (!v) throw new Error("no video stream");
  return {
    vcodec: v.codec_name, acodec: a ? a.codec_name : "", width: v.width, height: v.height,
    duration: parseFloat((j.format && j.format.duration) || v.duration || "0") || 0,
  };
}

// Builds the viewer-safe files for one media row. The original is never touched.
// A derived file that still carries location or device tags is discarded and the
// derive is reported as failed, so metadata can never leak by accident.
function deriveMedia(app, mediaId) {
  const media = app.findRecordById("media", mediaId);
  const orig = app.findFirstRecordByFilter("media_originals", "media = {:m}", { m: mediaId });
  const src = storagePath(orig, "file");
  const tmp = $filepath.join($os.getenv("TMPDIR") || "/tmp", "bj-derive-" + $security.randomString(16));
  $os.mkdirAll(tmp, 0o700);
  try {
    const attach = {};
    if (media.getString("kind") === "image") {
      const out = $filepath.join(tmp, "display.jpg");
      run(["convert", src + "[0]", "-auto-orient", "-resize", "2560x2560>", "+profile", "!icc,*", "-quality", "88", out], IMAGE_SECONDS);
      attach.display = out;
      const dm = exifJSON(out);
      const w = pick(dm, ["ImageWidth"]), h = pick(dm, ["ImageHeight"]);
      if (w && h) { media.set("width", w); media.set("height", h); }
    } else {
      const info = probeVideo(src);
      const webOk = ["vp8", "vp9", "av1"].indexOf(info.vcodec) !== -1 && (!info.acodec || ["opus", "vorbis"].indexOf(info.acodec) !== -1);
      const copyOk = info.vcodec === "h264" && (!info.acodec || ["aac", "mp3"].indexOf(info.acodec) !== -1);
      const ext = webOk ? "webm" : "mp4";
      const out = $filepath.join(tmp, "playback." + ext);
      const args = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", src,
        "-map", "0:v:0", "-map", "0:a:0?", "-map_metadata", "-1", "-map_chapters", "-1",
        "-metadata:s:v:0", "handler_name=", "-metadata:s:a:0", "handler_name="];
      if (copyOk || webOk) args.push("-c", "copy"); // stream copy: no re-encoding
      else args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k");
      if (ext === "mp4") args.push("-movflags", "+faststart");
      args.push(out);
      run(args, VIDEO_SECONDS);
      attach.playback = out;

      const poster = $filepath.join(tmp, "poster.jpg");
      const at = Math.min(1, info.duration / 2).toFixed(2);
      run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-ss", at, "-i", src, "-frames:v", "1",
        "-vf", "scale='min(1280,iw)':-2", "-map_metadata", "-1", "-q:v", "3", poster], VIDEO_SECONDS);
      attach.poster = poster;
      media.set("duration", info.duration);
      if (!media.getInt("width")) { media.set("width", info.width); media.set("height", info.height); }
    }

    for (const field of Object.keys(attach)) {
      const bad = leakedKeys(attach[field]);
      if (bad.length) throw new Error("metadata still present in " + field + ": " + bad.join(", "));
    }
    for (const field of Object.keys(attach)) media.set(field, $filesystem.fileFromPath(attach[field]));
    media.set("derive_status", "ready");
    media.set("derive_error", "");
    app.save(media);
    return true;
  } catch (err) {
    media.set("derive_status", "failed");
    media.set("derive_error", String(err).slice(0, 480));
    app.save(media);
    return false;
  } finally {
    try { $os.removeAll(tmp); } catch (_) {}
  }
}

module.exports = {
  ALLOWED, run, storagePath, sha256File, sniffMime, exifJSON, exifDate, pick,
  diskUsedPercent, leakedKeys, probeVideo, deriveMedia,
};
