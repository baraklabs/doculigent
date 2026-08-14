
import type { AreaRect, CaptureMode, CaptureTarget, MicConfig, OverlayConfig, SystemAudioConfig } from "@shared/types/models";
import { cameraBubbleRect, OUTPUT_HEIGHT, OUTPUT_WIDTH } from "@shared/lib/cameraBubble";
import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  drawCameraBubble,
  drawCameraFrame,
  drawCameraFullFrame,
  drawLetterboxed,
} from "./compositor";
import { desktopConstraints } from "./constraints";
import { getSystemAudioStream } from "./AudioRecordingService";
import { applyCameraBlur, type CameraBlurHandle } from "../camera/cameraBlur";

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
  private screenStream: MediaStream | null = null;
  private screenVideoEl: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private rafId: number | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];

  private cameraStream: MediaStream | null = null;
  private cameraBlurHandle: CameraBlurHandle | null = null;
  private cameraVideoEl: HTMLVideoElement | null = null;
  private micStream: MediaStream | null = null;
  private systemAudioStream: MediaStream | null = null;
  private audioMixCtx: AudioContext | null = null;
  private audioTrack: MediaStreamTrack | null = null;
  private overlay: OverlayConfig | null = null;
  private captureMode: CaptureMode = "display";
  private areaRect: AreaRect | null = null;
  private startedAt = 0;
  private paused = false;
  private pausedAccumMs = 0;
  private pauseStartedAt = 0;

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

  isNativeCapture(): boolean {
    return this.nativeCapture;
  }

  getCanvas(): HTMLCanvasElement | null {
    return this.canvas;
  }

  isPaused(): boolean {
    return this.paused;
  }

  getElapsedMs(): number {
    if (!this.overlay) return 0;
    const pausedMs = this.paused ? this.pausedAccumMs + (performance.now() - this.pauseStartedAt) : this.pausedAccumMs;
    return performance.now() - this.startedAt - pausedMs;
  }

  async start(
    targetId: string,
    overlay: OverlayConfig,
    mic: MicConfig,
    systemAudio: SystemAudioConfig,
    captureMode: CaptureMode = "display",
    areaRect: AreaRect | null = null
  ): Promise<void> {
    this.captureMode = captureMode;
    this.areaRect = captureMode === "area" ? areaRect : null;
    this.overlay = captureMode === "camera" ? { ...overlay, showCamera: false } : overlay;

    if (captureMode !== "camera" && window.api.system.platform === "darwin") {
      const permission = await window.api.capture.getPermissionStatus();
      if (permission.screen !== "granted") {
        await window.api.capture.openScreenRecordingSettings();
        throw new Error(
          "Screen Recording permission is required. Enable Doculigent under System Settings > Privacy & Security > Screen Recording, then restart the app."
        );
      }
    }

    this.nativeCapture =
      captureMode !== "camera" &&
      (await window.api.screenCapture.start(targetId, overlay.cursorHighlight === "hidden", this.areaRect ?? undefined))
        .available;

    if (captureMode === "camera") {
      this.cameraStream = await navigator.mediaDevices.getUserMedia({
        video: overlay.cameraDeviceId ? { deviceId: { exact: overlay.cameraDeviceId } } : true,
      });
    }
    if (!mic.muted) {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: mic.deviceId ? { deviceId: { exact: mic.deviceId } } : true,
      });
    }
    if (systemAudio.enabled && systemAudio.sourceId) {
      this.systemAudioStream = await getSystemAudioStream(systemAudio.sourceId);
    }
    this.audioTrack = this.resolveAudioTrack();
    if (this.cameraStream) {
      this.cameraVideoEl = document.createElement("video");
      if (overlay.cameraBlur === "none") {
        this.cameraVideoEl.srcObject = this.cameraStream;
      } else {
        this.cameraBlurHandle = applyCameraBlur(this.cameraStream, overlay.cameraBlur);
        this.cameraVideoEl.srcObject = this.cameraBlurHandle.stream;
      }
      this.cameraVideoEl.muted = true;
      await this.cameraVideoEl.play();
    }

    if (this.nativeCapture) {
      await this.startSideClip(this.overlay);
    } else if (captureMode === "camera") {
      await this.startCameraOnlyPipeline();
    } else {
      await this.startOrdinaryPipeline(targetId);
    }

    this.startedAt = performance.now();

    if (captureMode !== "camera") {
      window.api.cursor.startCapture(targetId, overlay.cursorHighlight).catch(() => {});
    }
  }

  private resolveAudioTrack(): MediaStreamTrack | null {
    const micTrack = this.micStream?.getAudioTracks()[0] ?? null;
    const systemTrack = this.systemAudioStream?.getAudioTracks()[0] ?? null;
    if (micTrack && systemTrack) {
      this.audioMixCtx = new AudioContext();
      const dest = this.audioMixCtx.createMediaStreamDestination();
      this.audioMixCtx.createMediaStreamSource(this.micStream!).connect(dest);
      this.audioMixCtx.createMediaStreamSource(this.systemAudioStream!).connect(dest);
      return dest.stream.getAudioTracks()[0] ?? null;
    }
    return micTrack ?? systemTrack ?? null;
  }

  private async startOrdinaryPipeline(targetId: string): Promise<void> {
    this.screenStream = await navigator.mediaDevices.getUserMedia(desktopConstraints(targetId));
    this.screenVideoEl = document.createElement("video");
    this.screenVideoEl.srcObject = this.screenStream;
    this.screenVideoEl.muted = true;
    await this.screenVideoEl.play();

    this.canvas = document.createElement("canvas");
    if (this.captureMode === "area" && this.areaRect) {
      const fullW = this.screenVideoEl.videoWidth || 1;
      const fullH = this.screenVideoEl.videoHeight || 1;
      this.canvas.width = Math.max(2, Math.round(this.areaRect.width * fullW));
      this.canvas.height = Math.max(2, Math.round(this.areaRect.height * fullH));
    } else {
      this.canvas.width = CANVAS_WIDTH;
      this.canvas.height = CANVAS_HEIGHT;
    }
    this.ctx = this.canvas.getContext("2d");

    const canvasStream = this.canvas.captureStream(FPS);
    if (this.audioTrack) canvasStream.addTrack(this.audioTrack);

    this.recorder = new MediaRecorder(canvasStream, { mimeType: pickMimeType() });
    this.chunks = [];
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.start();
    this.tick();
  }

  private async startCameraOnlyPipeline(): Promise<void> {
    this.canvas = document.createElement("canvas");
    this.canvas.width = CANVAS_WIDTH;
    this.canvas.height = CANVAS_HEIGHT;
    this.ctx = this.canvas.getContext("2d");

    const canvasStream = this.canvas.captureStream(FPS);
    if (this.audioTrack) canvasStream.addTrack(this.audioTrack);

    this.recorder = new MediaRecorder(canvasStream, { mimeType: pickMimeType() });
    this.chunks = [];
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.start();
    this.tick();
  }

  private async startSideClip(overlay: OverlayConfig): Promise<void> {
    this.sideHasVideo = overlay.showCamera && !!this.cameraStream;
    this.sideHasAudio = !!this.audioTrack;
    if (!this.sideHasVideo && !this.sideHasAudio) return;

    let stream: MediaStream;
    if (this.sideHasVideo) {
      const { size } = cameraBubbleRect(overlay, OUTPUT_WIDTH, OUTPUT_HEIGHT);
      this.sideCanvas = document.createElement("canvas");
      this.sideCanvas.width = size;
      this.sideCanvas.height = size;
      this.sideCtx = this.sideCanvas.getContext("2d");
      stream = this.sideCanvas.captureStream(FPS);
      if (this.audioTrack) stream.addTrack(this.audioTrack);
      this.sideTick();
    } else {
      stream = new MediaStream([this.audioTrack!]);
    }

    this.sideRecorder = new MediaRecorder(stream, { mimeType: pickMimeType() });
    this.sideChunks = [];
    this.sideRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.sideChunks.push(e.data);
    };
    this.sideRecorder.start();
  }

  private tick = (): void => {
    if (!this.ctx || !this.canvas || !this.overlay) return;
    const outW = this.canvas.width;
    const outH = this.canvas.height;
    if (this.captureMode === "camera") {
      if (!this.cameraVideoEl) return;
      drawCameraFullFrame(this.ctx, this.cameraVideoEl, outW, outH, this.overlay.mirrorCamera);
    } else {
      if (!this.screenVideoEl) return;
      drawLetterboxed(this.ctx, this.screenVideoEl, outW, outH, this.areaRect ?? undefined);
      if (this.overlay.showCamera && this.cameraVideoEl) {
        drawCameraBubble(this.ctx, this.cameraVideoEl, this.overlay, outW, outH);
      }
    }
    this.rafId = requestAnimationFrame(this.tick);
  };

  private sideTick = (): void => {
    if (!this.sideCtx || !this.sideCanvas || !this.cameraVideoEl || !this.overlay) return;
    drawCameraFrame(this.sideCtx, this.cameraVideoEl, this.sideCanvas.width, this.overlay.circular);
    this.sideRafId = requestAnimationFrame(this.sideTick);
  };

  async pause(): Promise<void> {
    if (!this.overlay || this.paused) return;
    this.paused = true;
    this.pauseStartedAt = performance.now();

    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    if (this.sideRafId !== null) cancelAnimationFrame(this.sideRafId);
    this.sideRafId = null;

    if (this.recorder && this.recorder.state === "recording") this.recorder.pause();
    if (this.sideRecorder && this.sideRecorder.state === "recording") this.sideRecorder.pause();
    if (this.nativeCapture) await window.api.screenCapture.pause().catch(() => {});
  }

  async resume(): Promise<void> {
    if (!this.overlay || !this.paused) return;
    this.paused = false;
    this.pausedAccumMs += performance.now() - this.pauseStartedAt;

    if (this.recorder && this.recorder.state === "paused") this.recorder.resume();
    if (this.sideRecorder && this.sideRecorder.state === "paused") this.sideRecorder.resume();
    if (this.nativeCapture) await window.api.screenCapture.resume().catch(() => {});

    if (this.canvas) this.tick();
    if (this.sideCanvas) this.sideTick();
  }

  async discard(): Promise<void> {
    if (!this.overlay) return;
    const wasNative = this.nativeCapture;

    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    if (this.sideRafId !== null) cancelAnimationFrame(this.sideRafId);
    this.sideRafId = null;

    await window.api.cursor.stopCapture().catch(() => {});
    if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
    if (this.sideRecorder && this.sideRecorder.state !== "inactive") this.sideRecorder.stop();
    if (wasNative) await window.api.screenCapture.discard().catch(() => {});

    this.cleanupStreams();
    this.overlay = null;
    this.nativeCapture = false;
    this.captureMode = "display";
    this.areaRect = null;
    this.paused = false;
    this.pausedAccumMs = 0;
  }

  async stop(title: string, source: "record" | "meeting"): Promise<{ id: string }> {
    if (!this.overlay) throw new Error("no active recording");
    const pausedMs = this.paused ? this.pausedAccumMs + (performance.now() - this.pauseStartedAt) : this.pausedAccumMs;
    const durationSecs = (performance.now() - this.startedAt - pausedMs) / 1000;
    const overlay = this.overlay;
    const wasNative = this.nativeCapture;

    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    if (this.sideRafId !== null) cancelAnimationFrame(this.sideRafId);
    this.sideRafId = null;

    await window.api.cursor.stopCapture().catch(() => {});

    const result = wasNative
      ? await this.stopNative(title, source, durationSecs, overlay)
      : await this.stopOrdinary(title, source, durationSecs, overlay);

    this.cleanupStreams();
    this.overlay = null;
    this.nativeCapture = false;
    this.captureMode = "display";
    this.areaRect = null;
    this.paused = false;
    this.pausedAccumMs = 0;
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
    this.cameraBlurHandle?.stop();
    this.cameraBlurHandle = null;
    for (const stream of [this.screenStream, this.cameraStream, this.micStream, this.systemAudioStream]) {
      stream?.getTracks().forEach((t) => t.stop());
    }
    this.screenStream = null;
    this.cameraStream = null;
    this.micStream = null;
    this.systemAudioStream = null;
    this.audioMixCtx?.close();
    this.audioMixCtx = null;
    this.audioTrack = null;
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
