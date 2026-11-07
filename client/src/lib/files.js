// Protected files (display copies, posters, playback) need a short-lived token in the URL.
// Tokens are never written to storage and never cached by the service worker.
let cached = { token: "", at: 0 };

export async function fileToken(pb) {
  if (cached.token && Date.now() - cached.at < 50 * 60_000) return cached.token; // the server issues 1 hour
  const token = await pb.files.getToken();
  cached = { token, at: Date.now() };
  return token;
}
export function forgetFileToken() { cached = { token: "", at: 0 }; }

export function fileUrl(pb, record, filename, token, thumb) {
  if (!record || !filename) return "";
  return pb.files.getURL(record, filename, { token, ...(thumb ? { thumb } : {}) });
}
