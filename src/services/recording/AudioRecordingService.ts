import { desktopAudioConstraints } from "./constraints";

/**
 * Audio-only capture for the Meeting tab, from one or both of: the microphone, and
 * "system sound" (desktop loopback audio, OBS-style). Both sources — when enabled — are
 * mixed into one stream via a Web Audio MediaStreamAudioDestinationNode before recording,
 * so the rest of the pipeline (master/segment recorders, live transcription) doesn't need
 * to know how many sources are actually feeding it.
 *
 * Two MediaRecorders share that mixed stream: a "master" one that runs for the whole
 * session (what actually gets saved), and a rolling "segment" one that stops/restarts
 * every SEGMENT_MS to produce short, independently-decodable clips for live
 * transcription. Two recorders rather than one because MediaRecorder's `timeslice` chunks
 * aren't reliably self-contained WebM files on their own — a stopped recorder's output
 * always is.
 *
 * Each segment is decoded to 16kHz mono PCM right here in the renderer (via
 * decodeToPcm16k, using the browser's built-in WebM/Opus decoder) before handing samples
 * to the caller, instead of shipping the raw WebM bytes to the main process for ffmpeg to
 * convert. That skips a per-chunk process spawn + temp-file round trip, which is what was
 * making the live transcript feel a couple seconds behind — it only matters here because
 * this path runs once per rolling segment rather than once per whole recording.
 *
 * 4s (not shorter) is deliberate: a shorter window was tried and made live-caption
 * accuracy noticeably worse (more words get cut across a chunk boundary, and Whisper does
 * better with more acoustic context per call) for latency gains that ffmpeg removal above
 * already captured most of.
 */
const SEGMENT_MS = 4000;

export interface MeetingAudioSources {
  mic: { enabled: boolean; deviceId: string | null };
  /** `sourceId`: a CaptureTarget id (see window.api.capture.listTargets) for a *display*
   *  specifically — see desktopAudioConstraints for why it has to be a screen, and why it
   *  doesn't actually scope which audio comes through (all system audio does, regardless
   *  of which screen is picked). */
  systemAudio: { enabled: boolean; sourceId: string | null };
}

function pickAudioMimeType(): string {
  const candidates = ["audio/webm;codecs=opus", "audio/webm"];
  return candidates.find((c) => MediaRecorder.isTypeSupported(c)) ?? "audio/webm";
}

/** Decodes a self-contained audio blob (a stopped MediaRecorder's output) to 16kHz mono
 *  PCM using the browser's native decoder — no ffmpeg needed for this in-process path.
 *  Uses a throwaway AudioContext for the decode step (rather than the analyser's live one)
 *  so this can't race that context's lifecycle when a recording stops mid-decode. */
async function decodeToPcm16k(blob: Blob): Promise<Float32Array> {
  const arrayBuffer = await blob.arrayBuffer();
  const decodeCtx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(arrayBuffer);
  } finally {
    decodeCtx.close();
  }

  const targetLength = Math.max(1, Math.ceil(decoded.duration * 16000));
  const offlineCtx = new OfflineAudioContext(1, targetLength, 16000);
  const source = offlineCtx.createBufferSource();
  source.buffer = decoded;
  source.connect(offlineCtx.destination);
  source.start();
  const rendered = await offlineCtx.startRendering();
  return rendered.getChannelData(0).slice();
}

/** Chromium requires requesting `video` alongside desktop `audio` to unlock the audio
 *  track at all (see desktopAudioConstraints) — the video track is dropped immediately
 *  since the Meeting tab only wants audio. Exported so MeetingPage can open its own
 *  short-lived stream for the "system sound" level-meter preview, independent of an
 *  actual recording. */
export async function getSystemAudioStream(sourceId: string): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getUserMedia(desktopAudioConstraints(sourceId));
  stream.getVideoTracks().forEach((t) => t.stop());
  return stream;
}

class AudioRecordingService {
  private micStream: MediaStream | null = null;
  private systemAudioStream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private mixDestination: MediaStreamAudioDestinationNode | null = null;
  private analyser: AnalyserNode | null = null;
  private masterRecorder: MediaRecorder | null = null;
  private masterChunks: Blob[] = [];
  private segmentRecorder: MediaRecorder | null = null;
  private segmentChunks: Blob[] = [];
  private segmentTimer: number | null = null;
  private onSegment: ((samples: Float32Array) => void) | null = null;
  private startedAt = 0;
  private recording = false;

