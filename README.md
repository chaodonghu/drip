<div align="center">

# Wardrobe

Your clothes, extracted and organized with gpt-image.

[![License: MIT](https://img.shields.io/badge/license-MIT-191919?style=flat-square)](LICENSE)
[![Node 22+](https://img.shields.io/badge/node-22%2B-191919?style=flat-square)](package.json)

[See the original post →](https://x.com/cdngdev/status/2076812846793650485)

</div>

![Wardrobe gallery](docs/screenshots/gallery.png)

![Modeled wardrobe editor](docs/screenshots/editor.png)

## Quick start

```bash
git clone https://github.com/chaodonghu/wardrobe.git
cd wardrobe
npm install
cp .env.example .env
npm run dev
```

⚠️ The importer stays disabled until you add `OPENAI_API_KEY` to `.env` and place a PNG reference photo of yourself at `data/model-reference.png`.

Open [localhost:5173](http://localhost:5173).

## Import with Codex

This repo includes two Codex skills: one imports clothes and generates modeled item photos; the other styles complete outfits and generates a modeled lookbook.

```text
$import-clothes Import the clothes from ~/Pictures/outfits, create modeled photos, and add them to this wardrobe.
$generate-outfits Create modeled outfit ideas from my wardrobe.
```

Open the cloned repo in Codex and run either prompt. The import skill asks for a local model-reference PNG when needed, reviews every cutout and modeled photo, then writes to `data/library.json` and `data/imported/`. The outfit skill asks how many looks to create, then curates, generates, verifies, and saves the complete collection under `data/`.

### For agents

If you are setting up Wardrobe for a user, ask how they want to import their clothes:

- **Codex:** Ask for a folder or camera-roll location and a model-reference PNG, then extract, model, and import the individual pieces by following [the bundled import skill](.agents/skills/import-clothes/SKILL.md). Afterward, offer to create a requested number of modeled looks with [the outfit-generation skill](.agents/skills/generate-outfits/SKILL.md).
- **Web UI:** Help the user configure their own `OPENAI_API_KEY` and `data/model-reference.png`, then let them import through the app.

## What it does

- Detects every garment in a photo with the OpenAI Responses API
- Extracts clean product cutouts with the OpenAI Images API
- Generates an optional modeled editorial preview
- Keeps originals, jobs, generated images, and the JSON database local in `data/`
- Supports drag, drop, paste, editing, review, regeneration, and approval

## Configuration

| Variable | Default |
| --- | --- |
| `OPENAI_API_KEY` | Required |
| `OPENAI_VISION_MODEL` | `gpt-5.4-mini` |
| `OPENAI_IMAGE_MODEL` | `gpt-image-2` |
| `OPENAI_IMAGE_QUALITY` | `high` |
| `WARDROBE_MODEL_REFERENCE` | `data/model-reference.png` |
| `WARDROBE_DATA_DIR` | `data` |
| `WARDROBE_IMPORT_SECRET` | Unset. Required on Vercel |
| `WARDROBE_STORAGE` | Unset, which uses `data/`. Set `blob` to use Vercel Blob |
| `BLOB_READ_WRITE_TOKEN` | Written to `.env.local` by `vercel env pull` |

## Deploy to Vercel

The hosted app runs the import API as one Vercel function. It keeps the library, import jobs, and your reference photo in a private Vercel Blob store. Anyone with the URL can view the gallery. Creating, approving, and deleting items needs the import secret.

`scripts/setup-vercel.sh` runs every step below in one go after `vercel login`. The manual steps follow.

1. Link the project.

   ```bash
   vercel link
   ```

2. Create a private Blob store and connect it to every environment. Connecting the store adds `BLOB_READ_WRITE_TOKEN` to the project.

   ```bash
   vercel blob create-store wardrobe --access private --yes
   ```

3. Add the OpenAI key and an import secret to Production. Add `OPENAI_VISION_MODEL`, `OPENAI_IMAGE_MODEL`, or `OPENAI_IMAGE_QUALITY` the same way to override the defaults.

   ```bash
   vercel env add OPENAI_API_KEY production
   vercel env add WARDROBE_IMPORT_SECRET production
   ```

4. Pull the Blob token into `.env.local`, then upload your reference photo and your local library.

   ```bash
   vercel env pull .env.local
   npm run publish-data
   ```

   The script resizes the reference photo to 2048 px on the long edge before it uploads. It also replaces the hosted `library.json` with your local copy, so run it before you import from the hosted app.

5. Deploy.

   ```bash
   vercel deploy --prod
   ```

6. Open the deployed app on your phone, open the import panel, and enter the import secret. The browser remembers it.

Vercel stops a function after 300 seconds. If a generation step runs out of time, the job shows "Generation timed out. Try regenerating." six minutes after the step started.

## License

[MIT](LICENSE)
