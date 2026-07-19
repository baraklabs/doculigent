/**
 * Electron/Chromium-specific constraint shape for desktopCapturer-sourced streams — not
 * part of the standard MediaTrackConstraints type, hence the cast. Shared by the live
 * setup preview (RecordPage) and the actual recording pipeline (RecordingService) so
 * both request the desktop stream the same way.
 */
export function desktopConstraints(sourceId: string): MediaStreamConstraints {
  return {
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: sourceId,
      },
    },
  } as unknown as MediaStreamConstraints;
}

/**
 * Same desktopCapturer-sourced stream, but for the Meeting tab's "system sound" source
 * (see AudioRecordingService's getSystemAudioStream). Chromium's desktop-audio capture
 * has two quirks this works around:
 *  - the `audio` constraint can't be requested alone — `video` must be present in the
 *    same call or the audio track never initializes, even though the video is unwanted
 *    here (the caller stops that track immediately after getUserMedia resolves).
 *  - `chromeMediaSourceId` only targets which screen's *video* comes through; the audio
 *    track is always the single system-wide loopback regardless of which id is passed
 *    (Windows doesn't expose per-window loopback via this API), so "source" here really
 *    means "which screen to nominally request video from to unlock system audio at all,"
 *    not "which app's audio to capture."
 */
export function desktopAudioConstraints(sourceId: string): MediaStreamConstraints {
  return {
    audio: {
      mandatory: {
        chromeMediaSource: "desktop",
      },
    },
    video: {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: sourceId,
      },
    },
  } as unknown as MediaStreamConstraints;
}