  async start(onSegment: (samples: Float32Array) => void, sources: MeetingAudioSources): Promise<AnalyserNode> {
    if (!sources.mic.enabled && !sources.systemAudio.enabled) {
      throw new Error("Enable at least one audio source (microphone or system sound).");
    }

    this.onSegment = onSegment;
    this.startedAt = performance.now();
    this.recording = true;

    this.audioCtx = new AudioContext();
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.mixDestination = this.audioCtx.createMediaStreamDestination();

    try {
      if (sources.mic.enabled) {
        this.micStream = await navigator.mediaDevices.getUserMedia({
          audio: sources.mic.deviceId ? { deviceId: { exact: sources.mic.deviceId } } : true,
        });
        const micSource = this.audioCtx.createMediaStreamSource(this.micStream);
        micSource.connect(this.analyser);
        micSource.connect(this.mixDestination);
      }

      if (sources.systemAudio.enabled && sources.systemAudio.sourceId) {
        this.systemAudioStream = await getSystemAudioStream(sources.systemAudio.sourceId);
        const systemSource = this.audioCtx.createMediaStreamSource(this.systemAudioStream);
        systemSource.connect(this.analyser);
        systemSource.connect(this.mixDestination);
      }
    } catch (e) {
      this.recording = false;
      this.cleanupStreams();
      throw e;
    }

    const mixedStream = this.mixDestination.stream;

    this.masterChunks = [];
    this.masterRecorder = new MediaRecorder(mixedStream, { mimeType: pickAudioMimeType() });
    this.masterRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.masterChunks.push(e.data);
    };
    this.masterRecorder.start();

    this.startNextSegment(mixedStream);
    return this.analyser;
  }

  private startNextSegment(stream: MediaStream): void {
    if (!this.recording) return;
    this.segmentChunks = [];
    const recorder = new MediaRecorder(stream, { mimeType: pickAudioMimeType() });
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.segmentChunks.push(e.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(this.segmentChunks, { type: "audio/webm" });
      if (blob.size > 0) {
        // Decoding is async but chaining the next segment below isn't gated on it, so
        // recording keeps rolling gap-free while this segment's decode+transcribe happens
        // in the background.
        decodeToPcm16k(blob)
          .then((samples) => this.onSegment?.(samples))
          .catch(() => {}); // e.g. a too-short/silent segment the decoder can't parse — drop it
      }
      // Chain the next segment only if we're still recording (stop() clears the flag
      // before calling segmentRecorder.stop(), which is what lands us here at the end).
      if (this.recording) this.startNextSegment(stream);
    };
    recorder.start();
    this.segmentRecorder = recorder;
    this.segmentTimer = window.setTimeout(() => this.segmentRecorder?.stop(), SEGMENT_MS);
  }

  async stop(): Promise<{ blob: Blob; durationSecs: number }> {
    const durationSecs = (performance.now() - this.startedAt) / 1000;
    if (this.segmentTimer !== null) window.clearTimeout(this.segmentTimer);

    this.recording = false; // signals startNextSegment (via segmentRecorder.onstop) to stop chaining
    this.segmentRecorder?.stop();

    const blob = await new Promise<Blob>((resolve) => {
      if (!this.masterRecorder) {
        resolve(new Blob(this.masterChunks, { type: "audio/webm" }));
        return;
      }
      this.masterRecorder.onstop = () => resolve(new Blob(this.masterChunks, { type: "audio/webm" }));
      this.masterRecorder.stop();
    });

    this.cleanupStreams();
    this.onSegment = null;

    return { blob, durationSecs };
  }

  private cleanupStreams(): void {
    for (const stream of [this.micStream, this.systemAudioStream]) {
      stream?.getTracks().forEach((t) => t.stop());
    }
    this.micStream = null;
    this.systemAudioStream = null;
    this.audioCtx?.close();
    this.audioCtx = null;
    this.mixDestination = null;
    this.analyser = null;
  }
}

export const audioRecordingService = new AudioRecordingService();
