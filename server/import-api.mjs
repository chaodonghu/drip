import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";
import OpenAI from "openai";
import sharp from "sharp";

const API_ROOT = "/api/import/jobs";
const ASSET_ROOT = "/api/import/assets";
const LIBRARY_ASSET_ROOT = "/api/import/library";
const LIBRARY_KEY = "library/library.json";
const MODEL_REFERENCE_KEY = "model-reference.png";
const STAGES = new Set(["crop", "garment", "modeled"]);
const DECISIONS = new Set(["approve", "reject"]);
const PARTS = new Set(["upperbody", "wholebody_up", "lowerbody", "accessories_up", "shoes"]);
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const STUCK_AFTER_MS = 6 * 60 * 1000;
const UPLOAD_MODES = new Set(["angles", "separate"]);
const MAX_UPLOAD_IMAGES = 4;
const TURNAROUND_COLUMNS = 4;
const TURNAROUND_ROWS = 2;
// The sheet is keyed like garments are, so the frames sit on whatever surface the viewer gives them.
const turnaroundPrompt = (chromaKey) => `Create a photographic turnaround sheet of the person in Image 1 wearing the exact garment from Image 2. Eight full-body views of the same person, same relaxed natural standing pose with arms at the sides, head level and a calm neutral expression, same lighting, same scale, evenly spaced at 45 degree steps: front, front-left, left, back-left, back, back-right, right, front-right. Arrange them in two rows of four on a perfectly flat, absolutely uniform solid ${chromaKey} chroma-key background, edge to edge, with thin even gaps of the same ${chromaKey} color between the views. No floor, no shadows, no dividing lines, no text or labels. Use no ${chromaKey} anywhere on the person or the garment. Preserve the person's build, height, skin tone and proportions and every garment detail including the back of the garment. Do not reproduce the person's face: give the figure a neutral, generic face with no resemblance to Image 1. The person wears no hat or beanie; they have a medium-length flow haircut with natural dark hair.`;

const jobKey = (id, name) => `jobs/${id}/${name}`;
const turnaroundFiles = (itemId) => [
  `${itemId}-turnaround.png`,
  ...Array.from({ length: TURNAROUND_COLUMNS * TURNAROUND_ROWS }, (_, index) => `${itemId}-turn-${index + 1}.png`),
];
const assetName = (url) => path.basename(new URL(url, "http://localhost").pathname);

function json(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function body(request, limit = 25 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  if (request.body) {
    for await (const chunk of request.body) {
      size += chunk.length;
      if (size > limit) throw Object.assign(new Error("Request body too large"), { status: 413 });
      chunks.push(chunk);
    }
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("Expected a JSON request body"), { status: 400 }); }
}

function sameSecret(provided, expected) {
  const digest = (value) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(provided), digest(expected));
}

function publicJob(job) {
  const copy = structuredClone(job);
  delete copy.internal;
  return copy;
}

function extension(mime = "image/png") {
  return ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" })[mime] || "png";
}

function decodeImage(raw, fallbackMime) {
  if (!raw || typeof raw !== "string") throw Object.assign(new Error("imageDataUrl, imageDataUrls, or imageBase64 is required"), { status: 400 });
  const match = raw.match(/^data:([^;]+);base64,(.+)$/s);
  const mime = match?.[1] || fallbackMime || "image/png";
  const data = Buffer.from(match?.[2] || raw, "base64");
  if (!data.length) throw Object.assign(new Error("Image payload is empty"), { status: 400 });
  return { data, mime };
}

function decodeImages(input) {
  const raws = input.imageDataUrls ?? [input.imageDataUrl || input.imageBase64];
  if (!Array.isArray(raws) || !raws.length) throw Object.assign(new Error("imageDataUrls must be a non-empty array"), { status: 400 });
  // Vercel rejects bodies over 4.5 MB, which caps one upload at four downscaled photos.
  if (raws.length > MAX_UPLOAD_IMAGES) throw Object.assign(new Error(`Send at most ${MAX_UPLOAD_IMAGES} photos per upload.`), { status: 413 });
  return raws.map((raw) => decodeImage(raw, input.mimeType));
}

function normalizeMetadata(value = {}) {
  const metadata = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const color = typeof metadata.color === "string" && HEX_COLOR.test(metadata.color) ? metadata.color.toLowerCase() : "#d8d0c2";
  const secondaryColor = typeof metadata.secondaryColor === "string" && HEX_COLOR.test(metadata.secondaryColor) ? metadata.secondaryColor.toLowerCase() : null;
  return {
    name: cleanName(metadata.name),
    part: PARTS.has(metadata.part) ? metadata.part : "upperbody",
    color,
    secondaryColor,
    tags: Array.isArray(metadata.tags) ? metadata.tags.filter((tag) => typeof tag === "string").map((tag) => tag.trim().toLowerCase().slice(0, 40)).filter(Boolean).slice(0, 12) : [],
    boundingBox: normalizeBoundingBox(metadata.boundingBox),
  };
}

function normalizeBoundingBox(value = {}) {
  const box = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const number = (key, fallback) => Number.isFinite(Number(box[key])) ? Math.round(Number(box[key])) : fallback;
  const x = Math.max(0, Math.min(999, number("x", 0)));
  const y = Math.max(0, Math.min(999, number("y", 0)));
  const width = Math.max(1, Math.min(1000 - x, number("width", 1000 - x)));
  const height = Math.max(1, Math.min(1000 - y, number("height", 1000 - y)));
  return { x, y, width, height };
}


export async function normalizeImage(bytes) {
  return sharp(bytes)
    .rotate()
    .resize(2048, 2048, { fit: "inside", withoutEnlargement: true })
    .toColorspace("srgb")
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function cropDetectedItem(bytes, boundingBox) {
  const normalized = await normalizeImage(bytes);
  const { width, height } = await sharp(normalized).metadata();
  const box = normalizeBoundingBox(boundingBox);
  const rawLeft = (box.x / 1000) * width;
  const rawTop = (box.y / 1000) * height;
  const rawWidth = (box.width / 1000) * width;
  const rawHeight = (box.height / 1000) * height;
  const padding = Math.max(12, Math.round(Math.max(rawWidth, rawHeight) * 0.08));
  const left = Math.max(0, Math.floor(rawLeft - padding));
  const top = Math.max(0, Math.floor(rawTop - padding));
  const right = Math.min(width, Math.ceil(rawLeft + rawWidth + padding));
  const bottom = Math.min(height, Math.ceil(rawTop + rawHeight + padding));
  return sharp(normalized).extract({ left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) }).png().toBuffer();
}

