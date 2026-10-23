import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowCounterClockwise, Check, Plus, SpinnerGap, Trash, UploadSimple, WarningCircle, X } from "@phosphor-icons/react";
import "./import-flow.css";

const API = "/api/import/jobs";
const CONFIG_API = "/api/import/config";
const PARTS = [
  ["upperbody", "Tops"],
  ["wholebody_up", "Jackets"],
  ["lowerbody", "Bottoms"],
  ["accessories_up", "Accessories"],
  ["shoes", "Shoes"],
];
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const SECRET_KEY = "wardrobe-import-secret";
// Vercel rejects request bodies over 4.5 MB, so photos shrink before upload and an angle batch splits that budget.
const UPLOAD_LIMITS = {
  single: { maxEdge: 2048, passthroughBytes: 1.5 * 1024 * 1024 },
  angles: { maxEdge: 1600, passthroughBytes: 0.75 * 1024 * 1024 },
};
const MAX_ANGLES = 4;

const readDataUrl = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error || new Error("Could not read that image."));
  reader.readAsDataURL(file);
});

async function fileToDataUrl(file, { maxEdge, passthroughBytes }) {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return readDataUrl(file);
  const longEdge = Math.max(bitmap.width, bitmap.height);
  if (file.size < passthroughBytes && longEdge <= maxEdge) {
    bitmap.close();
    return readDataUrl(file);
  }
  const scale = Math.min(1, maxEdge / longEdge);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext("2d");
  // JPEG has no alpha, and transparent pixels would otherwise turn black.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.9);
}

export const SECRET_CHANGE_EVENT = "wardrobe-secret-change";

export function storedSecret() {
  try { return localStorage.getItem(SECRET_KEY) || ""; } catch { return ""; }
}

// The gallery listens for this so it can switch between the editor and the read-only view.
function storeSecret(secret) {
  try {
    if (secret) localStorage.setItem(SECRET_KEY, secret);
    else localStorage.removeItem(SECRET_KEY);
  } catch {}
  window.dispatchEvent(new Event(SECRET_CHANGE_EVENT));
}

export function importAuthHeaders() {
  const secret = storedSecret();
  return secret ? { Authorization: `Bearer ${secret}` } : {};
}

async function api(path, options) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...importAuthHeaders(), ...(options?.headers || {}) },
  });
  const value = await response.json().catch(() => ({}));
  if (response.status === 401) storeSecret("");
  if (!response.ok) throw new Error(value.error || "The import job could not be updated.");
  return value;
}

function SecretForm({ onSave }) {
  const [value, setValue] = useState("");
  return (
    <form className="import-secret" onSubmit={(event) => { event.preventDefault(); if (value.trim()) onSave(value.trim()); }}>
      <div className="import-field"><label htmlFor="import-secret">Import secret</label><input id="import-secret" type="password" autoComplete="current-password" value={value} onChange={(event) => setValue(event.target.value)} /></div>
      <button className="import-button import-button--primary" type="submit" disabled={!value.trim()}>Save</button>
    </form>
  );
}

function deriveStatus(job) {
  const crop = job.stages?.crop;
  const garment = job.stages?.garment;
  if (job.error || crop?.status === "failed" || garment?.status === "failed") return { tone: "error", text: "Import needs attention", detail: crop?.error || garment?.error || job.error };
  if (garment?.status === "review") return { tone: "ready", text: "Ready for review" };
  if (garment?.status === "approved") return { tone: "processing", text: "Saving piece" };
  if (crop?.status === "review") return { tone: "ready", text: "Crop ready for review" };
  if (crop?.status === "approved") return { tone: "processing", text: "Creating garment image" };
  if (crop?.status === "rejected" || garment?.status === "rejected") return { tone: "complete", text: "Import declined" };
  return { tone: "processing", text: "Extracting clothing from image" };
}

function reviewStageFor(job) {
  if (job.stages?.garment?.status === "review") return "garment";
  if (job.stages?.crop?.status === "review") return "crop";
  return null;
}

function hasCleanupFailure(job) {
  return job.stages?.garment?.status === "failed" && Boolean(job.stages?.garment?.failedAssetUrl);
}

