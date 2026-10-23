import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, MagnifyingGlass, Plus, SpinnerGap, Trash, X } from "@phosphor-icons/react";
import { importAuthHeaders, SECRET_CHANGE_EVENT, storedSecret, WardrobeImportFlow } from "./import-flow.jsx";
import { OptimizedImage } from "./OptimizedImage.jsx";

const STORAGE_KEY = "open-wardrobe-edits-v1";
const DELETED_STORAGE_KEY = "open-wardrobe-deleted-v1";

const TYPES = [
  { id: "all", label: "All" },
  { id: "upperbody", label: "Tops", singular: "Top" },
  { id: "wholebody_up", label: "Jackets", singular: "Jacket" },
  { id: "lowerbody", label: "Bottoms", singular: "Bottom" },
  { id: "accessories_up", label: "Accessories", singular: "Accessory" },
  { id: "shoes", label: "Shoes", singular: "Shoes" },
];

const TYPE_MAP = Object.fromEntries(TYPES.map((type) => [type.id, type]));

// The gallery view lives in the URL as ?type=<id>&q=<search>, so a link reproduces the same filtered set.
function readViewFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const type = params.get("type");
  return { type: type && type !== "all" && TYPE_MAP[type] ? type : "all", query: params.get("q") || "" };
}

function writeViewToUrl({ type, query }) {
  const params = new URLSearchParams(window.location.search);
  if (type === "all") params.delete("type"); else params.set("type", type);
  if (query.trim()) params.set("q", query.trim()); else params.delete("q");
  const search = params.toString();
  const next = `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`;
  if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) window.history.replaceState(null, "", next);
}

// Apostrophes are dropped rather than split on, so "arcteryx" finds Arc'teryx.
const searchWords = (text) => text.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f'\u2019]/g, "").split(/[^a-z0-9]+/).filter(Boolean);

function withinEdits(a, b, limit) {
  if (Math.abs(a.length - b.length) > limit) return false;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, current[j]);
    }
    if (rowMin > limit) return false;
    previous = current;
  }
  return previous[b.length] <= limit;
}

// Every search word has to hit some word of the piece: as a substring, or within one edit for words of four letters or more, two for seven or more.
function matchesSearch(item, query) {
  const needles = searchWords(query);
  if (!needles.length) return true;
  const haystack = searchWords([item.name, ...(item.tags || []), TYPE_MAP[item.part]?.label || ""].join(" "));
  const joined = haystack.join(" ");
  const compact = haystack.join("");
  return needles.every((needle) => joined.includes(needle) || compact.includes(needle) || haystack.some((word) => withinEdits(needle, word, needle.length >= 7 ? 2 : needle.length >= 4 ? 1 : 0)));
}
const TYPE_ORDER = Object.fromEntries(TYPES.slice(1).map((type, index) => [type.id, index]));
const TURNAROUND_VIEWS = ["Front", "Front left", "Left", "Back left", "Back", "Back right", "Right", "Front right"];
const TURNAROUND_ACTIONS = { ready: "Regenerate", failed: "Try again" };


function readEdits() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}


function persistEdit(item) {
  const edits = readEdits();
  edits[item.id] = {
    name: item.name || "",
    part: item.part,
    color: item.color || null,
    secondaryColor: item.secondaryColor || null,
    tags: item.tags || [],
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(edits));
}

function removePersistedEdit(id) {
  const edits = readEdits();
  delete edits[id];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(edits));
}

function readDeletedItems() {
  try {
    const value = JSON.parse(localStorage.getItem(DELETED_STORAGE_KEY) || "[]");
    return new Set(Array.isArray(value) ? value : []);
  } catch {
    return new Set();
  }
}

function persistDeletedItem(id) {
  const deleted = readDeletedItems();
  deleted.add(id);
  localStorage.setItem(DELETED_STORAGE_KEY, JSON.stringify([...deleted]));
}

function rgbToHex(red, green, blue) {
  return `#${[red, green, blue].map((value) => Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0")).join("")}`;
}

function colorDistance(first, second) {
  return Math.sqrt(
    ((first.red - second.red) ** 2)
    + ((first.green - second.green) ** 2)
    + ((first.blue - second.blue) ** 2),
  );
}

