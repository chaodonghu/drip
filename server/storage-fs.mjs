import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const MODEL_REFERENCE_KEY = "model-reference.png";

export function createFsStorage({ root = process.cwd(), dataDir = "data", modelReference = "data/model-reference.png" } = {}) {
  const dataRoot = path.resolve(root, dataDir);
  const jobsDir = path.join(dataRoot, "jobs");
  const modelsDir = path.join(dataRoot, "models");
  const modelReferencePath = path.resolve(root, modelReference);

  // library.json and imported/ sit directly under the data dir because the bundled Codex skills write that layout.
  function file(key) {
    if (key === MODEL_REFERENCE_KEY) return modelReferencePath;
    if (key.startsWith("models/")) return path.join(modelsDir, key.slice("models/".length));
    if (key === "library/library.json") return path.join(dataRoot, "library.json");
    if (key.startsWith("library/")) return path.join(dataRoot, "imported", key.slice("library/".length));
    if (key.startsWith("jobs/")) return path.join(dataRoot, key);
    throw new Error(`Unknown storage key ${key}`);
  }

  async function readOrNull(key, encoding) {
    try { return await readFile(file(key), encoding); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }

  async function atomicWrite(target, contents) {
    await mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${randomUUID()}.tmp`;
    await writeFile(tmp, contents);
    try {
      await rename(tmp, target);
    } catch (error) {
      if (!["EBUSY", "EXDEV", "EPERM"].includes(error.code)) {
        await rm(tmp, { force: true });
        throw error;
      }
      await copyFile(tmp, target);
      await rm(tmp, { force: true });
    }
  }

  return {
    modelReference: `${path.relative(root, modelsDir)}/ (or ${modelReference})`,
    async readJson(key) {
      const text = await readOrNull(key, "utf8");
      return text === null ? null : JSON.parse(text);
    },
    async writeJson(key, value) {
      await atomicWrite(file(key), `${JSON.stringify(value, null, 2)}\n`);
    },
    readBytes: (key) => readOrNull(key),
    async writeBytes(key, bytes) {
      const target = file(key);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes);
    },
    async exists(key) {
      try { return (await stat(file(key))).isFile(); }
      catch (error) { if (error.code === "ENOENT") return false; throw error; }
    },
    async remove(key) {
      await rm(file(key), { force: true });
    },
    async removePrefix(prefix) {
      await rm(file(prefix.replace(/\/$/, "")), { recursive: true, force: true });
    },
    async listModels() {
      const names = await readdir(modelsDir).catch(() => []);
      return names.filter((name) => /\.(png|jpe?g|webp)$/i.test(name)).sort().map((name) => `models/${name}`);
    },
    async listJobIds() {
      const ids = await readdir(jobsDir).catch(() => []);
      const present = await Promise.all(ids.map(async (id) => (await stat(path.join(jobsDir, id, "job.json")).catch(() => null))?.isFile()));
      return ids.filter((_, index) => present[index]);
    },
  };
}
