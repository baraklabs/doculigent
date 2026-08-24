
import type {
  AreaRect,
  CaptureMode,
  CaptureTarget,
  MicConfig,
  OverlayConfig,
  SystemAudioConfig,
} from "@shared/types/models";
import { CANVAS_HEIGHT, CANVAS_WIDTH, drawCameraFullFrame, drawCameraRaw } from "./compositor";
import { getSystemAudioStream } from "./AudioRecordingService";
import { applyCameraBlur, type CameraBlurHandle } from "../camera/cameraBlur";

const FPS = 30;

interface MimeChoice {
  mimeType: string;
  ext: "mp4" | "webm";
}

// Tried in order — avc1.64001f (High profile) first since it's what the native Quick
// Recording paths already produce (ScreenCaptureKitRecorder.swift, capture-helper's WGC
// helper), then a couple of narrower-support H.264 profiles, before ever falling back to
// VP9/VP8. Never assumed available — every candidate is verified via
// MediaRecorder.isTypeSupported at call time, since Chromium's MP4/H.264 MediaRecorder
// output depends on the OS exposing a platform encoder (Media Foundation on Windows,
// VideoToolbox on mac) that isn't guaranteed present on every machine/Electron build.
const H264_MP4_CANDIDATES = [
  'video/mp4;codecs="avc1.64001f"',
  'video/mp4;codecs="avc1.640028"',
  'video/mp4;codecs="avc1.42E01E"',
  "video/mp4",
];
const VP9_WEBM_CANDIDATES = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];

/** `hasVideo: false` (the mic/system-audio-only side clip — see startSideClip) skips the
 *  H.264/MP4 candidates entirely and keeps the original VP9/WebM-only behavior: those
 *  candidates all name an H.264 *video* codec, and constructing a MediaRecorder for an
 *  audio-only MediaStream against a video-codec mimeType is exactly the kind of mismatch
 *  isTypeSupported doesn't validate (it checks codec/container support in the abstract, not
 *  against a specific stream's actual tracks) — safest not to touch a path that already
 *  works. */
function pickMimeType(hasVideo: boolean): MimeChoice {
  if (hasVideo) {
    const h264 = H264_MP4_CANDIDATES.find((c) => MediaRecorder.isTypeSupported(c));
    if (h264) return { mimeType: h264, ext: "mp4" };
  }
  const webm = VP9_WEBM_CANDIDATES.find((c) => MediaRecorder.isTypeSupported(c));
  return { mimeType: webm ?? "video/webm", ext: "webm" };
}

interface SideClipResult {
  bytes: ArrayBuffer;
  hasVideo: boolean;
  hasAudio: boolean;
  ext: "mp4" | "webm";
}

class RecordingService {
  private screenStream: MediaStream | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private rafId: number | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private cameraOnlyExt: "mp4" | "webm" = "webm";

  // The non-native (no gdigrab) equivalent of screenCapture.ts's native pipeline — a raw,
  // uncropped/unscaled recording of the whole display/window, muxed with the camera and
  // cursor server-side afterward exactly like a native capture is (see
  // ipc/recording.ts's buildFinalMp4). No canvas involved — nothing here needs compositing
  // live, so this just records `screenStream` directly.
  private rawScreenRecorder: MediaRecorder | null = null;
  private rawScreenChunks: Blob[] = [];
  private rawScreenExt: "mp4" | "webm" = "webm";

  private cameraStream: MediaStream | null = null;
  private cameraBlurHandle: CameraBlurHandle | null = null;
  private cameraVideoEl: HTMLVideoElement | null = null;
  private micStream: MediaStream | null = null;
  private systemAudioStream: MediaStream | null = null;
  private audioMixCtx: AudioContext | null = null;
  private audioTrack: MediaStreamTrack | null = null;
  private overlay: OverlayConfig | null = null;
  private mode: "quick" | "advanced" = "quick";
  private captureMode: CaptureMode = "display";
  private areaRect: AreaRect | null = null;
  private startedAt = 0;
  private paused = false;
  private pausedAccumMs = 0;
  private pauseStartedAt = 0;

  private cameraDegraded = false;