function extractPalette(image) {
  const canvas = document.createElement("canvas");
  canvas.width = 72;
  canvas.height = 72;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const buckets = new Map();

  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = pixels[index + 3];
    if (alpha < 72) continue;

    const red = pixels[index];
    const green = pixels[index + 1];
    const blue = pixels[index + 2];
    const key = `${Math.round(red / 28)}-${Math.round(green / 28)}-${Math.round(blue / 28)}`;
    const current = buckets.get(key) || { red: 0, green: 0, blue: 0, count: 0 };
    current.red += red;
    current.green += green;
    current.blue += blue;
    current.count += 1;
    buckets.set(key, current);
  }

  const ranked = [...buckets.values()]
    .map((bucket) => ({
      red: Math.round(bucket.red / bucket.count),
      green: Math.round(bucket.green / bucket.count),
      blue: Math.round(bucket.blue / bucket.count),
      count: bucket.count,
    }))
    .sort((a, b) => b.count - a.count);

  const selected = [];
  for (const color of ranked) {
    if (selected.every((existing) => colorDistance(existing, color) > 38)) selected.push(color);
    if (selected.length === 5) break;
  }

  return selected.map((color) => rgbToHex(color.red, color.green, color.blue));
}

function buildSamplingCanvas(image) {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  canvas.getContext("2d", { willReadFrequently: true }).drawImage(image, 0, 0);
  return canvas;
}

function sampleImageColor(image, canvas, event) {
  const bounds = image.getBoundingClientRect();
  const scale = Math.min(bounds.width / image.naturalWidth, bounds.height / image.naturalHeight);
  const renderedWidth = image.naturalWidth * scale;
  const renderedHeight = image.naturalHeight * scale;
  const offsetX = (bounds.width - renderedWidth) / 2;
  const offsetY = (bounds.height - renderedHeight) / 2;
  const imageX = Math.floor((event.clientX - bounds.left - offsetX) / scale);
  const imageY = Math.floor((event.clientY - bounds.top - offsetY) / scale);

  if (imageX < 0 || imageY < 0 || imageX >= canvas.width || imageY >= canvas.height) return null;

  const context = canvas.getContext("2d", { willReadFrequently: true });
  for (let radius = 0; radius <= 18; radius += 2) {
    const startX = Math.max(0, imageX - radius);
    const startY = Math.max(0, imageY - radius);
    const width = Math.min(canvas.width - startX, (radius * 2) + 1);
    const height = Math.min(canvas.height - startY, (radius * 2) + 1);
    const data = context.getImageData(startX, startY, width, height).data;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index + 3] > 96) return rgbToHex(data[index], data[index + 1], data[index + 2]);
    }
  }

  return null;
}

function GalleryItem({ item, selected, onOpen }) {
  const type = TYPE_MAP[item.part]?.singular || "wardrobe item";

  return (
    <button
      className={`gallery-item${selected ? " selected" : ""}`}
      type="button"
      onClick={() => onOpen(item.id)}
      aria-label={`View ${item.name || type}`}
      aria-pressed={selected}
      data-testid={`wardrobe-item-${item.id}`}
    >
      <OptimizedImage
        src={item.thumbnail || item.image}
        alt=""
        sizes="(max-width: 520px) calc(50vw - 16px), (max-width: 860px) calc(33vw - 18px), 180px"
        breakpoints={[120, 180, 240, 320, 480]}
      />
    </button>
  );
}

