import { BlobNotFoundError, del, get, head, list, put } from "@vercel/blob";

export function createBlobStorage({ token }) {
  if (!token) throw new Error("BLOB_READ_WRITE_TOKEN is not configured");
  const auth = { token };

  async function readBytes(key) {
    // Skip the cache so a poll never sees a stale job.json.
    const result = await get(key, { ...auth, access: "private", useCache: false });
    if (!result?.stream) return null;
    return Buffer.from(await new Response(result.stream).arrayBuffer());
  }

  async function writeBytes(key, bytes, contentType) {
    await put(key, bytes, { ...auth, access: "private", addRandomSuffix: false, allowOverwrite: true, contentType });
  }

  async function listAll(prefix) {
    const blobs = [];
    let cursor;
    do {
      const page = await list({ ...auth, prefix, cursor });
      blobs.push(...page.blobs);
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return blobs;
  }

  return {
    modelReference: "models/ in Blob storage (upload them with npm run publish-data)",
    async readJson(key) {
      const bytes = await readBytes(key);
      return bytes === null ? null : JSON.parse(bytes.toString("utf8"));
    },
    writeJson: (key, value) => writeBytes(key, `${JSON.stringify(value, null, 2)}\n`, "application/json"),
    readBytes,
    writeBytes,
    async exists(key) {
      try { await head(key, auth); return true; }
      catch (error) { if (error instanceof BlobNotFoundError) return false; throw error; }
    },
    remove: (key) => del(key, auth),
    async removePrefix(prefix) {
      const urls = (await listAll(prefix)).map((blob) => blob.url);
      if (urls.length) await del(urls, auth);
    },
    async listModels() {
      return (await listAll("models/")).map((blob) => blob.pathname).filter((name) => /\.(png|jpe?g|webp)$/i.test(name)).sort();
    },
    async listJobIds() {
      return (await listAll("jobs/"))
        .map((blob) => blob.pathname.match(/^jobs\/([^/]+)\/job\.json$/)?.[1])
        .filter(Boolean);
    },
  };
}
