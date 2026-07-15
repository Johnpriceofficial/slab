import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, FlipHorizontal2, Layers, Loader2, RotateCcw, ShieldAlert, Sparkles, SquareStack } from "lucide-react";
import { toast } from "sonner";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { computeSourceCrop, outputSize } from "@/lib/cards/scanner";
import { createSlabImageState, releaseSlabImageState, type SlabImageState } from "@/lib/slabs/image-state";
import { stageCameraCapture } from "@/lib/slabs/camera-capture";
import { analyzeSlab } from "@/lib/slabs/data";
import { scanCard } from "@/lib/cards/api";
import { classifyScannedItem } from "@/lib/slabs/classify-item";
import { decideIntakeRoute } from "@/lib/slabs/intake-route";
import type { AnalyzeResult } from "@/server/analyze-slab/handler";

type CameraState = "starting" | "ready" | "processing" | "error";

const SLAB_INTAKE_ROUTE = "/slabs/new";

/** A capture awaiting a manual raw/slab decision (classification was uncertain). */
interface PendingDecision {
  image: SlabImageState;
  analysis: AnalyzeResult | null;
  reason: string;
}

function errorMessage(error: unknown): string {
  if (error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError")) {
    return "Camera permission was denied. Allow camera access in your browser settings, then try again.";
  }
  if (error instanceof DOMException && error.name === "NotFoundError") return "No camera was found on this device.";
  return error instanceof Error ? error.message : "The camera could not be started.";
}

/**
 * Universal "Scan Item" capture device.
 *
 * One capture, one analysis: the frame is normalized, sent to the server-side
 * analyzer, and CLASSIFIED as a graded slab or a raw card. A confident graded
 * slab is staged (image + analysis) and handed to /slabs/new — reusing the whole
 * Add-a-Slab pipeline with no second AI call. A confident raw card goes straight
 * into the raw inventory (R-code assigned server-side). When the model can't
 * decide — or analysis is unavailable — the operator picks: Raw Card / Slab /
 * Retake. This is the single permanent entry point for the whole system.
 */