function TagEditor({ tags, onChange }) {
  const [input, setInput] = useState("");

  const addTag = () => {
    const nextTag = input.trim().replace(/^#/, "");
    if (!nextTag || tags.some((tag) => tag.toLowerCase() === nextTag.toLowerCase())) return;
    onChange([...tags, nextTag]);
    setInput("");
  };

  return (
    <div className="tag-editor">
      <div className="editable-tags">
        {tags.map((tag) => (
          <span className="editable-tag" key={tag}>
            {tag}
            <button type="button" onClick={() => onChange(tags.filter((existing) => existing !== tag))} aria-label={`Remove ${tag}`}>
              <X size={12} weight="regular" aria-hidden="true" />
            </button>
          </span>
        ))}
      </div>
      <div className="tag-input-row">
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === ",") {
              event.preventDefault();
              addTag();
            }
          }}
          placeholder="Add a detail"
          aria-label="Add detail tag"
        />
        <button type="button" onClick={addTag} disabled={!input.trim()} aria-label="Add detail">
          <Plus size={15} weight="regular" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function ColorControl({ label, field, value, palette, onChange, sampling, setSampling, optional = false, onClear, onAdd }) {
  if (optional && !value) {
    return (
      <div className="color-slot empty-color-slot">
        <div className="color-slot-heading">
          <span>{label}</span>
          <small>Optional</small>
        </div>
        <p>No distinct secondary color detected.</p>
        <button className="add-secondary-button" type="button" onClick={onAdd}>Add secondary color</button>
      </div>
    );
  }

  return (
    <div className="color-slot">
      <div className="color-slot-heading">
        <span>{label}</span>
        {optional && <button type="button" onClick={onClear}>Remove</button>}
      </div>
      <label className="selected-color-control">
        <input
          type="color"
          value={value || "#9a9286"}
          onChange={(event) => onChange(event.target.value)}
          aria-label={`Choose ${label.toLowerCase()}`}
        />
        <span className="selected-color-copy">
          <small>Selected</small>
          <strong>{value || "Custom"}</strong>
        </span>
      </label>
      <div className="suggestion-heading">
        <span>Image suggestions</span>
        <small>Click to apply</small>
      </div>
      <div className="palette" aria-label={`${label} suggestions from image`}>
        {palette.map((color) => (
          <button
            type="button"
            key={color}
            className={value?.toLowerCase() === color.toLowerCase() ? "active" : ""}
            style={{ backgroundColor: color }}
            onClick={() => onChange(color)}
            aria-label={`Use ${color} as ${label.toLowerCase()}`}
            title={color}
          />
        ))}
      </div>
      <button
        className={`sample-button${sampling === field ? " active" : ""}`}
        type="button"
        onClick={() => setSampling((current) => current === field ? null : field)}
      >
        {sampling === field ? "Cancel picking" : `Pick ${label.toLowerCase()} from image`}
      </button>
    </div>
  );
}

function ItemSummary({ item }) {
  const tags = (item.tags || []).filter(Boolean);
  const colors = [item.color, item.secondaryColor].filter(Boolean);
  return (
    <div className="item-summary">
      <h2>{item.name || TYPE_MAP[item.part]?.singular || "Wardrobe item"}</h2>
      <dl>
        <div><dt>Category</dt><dd>{TYPE_MAP[item.part]?.label || "Uncategorized"}</dd></div>
        {colors.length > 0 && (
          <div><dt>Colors</dt><dd className="summary-colors">{colors.map((color) => <span key={color}><i style={{ backgroundColor: color }} aria-hidden="true" />{color}</span>)}</dd></div>
        )}
        {tags.length > 0 && (
          <div><dt>Details</dt><dd className="summary-tags">{tags.map((tag) => <span key={tag}>{tag}</span>)}</dd></div>
        )}
      </dl>
    </div>
  );
}

function ItemEditor({ draft, setDraft, palette, sampling, setSampling, sampleStatus }) {
  const suggestedSecondary = palette.find((color) => color.toLowerCase() !== draft.color?.toLowerCase()) || "#9a9286";

  return (
    <div className="item-editor">
      <label className="field">
        <span>Name</span>
        <input
          value={draft.name}
          onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
          placeholder={TYPE_MAP[draft.part]?.singular || "Wardrobe item"}
        />
      </label>

      <label className="field">
        <span>Category</span>
        <select value={draft.part} onChange={(event) => setDraft((current) => ({ ...current, part: event.target.value }))}>
          {TYPES.slice(1).map((type) => <option value={type.id} key={type.id}>{type.label}</option>)}
        </select>
      </label>

      <fieldset className="color-field">
        <legend>Colors</legend>
        <div className="colors-editor">
          <ColorControl
            label="Primary color"
            field="primary"
            value={draft.color}
            palette={palette}
            onChange={(color) => setDraft((current) => ({ ...current, color }))}
            sampling={sampling}
            setSampling={setSampling}
          />
          <ColorControl
            label="Secondary color"
            field="secondary"
            value={draft.secondaryColor}
            palette={palette}
            onChange={(secondaryColor) => setDraft((current) => ({ ...current, secondaryColor }))}
            sampling={sampling}
            setSampling={setSampling}
            optional
            onClear={() => setDraft((current) => ({ ...current, secondaryColor: null }))}
            onAdd={() => setDraft((current) => ({ ...current, secondaryColor: suggestedSecondary }))}
          />
        </div>
        <p className="color-help" aria-live="polite">{sampling ? `Click anywhere on the garment to sample the ${sampling} color.` : sampleStatus || "Primary colors come from the image. A secondary is suggested only when a distinct color has meaningful coverage."}</p>
      </fieldset>

      <div className="field details-field">
        <span>Details</span>
        <TagEditor tags={draft.tags} onChange={(tags) => setDraft((current) => ({ ...current, tags }))} />
      </div>
    </div>
  );
}

