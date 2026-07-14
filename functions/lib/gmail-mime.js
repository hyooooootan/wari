function decodeBase64Url(value) {
  if (!value) return "";
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(normalized), (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function extractGmailText(payload) {
  const plain = [];
  const html = [];
  const visit = (part) => {
    if (!part || typeof part !== "object") return;
    const type = String(part.mimeType || "").toLowerCase();
    if (type === "text/plain" && part.body?.data) plain.push(decodeBase64Url(part.body.data));
    else if (type === "text/html" && part.body?.data) html.push(stripHtml(decodeBase64Url(part.body.data)));
    for (const child of part.parts || []) visit(child);
  };
  visit(payload);
  return plain.join("\n").trim() || html.join("\n").trim();
}

function stripHtml(value) {
  return value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&#39;/g, "'").replace(/&quot;/gi, '"');
}

export { decodeBase64Url };