  private nativeCapture = false;
  private sideCanvas: HTMLCanvasElement | null = null;
  private sideCtx: CanvasRenderingContext2D | null = null;
  private sideRafId: number | null = null;
  private sideRecorder: MediaRecorder | null = null;
  private sideChunks: Blob[] = [];
  private sideHasVideo = false;
  private sideHasAudio = false;
  private sideExt: "mp4" | "webm" = "webm";

  // Wall-clock (Date.now(), not performance.now() — needs to compare directly against the
  // main process's own capture clock) origin of the screen recording's t=0, and how many ms
  // after it the side clip's own separate MediaRecorder actually started — see
  // EditProjectMedia.sideClipStartOffsetMs for why this exists and how it's used. Null
  // until (if ever) set: screenStartedAtMs stays null for captureMode "camera" (no screen
  // capture at all), sideClipStartOffsetMs stays null whenever startSideClip never actually
  // starts a recorder (no camera, no mic/system audio either).
  private screenStartedAtMs: number | null = null;
  private sideClipStartOffsetMs: number | null = null;

  // Prewarm: kick camera/mic/system-audio acquisition off ahead of start() (e.g. as soon as
  // the camera bubble opens, or as soon as a record countdown begins), so start()'s own
  // Promise.all (see below) can consume an already-open — or at least already in-flight —
  // stream instead of paying a cold getUserMedia()/device round-trip at record time. Purely
  // a latency optimization: start() always awaits camera/mic/system-audio regardless (screen
  // capture only begins once they're ready — see start()), so a missing or stale prewarm
  // just falls back to acquiring fresh, same as if prewarming didn't exist. Each key is null
  // when nothing's prewarmed (or the relevant device/setting means there's nothing to
  // prewarm — muted mic, disabled system audio); a non-null key that doesn't match what
  // start() actually needs (device changed since) is treated the same as no prewarm at all.
  private prewarmedCameraKey: string | null = null;
  private prewarmedCameraPromise: Promise<MediaStream> | null = null;
  private prewarmedMicKey: string | null = null;
  private prewarmedMicPromise: Promise<MediaStream> | null = null;
  private prewarmedSystemAudioKey: string | null = null;
  private prewarmedSystemAudioPromise: Promise<MediaStream> | null = null;

  listCaptureTargets(): Promise<CaptureTarget[]> {
    return window.api.capture.listTargets();
  }

  isNativeCapture(): boolean {
    return this.nativeCapture;
  }