function TurnaroundStrip({ frames, label }) {
  const [index, setIndex] = useState(0);
  const dragRef = useRef(null);
  const count = frames.length;
  const wrap = (value) => ((value % count) + count) % count;

  const startDrag = (event) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { x: event.clientX, index, segment: event.currentTarget.clientWidth / count };
  };

  const drag = (event) => {
    const start = dragRef.current;
    if (!start) return;
    setIndex(wrap(start.index + Math.round((start.x - event.clientX) / start.segment)));
  };

  const endDrag = () => { dragRef.current = null; };

  const onKeyDown = (event) => {
    const delta = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (!delta) return;
    event.preventDefault();
    setIndex((current) => wrap(current + delta));
  };

  return (
    <div className="turnaround-strip">
      <div
        className="turnaround-stage"
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={1}
        aria-valuemax={count}
        aria-valuenow={index + 1}
        aria-valuetext={TURNAROUND_VIEWS[index] || `View ${index + 1}`}
        onPointerDown={startDrag}
        onPointerMove={drag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
      >
        {frames.map((frame, frameIndex) => (
          <img
            key={frame}
            className={frameIndex === index ? "active" : ""}
            src={frame}
            alt=""
            draggable={false}
          />
        ))}
      </div>
      <div className="turnaround-dots" aria-hidden="true">
        {frames.map((frame, frameIndex) => <span key={frame} className={frameIndex === index ? "active" : ""} />)}
      </div>
    </div>
  );
}

