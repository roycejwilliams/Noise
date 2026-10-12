// The HTML pages in public/ are only served through their gated routes (server.ts); the static mount must never hand one out
// by filename. Judged on the decoded path, since express.static decodes before it reads the disk (security review,
// 2026-10-12: /phone.htm%6c served the login-only page). Pure. A path that won't decode is refused too.
export function servesHtmlPage(rawPath: string): boolean {
  let p = rawPath;
  for (let i = 0; i < 3; i++) {
    let d: string;
    try {
      d = decodeURIComponent(p);
    } catch {
      return true;
    }
    if (d === p) break;
    p = d;
  }
  p = p.toLowerCase().replace(/[\s./\\]+$/, "");
  return /\.html?$/.test(p) || p.includes("\0");
}