function chooseChromaKey(primary = "#808080") {
  const value = HEX_COLOR.test(primary) ? primary : "#808080";
  const source = [1, 3, 5].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16));
  const candidates = [[0, 255, 0], [255, 0, 255], [0, 255, 255]];
  const selected = candidates.sort((a, b) => {
    const distance = (color) => color.reduce((total, channel, index) => total + ((channel - source[index]) ** 2), 0);
    return distance(b) - distance(a);
  })[0];
  return `#${selected.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

// Lookups sometimes append notes in brackets or a colorway after a dash. The name keeps only the product title.
export function cleanName(value) {
  if (typeof value !== "string") return "New piece";
  const cleaned = value.replace(/\s*[([{][^)\]}]*[)\]}]?/g, " ").replace(/\s+[-\u2013|]\s+.*$/, "").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 80) || "New piece";
}

export function buildGarmentPrompt(metadata = {}, chromaKey = "#00ff00", imageCount = 1) {
  const name = metadata.name || "clothing item";
  const category = metadata.part || "wardrobe item";
  const primary = metadata.color || "the exact visible color";
  const secondary = metadata.secondaryColor ? ` with distinct secondary color ${metadata.secondaryColor}` : "";
  const details = Array.isArray(metadata.tags) && metadata.tags.length
    ? metadata.tags.join(", ")
    : "all visible construction and design details";
  const angles = imageCount > 1
    ? "\n\nOther angles: Every image after the first shows the same garment from another angle, so produce one front-facing cutout that stays faithful to every visible detail across all of them."
    : "";

  return `Use case: background-extraction
Asset type: ecommerce catalog product cutout source

Input image: The reference photograph shows the exact garment, either by itself or worn by a person. Use it only to identify and reconstruct the garment.${angles}

Primary request: Reconstruct ONLY the complete empty ${name} (${category}) as a clean, front-facing ecommerce catalog product photograph. If a wearer is present, remove them. Remove every other garment, object, and background element. Show the complete item naturally arranged and symmetrical, with no person, body, mannequin, or hanger visible.

Garment fidelity: Preserve the reference garment's exact primary color ${primary}${secondary}, material and texture, silhouette, neckline, sleeves, fastenings, pattern, and distinctive details (${details}). Preserve any clearly legible existing graphic or logo exactly, in the exact colors seen in the photograph, but do not invent or reinterpret uncertain logos, text, pockets, seams, hardware, colors, or decoration.

Color source: Every color comes from the photograph, never from your knowledge of this product. The photographed piece may be a different colorway from the one usually sold, so if a graphic, logo, text or trim is red in the photo it stays red even if the product is known in gold. Do not recolor, restyle or substitute the catalog version.

Composition: Centered straight-on product view. Keep the entire garment inside the frame with generous, even padding on every side. No cropping or truncation.

Background: Perfectly flat, absolutely uniform solid ${chromaKey} chroma-key color, edge-to-edge. No shadows, gradient, texture, vignette, floor, horizon, reflection, or lighting variation.

Lighting: Neutral diffuse product lighting contained on the garment only.

Avoid: person, body, skin, hair, mannequin, hanger, props, other garments, retail tags, cast shadow, contact shadow, reflection, watermark, caption, border, background variation, or chroma spill.

