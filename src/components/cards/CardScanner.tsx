import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, FlipHorizontal2, Layers, Loader2, RotateCcw, ShieldAlert, Sparkles, SquareStack, Upload } from "lucide-react";
import { toast } from "sonner";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { computeSourceCrop, outputSize } from "@/lib/cards/scanner";
import { createSlabImageState, releaseSlabImageState, type SlabImageState } from "@/lib/slabs/image-state";
import { stageCameraCapture } from "@/lib/slabs/camera-capture";
import { analyzeSlab } from "@/lib/slabs/data";
import { stageRawCard, rawIdentityGaps } from "@/lib/cards/stage-raw";
import { classifyScannedItem, type ItemType } from "@/lib/slabs/classify-item";
import { decideIntakeRoute } from "@/lib/slabs/intake-route";
import { slabBackRequirement, canSkipBack } from "@/lib/slabs/back-capture";
import type { AnalyzeResult } from "@/server/analyze-slab/handler";

type Phase = "starting" | "camera" | "busy" | "review" | "error";
const SLAB_INTAKE_ROUTE = "/slabs/new";

function errorMessage(error: unknown): string {
  if (error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError")) {
    return "Camera permission was denied. Allow camera access in your browser settings, then try again.";
  }
  if (error instanceof DOMException && error.name === "NotFoundError") return "No camera was found on this device.";
  return error instanceof Error ? error.message : "The camera could not be started.";
}

/**
 * Universal "Scan Item" scanner with a front/back workflow.
 *
 * Capture the front → analyze once → classify. A graded slab may require or
 * recommend the back (unreadable cert, low confidence, or disagreeing reads); a
 * raw card offers the back for condition/verification. The back can be captured,
 * uploaded, or skipped (when permitted); adding or replacing it triggers ONE
 * combined reanalysis, and unchanged images are never analyzed twice. A graded
 * item stages both images + the analysis into /slabs/new (no repeat call); a raw
 * item is created from the SAME extraction with no second model request.
 * Captures survive analysis/quota failures and route changes.
 */
