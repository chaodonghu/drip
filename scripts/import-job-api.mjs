import { Readable } from "node:stream";
import { createImportApi } from "../server/import-api.mjs";
import { createBlobStorage } from "../server/storage-blob.mjs";
import { createFsStorage } from "../server/storage-fs.mjs";

function toRequest(req) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  const hasBody = !["GET", "HEAD"].includes(req.method);
  return new Request(`http://${req.headers.host || "localhost"}${req.url}`, {
    method: req.method,
    headers,
    body: hasBody ? Readable.toWeb(req) : undefined,
    duplex: "half",
  });
}

async function sendResponse(res, response) {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => res.setHeader(name, value));
  res.end(Buffer.from(await response.arrayBuffer()));
}

export function wardrobeImportApi(options = {}) {
  let api;
  const setting = (name, fallback = "") => options.env?.[name] || process.env[name] || fallback;

  async function handler(req, res, next) {
    if (!req.url.startsWith("/api/import/")) return next();
    try {
      await sendResponse(res, await api.handle(toRequest(req)));
    } catch (error) {
      next(error);
    }
  }

  return {
    name: "wardrobe-import-job-api",
    apply: "serve",
    async configResolved(config) {
      const storage = setting("WARDROBE_STORAGE") === "blob"
        ? createBlobStorage({ token: setting("BLOB_READ_WRITE_TOKEN") })
        : createFsStorage({ root: config.root, dataDir: setting("WARDROBE_DATA_DIR", "data"), modelReference: setting("WARDROBE_MODEL_REFERENCE", "data/model-reference.png") });
      api = createImportApi({ storage, setting, background: (promise) => { promise.catch(() => {}); } });
      await api.recoverJobs();
    },
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}