function defaultDraft(job) {
  const metadata = job.metadata || {};
  return {
    name: metadata.name || "New piece",
    part: metadata.part || "upperbody",
    color: metadata.color || "#d8d0c2",
    secondaryColor: metadata.secondaryColor || "",
    tags: Array.isArray(metadata.tags) ? metadata.tags.join(", ") : (metadata.tags || ""),
  };
}

function ReviewEditor({ job, stage, draft, setDraft, regenPrompt, setRegenPrompt, busy, onAction }) {
  const asset = job.stages[stage]?.assetUrl;
  const isCrop = stage === "crop";
  const primaryValid = HEX_COLOR.test(draft.color);
  const secondaryValid = !draft.secondaryColor || HEX_COLOR.test(draft.secondaryColor);
  return (
    <div className="import-editor">
      <div className="import-editor__media">
        <img className="import-editor__preview" src={asset} alt={isCrop ? "Detected item crop" : "Extracted garment"} />
        {job.sourceAssetUrls?.length > 1 && <ul className="import-angles">{job.sourceAssetUrls.slice(1).map((url) => <li key={url}><img src={url} alt="Another angle of this piece" /></li>)}</ul>}
      </div>
      <div className="import-fields">
        <p className="import-editor__stage">{isCrop ? "Detected item" : "Garment image"}</p>
        {isCrop ? <p className="import-card__detail">Check that this crop contains the complete intended item. Approving it starts the clean garment-image generation.</p> : (
          <>
            <div className="import-field"><label htmlFor={`name-${job.id}`}>Name</label><input id={`name-${job.id}`} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></div>
            <div className="import-field"><label htmlFor={`part-${job.id}`}>Category</label><select id={`part-${job.id}`} value={draft.part} onChange={(event) => setDraft({ ...draft, part: event.target.value })}>{PARTS.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></div>
            <div className="import-field"><label htmlFor={`primary-${job.id}`}>Primary color</label><div className="import-color-row"><input id={`primary-${job.id}`} type="color" value={primaryValid ? draft.color : "#000000"} onChange={(event) => setDraft({ ...draft, color: event.target.value })} /><input aria-label="Primary color hex" aria-invalid={!primaryValid} value={draft.color} onChange={(event) => setDraft({ ...draft, color: event.target.value })} /></div>{!primaryValid && <small className="import-field-error">Use a six-digit hex color, such as #d8d0c2.</small>}</div>
            <div className="import-field"><label htmlFor={`secondary-${job.id}`}>Secondary color <span>optional</span></label><input id={`secondary-${job.id}`} type="text" aria-invalid={!secondaryValid} placeholder="#hex or leave blank" value={draft.secondaryColor} onChange={(event) => setDraft({ ...draft, secondaryColor: event.target.value })} />{!secondaryValid && <small className="import-field-error">Use a six-digit hex color or leave this empty.</small>}</div>
            <div className="import-field"><label htmlFor={`tags-${job.id}`}>Details</label><input id={`tags-${job.id}`} value={draft.tags} placeholder="casual, cotton, striped" onChange={(event) => setDraft({ ...draft, tags: event.target.value })} /></div>
            <p className="import-card__detail">Approving saves the piece to your wardrobe and starts its 360 view.</p>
          </>
        )}
        {!isCrop && <div className="import-field import-regenerate-field">
          <label htmlFor={`regenerate-${job.id}-${stage}`}>Regeneration direction <span>optional</span></label>
          <textarea id={`regenerate-${job.id}-${stage}`} rows="3" value={regenPrompt} onChange={(event) => setRegenPrompt(event.target.value)} placeholder="Example: preserve the original zipper and remove the retail tag" />
        </div>}
        <div className="import-actions">
          <button className="import-button" disabled={busy} onClick={() => onAction("reject")}><Trash size={14} /> Reject</button>
          {!isCrop && <button className="import-button" disabled={busy} onClick={() => onAction("regenerate", regenPrompt)}><ArrowCounterClockwise size={14} /> Regenerate</button>}
          <button className="import-button import-button--primary" disabled={busy || (!isCrop && (!draft.name.trim() || !primaryValid || !secondaryValid))} onClick={() => onAction("approve")}><Check size={14} weight="bold" /> {isCrop ? "Use crop" : "Approve"}</button>
        </div>
      </div>
    </div>
  );
}

function CleanupEditor({ job, tolerance, setTolerance, busy, onPreview, onAccept }) {
  const stage = job.stages.garment;
  const contaminated = stage.cleanupDiagnostics?.contaminatedPixels;
  const previewTimer = useRef(null);
  useEffect(() => () => clearTimeout(previewTimer.current), []);
  const updateTolerance = (next) => {
    setTolerance(next);
    clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(() => onPreview(next), 300);
  };
  return (
    <div className="import-cleanup-editor">
      <p className="import-editor__stage">Background cleanup</p>
      <p className="import-card__detail">The generated garment is preserved below. Adjust the cleanup locally—this does not call the image model again.</p>
      <div className="import-cleanup-comparison">
        <figure><img src={stage.failedAssetUrl} alt="Generated garment on its chroma background" /><figcaption>Generated source</figcaption></figure>
        <figure><img src={stage.cleanupPreviewUrl || stage.failedAssetUrl} alt="Transparent garment cleanup preview" /><figcaption>{stage.cleanupPreviewUrl ? "Cleanup preview" : "Preview appears here"}</figcaption></figure>
      </div>
      <div className="import-field import-cleanup-strength">
        <label htmlFor={`cleanup-${job.id}`}>Cleanup strength <strong>{tolerance}</strong></label>
        <input id={`cleanup-${job.id}`} type="range" min="18" max="110" step="2" value={tolerance} onChange={(event) => updateTolerance(Number(event.target.value))} />
        <div className="import-cleanup-scale"><span>Preserve more edge detail</span><span>Remove more background</span></div>
      </div>
      {Number.isFinite(contaminated) && <p className="import-card__detail">The automated check sees {contaminated.toLocaleString()} tinted edge {contaminated === 1 ? "pixel" : "pixels"}. If the preview looks clean, you can still use it.</p>}
      <div className="import-actions">
        <button className="import-button" disabled={busy} onClick={() => onPreview(tolerance)}><ArrowCounterClockwise size={14} /> Preview cleanup</button>
        <button className="import-button import-button--primary" disabled={busy} onClick={onAccept}><Check size={14} weight="bold" /> Use this cleanup</button>
      </div>
    </div>
  );
}

export function WardrobeImportFlow({ onGarmentApproved }) {
  const inputRef = useRef(null);
  const [jobs, setJobs] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [regenerationPrompts, setRegenerationPrompts] = useState({});
  const [cleanupTolerances, setCleanupTolerances] = useState({});
  const [dragging, setDragging] = useState(false);
  const [open, setOpen] = useState(false);
  const [selectedReviewId, setSelectedReviewId] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(null);
  const [setup, setSetup] = useState(null);
  const [uploading, setUploading] = useState(0);
  const [pendingBatch, setPendingBatch] = useState(null);
  const pendingPreviews = useMemo(() => pendingBatch?.map((file) => URL.createObjectURL(file)) || [], [pendingBatch]);
  useEffect(() => () => pendingPreviews.forEach((preview) => URL.revokeObjectURL(preview)), [pendingPreviews]);

  const loadConfig = useCallback(() => {
    api(CONFIG_API).then(setSetup).catch((requestError) => setSetup({ ready: false, error: requestError.message }));
  }, []);

  useEffect(() => {
    loadConfig();
    api(API)
      .then((storedJobs) => {
        const visibleJobs = storedJobs.filter((job) => job.status !== "complete" && job.stages?.crop?.status !== "rejected" && job.stages?.garment?.status !== "rejected");
        setJobs(visibleJobs);
        setDrafts(Object.fromEntries(visibleJobs.map((job) => [job.id, defaultDraft(job)])));
      })
      .catch(() => {});
  }, [loadConfig]);

  const refresh = useCallback(async (id) => {
    try {
      const next = await api(`${API}/${id}`);
      setJobs((current) => current.map((job) => job.id === id ? next : job));
      setDrafts((current) => current[id] ? current : { ...current, [id]: defaultDraft(next) });
    } catch (requestError) { setError(requestError.message); }
  }, []);

  useEffect(() => {
    if (!jobs.some((job) => job.stages?.crop?.status === "approved" && ["processing", "pending", "queued"].includes(job.stages?.garment?.status))) return undefined;
    const timer = setInterval(() => jobs.forEach((job) => refresh(job.id)), 2000);
    return () => clearInterval(timer);
  }, [jobs, refresh]);

  const uploadImages = useCallback(async (images, mode) => {
    setPendingBatch(null);
    setUploading(images.length);
    const uploads = mode === "angles" ? [images] : images.map((file) => [file]);
    for (const files of uploads) {
      const [file] = files;
      try {
        const limits = files.length > 1 ? UPLOAD_LIMITS.angles : UPLOAD_LIMITS.single;
        const imageDataUrls = await Promise.all(files.map((image) => fileToDataUrl(image, limits)));
        const result = await api(API, { method: "POST", body: JSON.stringify({ imageDataUrls, mode, metadata: { name: file.name.replace(/\.[^.]+$/, "") } }) });
        const createdJobs = result.jobs || [result];
        if (!createdJobs.length && result.noClothingDetected) {
          setNotice({ tone: "complete", text: "No clothing detected", detail: `We couldn’t find a distinct wearable item in ${files.length > 1 ? "those photos" : file.name}. Try a clearer or more tightly framed image.` });
          setOpen(true);
          continue;
        }
        setJobs((current) => [...current, ...createdJobs]);
        setDrafts((current) => ({ ...current, ...Object.fromEntries(createdJobs.map((job) => [job.id, defaultDraft(job)])) }));
      } catch (requestError) { setError(requestError.message); }
      finally { setUploading((count) => Math.max(0, count - files.length)); }
    }
  }, []);

  const submitFiles = useCallback((files) => {
    if (!setup?.ready || (setup.requiresSecret && !storedSecret())) { setOpen(true); return; }
    const images = [...files].filter((file) => file.type.startsWith("image/"));
    if (!images.length) return;
    setDragging(false); setError(""); setNotice(null);
    if (images.length > 1) { setPendingBatch(images); setOpen(true); return; }
    uploadImages(images, "separate");
  }, [setup, uploadImages]);

  useEffect(() => {
    let depth = 0;
    const onDragEnter = (event) => { if (![...event.dataTransfer.types].includes("Files")) return; event.preventDefault(); depth += 1; setDragging(true); };
    const onDragOver = (event) => { if ([...event.dataTransfer.types].includes("Files")) event.preventDefault(); };
    const onDragLeave = (event) => { event.preventDefault(); depth = Math.max(0, depth - 1); if (!depth) setDragging(false); };
    const onDrop = (event) => { event.preventDefault(); depth = 0; setDragging(false); submitFiles(event.dataTransfer.files); };
    const onPaste = (event) => { const files = [...event.clipboardData.files]; if (files.some((file) => file.type.startsWith("image/"))) { event.preventDefault(); submitFiles(files); } };
    window.addEventListener("dragenter", onDragEnter); window.addEventListener("dragover", onDragOver); window.addEventListener("dragleave", onDragLeave); window.addEventListener("drop", onDrop); window.addEventListener("paste", onPaste);
    return () => { window.removeEventListener("dragenter", onDragEnter); window.removeEventListener("dragover", onDragOver); window.removeEventListener("dragleave", onDragLeave); window.removeEventListener("drop", onDrop); window.removeEventListener("paste", onPaste); };
  }, [submitFiles]);

  const dropJob = (jobId) => {
    const remainingJobs = jobs.filter((item) => item.id !== jobId);
    setJobs((current) => current.filter((item) => item.id !== jobId));
    setDrafts((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== jobId)));
    setSelectedReviewId(null);
    if (!remainingJobs.length) setOpen(false);
  };

  const perform = async (job, stage, action, prompt = "") => {
    setBusyId(job.id); setError("");
    try {
      if (stage === "garment" && action === "approve") {
        const draft = drafts[job.id];
        const metadata = { ...draft, secondaryColor: draft.secondaryColor || null, tags: draft.tags.split(",").map((tag) => tag.trim()).filter(Boolean) };
        await api(`${API}/${job.id}/metadata`, { method: "PATCH", body: JSON.stringify({ metadata }) });
        await api(`${API}/${job.id}/stages/garment/approve`, { method: "POST" });
        const garmentPath = `/api/import/library/import-${job.id}-garment.png`;
        // The server starts the 360 view on approval. Polling replaces this with the stored state.
        const turnaround = { status: "processing", frames: [], sheet: null, error: null, updatedAt: new Date().toISOString() };
        onGarmentApproved?.({ id: `import-${job.id}`, ...metadata, image: garmentPath, thumbnail: garmentPath, palette: [metadata.color, metadata.secondaryColor].filter(Boolean), importJobId: job.id, turnaround });
        dropJob(job.id);
      } else {
        const updated = await api(`${API}/${job.id}/stages/${stage}/${action}`, { method: "POST", body: action === "regenerate" ? JSON.stringify({ prompt }) : undefined });
        if (action === "reject") dropJob(job.id);
        else setJobs((current) => current.map((item) => item.id === job.id ? updated : item));
        if (action === "regenerate") setRegenerationPrompts((current) => ({ ...current, [`${job.id}:${stage}`]: "" }));
      }
    } catch (requestError) { setError(requestError.message); }
    finally { setBusyId(null); }
  };

  const performCleanup = async (job, action, requestedTolerance) => {
    setBusyId(job.id); setError("");
    try {
      const tolerance = requestedTolerance ?? cleanupTolerances[job.id] ?? job.stages?.garment?.cleanupTolerance ?? 46;
      const updated = await api(`${API}/${job.id}/stages/garment/cleanup-${action}`, { method: "POST", body: JSON.stringify({ tolerance }) });
      setJobs((current) => current.map((item) => item.id === job.id ? updated : item));
      setCleanupTolerances((current) => ({ ...current, [job.id]: updated.stages?.garment?.cleanupTolerance ?? tolerance }));
      setSelectedReviewId(job.id);
    } catch (requestError) { setError(requestError.message); }
    finally { setBusyId(null); }
  };

  const deleteJob = async (job) => {
    setBusyId(job.id); setError("");
    try {
      await api(`${API}/${job.id}`, { method: "DELETE" });
      const remaining = jobs.filter((item) => item.id !== job.id);
      setJobs(remaining);
      setDrafts((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== job.id)));
      if (selectedReviewId === job.id) setSelectedReviewId(null);
      if (!remaining.length) setOpen(false);
    } catch (requestError) { setError(requestError.message); }
    finally { setBusyId(null); }
  };

  const active = jobs[jobs.length - 1];
  const setupRequired = setup?.ready === false;
  const needsSecret = Boolean(setup?.requiresSecret) && !storedSecret();
  const uploadStatus = uploading ? { tone: "processing", text: uploading === 1 ? "Detecting clothing" : `Detecting clothing in ${uploading} photos` } : null;
  const activeStatus = setupRequired ? { tone: "error", text: "Setup required" } : active ? deriveStatus(active) : uploadStatus || notice;
  const readyCount = jobs.filter((job) => deriveStatus(job).tone === "ready").length;
  const selectedReviewJob = jobs.find((job) => job.id === selectedReviewId && (reviewStageFor(job) || hasCleanupFailure(job)));
  const reviewJob = selectedReviewJob || jobs.find((job) => reviewStageFor(job)) || jobs.find((job) => hasCleanupFailure(job)) || active;
  const reviewStage = reviewJob ? reviewStageFor(reviewJob) : null;
  const progress = 0;
  const hasImportActivity = Boolean(jobs.length || uploading || notice || setupRequired);
  const close = () => { setOpen(false); setPendingBatch(null); };
  // Dropping down to one photo leaves nothing to choose between, so it imports the way a single pick does.
  const dropPhoto = (index) => {
    const remaining = pendingBatch.filter((_, position) => position !== index);
    if (remaining.length === 1) uploadImages(remaining, "separate");
    else setPendingBatch(remaining.length ? remaining : null);
  };

  return (
    <>
      <input ref={inputRef} type="file" accept="image/*" multiple hidden disabled={!setup?.ready} onChange={(event) => { submitFiles(event.target.files); event.target.value = ""; }} />
      <div className="import-drop-overlay" data-active={dragging && !setupRequired} aria-hidden={!dragging || setupRequired}><div className="import-drop-target is-over"><UploadSimple size={34} weight="light" /><h2>Drop clothing images</h2><p>A single garment or a photo of a full outfit works. Your wardrobe stays exactly where you left it.</p></div></div>
      <aside className={`import-tray${hasImportActivity ? " is-expanded" : ""}`} aria-label="Wardrobe imports">
        <button className="import-tray__button" type="button" onClick={() => setupRequired || needsSecret || hasImportActivity ? setOpen(true) : inputRef.current?.click()} aria-label={setupRequired ? "Open setup instructions" : hasImportActivity ? "Open import progress" : "Add clothes"}>{activeStatus?.tone === "processing" ? <SpinnerGap size={19} className="import-spinner" /> : activeStatus?.tone === "error" ? <WarningCircle size={19} /> : readyCount ? <span>{readyCount}</span> : notice ? <X size={18} /> : <Plus size={19} />}</button>
        <div className="import-tray__actions">{active && <img className="import-tray__preview" src={active.stages?.garment?.assetUrl || active.stages?.garment?.failedAssetUrl || active.stages?.crop?.assetUrl || active.originalAssetUrl} alt="" />}<span className="import-tray__label">{activeStatus?.text || "Add clothes"}</span>{!setupRequired && <button className="import-icon-button" type="button" onClick={() => inputRef.current?.click()} aria-label="Choose images"><UploadSimple size={17} /></button>}</div>
      </aside>
      <div className="import-popover-backdrop" data-open={open} onMouseDown={(event) => event.target === event.currentTarget && close()}>
        <section className="import-popover" role="dialog" aria-modal="true" aria-labelledby="import-title">
          <header className="import-popover__header"><div><p className="import-popover__eyebrow">Wardrobe import</p><h2 className="import-popover__title" id="import-title">{pendingBatch ? `${pendingBatch.length} photos selected` : readyCount ? `${readyCount} ready for review` : activeStatus?.tone === "error" ? "Import needs attention" : jobs.length || uploading ? "Preparing new pieces" : notice?.text || "Add to your wardrobe"}</h2></div><button className="import-icon-button" type="button" onClick={close} aria-label="Close import progress"><X size={20} /></button></header>
          {needsSecret && !setupRequired && <SecretForm onSave={(secret) => { storeSecret(secret); setError(""); loadConfig(); }} />}
          {pendingBatch ? (
            <>
              <ul className="import-angles import-angles--batch">{pendingPreviews.map((preview, index) => <li key={preview}><img src={preview} alt="" /><button className="import-angle-remove" type="button" onClick={() => dropPhoto(index)} aria-label={`Remove photo ${index + 1}`}><X size={12} weight="bold" /></button></li>)}</ul>
              {pendingBatch.length > MAX_ANGLES && <p className="import-card__detail">One piece takes up to {MAX_ANGLES} angles. Remove {pendingBatch.length - MAX_ANGLES} to import these as one piece.</p>}
              <div className="import-actions">
                <button className="import-button" type="button" onClick={() => uploadImages(pendingBatch, "separate")}>Separate pieces</button>
                <button className="import-button import-button--primary" type="button" disabled={pendingBatch.length > MAX_ANGLES} onClick={() => uploadImages(pendingBatch, "angles")}>One piece, several angles</button>
              </div>
            </>
          ) : !jobs.length ? setupRequired ? <div className="import-drop-target import-setup-warning"><WarningCircle size={30} /><h2>Setup required</h2>{setup.setupMessage ? <p>{setup.setupMessage}</p> : <p>Add your OpenAI API key to <code>.env</code> and a PNG reference photo of yourself at <code>{setup.modelReference || "data/model-reference.png"}</code>, then restart the app.</p>}</div> : uploading ? <div className="import-progress is-indeterminate"><div className="import-progress__meta"><span>{uploadStatus.text}</span><span>{uploading} {uploading === 1 ? "photo" : "photos"}</span></div><div className="import-progress__track"><div className="import-progress__bar" /></div></div> : <div className="import-drop-target"><UploadSimple size={28} /><h2>{notice ? "Try another image" : "Choose or paste an image"}</h2><p>{notice?.detail || "We’ll isolate each clothing item, suggest its details, and hold everything for your approval."}</p><button className="import-button import-button--primary" disabled={!setup?.ready || needsSecret} onClick={() => { setNotice(null); inputRef.current?.click(); }}>Choose images</button></div> : (
            <>
              <div className={`import-progress${activeStatus?.tone !== "processing" ? " is-reviewing" : progress < 100 ? " is-indeterminate" : ""}`}><div className="import-progress__meta"><span>{activeStatus?.text}</span><span>{jobs.length} {jobs.length === 1 ? "item" : "items"}</span></div>{activeStatus?.tone === "processing" && <div className="import-progress__track"><div className="import-progress__bar" style={{ "--import-progress": `${progress}%` }} /></div>}</div>
              {reviewJob && reviewStage ? <ReviewEditor job={reviewJob} stage={reviewStage} draft={drafts[reviewJob.id] || defaultDraft(reviewJob)} setDraft={(draft) => setDrafts((current) => ({ ...current, [reviewJob.id]: draft }))} regenPrompt={regenerationPrompts[`${reviewJob.id}:${reviewStage}`] || ""} setRegenPrompt={(prompt) => setRegenerationPrompts((current) => ({ ...current, [`${reviewJob.id}:${reviewStage}`]: prompt }))} busy={busyId === reviewJob.id} onAction={(action, prompt) => perform(reviewJob, reviewStage, action, prompt)} /> : reviewJob && hasCleanupFailure(reviewJob) ? <CleanupEditor job={reviewJob} tolerance={cleanupTolerances[reviewJob.id] ?? reviewJob.stages.garment.cleanupTolerance ?? 46} setTolerance={(tolerance) => setCleanupTolerances((current) => ({ ...current, [reviewJob.id]: tolerance }))} busy={busyId === reviewJob.id} onPreview={(tolerance) => performCleanup(reviewJob, "preview", tolerance)} onAccept={() => performCleanup(reviewJob, "accept")} /> : null}
              <div className="import-card-list">{jobs.map((job) => { const status = deriveStatus(job); const itemName = drafts[job.id]?.name || job.metadata?.name || "New piece"; const failedStage = job.stages?.garment?.status === "failed" ? "garment" : null; return <article className={`import-card is-${status.tone}${reviewJob?.id === job.id ? " is-selected" : ""}`} key={job.id}><div className="import-card__media"><img className="import-card__image" src={job.stages?.garment?.assetUrl || job.stages?.garment?.failedAssetUrl || job.stages?.crop?.assetUrl || job.originalAssetUrl} alt="" />{job.sourceAssetUrls?.length > 1 && <ul className="import-angles">{job.sourceAssetUrls.slice(1).map((url) => <li key={url}><img src={url} alt="" /></li>)}</ul>}</div><div className="import-card__body"><h3 className="import-card__title">{itemName}</h3><p className="import-card__detail import-card__detail--status" data-tone={status.tone}>{status.tone === "error" ? status.detail : status.text}</p></div><div className="import-card__actions">{status.tone === "ready" && <button className="import-icon-button" onClick={() => { setSelectedReviewId(job.id); setOpen(true); }} aria-label={`Review ${itemName}`}><Check size={17} /></button>}{failedStage && <button className="import-button import-card__retry" disabled={busyId === job.id} onClick={() => perform(job, failedStage, "regenerate", "")}><ArrowCounterClockwise size={14} /> Retry</button>}<button className="import-icon-button import-card__delete" disabled={busyId === job.id} onClick={() => deleteJob(job)} aria-label={`Delete ${itemName} from import queue`}><Trash size={16} /></button></div></article>; })}</div>
              <div className="import-actions"><button className="import-button" onClick={() => inputRef.current?.click()}><Plus size={14} /> Add another</button></div>
            </>
          )}
          {error && <p className="import-status is-error" role="alert">{error}</p>}
        </section>
      </div>
    </>
  );
}