export function CardScanner({ onInventoryChange }: { onInventoryChange?: () => void }) {
  const navigate = useNavigate();
  const videoRef = useRef<HTMLVideoElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const guideRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const backInputRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // The (front,back) File pair the current analysis was computed from — so the
  // same unchanged images are never analyzed twice.
  const analyzedRef = useRef<{ front: File | null; back: File | null }>({ front: null, back: null });

  const [facingMode, setFacingMode] = useState<"environment" | "user">("environment");
  const [phase, setPhase] = useState<Phase>("starting");
  const [cameraError, setCameraError] = useState("");
  const [busyLabel, setBusyLabel] = useState("");
  const [front, setFront] = useState<SlabImageState | null>(null);
  const [back, setBack] = useState<SlabImageState | null>(null);
  const [analysis, setAnalysis] = useState<AnalyzeResult | null>(null);
  const [analysisError, setAnalysisError] = useState("");
  const [override, setOverride] = useState<ItemType | null>(null);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const startCamera = useCallback(async () => {
    stopCamera();
    setPhase("starting");
    setCameraError("");
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser does not support live camera scanning.");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: facingMode }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setPhase("camera");
    } catch (error) {
      setCameraError(errorMessage(error));
      setPhase("error");
    }
  }, [facingMode, stopCamera]);

  useEffect(() => {
    void startCamera();
    return stopCamera;
  }, [startCamera, stopCamera]);

  const captureBlob = useCallback(async (): Promise<Blob> => {
    const video = videoRef.current;
    const frame = frameRef.current;
    const guide = guideRef.current;
    const canvas = canvasRef.current;
    if (!video || !frame || !guide || !canvas || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      throw new Error("Camera frame is not ready yet.");
    }
    const crop = computeSourceCrop(video.videoWidth, video.videoHeight, frame.getBoundingClientRect(), guide.getBoundingClientRect());
    const size = outputSize(crop);
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image capture is unavailable in this browser.");
    context.drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, size.width, size.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
    if (!blob) throw new Error("The camera frame could not be encoded.");
    return blob;
  }, []);

  // Analyze the current pair, but only if it changed since the last run — the
  // same unchanged images are never analyzed twice. A failure (e.g. quota) never
  // discards the captured images.
  const analyzePair = useCallback(async (nextFront: SlabImageState, nextBack: SlabImageState | null, force = false) => {
    if (!force && analyzedRef.current.front === nextFront.file && analyzedRef.current.back === (nextBack?.file ?? null)) {
      return;
    }
    setPhase("busy");
    setBusyLabel(nextBack ? "Reconciling front and back…" : "Analyzing item…");
    setAnalysisError("");
    try {
      const result = await analyzeSlab(
        { blob: nextFront.file, mime: nextFront.file.type || "image/jpeg" },
        nextBack ? { blob: nextBack.file, mime: nextBack.file.type || "image/jpeg" } : null,
      );
      if (result.status === "success") {
        setAnalysis(result);
        analyzedRef.current = { front: nextFront.file, back: nextBack?.file ?? null };
      } else {
        setAnalysis(null);
        setAnalysisError(result.message);
      }
    } catch (error) {
      setAnalysis(null);
      setAnalysisError(errorMessage(error));
    } finally {
      setPhase("review");
    }
  }, []);

  const captureFront = async () => {
    if (phase !== "camera") return;
    setPhase("busy");
    setBusyLabel("Capturing…");
    try {
      const blob = await captureBlob();
      const { image, error } = await createSlabImageState(blob, { fallbackName: "front.jpg" });
      if (error || !image) throw new Error(error ?? "The captured photo could not be prepared.");
      setFront(image);
      setBack(null);
      setOverride(null);
      analyzedRef.current = { front: null, back: null };
      await analyzePair(image, null);
    } catch (error) {
      toast.error(errorMessage(error));
      setPhase("camera");
    }
  };

  const addBack = async (image: SlabImageState) => {
    releaseSlabImageState(back);
    setBack(image);
    await analyzePair(front!, image); // one combined reanalysis
  };

  const captureBack = async () => {
    setPhase("busy");
    setBusyLabel("Capturing back…");
    try {
      const blob = await captureBlob();
      const { image, error } = await createSlabImageState(blob, { fallbackName: "back.jpg" });
      if (error || !image) throw new Error(error ?? "The captured photo could not be prepared.");
      await addBack(image);
    } catch (error) {
      toast.error(errorMessage(error));
      setPhase("review");
    }
  };

  const uploadBack = async (file: File) => {
    setPhase("busy");
    setBusyLabel("Preparing back…");
    const { image, error } = await createSlabImageState(file, { fallbackName: "back.jpg" });
    if (error || !image) {
      toast.error(error ?? "Could not use that image.");
      setPhase("review");
      return;
    }
    await addBack(image);
  };

  const retakeFront = () => {
    releaseSlabImageState(front);
    releaseSlabImageState(back);
    setFront(null);
    setBack(null);
    setAnalysis(null);
    setAnalysisError("");
    setOverride(null);
    analyzedRef.current = { front: null, back: null };
    setPhase("camera");
  };

  const retakeBack = async () => {
    releaseSlabImageState(back);
    setBack(null);
    await analyzePair(front!, null); // back removed → reconcile front-only (one call)
  };

  // ── Routing ────────────────────────────────────────────────────────────────
  const routeToSlab = () => {
    stageCameraCapture(front!, back, analysis);
    stopCamera();
    toast.success("Graded slab — finish the details.");
    navigate(SLAB_INTAKE_ROUTE);
  };

  const routeToRaw = async () => {
    if (!analysis) {
      toast.error("Couldn't read the card. Reanalyze, add the back, or file it as a slab.");
      return;
    }
    const gaps = rawIdentityGaps(analysis);
    if (gaps.length > 0) {
      toast.error(`Still missing ${gaps.join(", ")} — capture the back or reanalyze.`);
      return;
    }
    setPhase("busy");
    setBusyLabel("Adding to raw inventory…");
    try {
      const card = await stageRawCard(analysis, { front: front!.file, back: back?.file ?? null });
      toast.success(`${card.card_name} added as ${card.inventory_code}.`);
      onInventoryChange?.();
      retakeFront(); // reset for the next scan; camera stays live
    } catch (error) {
      toast.error(errorMessage(error));
      setPhase("review");
    }
  };

  // ── Derived review state ────────────────────────────────────────────────────
  const classification = analysis ? classifyScannedItem(analysis) : null;
  const route = analysis ? decideIntakeRoute(classification!) : "choose";
  const effectiveType: ItemType | null = override ?? (route === "slab" ? "graded_slab" : route === "raw" ? "raw_card" : null);
  const backReq = analysis && effectiveType === "graded_slab" ? slabBackRequirement(analysis) : null;
  const backBlocked = !!backReq && backReq.requirement === "required" && !back && !canSkipBack(backReq.requirement);

  return (
    <section className="relative overflow-hidden rounded-2xl bg-slate-950 text-white shadow-2xl sm:min-h-[680px]">
      <div ref={frameRef} className="relative h-[calc(100dvh-8.5rem)] min-h-[520px] w-full overflow-hidden sm:h-[680px]">
        <video ref={videoRef} playsInline muted className="h-full w-full object-cover" aria-label="Live camera preview" />
        <div className="pointer-events-none absolute inset-0 bg-black/20" />
        <div
          ref={guideRef}
          className="pointer-events-none absolute left-1/2 top-1/2 aspect-[5/7] h-[70%] max-h-[560px] -translate-x-1/2 -translate-y-1/2 rounded-[5%] border-2 border-white/90 shadow-[0_0_0_9999px_rgba(0,0,0,0.36)]"
        >
          <span className="absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-black/55 px-3 py-1 text-xs font-medium">
            {phase === "review" ? "Add the back, or file this item" : "Align the card or slab inside the guide"}
          </span>
          <i className="absolute -left-1 -top-1 h-10 w-10 rounded-tl-xl border-l-4 border-t-4 border-secondary" />
          <i className="absolute -right-1 -top-1 h-10 w-10 rounded-tr-xl border-r-4 border-t-4 border-secondary" />
          <i className="absolute -bottom-1 -left-1 h-10 w-10 rounded-bl-xl border-b-4 border-l-4 border-secondary" />
          <i className="absolute -bottom-1 -right-1 h-10 w-10 rounded-br-xl border-b-4 border-r-4 border-secondary" />
        </div>

        <div className="absolute left-3 right-3 top-3 flex items-center justify-end gap-2">
          <Button
            type="button" variant="outline" size="icon"
            className="border-white/40 bg-black/50 text-white hover:bg-black/70 hover:text-white"
            onClick={() => setFacingMode((mode) => (mode === "environment" ? "user" : "environment"))}
            disabled={phase === "busy"}
            aria-label="Flip camera"
          ><FlipHorizontal2 /></Button>
        </div>

        {phase === "starting" && (
          <div className="absolute inset-0 grid place-items-center bg-slate-950/80"><div className="text-center"><Loader2 className="mx-auto mb-3 h-8 w-8 animate-spin" /><p>Starting camera…</p></div></div>
        )}
        {phase === "error" && (
          <div className="absolute inset-0 grid place-items-center bg-slate-950 p-6 text-center">
            <div className="max-w-sm"><ShieldAlert className="mx-auto mb-3 h-10 w-10 text-amber-400" /><h2 className="text-xl font-bold">Camera unavailable</h2><p className="mt-2 text-sm text-white/70">{cameraError}</p><Button className="mt-5" onClick={() => void startCamera()}><RotateCcw /> Try again</Button></div>
          </div>
        )}
        {phase === "busy" && (
          <div className="absolute inset-0 grid place-items-center bg-slate-950/70">
            <div className="text-center"><Sparkles className="mx-auto mb-3 h-8 w-8 animate-pulse text-primary" /><p>{busyLabel || "Working…"}</p></div>
          </div>
        )}

        {phase === "camera" && (
          <div className="absolute bottom-5 left-0 right-0 flex justify-center">
            <Button
              size="lg" className="h-16 rounded-full border-4 border-white bg-primary px-8 text-lg shadow-xl hover:bg-primary/90"
              onClick={() => void captureFront()}
            ><Camera className="h-6 w-6" /> Scan item</Button>
          </div>
        )}

        {phase === "review" && front && (
          <div className="absolute inset-x-3 bottom-3 max-h-[80%] overflow-y-auto rounded-2xl bg-white p-4 text-slate-900 shadow-2xl sm:left-1/2 sm:right-auto sm:w-[min(94%,600px)] sm:-translate-x-1/2">
            <div className="flex items-start gap-3">
              <div className="flex gap-1">
                <img src={front.previewUrl} alt="Captured front" className="h-28 w-20 rounded-lg object-cover shadow" />
                {back && <img src={back.previewUrl} alt="Captured back" className="h-28 w-20 rounded-lg object-cover shadow" />}
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="font-bold">
                  {effectiveType === "graded_slab" ? "Graded slab" : effectiveType === "raw_card" ? "Raw card" : "Couldn't determine the item type"}
                </h2>
                {analysisError ? (
                  <p className="mt-1 text-sm text-amber-700">Couldn't analyze ({analysisError}) — your capture is kept. Choose the type, reanalyze, or add the back.</p>
                ) : backReq && backReq.requirement !== "optional" ? (
                  <p className={`mt-1 text-sm ${backReq.requirement === "required" ? "text-red-700" : "text-amber-700"}`}>{backReq.reason}</p>
                ) : effectiveType === "raw_card" ? (
                  <p className="mt-1 text-sm text-slate-600">Add the back to record condition (whitening, edges, surface) — optional.</p>
                ) : (
                  <p className="mt-1 text-sm text-slate-600">The front is enough. The back is optional.</p>
                )}
              </div>
            </div>

            {/* Back controls */}
            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => void captureBack()}><Camera className="mr-1 h-4 w-4" /> {back ? "Recapture back" : "Capture back"}</Button>
              <Button variant="outline" size="sm" onClick={() => backInputRef.current?.click()}><Upload className="mr-1 h-4 w-4" /> Upload back</Button>
              {back && <Button variant="ghost" size="sm" onClick={() => void retakeBack()}>Remove back</Button>}
              <Button variant="ghost" size="sm" onClick={() => void analyzePair(front, back, true)}><Sparkles className="mr-1 h-4 w-4" /> Reanalyze</Button>
              <Button variant="ghost" size="sm" onClick={retakeFront}><RotateCcw className="mr-1 h-4 w-4" /> Retake front</Button>
            </div>

            {/* Type + route. Manual override is always available. */}
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t pt-3">
              <div className="flex gap-2">
                <Button variant={effectiveType === "raw_card" ? "default" : "outline"} size="sm" onClick={() => setOverride("raw_card")}><Layers className="mr-1 h-4 w-4" /> Raw</Button>
                <Button variant={effectiveType === "graded_slab" ? "default" : "outline"} size="sm" onClick={() => setOverride("graded_slab")}><SquareStack className="mr-1 h-4 w-4" /> Slab</Button>
              </div>
              {effectiveType === "graded_slab" ? (
                <Button onClick={routeToSlab} disabled={backBlocked} title={backBlocked ? "Capture the back first" : undefined}>Continue to slab details</Button>
              ) : effectiveType === "raw_card" ? (
                <Button onClick={() => void routeToRaw()}>Add to raw inventory</Button>
              ) : (
                <span className="text-sm text-slate-500">Choose Raw or Slab to continue.</span>
              )}
            </div>
            <input ref={backInputRef} type="file" accept="image/*" className="hidden" aria-label="Upload back image"
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void uploadBack(f); }} />
          </div>
        )}
      </div>
      <canvas ref={canvasRef} className="hidden" aria-hidden="true" />
    </section>
  );
}
