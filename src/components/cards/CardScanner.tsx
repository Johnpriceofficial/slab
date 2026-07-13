import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, CameraIcon, CheckCircle2, FlipHorizontal2, Loader2, RotateCcw, ShieldAlert, SkipForward } from "lucide-react";
import { toast } from "sonner";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { computeSourceCrop, outputSize } from "@/lib/cards/scanner";
import { resolveScan, scanCard, type ScanCardResponse } from "@/lib/cards/api";

type CameraState = "starting" | "ready" | "processing" | "error";

function errorMessage(error: unknown): string {
  if (error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError")) {
    return "Camera permission was denied. Allow camera access in your browser settings, then try again.";
  }
  if (error instanceof DOMException && error.name === "NotFoundError") return "No camera was found on this device.";
  return error instanceof Error ? error.message : "The camera could not be started.";
}

export function CardScanner({ onInventoryChange }: { onInventoryChange?: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const guideRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const clearTimer = useRef<number>();
  const [facingMode, setFacingMode] = useState<"environment" | "user">("environment");
  const [cameraState, setCameraState] = useState<CameraState>("starting");
  const [cameraError, setCameraError] = useState("");
  const [scanError, setScanError] = useState("");
  const [result, setResult] = useState<ScanCardResponse | null>(null);
  const [thumbnail, setThumbnail] = useState<string | null>(null);
  const [sessionScanned, setSessionScanned] = useState(0);
  const [sessionAdded, setSessionAdded] = useState(0);
  const [corrections, setCorrections] = useState({ card_name: "", set_name: "", card_number: "", rarity: "" });

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
    return () => {
      stopCamera();
      if (clearTimer.current) window.clearTimeout(clearTimer.current);
    };
  }, [startCamera, stopCamera]);

  const clearResult = useCallback((delay = 0) => {
    if (clearTimer.current) window.clearTimeout(clearTimer.current);
    const clear = () => {
      setResult(null);
      setCorrections({ card_name: "", set_name: "", card_number: "", rarity: "" });
      setThumbnail((old) => { if (old) URL.revokeObjectURL(old); return null; });
    };
    if (delay > 0) clearTimer.current = window.setTimeout(clear, delay);
    else clear();
  }, []);

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

  const handleScan = async () => {
    if (cameraState !== "ready" || result) return;
    setCameraState("processing");
    setScanError("");
    try {
      const blob = await captureBlob();
      setThumbnail((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(blob); });
      setSessionScanned((count) => count + 1);
      const response = await scanCard(blob);
      setResult(response);
      if (response.extraction) {
        setCorrections({
          card_name: response.extraction.card_name,
          set_name: response.extraction.set_name,
          card_number: response.extraction.card_number,
          rarity: response.extraction.rarity,
        });
      }
      if (response.status === "added") {
        setSessionAdded((count) => count + 1);
        toast.success(`${response.extraction?.card_name ?? "Card"} added to inventory.`);
        onInventoryChange?.();
        clearResult(2600);
      }
    } catch (error) {
      const message = errorMessage(error);
      setScanError(message);
      toast.error(message);
      clearResult();
    } finally {
      setCameraState("ready");
    }
  };

  const resolve = async (action: "confirm" | "skip", addAnyway = false) => {
    if (!result?.scan_id) return;
    setCameraState("processing");
    try {
      const response = await resolveScan({ action, scan_id: result.scan_id, ...corrections, add_anyway: addAnyway });
      if (response.status === "possible_duplicate") {
        setResult(response);
        return;
      }
      if (response.status === "added") {
        setSessionAdded((count) => count + 1);
        toast.success("Card confirmed and added to inventory.");
        onInventoryChange?.();
      } else toast.success("Scan skipped.");
      clearResult(1500);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
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
            Align one card inside the guide
          </span>
          <i className="absolute -left-1 -top-1 h-10 w-10 rounded-tl-xl border-l-4 border-t-4 border-secondary" />
          <i className="absolute -right-1 -top-1 h-10 w-10 rounded-tr-xl border-r-4 border-t-4 border-secondary" />
          <i className="absolute -bottom-1 -left-1 h-10 w-10 rounded-bl-xl border-b-4 border-l-4 border-secondary" />
          <i className="absolute -bottom-1 -right-1 h-10 w-10 rounded-br-xl border-b-4 border-r-4 border-secondary" />
        </div>

        <div className="absolute left-3 right-3 top-3 flex items-center justify-between gap-2">
          <div className="rounded-full bg-black/60 px-3 py-1.5 text-sm backdrop-blur">
            <strong>{sessionAdded}</strong> added <span className="text-white/60">· {sessionScanned} scanned</span>
          </div>
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

        {!result && cameraState !== "error" && (
          <div className="absolute bottom-5 left-0 right-0 flex justify-center">
            <Button
              size="lg" className="h-16 rounded-full border-4 border-white bg-primary px-8 text-lg shadow-xl hover:bg-primary/90"
              onClick={() => void handleScan()} disabled={cameraState !== "ready"}
            >{cameraState === "processing" ? <><Loader2 className="animate-spin" /> Identifying…</> : <><Camera className="h-6 w-6" /> Scan card</>}</Button>
          </div>
        )}

        {scanError && !result && (
          <div role="alert" className="absolute bottom-24 left-4 right-4 rounded-xl border border-red-300/60 bg-red-950/90 p-3 text-center text-sm text-red-50 shadow-lg sm:left-1/2 sm:right-auto sm:w-[min(90%,520px)] sm:-translate-x-1/2">
            {scanError}
          </div>
        )}

        {result && (
          <div className="absolute inset-x-3 bottom-3 max-h-[72%] overflow-y-auto rounded-2xl bg-white p-4 text-slate-900 shadow-2xl sm:left-1/2 sm:right-auto sm:w-[min(92%,620px)] sm:-translate-x-1/2">
            <div className="flex gap-4">
              {thumbnail && <img src={thumbnail} alt="Captured card" className="h-36 w-24 rounded-lg object-cover shadow" />}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  {result.status === "added" ? <CheckCircle2 className="text-green-600" /> : <CameraIcon className="text-primary" />}
                  <h2 className="font-bold">{result.status === "added" ? "Added to inventory" : result.status === "possible_duplicate" ? "Possible duplicate" : "Needs review"}</h2>
                  {result.extraction && <Badge variant="outline">{Math.round(result.extraction.confidence * 100)}% confidence</Badge>}
                </div>
                {result.status === "possible_duplicate" && <p className="mt-2 text-sm text-amber-700">This identity already exists. Add it only if this is another physical copy.</p>}
                {result.status === "needs_review" && <p className="mt-2 text-sm text-amber-700">Confidence is below 75%. Correct the guess before adding it.</p>}
              </div>
            </div>
            {result.status !== "added" && (
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <Field label="Card name" value={corrections.card_name} onChange={(value) => setCorrections((old) => ({ ...old, card_name: value }))} />
                <Field label="Set" value={corrections.set_name} onChange={(value) => setCorrections((old) => ({ ...old, set_name: value }))} />
                <Field label="Card number" value={corrections.card_number} onChange={(value) => setCorrections((old) => ({ ...old, card_number: value }))} />
                <Field label="Rarity" value={corrections.rarity} onChange={(value) => setCorrections((old) => ({ ...old, rarity: value }))} />
              </div>
            )}
            {result.status === "added" && result.card?.id && (
              <div className="mt-4 flex justify-end"><Button variant="outline" asChild><Link to={`/cards/${result.card.id}`}>View inventory card</Link></Button></div>
            )}
            {result.extraction && (
              <p className="mt-3 text-xs text-slate-500">
                Condition: {[result.extraction.condition_issues.whitening, result.extraction.condition_issues.scratches, result.extraction.condition_issues.centering_notes, result.extraction.condition_issues.other].filter(Boolean).join(" · ") || "No visible issue confidently identified"}
              </p>
            )}
            {result.status !== "added" && (
              <div className="mt-4 flex flex-wrap justify-end gap-2">
                <Button variant="outline" onClick={() => void resolve("skip")} disabled={cameraState === "processing"}><SkipForward /> Skip</Button>
                <Button onClick={() => void resolve("confirm", result.status === "possible_duplicate")} disabled={cameraState === "processing" || !corrections.card_name.trim() || !corrections.set_name.trim() || !corrections.card_number.trim()}>
                  {cameraState === "processing" ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
                  {result.status === "possible_duplicate" ? "Add another copy" : "Confirm & add"}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
      <canvas ref={canvasRef} className="hidden" aria-hidden="true" />
    </section>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange(value: string): void }) {
  return <label className="text-xs font-medium text-slate-600">{label}<Input className="mt-1 text-sm" value={value} onChange={(event) => onChange(event.target.value)} /></label>;
}
