/**
 * Orchestrates screen+camera+mic capture and encoding. Two capture pipelines live here:
 *
 *  - The ordinary one (unchanged from before): Chromium's getUserMedia desktop stream is
 *    drawn into a canvas frame-by-frame (letterboxed screen + camera bubble), and
 *    MediaRecorder encodes that canvas. See FUNCTIONALITY.md §7.6 for why this — rather
 *    than piping raw frames into an ffmpeg sidecar — sidesteps the frame-pacing/
 *    duration-collapse bug class entirely.
 *  - The native one, used whenever `window.api.screenCapture.start` reports it's
 *    available (Windows, whole-display target — see electron/main/native/screenCapture.ts):
 *    the screen is recorded directly to disk by ffmpeg's gdigrab, which can genuinely
 *    exclude the cursor from the frames (Chromium's `cursor: "never"` constraint is
 *    silently ignored — verified empirically, not a Chromium docs claim). In this mode the
 *    camera bubble and/or mic are recorded to a small side clip instead, and the main
 *    process combines the two when the recording is saved (see ipc/recording.ts).
 *
 * Either way, the *cursor track* (metadata sidecar for Edit to redraw a cursor from) is
 * sampled the same way regardless of which pipeline recorded the video — see
 * native/cursorTrack.ts.
 */
import type { CaptureTarget, MicConfig, OverlayConfig } from "@shared/types/models";
import { cameraBubbleRect, OUTPUT_HEIGHT, OUTPUT_WIDTH } from "@shared/lib/cameraBubble";
import { CANVAS_HEIGHT, CANVAS_WIDTH, drawCameraBubble, drawCameraFrame, drawLetterboxed } from "./compositor";
import { desktopConstraints } from "./constraints";

const FPS = 30;

function pickMimeType(): string {
  const candidates = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  return candidates.find((c) => MediaRecorder.isTypeSupported(c)) ?? "video/webm";
}

interface SideClipResult {
  bytes: ArrayBuffer;
  hasVideo: boolean;
  hasAudio: boolean;
}