Critical: Use no ${chromaKey} anywhere in the garment. Produce exactly one complete garment with a crisp, separable outer silhouette.`;
}

function cleanupTolerance(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(18, Math.min(110, Math.round(parsed))) : 46;
}

function removeKeyedSpill(data, index, keyedChannels, neutralLevel) {
  let remaining = Math.ceil(keyedChannels.reduce((total, channel) => total + data[index + channel], 0) - (neutralLevel * keyedChannels.length));
  let active = keyedChannels.filter((channel) => data[index + channel] > 0);
  while (remaining > 0 && active.length) {
    const share = Math.ceil(remaining / active.length);
    const next = [];
    for (const channel of active) {
      const reduction = Math.min(data[index + channel], share, remaining);
      data[index + channel] -= reduction;
      remaining -= reduction;
      if (data[index + channel] > 0) next.push(channel);
    }
    active = next;
  }
}

export async function processChromaBackground(bytes, key, options = {}) {
  const tolerance = cleanupTolerance(options.tolerance);
  const feather = 80;
  const target = [1, 3, 5].map((offset) => Number.parseInt(key.slice(offset, offset + 2), 16));
  const keyedChannels = target.map((channel, index) => channel > 200 ? index : null).filter((index) => index !== null);
  const neutralChannels = target.map((channel, index) => channel < 55 ? index : null).filter((index) => index !== null);
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let index = 0; index < data.length; index += 4) {
    const distance = Math.sqrt(
      ((data[index] - target[0]) ** 2)
      + ((data[index + 1] - target[1]) ** 2)
      + ((data[index + 2] - target[2]) ** 2),
    );
    if (distance <= tolerance) {
      data[index] = 0;
      data[index + 1] = 0;
      data[index + 2] = 0;
      data[index + 3] = 0;
    } else {
      if (distance < tolerance + feather) data[index + 3] = Math.round(data[index + 3] * ((distance - tolerance) / feather));
      const keyedLevel = keyedChannels.reduce((total, channel) => total + data[index + channel], 0) / keyedChannels.length;
      const neutralLevel = neutralChannels.reduce((total, channel) => total + data[index + channel], 0) / neutralChannels.length;
      const spill = Math.max(0, keyedLevel - neutralLevel);
      if (spill > 0) {
        const spillAlpha = Math.max(0, 1 - (Math.max(0, spill - 4) / 150));
        data[index + 3] = Math.round(data[index + 3] * spillAlpha);
        removeKeyedSpill(data, index, keyedChannels, neutralLevel);
      }
      if (data[index + 3] <= 8) {
        data[index] = 0;
        data[index + 1] = 0;
        data[index + 2] = 0;
        data[index + 3] = 0;
      }
    }
  }
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] === 0) continue;
    const keyedLevel = keyedChannels.reduce((total, channel) => total + data[index + channel], 0) / keyedChannels.length;
    const neutralLevel = neutralChannels.reduce((total, channel) => total + data[index + channel], 0) / neutralChannels.length;
    const residualSpill = Math.max(0, keyedLevel - neutralLevel);
    if (residualSpill > 0) {
      removeKeyedSpill(data, index, keyedChannels, neutralLevel);
    }
  }
  const keyedOutput = await sharp(data, { raw: info }).png().toBuffer();
  if (options.frame === false) return { bytes: keyedOutput, verification: await verifyNoChromaSpill(keyedOutput, key), tolerance };
  const framedOutput = await frameTransparentGarment(keyedOutput);
  const { data: framedData, info: framedInfo } = await sharp(framedOutput).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let index = 0; index < framedData.length; index += 4) {
    if (framedData[index + 3] === 0) continue;
    const keyedLevel = keyedChannels.reduce((total, channel) => total + framedData[index + channel], 0) / keyedChannels.length;
    const neutralLevel = neutralChannels.reduce((total, channel) => total + framedData[index + channel], 0) / neutralChannels.length;
    const residualSpill = Math.max(0, keyedLevel - neutralLevel);
    if (residualSpill <= 0) continue;
    removeKeyedSpill(framedData, index, keyedChannels, neutralLevel);
  }
  const output = await sharp(framedData, { raw: framedInfo }).png().toBuffer();
  const verification = await verifyNoChromaSpill(output, key);
  return { bytes: output, verification, tolerance };
}

export async function removeChromaBackground(bytes, key, options = {}) {
  const result = await processChromaBackground(bytes, key, options);
  if (options.strict !== false && result.verification.contaminatedPixels > 1) {
    throw new Error(`Background cleanup left ${result.verification.contaminatedPixels} chroma-contaminated pixels`);
  }
  return result.bytes;
}

function alphaBounds(data, info) {
  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;
  for (let index = 0, pixel = 0; index < data.length; index += 4, pixel += 1) {
    if (data[index + 3] <= 8) continue;
    const x = pixel % info.width;
    const y = Math.floor(pixel / info.width);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return maxX < minX ? null : { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

export async function frameTransparentGarment(bytes, canvasSize = 1024, occupancy = 0.88) {
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const bounds = alphaBounds(data, info);
  if (!bounds) throw new Error("Background removal did not leave a visible garment");
  const { minX, minY, maxX, maxY } = bounds;

  const trimmed = await sharp(data, { raw: info })
    .extract({ left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 })
    .png()
    .toBuffer();
  const targetSize = Math.max(1, Math.round(canvasSize * Math.max(0.5, Math.min(0.96, occupancy))));
  const resized = await sharp(trimmed)
    .resize(targetSize, targetSize, { fit: "inside", withoutEnlargement: false })
    .png()
    .toBuffer({ resolveWithObject: true });
  const left = Math.floor((canvasSize - resized.info.width) / 2);
  const top = Math.floor((canvasSize - resized.info.height) / 2);
  return sharp({ create: { width: canvasSize, height: canvasSize, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: resized.data, left, top }])
    .png()
    .toBuffer();
}

async function verifyNoChromaSpill(bytes, key) {
  const target = [1, 3, 5].map((offset) => Number.parseInt(key.slice(offset, offset + 2), 16));
  const keyedChannels = target.map((channel, index) => channel > 200 ? index : null).filter((index) => index !== null);
  const neutralChannels = target.map((channel, index) => channel < 55 ? index : null).filter((index) => index !== null);
  const { data } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let contaminatedPixels = 0;
  let maxSpill = 0;
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] === 0) continue;
    const keyedLevel = keyedChannels.reduce((total, channel) => total + data[index + channel], 0) / keyedChannels.length;
    const neutralLevel = neutralChannels.reduce((total, channel) => total + data[index + channel], 0) / neutralChannels.length;
    const spill = Math.max(0, keyedLevel - neutralLevel);
    maxSpill = Math.max(maxSpill, spill);
    if (spill > 1.5) contaminatedPixels += 1;
  }
  return { contaminatedPixels, maxSpill };
}

// The model draws light gutters between views, often several pixels off the exact cell edges, so cut at the gutters it drew.
function gutters(profile, parts) {
  const reach = Math.round(profile.length * 0.06);
  return Array.from({ length: parts - 1 }, (_, index) => {
    const expected = Math.round((profile.length * (index + 1)) / parts);
    const window = profile.slice(expected - reach, expected + reach);
    const median = [...window].sort((a, b) => a - b)[Math.floor(window.length / 2)];
    const bright = window.flatMap((value, offset) => value - median > 20 ? [expected - reach + offset] : []);
    return bright.length ? { start: bright[0], end: bright.at(-1) + 1 } : { start: expected, end: expected };
  });
}

// Every frame gets the same size, centered in its cell, so the figure does not jump while spinning.
function cellSpans(profile, parts) {
  const bounds = gutters(profile, parts);
  const cells = Array.from({ length: parts }, (_, index) => ({
    start: index === 0 ? 0 : bounds[index - 1].end,
    end: index === parts - 1 ? profile.length : bounds[index].start,
  }));
  const size = Math.floor(Math.min(...cells.map((cell) => cell.end - cell.start)) * 0.98);
  return cells.map((cell) => ({ start: cell.start + Math.floor((cell.end - cell.start - size) / 2), size }));
}

// Row-major order matches the view order in the prompt.
export async function sliceTurnaround(sheet) {
  const { data, info } = await sharp(sheet).removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
  const columnLight = new Float64Array(info.width);
  const rowLight = new Float64Array(info.height);
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const value = data[(y * info.width + x) * info.channels];
      columnLight[x] += value / info.height;
      rowLight[y] += value / info.width;
    }
  }
  const columns = cellSpans([...columnLight], TURNAROUND_COLUMNS);
  const rows = cellSpans([...rowLight], TURNAROUND_ROWS);
  const frames = [];
  for (const row of rows) {
    for (const column of columns) {
      frames.push(await sharp(sheet).extract({ left: column.start, top: row.start, width: column.size, height: row.size }).png().toBuffer());
    }
  }
  return frames;
}

// The model draws each view at a slightly different size and position, so the figure jumps while spinning.
// Every keyed frame is scaled to one height and set on one baseline, centered in a canvas of the sliced size.
export async function stabilizeTurnaround(frames) {
  const figures = await Promise.all(frames.map(async (bytes) => {
    const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { bytes, info, bounds: alphaBounds(data, info) };
  }));
  if (figures.some((figure) => !figure.bounds)) return frames;
  const width = Math.min(...figures.map((figure) => figure.info.width));
  const height = Math.min(...figures.map((figure) => figure.info.height));
  const heights = figures.map((figure) => figure.bounds.height).sort((a, b) => a - b);
  const targetHeight = Math.min(heights[Math.floor(heights.length / 2)], Math.round(height * 0.96));
  const baseline = Math.round((height + targetHeight) / 2);
  return Promise.all(figures.map(async ({ bytes, bounds }) => {
    const scale = Math.min(targetHeight / bounds.height, (width * 0.96) / bounds.width);
    const figure = await sharp(bytes)
      .extract({ left: bounds.minX, top: bounds.minY, width: bounds.width, height: bounds.height })
      .resize(Math.max(1, Math.round(bounds.width * scale)), Math.max(1, Math.round(bounds.height * scale)), { fit: "fill" })
      .png()
      .toBuffer({ resolveWithObject: true });
    return sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: figure.data, left: Math.round((width - figure.info.width) / 2), top: baseline - figure.info.height }])
      .png()
      .toBuffer();
  }));
}

function turnaroundState(status, fields = {}) {
  return { status, frames: [], sheet: null, error: null, updatedAt: new Date().toISOString(), ...fields };
}

function stageState() {
  return { status: "pending", decision: null, attempts: 0, assetUrl: null, failedAssetUrl: null, cleanupPreviewUrl: null, cleanupTolerance: 46, cleanupDiagnostics: null, error: null, prompt: null, updatedAt: null };
}

async function openAIFetch(url, options) {
  try {
    return await fetch(url, options);
  } catch (error) {
    const cause = error.cause;
    const detail = [cause?.code, cause?.message].filter(Boolean).join(": ");
    throw new Error(detail ? `OpenAI request failed (${detail})` : `OpenAI request failed (${error.message})`, { cause: error });
  }
}

async function openAIEdit({ key, baseUrl, responseModel, imageModel, prompt, images, size, background, quality }) {
  const client = new OpenAI({ apiKey: key, baseURL: baseUrl, maxRetries: 2, timeout: 10 * 60 * 1000 });
  const content = [{ type: "input_text", text: prompt }];
  for (const image of images) {
    const normalized = await normalizeImage(image.data);
    content.push({ type: "input_image", image_url: `data:image/png;base64,${normalized.toString("base64")}` });
  }
  const request = {
    model: responseModel,
    stream: true,
    input: [{ role: "user", content }],
    tool_choice: { type: "image_generation" },
    tools: [{
      type: "image_generation",
      action: "edit",
      model: imageModel,
      size,
      quality: quality || "high",
      ...(background ? { background } : {}),
    }],
  };
  let stream = await client.responses.create(request);
  let responseId = null;
  let cursor = 0;
  let encoded = null;
  let terminalError = null;
  for (let connection = 0; connection < 4 && !encoded && !terminalError; connection += 1) {
    try {
      for await (const event of stream) {
        if (Number.isFinite(event.sequence_number)) cursor = Math.max(cursor, event.sequence_number);
        if (event.type === "response.created") responseId = event.response.id;
        if (event.type === "response.output_item.done" && event.item.type === "image_generation_call") encoded = event.item.result;
        if (event.type === "response.completed") {
          encoded ||= event.response.output?.find((item) => item.type === "image_generation_call")?.result;
          if (!encoded) terminalError = event.response.output_text?.trim() || "OpenAI response did not contain image data";
        }
        if (event.type === "response.failed") terminalError = event.response.error?.message || "OpenAI image request failed";
      }
    } catch (error) {
      if (!responseId || connection === 3) throw error;
      stream = await client.responses.retrieve(responseId, { stream: true, starting_after: cursor });
      continue;
    }
    if (!encoded && !terminalError && responseId) {
      stream = await client.responses.retrieve(responseId, { stream: true, starting_after: cursor });
    }
  }
  if (terminalError) throw new Error(terminalError);
  if (!encoded) throw new Error("OpenAI image stream ended without image data");
  return Buffer.from(encoded, "base64");
}

export async function openAIAnalyze({ key, baseUrl, model, image, mime, singleGarment = false }) {
  const response = await openAIFetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      input: [{ role: "user", content: [
        { type: "input_text", text: `Identify every distinct wearable clothing item visible in this image. A photo may show one isolated garment or a person wearing several items. Return one record per actual item that should enter a wardrobe. Ignore the person's body and non-wearable background objects. For each item, include a tight bounding box around only that item using integer coordinates normalized to a 1000 by 1000 image: x and y are the top-left corner, followed by width and height. Boxes may overlap when garments overlap, but each box must focus on one distinct item. Use only these category ids: upperbody, wholebody_up, lowerbody, accessories_up, shoes. For the display name, identify the real product when you can: read the brand from logos, labels or printed text, note the distinctive design details, and use web search to confirm the official product name, for example Arc'teryx Gamma MX Hoody or Crocs Pollex Clog by Salehe Bembury. Use that official name only when the brand is visible or the design is unmistakable and the search confirms it. Otherwise fall back to a short descriptive title of two to four words like Black Cargo Pants. Never invent a product name. The name is the title only: no notes, parentheses, brackets, colorway, size or source after it. Also give the primary hex color of the garment fabric as photographed, the secondary hex color as the most prominent graphic, print, logo or accent color as photographed (null when there is none), and 1-4 useful lowercase detail tags. Read colors from the pixels in this photo, not from what this product usually looks like.${singleGarment ? " Every photo in this upload shows the same single garment from a different angle, and this is one of them, so return exactly one item for that garment." : ""}` },
        { type: "input_image", image_url: `data:${mime};base64,${image.toString("base64")}` },
      ] }],
      tools: [{ type: "web_search" }],
      tool_choice: "auto",
      text: { format: { type: "json_schema", name: "wardrobe_items", strict: true, schema: { type: "object", additionalProperties: false, properties: { items: { type: "array", minItems: 0, maxItems: singleGarment ? 1 : 8, items: { type: "object", additionalProperties: false, properties: { name: { type: "string" }, part: { type: "string", enum: ["upperbody", "wholebody_up", "lowerbody", "accessories_up", "shoes"] }, color: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" }, secondaryColor: { anyOf: [{ type: "string", pattern: "^#[0-9A-Fa-f]{6}$" }, { type: "null" }] }, tags: { type: "array", items: { type: "string" }, maxItems: 4 }, boundingBox: { type: "object", additionalProperties: false, properties: { x: { type: "integer", minimum: 0, maximum: 999 }, y: { type: "integer", minimum: 0, maximum: 999 }, width: { type: "integer", minimum: 1, maximum: 1000 }, height: { type: "integer", minimum: 1, maximum: 1000 } }, required: ["x", "y", "width", "height"] } }, required: ["name", "part", "color", "secondaryColor", "tags", "boundingBox"] } } }, required: ["items"] } } },
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message || `OpenAI analysis failed (${response.status})`);
  const outputText = result.output_text || result.output?.flatMap((item) => item.content || []).find((item) => item.type === "output_text")?.text;
  if (!outputText) throw new Error("OpenAI analysis returned no structured result");
  const parsed = JSON.parse(outputText);
  if (!Array.isArray(parsed.items)) throw new Error("OpenAI analysis returned an invalid clothing list");
  return parsed.items;
}

export function createImportApi({ storage, setting, background }) {
  const running = new Map();
  const apiBaseUrl = () => setting("OPENAI_API_BASE_URL", "https://api.openai.com/v1").replace(/\/$/, "");
  const importSecret = () => setting("WARDROBE_IMPORT_SECRET").trim();

  // Every full-body photo under models/ is a candidate. The single model-reference.png stays as the fallback.
  async function listModels() {
    const pool = await storage.listModels();
    if (pool.length) return pool;
    return (await storage.exists(MODEL_REFERENCE_KEY)) ? [MODEL_REFERENCE_KEY] : [];
  }

  // Each generation draws a fresh reference, so the model varies from piece to piece and across regenerations.
  async function pickModel() {
    const pool = await listModels();
    if (!pool.length) throw new Error(`No model reference found. Add full-body photos of yourself under ${storage.modelReference}.`);
    const key = pool[Math.floor(Math.random() * pool.length)];
    const data = await storage.readBytes(key);
    if (!data) throw new Error(`Model reference ${key} could not be read.`);
    return { key, data };
  }

  async function setupStatus() {
    const hasApiKey = Boolean(setting("OPENAI_API_KEY").trim());
    const hasModelReference = (await listModels()).length > 0;
    const requiresSecret = Boolean(importSecret());
    // A hosted deploy without a secret would let anyone spend the OpenAI key.
    const missingSecret = Boolean(process.env.VERCEL) && !requiresSecret;
    const missing = [
      !hasApiKey && "OPENAI_API_KEY in .env",
      !hasModelReference && `full-body photos of yourself under ${storage.modelReference}`,
      missingSecret && "WARDROBE_IMPORT_SECRET",
    ].filter(Boolean).join(" and ");
    return {
      ready: !missing,
      hasApiKey,
      hasModelReference,
      modelReference: storage.modelReference,
      requiresSecret,
      setupMessage: missing ? `Setup required: add ${missing}, then restart the app.` : null,
    };
  }

  async function loadJob(id) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) return null;
    return storage.readJson(jobKey(id, "job.json"));
  }

  async function saveJob(job) {
    job.updatedAt = new Date().toISOString();
    await storage.writeJson(jobKey(job.id, "job.json"), job);
  }

  async function requireBytes(key) {
    const bytes = await storage.readBytes(key);
    if (!bytes) throw Object.assign(new Error(`Missing stored asset ${key}`), { status: 404 });
    return bytes;
  }

  const loadImported = async () => (await storage.readJson(LIBRARY_KEY)) || [];

  // Re-reads the library so a concurrent edit or delete of another record survives the write.
  async function patchRecord(id, patch) {
    const records = await loadImported();
    const index = records.findIndex((record) => record.id === id);
    if (index === -1) return null;
    records[index] = { ...records[index], ...patch(records[index]) };
    await storage.writeJson(LIBRARY_KEY, records);
    return records[index];
  }

  const removeJob = (id) => storage.removePrefix(`jobs/${id}/`);

  async function createJobs(sources) {
    const [primary] = sources;
    const detected = (await openAIAnalyze({ key: setting("OPENAI_API_KEY"), baseUrl: apiBaseUrl(), model: setting("OPENAI_VISION_MODEL", "gpt-5.4-mini"), image: primary, mime: "image/png", singleGarment: sources.length > 1 })).map(normalizeMetadata);
    const sourceFiles = sources.length === 1 ? ["original.png"] : sources.map((_, index) => `original-${index + 1}.png`);
    const cropFile = "crop.png";
    const jobs = [];
    for (const metadata of detected) {
      const id = randomUUID();
      await Promise.all(sources.map((bytes, index) => storage.writeBytes(jobKey(id, sourceFiles[index]), bytes, "image/png")));
      await storage.writeBytes(jobKey(id, cropFile), await cropDetectedItem(primary, metadata.boundingBox), "image/png");
      const now = new Date().toISOString();
      const cropStage = { ...stageState(), status: "review", assetUrl: `${ASSET_ROOT}/${id}/${cropFile}`, updatedAt: now };
      const job = { id, status: "active", metadata, stages: { crop: cropStage, garment: stageState(), modeled: stageState() }, createdAt: now, updatedAt: now, internal: { originalFile: sourceFiles[0], sources: sourceFiles.map((file) => ({ file })), cropFile, originalMime: "image/png" } };
      job.originalAssetUrl = `${ASSET_ROOT}/${id}/${sourceFiles[0]}`;
      job.sourceAssetUrls = sourceFiles.map((file) => `${ASSET_ROOT}/${id}/${file}`);
      await saveJob(job); jobs.push(publicJob(job));
    }
    return jobs;
  }

  async function persistImported(job, includeModeled = false) {
    const id = `import-${job.id}`;
    const garmentName = `${id}-garment.png`;
    const garmentSource = job.stages.garment.assetUrl ? assetName(job.stages.garment.assetUrl) : `garment-${job.stages.garment.attempts}.png`;
    await storage.writeBytes(`library/${garmentName}`, await requireBytes(jobKey(job.id, garmentSource)), "image/png");
    let modeledImage = null;
    if (includeModeled) {
      const modeledName = `${id}-modeled.png`;
      const modeledSource = job.stages.modeled.assetUrl ? assetName(job.stages.modeled.assetUrl) : `modeled-${job.stages.modeled.attempts}.png`;
      await storage.writeBytes(`library/${modeledName}`, await requireBytes(jobKey(job.id, modeledSource)), "image/png");
      modeledImage = `${LIBRARY_ASSET_ROOT}/${modeledName}`;
    }
    const metadata = job.metadata || {};
    const records = await loadImported();
    const existing = records.find((record) => record.id === id);
    const record = {
      id,
      name: metadata.name || "New piece",
      part: metadata.part || "upperbody",
      color: metadata.color || "#d8d0c2",
      secondaryColor: metadata.secondaryColor || null,
      palette: [metadata.color, metadata.secondaryColor].filter(Boolean),
      tags: Array.isArray(metadata.tags) ? metadata.tags : [],
      image: `${LIBRARY_ASSET_ROOT}/${garmentName}`,
      thumbnail: `${LIBRARY_ASSET_ROOT}/${garmentName}`,
      modeledImage: modeledImage || existing?.modeledImage || null,
      importJobId: job.id,
      ...(existing?.turnaround && { turnaround: existing.turnaround }),
    };
    const next = [...records.filter((item) => item.id !== id), record];
    await storage.writeJson(LIBRARY_KEY, next);
    return record;
  }

  async function generate(job, stageName) {
    const lock = `${job.id}:${stageName}`;
    if (running.has(lock)) return running.get(lock);
    const task = (async () => {
      const current = await loadJob(job.id);
      if (!current?.stages?.[stageName]) return;
      const stage = current.stages[stageName];
      stage.status = "processing"; stage.decision = null; stage.error = null; stage.attempts += 1; stage.updatedAt = new Date().toISOString();
      await saveJob(current);
      let failedAssetUrl = null;
      let chromaKeyUsed = null;
      let modelUsed = null;
      try {
        const outputName = `${stageName}-${stage.attempts}.png`;
        const key = setting("OPENAI_API_KEY");
        if (!key) throw new Error("OPENAI_API_KEY is not configured");
        let bytes;
        if (stageName === "garment") {
          const sourceFiles = [current.internal.cropFile || current.internal.originalFile, ...(current.internal.sources || []).slice(1).map((source) => source.file)];
          const images = await Promise.all(sourceFiles.map(async (name) => ({ data: await requireBytes(jobKey(current.id, name)), mime: "image/png", name })));
          chromaKeyUsed = chooseChromaKey(current.metadata.color);
          const basePrompt = buildGarmentPrompt(current.metadata, chromaKeyUsed, images.length);
          bytes = await openAIEdit({ key, baseUrl: apiBaseUrl(), responseModel: setting("OPENAI_IMAGE_TOOL_MODEL", setting("OPENAI_VISION_MODEL", "gpt-5.4-mini")), imageModel: setting("OPENAI_GARMENT_MODEL", setting("OPENAI_IMAGE_MODEL", "gpt-image-2")), quality: setting("OPENAI_IMAGE_QUALITY", "high"), size: "1024x1024", images, prompt: current.stages.garment.prompt ? `${basePrompt}\nUser regeneration direction: ${current.stages.garment.prompt}` : basePrompt });
          const rawName = `${stageName}-${stage.attempts}-source.png`;
          await storage.writeBytes(jobKey(current.id, rawName), bytes, "image/png");
          failedAssetUrl = `${ASSET_ROOT}/${current.id}/${rawName}`;
          bytes = await removeChromaBackground(bytes, chromaKeyUsed);
        } else {
          const garmentName = current.stages.garment.assetUrl ? assetName(current.stages.garment.assetUrl) : `garment-${current.stages.garment.attempts}.png`;
          const garment = { data: await requireBytes(jobKey(current.id, garmentName)), mime: "image/png", name: "garment.png" };
          const picked = await pickModel();
          modelUsed = picked.key;
          const model = { data: picked.data, mime: "image/png", name: "model.png" };
          const basePrompt = "Create a professional horizontal 3:2 editorial fashion photograph of the person in Image 1 wearing the exact garment from Image 2. Preserve the person's build, height, skin tone, hair and proportions. Do not reproduce the person's face: give the model a neutral, generic face with no resemblance to Image 1, head level in a relaxed natural stance, looking at the camera or naturally off to one side, never looking down or hiding the face. Preserve every garment color, material, fit, construction, graphic, logo and distinctive detail. Keep the complete featured item clearly visible and unobstructed, use understated neutral supporting clothes, realistic anatomy, natural light, authentic fabric, a tasteful real-world setting, and leave environmental space around the model. No text, watermark, product mockup, or synthetic appearance.";
          bytes = await openAIEdit({ key, baseUrl: apiBaseUrl(), responseModel: setting("OPENAI_IMAGE_TOOL_MODEL", setting("OPENAI_VISION_MODEL", "gpt-5.4-mini")), imageModel: setting("OPENAI_MODELED_MODEL", setting("OPENAI_IMAGE_MODEL", "gpt-image-2")), quality: setting("OPENAI_IMAGE_QUALITY", "high"), size: "1536x1024", images: [model, garment], prompt: current.stages.modeled.prompt ? `${basePrompt}\nUser regeneration direction: ${current.stages.modeled.prompt}` : basePrompt });
        }
        await storage.writeBytes(jobKey(current.id, outputName), bytes, "image/png");
        const fresh = await loadJob(current.id);
        if (!fresh?.stages?.[stageName]) return;
        fresh.stages[stageName].status = "review";
        fresh.stages[stageName].assetUrl = `${ASSET_ROOT}/${fresh.id}/${outputName}`;
        fresh.stages[stageName].failedAssetUrl = null;
        fresh.stages[stageName].cleanupPreviewUrl = null;
        fresh.stages[stageName].cleanupDiagnostics = null;
        if (chromaKeyUsed) fresh.stages[stageName].chromaKey = chromaKeyUsed;
        if (modelUsed) fresh.stages[stageName].modelReference = modelUsed;
        fresh.stages[stageName].updatedAt = new Date().toISOString();
        await saveJob(fresh);
      } catch (error) {
        const fresh = await loadJob(current.id);
        if (!fresh?.stages?.[stageName]) return;
        fresh.stages[stageName].status = "failed"; fresh.stages[stageName].error = error.message; fresh.stages[stageName].updatedAt = new Date().toISOString();
        if (typeof failedAssetUrl === "string") fresh.stages[stageName].failedAssetUrl = failedAssetUrl;
        if (chromaKeyUsed) fresh.stages[stageName].chromaKey = chromaKeyUsed;
        await saveJob(fresh);
      }
    })().finally(() => running.delete(lock));
    running.set(lock, task);
    return task;
  }

  async function generateTurnaround(itemId) {
    const lock = `turnaround:${itemId}`;
    if (running.has(lock)) return running.get(lock);
    const task = (async () => {
      try {
        const key = setting("OPENAI_API_KEY");
        if (!key) throw new Error("OPENAI_API_KEY is not configured");
        const model = await pickModel();
        const garment = await requireBytes(`library/${itemId}-garment.png`);
        const chromaKey = chooseChromaKey((await loadImported()).find((record) => record.id === itemId)?.color);
        const sheet = await openAIEdit({ key, baseUrl: apiBaseUrl(), responseModel: setting("OPENAI_IMAGE_TOOL_MODEL", setting("OPENAI_VISION_MODEL", "gpt-5.4-mini")), imageModel: setting("OPENAI_MODELED_MODEL", setting("OPENAI_IMAGE_MODEL", "gpt-image-2")), quality: setting("OPENAI_IMAGE_QUALITY", "high"), size: "1536x1024", images: [{ data: model.data, mime: "image/png", name: "model.png" }, { data: garment, mime: "image/png", name: "garment.png" }], prompt: turnaroundPrompt(chromaKey) });
        const keyed = await Promise.all((await sliceTurnaround(sheet)).map(async (frame) => (await processChromaBackground(frame, chromaKey, { frame: false })).bytes));
        const frames = await stabilizeTurnaround(keyed);
        const names = turnaroundFiles(itemId);
        const [sheetName, ...frameNames] = names;
        await Promise.all([sheet, ...frames].map((bytes, index) => storage.writeBytes(`library/${names[index]}`, bytes, "image/png")));
        // The library route serves assets as immutable, so a regenerated frame needs a new URL.
        const version = `?v=${Date.now()}`;
        const record = await patchRecord(itemId, () => ({ turnaround: turnaroundState("ready", {
          frames: frameNames.map((name) => `${LIBRARY_ASSET_ROOT}/${name}${version}`),
          sheet: `${LIBRARY_ASSET_ROOT}/${sheetName}${version}`,
          modelReference: model.key,
        }) }));
        if (!record) await Promise.all(names.map((name) => storage.remove(`library/${name}`)));
      } catch (error) {
        await patchRecord(itemId, () => ({ turnaround: turnaroundState("failed", { error: error.message }) }));
      }
    })().finally(() => running.delete(lock));
    running.set(lock, task);
    return task;
  }

  async function startTurnaround(itemId) {
    const record = await patchRecord(itemId, () => ({ turnaround: turnaroundState("processing") }));
    if (record) background(generateTurnaround(itemId));
    return record;
  }

  const turnaroundStuck = (record) => record.turnaround?.status === "processing"
    && !running.has(`turnaround:${record.id}`)
    && Date.now() - Date.parse(record.turnaround.updatedAt) >= STUCK_AFTER_MS;

  // A Vercel function timeout kills generation mid-stage, and nothing else moves the stage out of processing.
  async function failStuckStages(job) {
    let changed = false;
    for (const [stageName, stage] of Object.entries(job.stages)) {
      if (stage?.status !== "processing" || running.has(`${job.id}:${stageName}`)) continue;
      if (Date.now() - Date.parse(stage.updatedAt) < STUCK_AFTER_MS) continue;
      stage.status = "failed";
      stage.error = "Generation timed out. Try regenerating.";
      stage.updatedAt = new Date().toISOString();
      changed = true;
    }
    if (changed) await saveJob(job);
  }

  async function route(request, url) {
    if (url.pathname === "/api/import/wardrobe" && request.method === "GET") {
      const stuck = (await loadImported()).filter(turnaroundStuck);
      for (const record of stuck) {
        await patchRecord(record.id, () => ({ turnaround: turnaroundState("failed", { error: "Generation timed out. Try again." }) }));
      }
      return json(200, await loadImported());
    }
    const turnaroundMatch = url.pathname.match(/^\/api\/import\/wardrobe\/(import-[a-f0-9-]{36})\/turnaround$/i);
    if (turnaroundMatch && request.method === "POST") {
      const record = (await loadImported()).find((item) => item.id === turnaroundMatch[1]);
      if (!record) return json(404, { error: "Imported wardrobe item not found" });
      if (record.turnaround?.status === "processing" && !turnaroundStuck(record)) return json(409, { error: "A 360 view is already being prepared" });
      const started = await startTurnaround(record.id);
      return started ? json(200, started) : json(404, { error: "Imported wardrobe item not found" });
    }
    if (url.pathname === "/api/import/config" && request.method === "GET") {
      return json(200, await setupStatus());
    }
    const wardrobeDeleteMatch = url.pathname.match(/^\/api\/import\/wardrobe\/(import-[a-f0-9-]{36})$/i);
    if (wardrobeDeleteMatch && request.method === "DELETE") {
      const id = wardrobeDeleteMatch[1];
      const records = await loadImported();
      const next = records.filter((record) => record.id !== id);
      if (next.length === records.length) return json(404, { error: "Imported wardrobe item not found" });
      await storage.writeJson(LIBRARY_KEY, next);
      await Promise.all([`${id}-garment.png`, `${id}-modeled.png`, ...turnaroundFiles(id)].map((name) => storage.remove(`library/${name}`)));
      return json(200, { deleted: true, id });
    }
    const libraryAssetMatch = url.pathname.match(/^\/api\/import\/library\/([\w-][\w.-]*\.png)$/i);
    if (libraryAssetMatch && request.method === "GET") {
      const bytes = await storage.readBytes(`library/${libraryAssetMatch[1]}`);
      if (!bytes) return json(404, { error: "Not found" });
      return new Response(bytes, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=31536000, immutable" } });
    }
    const assetMatch = url.pathname.match(/^\/api\/import\/assets\/([a-f0-9-]{36})\/([\w-][\w.-]*)$/i);
    if (assetMatch && request.method === "GET") {
      const bytes = await storage.readBytes(jobKey(assetMatch[1], assetMatch[2]));
      if (!bytes) return json(404, { error: "Not found" });
      return new Response(bytes, { headers: { "Content-Type": assetMatch[2].endsWith(".svg") ? "image/svg+xml" : "image/png", "Cache-Control": "no-store" } });
    }
    if (url.pathname === API_ROOT && request.method === "POST") {
      const setup = await setupStatus();
      if (!setup.ready) return json(503, { error: setup.setupMessage });
      const input = await body(request);
      const mode = input.mode ?? "separate";
      if (!UPLOAD_MODES.has(mode)) throw Object.assign(new Error('mode must be "angles" or "separate"'), { status: 400 });
      const images = await Promise.all(decodeImages(input).map((image) => normalizeImage(image.data)));
      const uploads = mode === "angles" ? [images] : images.map((image) => [image]);
      const jobs = [];
      for (const sources of uploads) jobs.push(...await createJobs(sources));
      return json(202, { jobs, noClothingDetected: jobs.length === 0 });
    }
    if (url.pathname === API_ROOT && request.method === "GET") {
      const ids = await storage.listJobIds();
      const loadedJobs = (await Promise.all(ids.map((id) => loadJob(id)))).filter(Boolean);
      const hiddenJobs = loadedJobs.filter((job) => job.status === "complete" || job.stages.crop?.status === "rejected" || job.stages.garment.status === "rejected" || job.stages.modeled.status === "rejected");
      await Promise.all(hiddenJobs.map((job) => removeJob(job.id)));
      const jobs = loadedJobs.filter((job) => !hiddenJobs.includes(job)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      await Promise.all(jobs.map(failStuckStages));
      return json(200, jobs.map(publicJob));
    }
    const match = url.pathname.match(/^\/api\/import\/jobs\/([a-f0-9-]{36})(?:\/(.*))?$/i);
    if (!match) return json(404, { error: "Not found" });
    const job = await loadJob(match[1]);
    if (!job) return json(404, { error: "Job not found" });
    const action = match[2] || "";
    if (!action && request.method === "GET") return json(200, publicJob(job));
    if (!action && request.method === "DELETE") {
      await removeJob(job.id);
      return json(200, { deleted: true, id: job.id });
    }
    if (action === "metadata" && (request.method === "PATCH" || request.method === "PUT")) {
      const input = await body(request);
      if (!input.metadata || typeof input.metadata !== "object" || Array.isArray(input.metadata)) throw Object.assign(new Error("metadata must be an object"), { status: 400 });
      job.metadata = normalizeMetadata({ ...job.metadata, ...input.metadata }); await saveJob(job);
      return json(200, publicJob(job));
    }
    const cleanupAction = action.match(/^stages\/garment\/(cleanup-preview|cleanup-accept)$/);
    if (cleanupAction && request.method === "POST") {
      const stage = job.stages.garment;
      if (stage.status !== "failed" || !stage.failedAssetUrl) {
        throw Object.assign(new Error("No failed garment source is available for cleanup"), { status: 409 });
      }
      const input = await body(request);
      const tolerance = cleanupTolerance(input.tolerance);
      const source = await requireBytes(jobKey(job.id, assetName(stage.failedAssetUrl)));
      const key = stage.chromaKey || chooseChromaKey(job.metadata?.color);
      const cleaned = await processChromaBackground(source, key, { tolerance });
      const previewName = `garment-${stage.attempts}-cleanup-${tolerance}.png`;
      const previewUrl = `${ASSET_ROOT}/${job.id}/${previewName}`;
      await storage.writeBytes(jobKey(job.id, previewName), cleaned.bytes, "image/png");
      stage.chromaKey = key;
      stage.cleanupTolerance = cleaned.tolerance;
      stage.cleanupDiagnostics = cleaned.verification;
      stage.cleanupPreviewUrl = previewUrl;
      stage.updatedAt = new Date().toISOString();
      if (cleanupAction[1] === "cleanup-accept") {
        stage.status = "review";
        stage.decision = null;
        stage.error = null;
        stage.assetUrl = previewUrl;
      }
      await saveJob(job);
      return json(200, publicJob(job));
    }
    const stageMatch = action.match(/^stages\/(crop|garment|modeled)\/(approve|reject|regenerate)$/);
    if (stageMatch && request.method === "POST") {
      const [, stageName, decision] = stageMatch;
      if (!STAGES.has(stageName)) throw Object.assign(new Error("Invalid stage"), { status: 400 });
      if (decision === "regenerate") {
        if (stageName === "crop") throw Object.assign(new Error("Upload the image again to create new crops"), { status: 400 });
        const input = await body(request);
        job.stages[stageName].prompt = typeof input.prompt === "string" ? input.prompt.trim().slice(0, 1200) || null : null;
        job.stages[stageName].status = "queued";
        job.stages[stageName].decision = null;
        await saveJob(job);
        background(generate(job, stageName));
        return json(202, publicJob(job));
      }
      if (!DECISIONS.has(decision) || job.stages[stageName].status !== "review") throw Object.assign(new Error("Stage is not ready for review"), { status: 409 });
      const previousStatus = job.stages[stageName].status;
      const previousDecision = job.stages[stageName].decision;
      const previousJobStatus = job.status;
      job.stages[stageName].decision = decision === "approve" ? "approved" : "rejected";
      job.stages[stageName].status = job.stages[stageName].decision;
      job.stages[stageName].error = null;
      job.stages[stageName].updatedAt = new Date().toISOString();
      const startGarment = stageName === "crop" && decision === "approve" && job.stages.garment.status === "pending";
      const startModeled = stageName === "garment" && decision === "approve" && job.stages.modeled.status === "pending";
      if (stageName === "modeled" && decision === "approve") job.status = "complete";
      await saveJob(job);
      if (decision === "approve" && stageName !== "crop") {
        try {
          await persistImported(job, stageName === "modeled");
        } catch (error) {
          job.stages[stageName].status = previousStatus;
          job.stages[stageName].decision = previousDecision;
          job.status = previousJobStatus;
          await saveJob(job);
          throw error;
        }
      }
      if (stageName === "modeled" && decision === "approve") {
        // persistImported already saved the piece. If this fails, the viewer offers to generate the 360 view instead.
        await startTurnaround(`import-${job.id}`).catch(() => {});
      }
      if (decision === "reject") await removeJob(job.id);
      if (startGarment) background(generate(job, "garment"));
      if (startModeled) background(generate(job, "modeled"));
      const response = publicJob(job);
      if (job.status === "complete") await removeJob(job.id);
      return json(200, response);
    }
    return json(404, { error: "Not found" });
  }

  async function handle(request) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/import/")) return json(404, { error: "Not found" });
    try {
      const secret = importSecret();
      if (secret && request.method !== "GET") {
        const header = request.headers.get("authorization") || "";
        if (!header.startsWith("Bearer ") || !sameSecret(header.slice("Bearer ".length), secret)) {
          return json(401, { error: "Import secret required" });
        }
      }
      return await route(request, url);
    } catch (error) {
      const statusCode = error.code === "ENOENT" ? 404 : error.status || 500;
      return json(statusCode, { error: statusCode === 500 ? "Internal server error" : error.message, ...(process.env.NODE_ENV === "development" && statusCode === 500 ? { detail: error.message } : {}) });
    }
  }

  async function recoverJobs() {
    for (const id of await storage.listJobIds()) {
      const job = await loadJob(id);
      if (!job) continue;
      if (job.status === "complete") {
        try {
          await persistImported(job, true);
          await removeJob(job.id);
        } catch {
          job.status = "active";
          job.stages.modeled.status = "review";
          job.stages.modeled.decision = null;
          job.stages.modeled.error = null;
          await saveJob(job);
        }
        continue;
      }
      if (job.stages.crop?.status === "rejected" || job.stages.garment.status === "rejected" || job.stages.modeled.status === "rejected") {
        await removeJob(job.id);
        continue;
      }
      if (job.stages.crop && job.stages.crop.status !== "approved") continue;
      if (["processing", "queued"].includes(job.stages.garment.status)) {
        job.stages.garment.status = "pending";
        await saveJob(job);
        background(generate(job, "garment"));
      } else if (job.stages.garment.status === "approved" && ["pending", "processing", "queued"].includes(job.stages.modeled.status)) {
        job.stages.modeled.status = "pending";
        await saveJob(job);
        background(generate(job, "modeled"));
      }
    }
  }

  return { handle, recoverJobs };
}
