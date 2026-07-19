/**
 * Orchestrates screen+camera+mic capture, canvas compositing, and MediaRecorder-based
 * encoding. See FUNCTIONALITY.md §7.6 for why this whole approach (rather than piping
 * raw frames into an ffmpeg sidecar, as the original Tauri app did) sidesteps the
 * frame-pacing/duration-collapse bug class entirely: Chromium's MediaRecorder times
 * frames off real wall-clock internally, so nothing here has to re-implement that.
 */
import type { CaptureTarget, MicConfig, OverlayConfig } from "@shared/types/models";
import { CANVAS_HEIGHT, CANVAS_WIDTH, drawCameraBubble, drawLetterboxed } from "./compositor";
import { desktopConstraints } from "./constraints";

const FPS = 30;

function pickMimeType(): string {
  const candidates = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  return candidates.find((c) => MediaRecorder.isTypeSupported(c)) ?? "video/webm";
}

class RecordingService {
  private screenStream: MediaStream | null = null;
  private cameraStream: MediaStream | null = null;
  private micStream: MediaStream | null = null;
  private screenVideoEl: HTMLVideoElement | null = null;
  private cameraVideoEl: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private rafId: number | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private overlay: OverlayConfig | null = null;
  private startedAt = 0;

  listCaptureTargets(): Promise<CaptureTarget[]> {
    return window.api.capture.listTargets();
  }

  /** The canvas actually being recorded (already has the camera bubble composited in,
   *  see `tick`) — RecordPage displays this element directly as the live preview while
   *  recording, so what you see is exactly the frames going into the file. */
  getCanvas(): HTMLCanvasElement | null {
    return this.canvas;
  }

  async start(targetId: string, overlay: OverlayConfig, mic: MicConfig): Promise<void> {
    this.overlay = overlay;

    this.screenStream = await navigator.mediaDevices.getUserMedia(desktopConstraints(targetId));
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

    this.screenVideoEl = document.createElement("video");
    this.screenVideoEl.srcObject = this.screenStream;
    this.screenVideoEl.muted = true;
    await this.screenVideoEl.play();

    if (this.cameraStream) {
      this.cameraVideoEl = document.createElement("video");
      this.cameraVideoEl.srcObject = this.cameraStream;
      this.cameraVideoEl.muted = true;
      await this.cameraVideoEl.play();
    }

    this.canvas = document.createElement("canvas");
    this.canvas.width = CANVAS_WIDTH;
    this.canvas.height = CANVAS_HEIGHT;
    this.ctx = this.canvas.getContext("2d");

    const canvasStream = this.canvas.captureStream(FPS);
    if (this.micStream) {
      for (const track of this.micStream.getAudioTracks()) {
        canvasStream.addTrack(track);
      }
    }

    this.recorder = new MediaRecorder(canvasStream, { mimeType: pickMimeType() });
    this.chunks = [];
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.start();
    this.startedAt = performance.now();

    this.tick();
  }

  private tick = (): void => {
    if (!this.ctx || !this.screenVideoEl || !this.overlay) return;
    drawLetterboxed(this.ctx, this.screenVideoEl, CANVAS_WIDTH, CANVAS_HEIGHT);
    if (this.overlay.showCamera && this.cameraVideoEl) {
      drawCameraBubble(this.ctx, this.cameraVideoEl, this.overlay, CANVAS_WIDTH, CANVAS_HEIGHT);
    }
    this.rafId = requestAnimationFrame(this.tick);
  };

  /** Stops capture and hands the raw webm off to the main process, which writes it to
   *  disk and resolves quickly — the (slow) MP4 transcode + library insert happens in
   *  the background afterward (see recording.ts). Callers should subscribe to
   *  window.api.recording.onSaveCompleted/onSaveFailed for the real Video row. */
  async stop(title: string, source: "record" | "meeting"): Promise<{ id: string }> {
    if (!this.overlay) throw new Error("no active recording");
    const durationSecs = (performance.now() - this.startedAt) / 1000;
    const overlay = this.overlay;

    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;

    const finalBlob = await new Promise<Blob>((resolve) => {
      if (!this.recorder || this.recorder.state === "inactive") {
        resolve(new Blob(this.chunks, { type: "video/webm" }));
        return;
      }
      this.recorder.onstop = () => resolve(new Blob(this.chunks, { type: "video/webm" }));
      this.recorder.stop();
    });

    this.cleanupStreams();

    const webmBytes = await finalBlob.arrayBuffer();
    const result = await window.api.recording.save({ webmBytes, overlay, durationSecs, title, source });

    this.overlay = null;
    return result;
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
  }
}

export const recordingService = new RecordingService();