class RecordingService {
  // --- Ordinary pipeline state ---------------------------------------------------------
  private screenStream: MediaStream | null = null;
  private screenVideoEl: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private rafId: number | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];

  // --- Shared across both pipelines -----------------------------------------------------
  private cameraStream: MediaStream | null = null;
  private cameraVideoEl: HTMLVideoElement | null = null;
  private micStream: MediaStream | null = null;
  private overlay: OverlayConfig | null = null;
  private startedAt = 0;

  // --- Native (gdigrab) pipeline state ---------------------------------------------------
  private nativeCapture = false;
  private sideCanvas: HTMLCanvasElement | null = null;
  private sideCtx: CanvasRenderingContext2D | null = null;
  private sideRafId: number | null = null;
  private sideRecorder: MediaRecorder | null = null;
  private sideChunks: Blob[] = [];
  private sideHasVideo = false;
  private sideHasAudio = false;

  listCaptureTargets(): Promise<CaptureTarget[]> {
    return window.api.capture.listTargets();
  }

  /** True once `start()` has decided this recording is using the native gdigrab pipeline —
   *  RecordPage uses this to know its own compositing canvas (`getCanvas()`) won't have
   *  anything in it, and to keep showing the raw desktop preview instead. */
  isNativeCapture(): boolean {
    return this.nativeCapture;
  }

  /** The canvas actually being recorded (already has the camera bubble composited in, see
   *  `tick`) — RecordPage displays this element directly as the live preview while
   *  recording, so what you see is exactly the frames going into the file. Null in native
   *  mode: there's no full-frame canvas, since the screen goes straight to disk via
   *  gdigrab and only the camera bubble (if any) is composited here. */
  getCanvas(): HTMLCanvasElement | null {
    return this.canvas;
  }

  async start(targetId: string, overlay: OverlayConfig, mic: MicConfig): Promise<void> {
    this.overlay = overlay;

    // Tried first and unconditionally: only Windows + a whole-display target support it,
    // and it silently reports unavailable everywhere else so this always falls through to
    // the ordinary pipeline below.
    this.nativeCapture = (
      await window.api.screenCapture.start(targetId, overlay.cursorHighlight === "hidden")
    ).available;

    if (overlay.showCamera) {
      this.cameraStream = await navigator.mediaDevices.getUserMedia({
        video: overlay.cameraDeviceId ? { deviceId: { exact: overlay.cameraDeviceId } } : true,
      });
    }
    if (!mic.muted) {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: mic.deviceId ? { deviceId: { exact: mic.deviceId } } : true,
      });
    }
    if (this.cameraStream) {
      this.cameraVideoEl = document.createElement("video");
      this.cameraVideoEl.srcObject = this.cameraStream;
      this.cameraVideoEl.muted = true;
      await this.cameraVideoEl.play();
    }

    if (this.nativeCapture) {
      await this.startSideClip(overlay);
    } else {
      await this.startOrdinaryPipeline(targetId);
    }

    this.startedAt = performance.now();

    // Started alongside the encoder(s) above so the track's t=0 lines up with the first
    // frame. Best-effort: a recording shouldn't fail because its cursor sidecar couldn't
    // start. Unrelated to which video pipeline is active — always runs.
    window.api.cursor.startCapture(targetId, overlay.cursorHighlight).catch(() => {});
  }

  private async startOrdinaryPipeline(targetId: string): Promise<void> {
    this.screenStream = await navigator.mediaDevices.getUserMedia(desktopConstraints(targetId));
    this.screenVideoEl = document.createElement("video");
    this.screenVideoEl.srcObject = this.screenStream;
    this.screenVideoEl.muted = true;
    await this.screenVideoEl.play();

    this.canvas = document.createElement("canvas");
    this.canvas.width = CANVAS_WIDTH;
    this.canvas.height = CANVAS_HEIGHT;
    this.ctx = this.canvas.getContext("2d");

    const canvasStream = this.canvas.captureStream(FPS);
    if (this.micStream) {
      for (const track of this.micStream.getAudioTracks()) canvasStream.addTrack(track);
    }

    this.recorder = new MediaRecorder(canvasStream, { mimeType: pickMimeType() });
    this.chunks = [];
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.start();
    this.tick();
  }

  /** Records just the camera bubble (if shown) plus mic (if unmuted) to a small clip that
   *  the main process later overlays/muxes onto the gdigrab screen video. When neither is
   *  present, there's nothing to record here — the gdigrab file is already the final
   *  output as far as this service is concerned. */
  private async startSideClip(overlay: OverlayConfig): Promise<void> {
    this.sideHasVideo = overlay.showCamera && !!this.cameraStream;
    this.sideHasAudio = !!this.micStream;
    if (!this.sideHasVideo && !this.sideHasAudio) return;

    let stream: MediaStream;
    if (this.sideHasVideo) {
      const { size } = cameraBubbleRect(overlay, OUTPUT_WIDTH, OUTPUT_HEIGHT);
      this.sideCanvas = document.createElement("canvas");
      this.sideCanvas.width = size;
      this.sideCanvas.height = size;
      this.sideCtx = this.sideCanvas.getContext("2d");
      stream = this.sideCanvas.captureStream(FPS);
      if (this.micStream) {
        for (const track of this.micStream.getAudioTracks()) stream.addTrack(track);
      }
      this.sideTick();
    } else {
      // Mic only, no camera: no canvas needed at all, just record the mic stream directly.
      stream = this.micStream!;
    }

    this.sideRecorder = new MediaRecorder(stream, { mimeType: pickMimeType() });
    this.sideChunks = [];
    this.sideRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.sideChunks.push(e.data);
    };
    this.sideRecorder.start();
  }

  private tick = (): void => {
    if (!this.ctx || !this.screenVideoEl || !this.overlay) return;
    drawLetterboxed(this.ctx, this.screenVideoEl, CANVAS_WIDTH, CANVAS_HEIGHT);
    if (this.overlay.showCamera && this.cameraVideoEl) {
      drawCameraBubble(this.ctx, this.cameraVideoEl, this.overlay, CANVAS_WIDTH, CANVAS_HEIGHT);
    }
    this.rafId = requestAnimationFrame(this.tick);
  };

  private sideTick = (): void => {
    if (!this.sideCtx || !this.sideCanvas || !this.cameraVideoEl || !this.overlay) return;
    drawCameraFrame(this.sideCtx, this.cameraVideoEl, this.sideCanvas.width, this.overlay.circular);
    this.sideRafId = requestAnimationFrame(this.sideTick);
  };

  /** Stops capture and hands the recording off to the main process, which writes it to
   *  disk and resolves quickly — the (slow) MP4 transcode/combine + library insert happens
   *  in the background afterward (see recording.ts). Callers should subscribe to
   *  window.api.recording.onSaveCompleted/onSaveFailed for the real Video row. */
  async stop(title: string, source: "record" | "meeting"): Promise<{ id: string }> {
    if (!this.overlay) throw new Error("no active recording");
    const durationSecs = (performance.now() - this.startedAt) / 1000;
    const overlay = this.overlay;
    const wasNative = this.nativeCapture;

    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    if (this.sideRafId !== null) cancelAnimationFrame(this.sideRafId);
    this.sideRafId = null;

    // Stops sampling immediately; the buffered track is picked up by recording.save below.
    await window.api.cursor.stopCapture().catch(() => {});

    const result = wasNative
      ? await this.stopNative(title, source, durationSecs, overlay)
      : await this.stopOrdinary(title, source, durationSecs, overlay);

    this.cleanupStreams();
    this.overlay = null;
    this.nativeCapture = false;
    return result;
  }

  private async stopOrdinary(
    title: string,
    source: "record" | "meeting",
    durationSecs: number,
    overlay: OverlayConfig
  ): Promise<{ id: string }> {
    const finalBlob = await new Promise<Blob>((resolve) => {
      if (!this.recorder || this.recorder.state === "inactive") {
        resolve(new Blob(this.chunks, { type: "video/webm" }));
        return;
      }
      this.recorder.onstop = () => resolve(new Blob(this.chunks, { type: "video/webm" }));
      this.recorder.stop();
    });
    const webmBytes = await finalBlob.arrayBuffer();
    return window.api.recording.save({ webmBytes, overlay, durationSecs, title, source });
  }

  private async stopNative(
    title: string,
    source: "record" | "meeting",
    durationSecs: number,
    overlay: OverlayConfig
  ): Promise<{ id: string }> {
    const sideClip = await this.stopSideClip();
    const { available, filePath } = await window.api.screenCapture.stop();
    if (!available || !filePath) throw new Error("native screen capture stopped with no output file");

    return window.api.recording.save({
      screenFilePath: filePath,
      sideClip,
      overlay,
      durationSecs,
      title,
      source,
    });
  }

  private async stopSideClip(): Promise<SideClipResult | undefined> {
    if (!this.sideRecorder) return undefined;
    const blob = await new Promise<Blob>((resolve) => {
      if (this.sideRecorder!.state === "inactive") {
        resolve(new Blob(this.sideChunks, { type: "video/webm" }));
        return;
      }
      this.sideRecorder!.onstop = () => resolve(new Blob(this.sideChunks, { type: "video/webm" }));
      this.sideRecorder!.stop();
    });
    return { bytes: await blob.arrayBuffer(), hasVideo: this.sideHasVideo, hasAudio: this.sideHasAudio };
  }

  private cleanupStreams(): void {
    for (const stream of [this.screenStream, this.cameraStream, this.micStream]) {
      stream?.getTracks().forEach((t) => t.stop());
    }
    this.screenStream = null;
    this.cameraStream = null;
    this.micStream = null;
    this.screenVideoEl = null;
    this.cameraVideoEl = null;
    this.canvas = null;
    this.ctx = null;
    this.sideCanvas = null;
    this.sideCtx = null;
    this.sideRecorder = null;
    this.sideChunks = [];
  }
}

export const recordingService = new RecordingService();
