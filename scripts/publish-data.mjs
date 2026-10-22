import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { loadEnv } from "vite";
import { normalizeImage } from "../server/import-api.mjs";
import { createBlobStorage } from "../server/storage-blob.mjs";

const root = process.cwd();
const env = loadEnv("development", root, "");
const setting = (name, fallback) => env[name] || fallback;
const dataDir = path.resolve(root, setting("WARDROBE_DATA_DIR", "data"));
const storage = createBlobStorage({ token: setting("BLOB_READ_WRITE_TOKEN") });

async function upload(key, bytes, contentType) {
  await storage.writeBytes(key, bytes, contentType);
  console.log(`${key} ${bytes.length} bytes`);
}

const reference = await readFile(path.resolve(root, setting("WARDROBE_MODEL_REFERENCE", "data/model-reference.png")));
await upload("model-reference.png", await normalizeImage(reference), "image/png");
await upload("library/library.json", await readFile(path.join(dataDir, "library.json")), "application/json");
for (const name of (await readdir(path.join(dataDir, "imported"))).filter((file) => file.endsWith(".png")).sort()) {
  await upload(`library/${name}`, await readFile(path.join(dataDir, "imported", name)), "image/png");
}
