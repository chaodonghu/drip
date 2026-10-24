import { createBlobStorage } from "../server/storage-blob.mjs";

// Serves the app shell for /?piece=<id> with that piece's name and cutout in the share tags,
// so a pasted link previews the piece instead of the generic site card.
const storage = createBlobStorage({ token: process.env.BLOB_READ_WRITE_TOKEN });
const LABELS = { upperbody: "Top", wholebody_up: "Jacket", lowerbody: "Bottom", accessories_up: "Accessory", shoes: "Shoes" };
const escape = (value) => String(value).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const meta = (html, attribute, name, content) => html.replace(new RegExp(`<meta ${attribute}="${name}" content="[^"]*" />`), `<meta ${attribute}="${name}" content="${escape(content)}" />`);

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const origin = `${url.protocol}//${url.host}`;
    let html = await (await fetch(`${origin}/index.html`)).text();
    const wanted = url.searchParams.get("piece") || "";
    const records = (await storage.readJson("library/library.json").catch(() => null)) || [];
    const piece = records.find((record) => record.id === wanted || record.id === `import-${wanted}`);
    if (piece) {
      const title = piece.name || "Wardrobe piece";
      const details = [LABELS[piece.part], ...(piece.tags || []).slice(0, 3)].filter(Boolean).join(" \u00b7 ");
      const description = `${details}. A piece in Drip, with a 360 spin.`;
      const image = `${origin}${piece.image}`;
      const link = `${origin}/?piece=${encodeURIComponent(piece.id.replace(/^import-/, ""))}`;
      html = html.replace(/<title>[^<]*<\/title>/, `<title>${escape(title)} \u00b7 Drip</title>`);
      html = meta(html, "name", "description", description);
      html = meta(html, "property", "og:title", title);
      html = meta(html, "property", "og:description", description);
      html = meta(html, "name", "twitter:title", title);
      html = meta(html, "name", "twitter:description", description);
      html = html.replace("<meta name=\"twitter:card\" content=\"summary\" />", [
        "<meta name=\"twitter:card\" content=\"summary\" />",
        `<meta property="og:url" content="${escape(link)}" />`,
        `<meta property="og:image" content="${escape(image)}" />`,
        "<meta property=\"og:image:width\" content=\"1024\" />",
        "<meta property=\"og:image:height\" content=\"1024\" />",
        `<meta name="twitter:image" content="${escape(image)}" />`,
      ].join("\n    "));
    }
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, s-maxage=60, stale-while-revalidate=600" } });
  },
};
