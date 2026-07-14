import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, FlipHorizontal2, Loader2, RotateCcw, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { computeSourceCrop, outputSize } from "@/lib/cards/scanner";
import { createSlabImageState } from "@/lib/slabs/image-state";
import { stageCameraCapture } from "@/lib/slabs/camera-capture";

type CameraState = "starting" | "ready" | "processing" | "error";

/** Where a capture is handed off to. Camera and manual upload share one screen. */
const INTAKE_ROUTE = "/slabs/new";

function errorMessage(error: unknown): string {
  if (error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError")) {
    return "Camera permission was denied. Allow camera access in your browser settings, then try again.";
  }
  if (error instanceof DOMException && error.name === "NotFoundError") return "No camera was found on this device.";
  return error instanceof Error ? error.message : "The camera could not be started.";
}

/**
 * Live capture device for the graded-slab intake flow.
 *
 * It identifies nothing and saves nothing: a capture is normalized into the
 * same `SlabImageState` a manual upload produces, staged, and carried to
 * /slabs/new, where the existing Add a Slab screen owns identity, AI analysis,
 * PriceCharting, valuation, the duplicate-certification check, and the save.
 * Keeping the write path in one place is what guarantees a scan produces exactly
 * one slab — and no separate /cards inventory row.
 */
export function CardScanner() {
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

  const handleCapture = async () => {
    if (cameraState !== "ready") return;
    setCameraState("processing");
    setCaptureError("");
    try {
      const blob = await captureBlob();
      const { image, error } = await createSlabImageState(blob, { fallbackName: "camera-capture.jpg" });
      if (error || !image) throw new Error(error ?? "The captured photo could not be prepared.");
      // Stage first, then release the camera, then hand off. The form mounts with
      // the photo already in the Front slot — no re-pick, no second upload.
      stageCameraCapture(image);
      stopCamera();
      toast.success("Photo captured — finish the slab details.");
      navigate(INTAKE_ROUTE);
    } catch (error) {
      const message = errorMessage(error);
      setCaptureError(message);
      toast.error(message);
      setCameraState("ready");
    }
  };

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
            Align the slab inside the guide
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
            disabled={cameraState === "processing"}
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

        {cameraState !== "error" && (
          <div className="absolute bottom-5 left-0 right-0 flex justify-center">
            <Button
              size="lg" className="h-16 rounded-full border-4 border-white bg-primary px-8 text-lg shadow-xl hover:bg-primary/90"
              onClick={() => void handleCapture()} disabled={cameraState !== "ready"}
            >{cameraState === "processing" ? <><Loader2 className="animate-spin" /> Preparing…</> : <><Camera className="h-6 w-6" /> Capture slab</>}</Button>
          </div>
        )}

        {captureError && (
          <div role="alert" className="absolute bottom-24 left-4 right-4 rounded-xl border border-red-300/60 bg-red-950/90 p-3 text-center text-sm text-red-50 shadow-lg sm:left-1/2 sm:right-auto sm:w-[min(90%,520px)] sm:-translate-x-1/2">
            {captureError}
          </div>
        )}
      </div>
      <canvas ref={canvasRef} className="hidden" aria-hidden="true" />
    </section>
  );
}
