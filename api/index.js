import { waitUntil } from "@vercel/functions";
import { createImportApi } from "../server/import-api.mjs";
import { createBlobStorage } from "../server/storage-blob.mjs";

const api = createImportApi({
  storage: createBlobStorage({ token: process.env.BLOB_READ_WRITE_TOKEN }),
  setting: (name, fallback = "") => process.env[name] || fallback,
  background: waitUntil,
});

export default {
  fetch(request) {
    return api.handle(request);
  },
};