export function CardScanner({ onInventoryChange }: { onInventoryChange?: () => void }) {
  const navigate = useNavigate();
  const videoRef = useRef<HTMLVideoElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const guideRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [facingMode, setFacingMode] = useState<"environment" | "user">("environment");
  const [cameraState, setCameraState] = useState<CameraState>("starting");
  const [cameraError, setCameraError] = useState("");
  const [captureError, setCaptureError] = useState("");
  const [progress, setProgress] = useState("");
  const [pending, setPending] = useState<PendingDecision | null>(null);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const startCamera = useCallback(async () => {
    stopCamera();
    setCameraState("starting");
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
      setCameraState("ready");
    } catch (error) {
      setCameraError(errorMessage(error));
      setCameraState("error");
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

  // Graded slab: hand the image AND its analysis to /slabs/new (no re-analysis).
  const routeToSlab = (image: SlabImageState, analysis: AnalyzeResult | null) => {
    stageCameraCapture(image, analysis);
    stopCamera();
    toast.success("Graded slab — finish the details.");
    navigate(SLAB_INTAKE_ROUTE);
  };

  // Raw card: create it through the proven raw pipeline (server assigns the
  // R-code). Uncertain/duplicate results land in the review queue below.
  const routeToRaw = async (image: SlabImageState) => {
    setPending(null);
    setCameraState("processing");
    setProgress("Adding to raw inventory…");
    try {
      const response = await scanCard(image.file);
      releaseSlabImageState(image);
      if (response.status === "added") toast.success(`${response.extraction?.card_name ?? "Raw card"} added to your inventory.`);
      else if (response.status === "possible_duplicate") toast.warning("Possible duplicate — review it below.");
      else if (response.status === "needs_review") toast.warning("Low confidence — review it below.");
      else toast.info("Scan recorded.");
      onInventoryChange?.();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setProgress("");
      setCameraState("ready");
    }
  };

  const handleCapture = async () => {
    if (cameraState !== "ready") return;
    setCameraState("processing");
    setCaptureError("");
    setProgress("Analyzing item…");
    try {
      const blob = await captureBlob();
      const { image, error } = await createSlabImageState(blob, { fallbackName: "camera-capture.jpg" });
      if (error || !image) throw new Error(error ?? "The captured photo could not be prepared.");

      const analysis = await analyzeSlab({ blob: image.file, mime: image.file.type || "image/jpeg" }, null);
      if (analysis.status !== "success") {
        // Analysis unavailable (e.g. quota) — fall back to a manual choice.
        setPending({ image, analysis: null, reason: analysis.message });
        setCameraState("ready");
        return;
      }

      const route = decideIntakeRoute(classifyScannedItem(analysis));
      if (route === "slab") return routeToSlab(image, analysis);
      if (route === "raw") return void routeToRaw(image);
      setPending({ image, analysis, reason: "The item type wasn't clear from the photo." });
      setCameraState("ready");
    } catch (error) {
      const message = errorMessage(error);
      setCaptureError(message);
      toast.error(message);
      setCameraState("ready");
    } finally {
      setProgress("");
    }
  };

  const retake = () => {
    if (pending) releaseSlabImageState(pending.image);
    setPending(null);
  };

  const busy = cameraState === "processing";

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
            Align the card or slab inside the guide
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
            onClick={() => setFacingMode((mode) => mode === "environment" ? "user" : "environment")}
            disabled={busy}
            aria-label="Flip camera"
          ><FlipHorizontal2 /></Button>
        </div>

        {cameraState === "starting" && (
          <div className="absolute inset-0 grid place-items-center bg-slate-950/80"><div className="text-center"><Loader2 className="mx-auto mb-3 h-8 w-8 animate-spin" /><p>Starting camera…</p></div></div>
        )}
        {cameraState === "error" && (
          <div className="absolute inset-0 grid place-items-center bg-slate-950 p-6 text-center">
            <div className="max-w-sm"><ShieldAlert className="mx-auto mb-3 h-10 w-10 text-amber-400" /><h2 className="text-xl font-bold">Camera unavailable</h2><p className="mt-2 text-sm text-white/70">{cameraError}</p><Button className="mt-5" onClick={() => void startCamera()}><RotateCcw /> Try again</Button></div>
          </div>
        )}

        {busy && (
          <div className="absolute inset-0 grid place-items-center bg-slate-950/70">
            <div className="text-center"><Sparkles className="mx-auto mb-3 h-8 w-8 animate-pulse text-primary" /><p>{progress || "Working…"}</p></div>
          </div>
        )}

        {/* Uncertain classification (or analysis unavailable): the operator decides. */}
        {pending && !busy && (
          <div className="absolute inset-x-3 bottom-3 rounded-2xl bg-white p-4 text-slate-900 shadow-2xl sm:left-1/2 sm:right-auto sm:w-[min(92%,560px)] sm:-translate-x-1/2">
            <div className="flex items-start gap-3">
              <img src={pending.image.previewUrl} alt="Captured item" className="h-28 w-20 rounded-lg object-cover shadow" />
              <div className="min-w-0">
                <h2 className="font-bold">Couldn't determine the item type</h2>
                <p className="mt-1 text-sm text-slate-600">{pending.reason} Choose how to file it.</p>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-3 gap-2">
              <Button variant="outline" onClick={() => void routeToRaw(pending.image)}><Layers className="mr-1 h-4 w-4" /> Raw Card</Button>
              <Button onClick={() => routeToSlab(pending.image, pending.analysis)}><SquareStack className="mr-1 h-4 w-4" /> Slab</Button>
              <Button variant="ghost" onClick={retake}><RotateCcw className="mr-1 h-4 w-4" /> Retake</Button>
            </div>
          </div>
        )}

        {cameraState !== "error" && !pending && !busy && (
          <div className="absolute bottom-5 left-0 right-0 flex justify-center">
            <Button
              size="lg" className="h-16 rounded-full border-4 border-white bg-primary px-8 text-lg shadow-xl hover:bg-primary/90"
              onClick={() => void handleCapture()} disabled={cameraState !== "ready"}
            ><Camera className="h-6 w-6" /> Scan item</Button>
          </div>
        )}

        {captureError && !pending && (
          <div role="alert" className="absolute bottom-24 left-4 right-4 rounded-xl border border-red-300/60 bg-red-950/90 p-3 text-center text-sm text-red-50 shadow-lg sm:left-1/2 sm:right-auto sm:w-[min(90%,520px)] sm:-translate-x-1/2">
            {captureError}
          </div>
        )}
      </div>
      <canvas ref={canvasRef} className="hidden" aria-hidden="true" />
    </section>
  );
}