function TurnaroundPanel({ turnaround, onGenerate, canEdit }) {
  const [pending, setPending] = useState(false);
  const [requestError, setRequestError] = useState("");
  const status = turnaround?.status;

  const generate = async () => {
    setPending(true);
    setRequestError("");
    try {
      await onGenerate();
    } catch (error) {
      setRequestError(error.message);
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="turnaround" aria-label="360 view controls">
      {status === "failed" && <p className="turnaround-error" role="alert">{turnaround.error}</p>}
      {canEdit && status !== "processing" && (
        <button className="turnaround-action" type="button" onClick={generate} disabled={pending}>
          {TURNAROUND_ACTIONS[status] || "Generate 360 view"}
        </button>
      )}
      {requestError && <p className="turnaround-error" role="alert">{requestError}</p>}
    </section>
  );
}

function SpinHero({ turnaround, label, sampling, garmentArtwork }) {
  const frames = turnaround?.frames || [];
  return (
    <div className="spin-hero">
      {sampling ? garmentArtwork : frames.length ? <TurnaroundStrip frames={frames} label={label} /> : (
        <p className="turnaround-status" role="status">
          {turnaround?.status === "processing" && <SpinnerGap size={14} className="import-spinner" aria-hidden="true" />}
          {turnaround?.status === "processing" ? "Preparing 360 view" : "No 360 view yet"}
        </p>
      )}
    </div>
  );
}

function ItemViewer({ item, onClose, onSave, onDelete, onGenerateTurnaround, canEdit }) {
  const closeButtonRef = useRef(null);
  const imageRef = useRef(null);
  const samplingCanvasRef = useRef(null);
  const shakeTimerRef = useRef(null);
  const [sampling, setSampling] = useState(null);
  const [sampleStatus, setSampleStatus] = useState("");
  const [palette, setPalette] = useState(item.palette || []);
  const [draft, setDraft] = useState({ name: item.name || "", part: item.part, color: item.color || "#9a9286", secondaryColor: item.secondaryColor || null, tags: [...(item.tags || [])] });
  const [shaking, setShaking] = useState(false);
  const [closeBlocked, setCloseBlocked] = useState(false);
  const type = TYPE_MAP[item.part]?.singular || "Wardrobe item";

  const isDirty = useMemo(() => {
    const normalizedTags = (tags) => tags.map((tag) => tag.trim()).filter(Boolean);
    return JSON.stringify({
      name: draft.name.trim(),
      part: draft.part,
      color: draft.color?.toLowerCase() || null,
      secondaryColor: draft.secondaryColor?.toLowerCase() || null,
      tags: normalizedTags(draft.tags),
    }) !== JSON.stringify({
      name: (item.name || "").trim(),
      part: item.part,
      color: item.color?.toLowerCase() || null,
      secondaryColor: item.secondaryColor?.toLowerCase() || null,
      tags: normalizedTags(item.tags || []),
    });
  }, [draft, item]);

  const nudgeUnsaved = useCallback(() => {
    setCloseBlocked(true);
    setShaking(false);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setShaking(true));
    });
    clearTimeout(shakeTimerRef.current);
    shakeTimerRef.current = setTimeout(() => setShaking(false), 420);
  }, []);

  const requestClose = useCallback(() => {
    if (isDirty) nudgeUnsaved();
    else onClose();
  }, [isDirty, nudgeUnsaved, onClose]);

  useEffect(() => {
    document.body.classList.add("viewer-open");
    closeButtonRef.current?.focus({ preventScroll: true });
    return () => {
      document.body.classList.remove("viewer-open");
      clearTimeout(shakeTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        if (sampling) setSampling(null);
        else requestClose();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [requestClose, sampling]);

  useEffect(() => {
    if (!isDirty) setCloseBlocked(false);
  }, [isDirty]);

  // Depends on the id only, so a polled turnaround update keeps unsaved edits.
  useEffect(() => {
    setSampling(null);
    setSampleStatus("");
    setPalette(item.palette || []);
    setDraft({ name: item.name || "", part: item.part, color: item.color || "#9a9286", secondaryColor: item.secondaryColor || null, tags: [...(item.tags || [])] });
  }, [item.id]);

  const cancelEditing = () => {
    setDraft({ name: item.name || "", part: item.part, color: item.color || "#9a9286", secondaryColor: item.secondaryColor || null, tags: [...(item.tags || [])] });
    setSampling(null);
    setSampleStatus("");
    onClose();
  };

  const saveEditing = () => {
    onSave({ ...item, ...draft, name: draft.name.trim(), tags: draft.tags.map((tag) => tag.trim()).filter(Boolean) });
    setSampling(null);
    setSampleStatus("Changes saved.");
  };

  const handleImageLoad = (event) => {
    samplingCanvasRef.current = buildSamplingCanvas(event.currentTarget);
    const extracted = extractPalette(event.currentTarget);
    setPalette([...new Set([...(item.palette || []), ...extracted])].slice(0, 5));
  };

  const handleImageClick = (event) => {
    if (!sampling || !samplingCanvasRef.current) return;
    const color = sampleImageColor(event.currentTarget, samplingCanvasRef.current, event);
    if (!color) {
      setSampleStatus("That spot is transparent—try directly on the garment.");
      return;
    }
    const targetField = sampling === "secondary" ? "secondaryColor" : "color";
    setDraft((current) => ({ ...current, [targetField]: color }));
    setPalette((current) => [color, ...current.filter((existing) => existing.toLowerCase() !== color.toLowerCase())].slice(0, 5));
    setSampleStatus(`Sampled ${color} as the ${sampling} color.`);
    setSampling(null);
  };

  const garmentArtwork = (
    <div className={`viewer-art${sampling ? " sampling" : ""}`}>
      <OptimizedImage
        ref={imageRef}
        src={item.image}
        alt={`Selected ${type.toLowerCase()}`}
        sizes="(max-width: 520px) 40vw, 300px"
        breakpoints={[160, 240, 320, 480, 640]}
        priority
        onLoad={handleImageLoad}
        onClick={handleImageClick}
      />
      {sampling && <span className="sample-hint">Click garment to sample</span>}
    </div>
  );

  return (
    <div className="viewer-overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && requestClose()}>
    <div className="viewer-entry">
    <aside className={`viewer editing has-spin${shaking ? " shake" : ""}`} role="dialog" aria-modal="true" aria-label="Selected wardrobe item">
      <button className="viewer-icon-close" type="button" onClick={requestClose} aria-label="Close viewer" ref={closeButtonRef}>
        <X size={24} weight="light" aria-hidden="true" />
      </button>

      <SpinHero
        turnaround={item.turnaround}
        label={`${draft.name || type} 360 view`}
        sampling={sampling}
        garmentArtwork={garmentArtwork}
      />

      <TurnaroundPanel turnaround={item.turnaround} onGenerate={() => onGenerateTurnaround(item.id)} canEdit={canEdit} />

      {!canEdit && (
        <div className="viewer-details">
          <ItemSummary item={item} />
        </div>
      )}

      {canEdit && <div className="viewer-details editing">
        <ItemEditor
          draft={draft}
          setDraft={setDraft}
          palette={palette}
          sampling={sampling}
          setSampling={setSampling}
          sampleStatus={sampleStatus}
        />

        {closeBlocked && <p className="unsaved-notice" role="status">Save or cancel changes before closing.</p>}

        <div className="viewer-actions">
          <button className="delete-button" type="button" onClick={() => onDelete(item.id)}>
            <Trash size={15} weight="regular" aria-hidden="true" /> Delete
          </button>
          <span className="action-spacer" />
          <button className="secondary-button" type="button" onClick={cancelEditing}>Cancel</button>
          <button className="primary-button" type="button" onClick={saveEditing}>
            <Check size={15} weight="bold" aria-hidden="true" /> Save
          </button>
        </div>
      </div>}
    </aside>
    </div>
    </div>
  );
}

// Editing needs the import secret when the server requires one. Until the config answers, assume it does.
function useCanEdit() {
  const [requiresSecret, setRequiresSecret] = useState(true);
  const [hasSecret, setHasSecret] = useState(() => Boolean(storedSecret()));
  useEffect(() => {
    fetch("/api/import/config", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((config) => { if (config) setRequiresSecret(Boolean(config.requiresSecret)); })
      .catch(() => {});
    const update = () => setHasSecret(Boolean(storedSecret()));
    window.addEventListener(SECRET_CHANGE_EVENT, update);
    window.addEventListener("storage", update);
    return () => { window.removeEventListener(SECRET_CHANGE_EVENT, update); window.removeEventListener("storage", update); };
  }, []);
  return !requiresSecret || hasSecret;
}

export function App() {
  const [items, setItems] = useState([]);
  const [initialView] = useState(readViewFromUrl);
  const canEdit = useCanEdit();
  const [activeType, setActiveType] = useState(initialView.type);
  const [query, setQuery] = useState(initialView.query);
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/import/wardrobe", { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error("Could not load the wardrobe.");
        return response.json();
      })
      .then((loadedItems) => {
        const edits = readEdits();
        const deleted = readDeletedItems();
        const visibleItems = loadedItems.filter((item) => !deleted.has(item.id));
        setItems(visibleItems.map((item) => ({ ...item, ...(edits[item.id] || {}) })));
      })
      .catch((requestError) => setError(requestError.message))
      .finally(() => setLoading(false));
  }, []);

  const mergeTurnarounds = useCallback((records) => {
    const byId = new Map(records.map((record) => [record.id, record]));
    setItems((current) => {
      const next = current.map((item) => {
        const record = byId.get(item.id);
        if (!record || JSON.stringify(record.turnaround) === JSON.stringify(item.turnaround)) return item;
        return { ...item, turnaround: record.turnaround };
      });
      return next.some((item, index) => item !== current[index]) ? next : current;
    });
  }, []);

  const hasProcessingTurnaround = items.some((item) => item.turnaround?.status === "processing");

  useEffect(() => {
    if (!hasProcessingTurnaround) return undefined;
    const timer = setInterval(() => {
      fetch("/api/import/wardrobe", { cache: "no-store" })
        .then((response) => response.ok ? response.json() : null)
        .then((records) => records && mergeTurnarounds(records))
        .catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, [hasProcessingTurnaround, mergeTurnarounds]);

  const generateTurnaround = async (id) => {
    const response = await fetch(`/api/import/wardrobe/${id}/turnaround`, { method: "POST", headers: importAuthHeaders() });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Could not start the 360 view.");
    mergeTurnarounds([result]);
  };

  const selectedItem = items.find((item) => item.id === selectedId) || null;

  useEffect(() => { writeViewToUrl({ type: activeType, query }); }, [activeType, query]);

  const visibleItems = useMemo(() => {
    const filtered = items.filter((item) => (activeType === "all" || item.part === activeType) && matchesSearch(item, query));
    return [...filtered].sort((a, b) => {
      if (activeType === "all") {
        const typeDifference = (TYPE_ORDER[a.part] ?? 99) - (TYPE_ORDER[b.part] ?? 99);
        if (typeDifference) return typeDifference;
      }
      return a.id.localeCompare(b.id);
    });
  }, [activeType, items, query]);
  const filtering = activeType !== "all" || Boolean(query.trim());

  const chooseType = (typeId) => {
    setActiveType(typeId);
    setSelectedId(null);
  };

  const saveItem = (updatedItem) => {
    setItems((current) => current.map((item) => item.id === updatedItem.id ? updatedItem : item));
    persistEdit(updatedItem);
  };

  const deleteItem = async (id) => {
    if (id.startsWith("import-")) {
      try {
        const response = await fetch(`/api/import/wardrobe/${id}`, { method: "DELETE", headers: importAuthHeaders() });
        if (!response.ok && response.status !== 404) throw new Error("Could not delete the imported item.");
      } catch (requestError) {
        setError(requestError.message);
        return;
      }
    }
    setItems((current) => current.filter((item) => item.id !== id));
    removePersistedEdit(id);
    persistDeletedItem(id);
    setSelectedId(null);
  };

  const addImportedItem = useCallback((newItem) => {
    setItems((current) => current.some((item) => item.id === newItem.id) ? current : [...current, newItem]);
  }, []);

  return (
    <div className={`app-shell${selectedItem ? " has-selection" : ""}`}>
      <main className="gallery-pane">
        <header className="gallery-header">
          <div className="gallery-meta-row">
            <p className="piece-count">{filtering ? `${visibleItems.length} of ${items.length}` : items.length} {items.length === 1 ? "piece" : "pieces"}</p>
            <label className="gallery-search">
              <MagnifyingGlass size={15} aria-hidden="true" />
              <input
                type="search"
                value={query}
                onChange={(event) => { setQuery(event.target.value); setSelectedId(null); }}
                placeholder="Search by name or detail"
                aria-label="Search pieces by name or detail"
                autoComplete="off"
                spellCheck={false}
              />
              {query && <button type="button" onClick={() => setQuery("")} aria-label="Clear search"><X size={14} aria-hidden="true" /></button>}
            </label>
          </div>
          <nav className="category-nav" aria-label="Filter wardrobe by item type">
            {TYPES.map((type) => (
              <button
                key={type.id}
                type="button"
                className={activeType === type.id ? "active" : ""}
                onClick={() => chooseType(type.id)}
                aria-pressed={activeType === type.id}
              >
                {type.label}
              </button>
            ))}
          </nav>
        </header>

        {error && <p className="status error">{error}</p>}
        {!error && loading && <p className="status">Loading wardrobe</p>}
        {!error && !loading && !items.length && <p className="status empty">Drop, paste, or add a photo to import your first piece.</p>}
        {!!items.length && !visibleItems.length && (
          <p className="status empty">
            No pieces match{query.trim() ? ` “${query.trim()}”` : ""}{activeType !== "all" ? ` in ${TYPE_MAP[activeType].label}` : ""}.
            {" "}<button type="button" className="status-link" onClick={() => { setQuery(""); setActiveType("all"); }}>Show everything</button>
          </p>
        )}

        {!!items.length && (
          <section className="gallery-grid" aria-label={`${TYPE_MAP[activeType]?.label || "All"} wardrobe items`}>
            {visibleItems.map((item) => (
              <GalleryItem
                key={item.id}
                item={item}
                selected={selectedId === item.id}
                onOpen={setSelectedId}
              />
            ))}
          </section>
        )}
      </main>

      {selectedItem && <ItemViewer item={selectedItem} onClose={() => setSelectedId(null)} onSave={saveItem} onDelete={deleteItem} onGenerateTurnaround={generateTurnaround} canEdit={canEdit} />}
      <WardrobeImportFlow onGarmentApproved={addImportedItem} />
    </div>
  );
}