  wasCameraDegraded(): boolean {
    return this.cameraDegraded;
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

  /** Starts acquiring the camera ahead of start() — see the prewarm fields' own doc comment.
   *  Idempotent for an unchanged deviceId (blur/mirror never affect the raw getUserMedia
   *  call, so they don't invalidate a prewarm); a changed deviceId tears down whatever was
   *  prewarmed for the old one and starts over for the new one. */
  prewarmCamera(deviceId: string | null): void {
    const key = deviceId ?? "";
    if (this.prewarmedCameraKey === key && this.prewarmedCameraPromise) return;
    this.cancelPrewarmedCamera();
    this.prewarmedCameraKey = key;
    const promise = this.acquireCameraStream(deviceId);
    this.prewarmedCameraPromise = promise;
    promise.catch(() => {
      // Self-heals a failed prewarm — clear it (if still current) so a later start() falls
      // through to a fresh cold acquireCameraStream() call instead of replaying the same
      // stale rejection forever.
      if (this.prewarmedCameraPromise === promise) {
        this.prewarmedCameraPromise = null;
        this.prewarmedCameraKey = null;
      }
    });
  }

  /** Tears down an unconsumed camera prewarm — stops its tracks once/if it resolves, no-op
   *  if nothing was prewarmed or it already failed. Call whenever whatever triggered
   *  prewarmCamera goes away (bubble closed, device changed, component unmounted) before a
   *  start() ever consumed it. */
  cancelPrewarmedCamera(): void {
    const promise = this.prewarmedCameraPromise;
    this.prewarmedCameraPromise = null;
    this.prewarmedCameraKey = null;
    promise?.then(
      (stream) => stream.getTracks().forEach((t) => t.stop()),
      () => {}
    );
  }

  /** Same idea as prewarmCamera, for the mic — keyed on (muted, deviceId) together; muted
   *  means "nothing to prewarm," same as start()'s own mic handling. */
  prewarmMic(mic: MicConfig): void {
    if (mic.muted) {
      this.cancelPrewarmedMic();
      return;
    }
    const key = mic.deviceId ?? "";
    if (this.prewarmedMicKey === key && this.prewarmedMicPromise) return;
    this.cancelPrewarmedMic();
    this.prewarmedMicKey = key;
    const promise = navigator.mediaDevices.getUserMedia({
      audio: mic.deviceId ? { deviceId: { exact: mic.deviceId } } : true,
    });
    this.prewarmedMicPromise = promise;
    promise.catch(() => {
      if (this.prewarmedMicPromise === promise) {
        this.prewarmedMicPromise = null;
        this.prewarmedMicKey = null;
      }
    });
  }

  cancelPrewarmedMic(): void {
    const promise = this.prewarmedMicPromise;
    this.prewarmedMicPromise = null;
    this.prewarmedMicKey = null;
    promise?.then(
      (stream) => stream.getTracks().forEach((t) => t.stop()),
      () => {}
    );
  }

  /** Same idea as prewarmCamera, for system audio — keyed on (enabled, sourceId) together. */
  prewarmSystemAudio(systemAudio: SystemAudioConfig): void {
    if (!systemAudio.enabled || !systemAudio.sourceId) {
      this.cancelPrewarmedSystemAudio();
      return;
    }
    const key = systemAudio.sourceId;
    if (this.prewarmedSystemAudioKey === key && this.prewarmedSystemAudioPromise) return;
    this.cancelPrewarmedSystemAudio();
    this.prewarmedSystemAudioKey = key;
    const promise = getSystemAudioStream(systemAudio.sourceId);
    this.prewarmedSystemAudioPromise = promise;
    promise.catch(() => {
      if (this.prewarmedSystemAudioPromise === promise) {
        this.prewarmedSystemAudioPromise = null;
        this.prewarmedSystemAudioKey = null;
      }
    });
  }

  cancelPrewarmedSystemAudio(): void {
    const promise = this.prewarmedSystemAudioPromise;
    this.prewarmedSystemAudioPromise = null;
    this.prewarmedSystemAudioKey = null;
    promise?.then(
      (stream) => stream.getTracks().forEach((t) => t.stop()),
      () => {}
    );
  }

  /** Cancels every outstanding prewarm at once — used when leaving the record setup screen
   *  entirely (unmount), where individual per-track cleanup isn't worth wiring separately. */
  cancelAllPrewarmed(): void {
    this.cancelPrewarmedCamera();
    this.cancelPrewarmedMic();
    this.cancelPrewarmedSystemAudio();
  }

  async start(
    targetId: string,
    overlay: OverlayConfig,
    mic: MicConfig,
    systemAudio: SystemAudioConfig,
    captureMode: CaptureMode = "display",
    areaRect: AreaRect | null = null,
    mode: "quick" | "advanced" = "quick"
  ): Promise<void> {
    this.captureMode = captureMode;
    this.areaRect = captureMode === "area" ? areaRect : null;
    this.overlay = captureMode === "camera" ? { ...overlay, showCamera: false } : overlay;
    this.mode = mode;
    this.cameraDegraded = false;
    this.screenStartedAtMs = null;
    this.sideClipStartOffsetMs = null;

    if (captureMode !== "camera" && window.api.system.platform === "darwin") {
      const permission = await window.api.capture.getPermissionStatus();
      if (permission.screen !== "granted") {
        await window.api.capture.openScreenRecordingSettings();
        throw new Error(
          "Screen Recording permission is required. Enable Doculigent under System Settings > Privacy & Security > Screen Recording, then restart the app."
        );
      }
    }

    // Quick Recording captures exactly what's on screen directly — no post-process
    // compositing — so the camera bubble needs to be visible to (not excluded from) the
    // native capture from the very first frame. Done before screenCapture.start() below,
    // not after, so there's no race where early frames are captured while still protected.
    const showBubbleDirectly = mode === "quick" && this.overlay.showCamera;
    if (showBubbleDirectly) {
      await window.api.cameraBubble.setContentProtected(false).catch(() => {});
    }

    // Hidden with the conservative default *before* camera/mic/system-audio acquisition
    // (rather than right before screen capture, as it used to be) — screen capture itself
    // now starts only after those are ready (see below), so this has to cover that whole
    // stretch too. `contentProtected: false` always means "hide" here (see
    // setCameraBubbleRecordingActive's shouldHide) regardless of what the real backend
    // turns out to support, which is exactly the safe assumption to hold until screen
    // capture actually starts and tells us the truth — revisited a few lines down.
    await window.api.cameraBubble.setRecordingActive(true, false, showBubbleDirectly).catch(() => {});

    // Camera/mic/system-audio acquisition are three independent OS/device round-trips —
    // run them concurrently (rather than one after another) so this stretch costs whichever
    // one is slowest, not their sum. Screen capture deliberately waits for all of this to
    // settle (see below) rather than starting immediately, so every track's real first
    // frame lands together — the tradeoff being that anything on screen during this stretch
    // goes uncaptured, same as it would during the record countdown.
    // Each obtain*Stream() consumes a matching prewarm (see prewarmCamera/prewarmMic/
    // prewarmSystemAudio above) if one exists, falling back to a fresh cold acquisition
    // otherwise — transparent either way to the rest of start().
    const cameraPromise: Promise<void> =
      captureMode === "camera" || this.overlay.showCamera
        ? this.obtainCameraStream(overlay.cameraDeviceId).then(
            (stream) => {
              this.cameraStream = stream;
            },
            (e) => {
              if (captureMode === "camera") throw e;
              console.error("Camera stream unavailable for compositing into the recording — continuing without it:", e);
              this.cameraStream = null;
              this.cameraDegraded = true;
            }
          )
        : Promise.resolve();
    const micStreamPromise = this.obtainMicStream(mic);
    const micPromise: Promise<void> = micStreamPromise
      ? micStreamPromise.then((stream) => {
          this.micStream = stream;
        })
      : Promise.resolve();
    const systemAudioStreamPromise = this.obtainSystemAudioStream(systemAudio);
    const systemAudioPromise: Promise<void> = systemAudioStreamPromise
      ? systemAudioStreamPromise.then((stream) => {
          this.systemAudioStream = stream;
        })
      : Promise.resolve();
    await Promise.all([cameraPromise, micPromise, systemAudioPromise]);
    this.audioTrack = this.resolveAudioTrack();
    if (this.cameraStream) {
      this.cameraVideoEl = document.createElement("video");
      // Attached to the document (off-screen, invisible) rather than left fully detached —
      // a <video> that's never part of the rendered tree at all is a known Chromium power-
      // saving throttling target: frame decode can slow to a crawl or stop outright after a
      // few real seconds, independent of window/renderer-level backgrounding (which
      // `backgroundThrottling`/disable-renderer-backgrounding, set elsewhere, don't cover —
      // those are about timers, not per-element media decode). tick()/sideTick()'s rAF loop
      // keeps firing either way — it just ends up copying the same stalled frame onto the
      // canvas over and over, drawing/encoding a frozen picture while the recorder's still
      // genuinely live audio track (a separate pipeline entirely) keeps right on going.
      this.cameraVideoEl.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;";
      document.body.appendChild(this.cameraVideoEl);
      if (overlay.cameraBlur === "none") {
        this.cameraVideoEl.srcObject = this.cameraStream;
      } else {
        this.cameraBlurHandle = applyCameraBlur(this.cameraStream, overlay.cameraBlur);
        this.cameraVideoEl.srcObject = this.cameraBlurHandle.stream;
      }
      this.cameraVideoEl.muted = true;
      await this.cameraVideoEl.play();
    }

    // Screen capture starts here — only now that camera/mic/system-audio are all settled
    // (see the Promise.all above) — rather than at the top of start(), so its real first
    // frame lands together with theirs instead of well ahead of them.
    let contentProtected = false;
    if (captureMode !== "camera") {
      // hideCursor is false for Quick — Quick's native capture backend composites the
      // cursor itself (Windows.Graphics.Capture on Windows, ScreenCaptureKit on Mac), the
      // same compositor-driven path the OS uses to draw it on screen, so there's nothing
      // to hide or resynthesize. Advanced still hides it (true) and tracks position
      // separately for its editable overlay — unrelated to the Quick/flicker fix, just
      // its own editing feature.
      const captureResult = await window.api.screenCapture.start(
        targetId,
        mode === "advanced",
        this.areaRect ?? undefined,
        mode
      );
      this.nativeCapture = captureResult.available;
      contentProtected = captureResult.contentProtected;
      this.screenStartedAtMs = captureResult.startedAtMs;

      // Advanced-only: Quick's native capture backend composites the real cursor itself
      // (see the hideCursor comment above), so there's nothing to track for it. Cursor
      // tracking piggybacks directly on screen capture actually starting — there's no
      // longer a coverage gap to race against, since screen capture no longer starts
      // early either.
      if (mode === "advanced") {
        window.api.cursor.startCapture(targetId, this.areaRect).catch(() => {});
      }

      // The conservative "hide" default set before acquisition (see above) only needs
      // revisiting when the real answer turns out to be the more permissive one — if
      // it's still false, the bubble is already correctly hidden.
      if (contentProtected) {
        window.api.cameraBubble.setRecordingActive(true, true, showBubbleDirectly).catch(() => {});
      }
    } else {
      this.nativeCapture = false;
    }
    console.log("[RecordingService] start()", {
      captureMode,
      mode,
      nativeCapture: this.nativeCapture,
      contentProtected,
      showBubbleDirectly,
      showCamera: this.overlay.showCamera,
      areaRect: this.areaRect,
    });

    if (captureMode === "camera") {
      await this.startCameraOnlyPipeline();
    } else if (this.nativeCapture) {
      await this.startSideClip(this.overlay);
    } else {
      // Fallback path — no gdigrab, so the screen itself is recorded raw (see
      // startRawScreenRecording) and the camera, same as native, gets its own clip.
      await this.startRawScreenRecording(targetId);
      await this.startSideClip(this.overlay);
    }

    this.startedAt = performance.now();

    // Camera position tracking stays Advanced-only, same reasoning as it always has: Quick
    // burns the bubble in directly via the native capture, no tracking needed. (Cursor
    // tracking starts right alongside screen capture itself — see above.)
    if (this.overlay.showCamera && mode === "advanced") {
      window.api.cameraBubble.startTrack().catch(() => {});
    }
  }

  private async acquireCameraStream(deviceId: string | null): Promise<MediaStream> {
    const deviceConstraint = deviceId ? { deviceId: { exact: deviceId } } : {};
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: { ...deviceConstraint, width: { ideal: 3840 }, height: { ideal: 2160 } },
      });
    } catch {
      return navigator.mediaDevices.getUserMedia({ video: deviceConstraint });
    }
  }

  private obtainCameraStream(deviceId: string | null): Promise<MediaStream> {
    const key = deviceId ?? "";
    if (this.prewarmedCameraKey === key && this.prewarmedCameraPromise) {
      const promise = this.prewarmedCameraPromise;
      this.prewarmedCameraPromise = null;
      this.prewarmedCameraKey = null;
      return promise;
    }
    this.cancelPrewarmedCamera();
    return this.acquireCameraStream(deviceId);
  }

  private obtainMicStream(mic: MicConfig): Promise<MediaStream> | null {
    if (mic.muted) {
      this.cancelPrewarmedMic();
      return null;
    }
    const key = mic.deviceId ?? "";
    if (this.prewarmedMicKey === key && this.prewarmedMicPromise) {
      const promise = this.prewarmedMicPromise;
      this.prewarmedMicPromise = null;
      this.prewarmedMicKey = null;
      return promise;
    }
    this.cancelPrewarmedMic();
    return navigator.mediaDevices.getUserMedia({
      audio: mic.deviceId ? { deviceId: { exact: mic.deviceId } } : true,
    });
  }

  private obtainSystemAudioStream(systemAudio: SystemAudioConfig): Promise<MediaStream> | null {
    if (!systemAudio.enabled || !systemAudio.sourceId) {
      this.cancelPrewarmedSystemAudio();
      return null;
    }
    const key = systemAudio.sourceId;
    if (this.prewarmedSystemAudioKey === key && this.prewarmedSystemAudioPromise) {
      const promise = this.prewarmedSystemAudioPromise;
      this.prewarmedSystemAudioPromise = null;
      this.prewarmedSystemAudioKey = null;
      return promise;
    }
    this.cancelPrewarmedSystemAudio();
    return getSystemAudioStream(systemAudio.sourceId);
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

  private async startRawScreenRecording(targetId: string): Promise<void> {
    // getDisplayMedia, not the legacy getUserMedia({chromeMediaSource: "desktop"})
    // constraints used elsewhere (e.g. the live setup preview) — needed for the `targetId`
    // hand-off via displayMedia.ts's request handler (registerDisplayMediaHandler) rather
    // than Chromium's native picker, so this still records exactly the target the user
    // chose in RecordPage's own list, not whatever the OS dialog would offer.
    //
    // `cursor: "always"`, not "never" — this constraint doesn't reliably suppress the OS
    // cursor on this same-process capture anyway (ipc/recording.ts's finishRecordingSave
    // treats every fallback recording as already having a real cursor baked in and skips
    // its own synthetic overlay pass for that reason). Asking Chromium for "never" here
    // fights the OS's own hardware cursor compositor without actually removing it, which
    // was producing a doubled/ghosted cursor on macOS (the real hardware cursor plus a
    // stale software-composited one). "always" lets exactly one, consistent cursor render.
    await window.api.capture.setDisplayMediaTarget(targetId);
    this.screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { cursor: "always" } as MediaTrackConstraints,
      audio: false,
    });
    console.log(
      "[RecordingService] startRawScreenRecording — track settings",
      this.screenStream.getVideoTracks()[0]?.getSettings()
    );
    const { mimeType, ext } = pickMimeType(true);
    this.rawScreenExt = ext;
    this.rawScreenRecorder = new MediaRecorder(this.screenStream, { mimeType });
    this.rawScreenChunks = [];
    this.rawScreenRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.rawScreenChunks.push(e.data);
    };
    this.rawScreenRecorder.onerror = (e) => console.error("[RecordingService] rawScreenRecorder error", e);
    this.rawScreenRecorder.start();
    // No main-process capture clock for this path (native capture didn't run at all — see
    // screenCapture.start()'s startedAtMs) — this recorder's own start is screen t=0
    // instead, same Date.now() clock startSideClip compares its own recorder's start
    // against.
    this.screenStartedAtMs = Date.now();
    console.log("[RecordingService] rawScreenRecorder started", { mimeType, ext });
  }

  private async startCameraOnlyPipeline(): Promise<void> {
    this.canvas = document.createElement("canvas");
    this.canvas.width = CANVAS_WIDTH;
    this.canvas.height = CANVAS_HEIGHT;
    this.ctx = this.canvas.getContext("2d");

    const canvasStream = this.canvas.captureStream(FPS);
    if (this.audioTrack) canvasStream.addTrack(this.audioTrack);

    const { mimeType, ext } = pickMimeType(true);
    this.cameraOnlyExt = ext;
    this.recorder = new MediaRecorder(canvasStream, { mimeType });
    this.chunks = [];
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.start();
    console.log("[RecordingService] camera-only recorder started", { mimeType, ext });
    this.tick();
  }

  private async startSideClip(overlay: OverlayConfig): Promise<void> {
    // Quick Recording burns the camera bubble in directly via the native capture itself
    // (see start()) — no separate camera clip to composite afterward, so the side clip (if
    // any) only ever carries mic/system audio for that mode. Advanced keeps today's full
    // separate-camera-clip behavior, unchanged.
    this.sideHasVideo = this.mode !== "quick" && overlay.showCamera && !!this.cameraStream;
    this.sideHasAudio = !!this.audioTrack;
    if (!this.sideHasVideo && !this.sideHasAudio) return;

    let stream: MediaStream;
    if (this.sideHasVideo) {
      this.sideCanvas = document.createElement("canvas");
      this.sideCanvas.width = this.cameraVideoEl!.videoWidth || 1280;
      this.sideCanvas.height = this.cameraVideoEl!.videoHeight || 720;
      this.sideCtx = this.sideCanvas.getContext("2d");
      stream = this.sideCanvas.captureStream(FPS);
      if (this.audioTrack) stream.addTrack(this.audioTrack);
      this.sideTick();
    } else {
      stream = new MediaStream([this.audioTrack!]);
    }

    const { mimeType, ext } = pickMimeType(this.sideHasVideo);
    this.sideExt = ext;
    this.sideRecorder = new MediaRecorder(stream, { mimeType });
    this.sideChunks = [];
    this.sideRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.sideChunks.push(e.data);
    };
    this.sideRecorder.start();
    // How far into the screen recording's own timeline this clip's t=0 falls — see
    // EditProjectMedia.sideClipStartOffsetMs. screenStartedAtMs is null only for
    // captureMode "camera", which never reaches startSideClip at all (see start()).
    this.sideClipStartOffsetMs = this.screenStartedAtMs !== null ? Date.now() - this.screenStartedAtMs : null;
    console.log("[RecordingService] side clip recorder started", {
      mimeType,
      ext,
      hasVideo: this.sideHasVideo,
      sideClipStartOffsetMs: this.sideClipStartOffsetMs,
    });
  }

  // Camera-only mode's own recorder — the only remaining caller, now that the screen
  // pipelines (native gdigrab and the raw-recording fallback) both burn the camera in via
  // ipc/recording.ts's ffmpeg post-process instead of a live canvas draw.
  private tick = (): void => {
    if (!this.ctx || !this.canvas || !this.overlay || !this.cameraVideoEl) return;
    drawCameraFullFrame(this.ctx, this.cameraVideoEl, this.canvas.width, this.canvas.height, this.overlay.mirrorCamera);
    this.rafId = requestAnimationFrame(this.tick);
  };

  private sideTick = (): void => {
    if (!this.sideCtx || !this.sideCanvas || !this.cameraVideoEl || !this.overlay) return;
    drawCameraRaw(this.sideCtx, this.cameraVideoEl, this.sideCanvas.width, this.sideCanvas.height);
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
    if (this.rawScreenRecorder && this.rawScreenRecorder.state === "recording") this.rawScreenRecorder.pause();
    if (this.sideRecorder && this.sideRecorder.state === "recording") this.sideRecorder.pause();
    if (this.nativeCapture) await window.api.screenCapture.pause().catch(() => {});
  }

  async resume(): Promise<void> {
    if (!this.overlay || !this.paused) return;
    this.paused = false;
    this.pausedAccumMs += performance.now() - this.pauseStartedAt;

    if (this.recorder && this.recorder.state === "paused") this.recorder.resume();
    if (this.rawScreenRecorder && this.rawScreenRecorder.state === "paused") this.rawScreenRecorder.resume();
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
    await window.api.cameraBubble.stopTrack().catch(() => {});
    window.api.cameraBubble.setRecordingActive(false).catch(() => {});
    if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
    if (this.rawScreenRecorder && this.rawScreenRecorder.state !== "inactive") this.rawScreenRecorder.stop();
    if (this.sideRecorder && this.sideRecorder.state !== "inactive") this.sideRecorder.stop();
    if (wasNative) await window.api.screenCapture.discard().catch(() => {});

    this.cleanupStreams();
    this.overlay = null;
    this.mode = "quick";
    this.nativeCapture = false;
    this.captureMode = "display";
    this.areaRect = null;
    this.paused = false;
    this.pausedAccumMs = 0;
    this.screenStartedAtMs = null;
    this.sideClipStartOffsetMs = null;
  }

  async stop(title: string, source: "record" | "meeting", mode: "quick" | "advanced" = "quick"): Promise<{ id: string }> {
    if (!this.overlay) throw new Error("no active recording");
    const pausedMs = this.paused ? this.pausedAccumMs + (performance.now() - this.pauseStartedAt) : this.pausedAccumMs;
    const durationSecs = (performance.now() - this.startedAt - pausedMs) / 1000;
    const overlay = this.overlay;
    const captureMode = this.captureMode;

    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    if (this.sideRafId !== null) cancelAnimationFrame(this.sideRafId);
    this.sideRafId = null;

    await window.api.cursor.stopCapture().catch(() => {});
    await window.api.cameraBubble.stopTrack().catch(() => {});
    window.api.cameraBubble.setRecordingActive(false).catch(() => {});

    const result =
      captureMode === "camera"
        ? await this.stopCameraOnly(title, source, durationSecs, overlay, mode)
        : await this.stopSeparateFiles(title, source, durationSecs, overlay, mode);

    this.cleanupStreams();
    this.overlay = null;
    this.mode = "quick";
    this.nativeCapture = false;
    this.captureMode = "display";
    this.areaRect = null;
    this.paused = false;
    this.pausedAccumMs = 0;
    this.screenStartedAtMs = null;
    this.sideClipStartOffsetMs = null;
    return result;
  }

  private async stopCameraOnly(
    title: string,
    source: "record" | "meeting",
    durationSecs: number,
    overlay: OverlayConfig,
    mode: "quick" | "advanced"
  ): Promise<{ id: string }> {
    const blobType = this.cameraOnlyExt === "mp4" ? "video/mp4" : "video/webm";
    const finalBlob = await new Promise<Blob>((resolve) => {
      if (!this.recorder || this.recorder.state === "inactive") {
        resolve(new Blob(this.chunks, { type: blobType }));
        return;
      }
      this.recorder.onstop = () => resolve(new Blob(this.chunks, { type: blobType }));
      this.recorder.stop();
    });
    const webmBytes = await finalBlob.arrayBuffer();
    return window.api.recording.save({ webmBytes, webmExt: this.cameraOnlyExt, overlay, durationSecs, title, source, mode });
  }

  private async stopSeparateFiles(
    title: string,
    source: "record" | "meeting",
    durationSecs: number,
    overlay: OverlayConfig,
    mode: "quick" | "advanced"
  ): Promise<{ id: string }> {
    const sideClip = await this.stopSideClip();
    console.log("[RecordingService] stopSeparateFiles", {
      nativeCapture: this.nativeCapture,
      hasSideClip: !!sideClip,
      sideClipHasVideo: sideClip?.hasVideo,
      sideClipHasAudio: sideClip?.hasAudio,
      sideClipBytes: sideClip?.bytes.byteLength,
    });

    if (this.nativeCapture) {
      const { available, filePath } = await window.api.screenCapture.stop();
      if (!available || !filePath) throw new Error("native screen capture stopped with no output file");
      return window.api.recording.save({
        screenFilePath: filePath,
        sideClip,
        sideClipStartOffsetMs: this.sideClipStartOffsetMs,
        overlay,
        durationSecs,
        title,
        source,
        mode,
      });
    }

    const rawScreenBlobType = this.rawScreenExt === "mp4" ? "video/mp4" : "video/webm";
    const finalBlob = await new Promise<Blob>((resolve) => {
      if (!this.rawScreenRecorder || this.rawScreenRecorder.state === "inactive") {
        resolve(new Blob(this.rawScreenChunks, { type: rawScreenBlobType }));
        return;
      }
      this.rawScreenRecorder.onstop = () => resolve(new Blob(this.rawScreenChunks, { type: rawScreenBlobType }));
      this.rawScreenRecorder.stop();
    });
    const screenBytes = await finalBlob.arrayBuffer();
    console.log("[RecordingService] raw screen recording stopped", {
      screenBytes: screenBytes.byteLength,
      screenExt: this.rawScreenExt,
      areaRect: this.areaRect,
    });
    return window.api.recording.save({
      screenBytes,
      screenExt: this.rawScreenExt,
      areaRect: this.areaRect,
      sideClip,
      sideClipStartOffsetMs: this.sideClipStartOffsetMs,
      overlay,
      durationSecs,
      title,
      source,
      mode,
    });
  }

  private async stopSideClip(): Promise<SideClipResult | undefined> {
    if (!this.sideRecorder) return undefined;
    const sideBlobType = this.sideExt === "mp4" ? "video/mp4" : "video/webm";
    const blob = await new Promise<Blob>((resolve) => {
      if (this.sideRecorder!.state === "inactive") {
        resolve(new Blob(this.sideChunks, { type: sideBlobType }));
        return;
      }
      this.sideRecorder!.onstop = () => resolve(new Blob(this.sideChunks, { type: sideBlobType }));
      this.sideRecorder!.stop();
    });
    return { bytes: await blob.arrayBuffer(), hasVideo: this.sideHasVideo, hasAudio: this.sideHasAudio, ext: this.sideExt };
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
    this.cameraVideoEl?.remove();
    this.cameraVideoEl = null;
    this.canvas = null;
    this.ctx = null;
    this.rawScreenRecorder = null;
    this.rawScreenChunks = [];
    this.sideCanvas = null;
    this.sideCtx = null;
    this.sideRecorder = null;
    this.sideChunks = [];
  }
}

export const recordingService = new RecordingService();
