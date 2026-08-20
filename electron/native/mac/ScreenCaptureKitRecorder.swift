import Foundation
import ScreenCaptureKit
import AVFoundation
import CoreGraphics

// Video-only ScreenCaptureKit-based screen recorder for the macOS native capture path
// (see electron/main/native/screenCapture.ts). Doculigent already records mic/system
// audio and the camera bubble through its own separate getUserMedia-based pipelines, so
// unlike a full-featured recorder this only ever needs one video track.
//
// Why ScreenCaptureKit instead of ffmpeg's `-f avfoundation` input (the pre-existing
// fallback, still used if this helper isn't built/found): avfoundation's screen capture
// goes through the legacy CGDisplayStream API, which does NOT reliably respect a
// window's NSWindow.sharingType = .none (what Electron's win.setContentProtection(true)
// sets) — confirmed by testing, a content-protected camera-bubble window still showed up
// baked into an avfoundation capture. ScreenCaptureKit is Apple's modern replacement and
// DOES honor sharingType = .none automatically, excluding such windows from every
// SCStream capture without needing to name them explicitly (no `exceptingWindows` list
// needed below) — the same mechanism apps like password managers and Zoom rely on to
// keep their own overlays out of screen shares. It also has a real cursor-suppression
// option (showsCursor) and a real AVAssetWriter-finalized output, sidestepping both the
// -fps_mode/-movflags workarounds the avfoundation path needed.

struct CaptureConfig: Codable {
	let fps: Int?
	let displayId: CGDirectDisplayID?
	let outputPath: String
	// Fractional (0..1) crop of the display, matching the AreaRect shape used elsewhere in
	// the app (native/screenCapture.ts's Windows/gdigrab path crops via -offset_x/-offset_y
	// instead, at the source, for the same reason: cropping here rather than in a
	// downstream ffmpeg pass keeps the native-capture output already at its final size).
	let areaX: Double?
	let areaY: Double?
	let areaWidth: Double?
	let areaHeight: Double?
	// Quick Recording wants the real OS cursor burnt directly into the capture (no
	// separate synthetic overlay needed); Advanced keeps it out, same as before, since it
	// tracks cursor position separately for editing. Defaults to false (hidden) to match
	// this recorder's pre-existing behavior when an older Node side doesn't send it.
	let showsCursor: Bool?
}

let targetCaptureFPS = 30

final class ScreenCaptureRecorder: NSObject, SCStreamOutput, SCStreamDelegate {
	private let queue = DispatchQueue(label: "doculigent.screencapturekit.video")
	private var assetWriter: AVAssetWriter?
	private var videoInput: AVAssetWriterInput?
	private var stream: SCStream?
	private var firstSampleTime: CMTime = .zero
	private var lastSampleBuffer: CMSampleBuffer?
	private var lastVideoPresentationTime: CMTime = .zero
	private var lastVideoDuration: CMTime = .zero
	private var isRecording = false
	private var isPaused = false
	private var pauseStartedHostTime: CMTime?
	private var pendingResumeAdjustment = false
	private var accumulatedPausedDuration: CMTime = .zero
	private var sessionStarted = false
	private var outputURL: URL?

	func startCapture(configJSON: String) async throws {
		guard !isRecording else {
			throw NSError(domain: "DoculigentCapture", code: 1, userInfo: [NSLocalizedDescriptionKey: "Recording is already in progress"])
		}
		guard let data = configJSON.data(using: .utf8) else {
			throw NSError(domain: "DoculigentCapture", code: 2, userInfo: [NSLocalizedDescriptionKey: "Invalid JSON input"])
		}
		let config = try JSONDecoder().decode(CaptureConfig.self, from: data)

		let availableContent = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
		let displayId = config.displayId ?? CGMainDisplayID()
		guard let display = availableContent.displays.first(where: { $0.displayID == displayId }) else {
			throw NSError(domain: "DoculigentCapture", code: 3, userInfo: [NSLocalizedDescriptionKey: "Display not found"])
		}

		// Empty exceptingWindows — sharingType=.none windows (the camera bubble) are
		// excluded automatically, nothing to list explicitly.
		let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])

		let streamConfig = SCStreamConfiguration()
		let requestedFPS = max(1, config.fps ?? targetCaptureFPS)
		streamConfig.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(requestedFPS))
		streamConfig.queueDepth = 6
		streamConfig.pixelFormat = kCVPixelFormatType_32BGRA
		streamConfig.showsCursor = config.showsCursor ?? false
		streamConfig.capturesAudio = false

		let displayBounds = CGDisplayBounds(display.displayID)
		let scaleFactor = Self.scaleFactor(for: display.displayID)
		var outputWidth: Int
		var outputHeight: Int
		if let ax = config.areaX, let ay = config.areaY, let aw = config.areaWidth, let ah = config.areaHeight {
			let sourceRect = CGRect(
				x: displayBounds.width * ax,
				y: displayBounds.height * ay,
				width: displayBounds.width * aw,
				height: displayBounds.height * ah
			)
			streamConfig.sourceRect = sourceRect
			outputWidth = max(2, Int(sourceRect.width) * scaleFactor)
			outputHeight = max(2, Int(sourceRect.height) * scaleFactor)
		} else {
			outputWidth = max(2, Int(displayBounds.width) * scaleFactor)
			outputHeight = max(2, Int(displayBounds.height) * scaleFactor)
		}

		// Cap to 1440p — full native/retina resolution (see scaleFactor above) is often well
		// past 4K on modern Macs (a 14"/16" MacBook Pro's own built-in display already
		// exceeds it, before even counting 5K/6K external displays) and that pixel count
		// dominates every later ffmpeg pass's cost (CFR normalization, cursor/camera overlay
		// compositing, export) far more than encoder choice does. A 1080p cap was tried
		// first but visibly softened text/UI on a Retina source (confirmed) — 1440p is the
		// compromise: still a real cut off native resolution, less blur. Setting
		// streamConfig.width/height (not just the AVAssetWriter output settings below) makes
		// ScreenCaptureKit itself deliver already-downscaled frames, so this is a real
		// capture-time cost reduction, not a wasted decode of full-res frames that then just
		// get resized.
		let (cappedWidth, cappedHeight) = Self.capTo1440p(width: outputWidth, height: outputHeight)
		outputWidth = cappedWidth
		outputHeight = cappedHeight
		streamConfig.width = outputWidth
		streamConfig.height = outputHeight

		let destinationURL = URL(fileURLWithPath: config.outputPath)
		outputURL = destinationURL
		let assetWriter = try AVAssetWriter(url: destinationURL, fileType: .mp4)
		self.assetWriter = assetWriter

		guard let assistant = AVOutputSettingsAssistant(preset: .preset3840x2160) else {
			throw NSError(domain: "DoculigentCapture", code: 5, userInfo: [NSLocalizedDescriptionKey: "Unable to create output settings assistant"])
		}
		assistant.sourceVideoFormat = try CMVideoFormatDescription(videoCodecType: .h264, width: outputWidth, height: outputHeight)
		guard var outputSettings = assistant.videoSettings else {
			throw NSError(domain: "DoculigentCapture", code: 6, userInfo: [NSLocalizedDescriptionKey: "Output settings unavailable"])
		}
		outputSettings[AVVideoWidthKey] = outputWidth
		outputSettings[AVVideoHeightKey] = outputHeight

		let videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: outputSettings)
		videoInput.expectsMediaDataInRealTime = true
		guard assetWriter.canAdd(videoInput) else {
			throw NSError(domain: "DoculigentCapture", code: 7, userInfo: [NSLocalizedDescriptionKey: "Unable to add video writer input"])
		}
		assetWriter.add(videoInput)
		self.videoInput = videoInput

		let stream = SCStream(filter: filter, configuration: streamConfig, delegate: self)
		self.stream = stream
		try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
		try await stream.startCapture()

		guard assetWriter.startWriting() else {
			throw NSError(domain: "DoculigentCapture", code: 8, userInfo: [NSLocalizedDescriptionKey: assetWriter.error?.localizedDescription ?? "Unable to start video writing"])
		}
		assetWriter.startSession(atSourceTime: .zero)
		sessionStarted = true
		isRecording = true
		isPaused = false
		pauseStartedHostTime = nil
		pendingResumeAdjustment = false
		accumulatedPausedDuration = .zero
		firstSampleTime = .zero
		lastVideoPresentationTime = .zero
		lastVideoDuration = .zero
		print("Recording started")
		fflush(stdout)
	}

	func stopCapture() async throws -> String {
		guard isRecording else {
			throw NSError(domain: "DoculigentCapture", code: 9, userInfo: [NSLocalizedDescriptionKey: "No recording in progress"])
		}
		return try await finishCapture()
	}

	func pauseCapture() {
		guard isRecording, !isPaused else { return }
		isPaused = true
		pauseStartedHostTime = CMClockGetTime(CMClockGetHostTimeClock())
		pendingResumeAdjustment = false
	}

	func resumeCapture() {
		guard isRecording, isPaused else { return }
		isPaused = false
		pendingResumeAdjustment = true
	}

	func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
		guard sessionStarted, sampleBuffer.isValid, isRecording, outputType == .screen else { return }
		guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
			  let attachment = attachments.first,
			  let statusRawValue = attachment[SCStreamFrameInfo.status] as? Int,
			  let status = SCFrameStatus(rawValue: statusRawValue),
			  status == .complete else {
			return
		}
		guard let presentationTime = adjustedPresentationTime(for: sampleBuffer) else { return }
		guard let videoInput = videoInput, videoInput.isReadyForMoreMediaData else { return }

		lastSampleBuffer = sampleBuffer
		let timing = CMSampleTimingInfo(duration: sampleBuffer.duration, presentationTimeStamp: presentationTime, decodeTimeStamp: sampleBuffer.decodeTimeStamp)
		if let retimedSampleBuffer = try? CMSampleBuffer(copying: sampleBuffer, withNewTiming: [timing]) {
			videoInput.append(retimedSampleBuffer)
			lastVideoPresentationTime = presentationTime
			lastVideoDuration = sampleBuffer.duration
		}
	}

	func stream(_ stream: SCStream, didStopWithError error: Error) {
		fputs("Error: \(error.localizedDescription)\n", stderr)
		fflush(stderr)
	}

	private func finishCapture() async throws -> String {
		if let activeStream = stream {
			do {
				try await activeStream.stopCapture()
			} catch {
				// Stream may have already been stopped by the system — continue with file finalization.
			}
		}
		stream = nil
		isRecording = false

		// Re-append the last frame with an extended duration so the asset writer's session
		// covers the full recorded span instead of ending exactly on the last frame's own
		// (possibly very short) native duration.
		if let originalBuffer = lastSampleBuffer, let videoInput = videoInput {
			let additionalTime = lastVideoPresentationTime + frameDuration(for: originalBuffer)
			let timing = CMSampleTimingInfo(duration: originalBuffer.duration, presentationTimeStamp: additionalTime, decodeTimeStamp: originalBuffer.decodeTimeStamp)
			if let additionalSampleBuffer = try? CMSampleBuffer(copying: originalBuffer, withNewTiming: [timing]) {
				videoInput.append(additionalSampleBuffer)
			}
		}

		let endTime = lastVideoPresentationTime + (lastSampleBuffer.map { frameDuration(for: $0) } ?? .zero)
		assetWriter?.endSession(atSourceTime: endTime)
		videoInput?.markAsFinished()
		await assetWriter?.finishWriting()

		let path = outputURL?.path ?? ""
		assetWriter = nil
		videoInput = nil
		outputURL = nil
		sessionStarted = false
		firstSampleTime = .zero
		lastSampleBuffer = nil
		lastVideoPresentationTime = .zero
		lastVideoDuration = .zero
		isPaused = false
		pauseStartedHostTime = nil
		pendingResumeAdjustment = false
		accumulatedPausedDuration = .zero
		return path
	}

	private func adjustedPresentationTime(for sampleBuffer: CMSampleBuffer) -> CMTime? {
		if isPaused { return nil }

		let sampleTime = sampleBuffer.presentationTimeStamp
		if pendingResumeAdjustment, let pauseStartedHostTime {
			let pauseGap = sampleTime - pauseStartedHostTime
			if pauseGap > .zero {
				accumulatedPausedDuration = accumulatedPausedDuration + pauseGap
			}
			self.pauseStartedHostTime = nil
			pendingResumeAdjustment = false
		}

		if firstSampleTime == .zero {
			firstSampleTime = sampleTime
		}

		return max(.zero, sampleTime - firstSampleTime - accumulatedPausedDuration)
	}

	private func frameDuration(for sampleBuffer: CMSampleBuffer) -> CMTime {
		if sampleBuffer.duration.isValid && sampleBuffer.duration > .zero {
			return sampleBuffer.duration
		}
		if lastVideoDuration.isValid && lastVideoDuration > .zero {
			return lastVideoDuration
		}
		return CMTime(value: 1, timescale: CMTimeScale(targetCaptureFPS))
	}

	private static func scaleFactor(for displayId: CGDirectDisplayID) -> Int {
		guard let mode = CGDisplayCopyDisplayMode(displayId) else { return 1 }
		return max(1, mode.pixelWidth / max(1, mode.width))
	}

	// Scales down to fit within a 2560x1440 box, preserving aspect ratio — never scales up
	// (a display/area already at or under 1440p is left alone). 1440p over 1080p: on a
	// Retina source, 1080p visibly softened text/UI (confirmed) — 1440p still meaningfully
	// cuts a native 4-6K pixel count (and therefore normalizeToCfr's decode/encode cost)
	// while staying noticeably sharper. H.264 needs even dimensions, so the result is
	// floored to the nearest even number on each axis.
	private static func capTo1440p(width: Int, height: Int) -> (Int, Int) {
		let maxWidth: CGFloat = 2560
		let maxHeight: CGFloat = 1440
		let scale = min(1.0, maxWidth / CGFloat(width), maxHeight / CGFloat(height))
		if scale >= 1.0 { return (width, height) }
		var cappedWidth = Int((CGFloat(width) * scale).rounded(.down))
		var cappedHeight = Int((CGFloat(height) * scale).rounded(.down))
		if cappedWidth % 2 != 0 { cappedWidth -= 1 }
		if cappedHeight % 2 != 0 { cappedHeight -= 1 }
		return (max(2, cappedWidth), max(2, cappedHeight))
	}
}

final class RecorderService {
	private let recorder = ScreenCaptureRecorder()
	private let queue = DispatchQueue(label: "doculigent.screencapturekit.commands")
	private let completionGroup = DispatchGroup()

	func start(configJSON: String) {
		completionGroup.enter()
		queue.async {
			Task {
				do {
					try await self.recorder.startCapture(configJSON: configJSON)
				} catch {
					fputs("Error starting capture: \(error.localizedDescription)\n", stderr)
					fflush(stderr)
					self.completionGroup.leave()
				}
			}
		}
	}

	func stop() {
		queue.async {
			Task {
				do {
					let outputPath = try await self.recorder.stopCapture()
					print("Recording stopped. Output path: \(outputPath)")
					fflush(stdout)
					self.completionGroup.leave()
				} catch {
					fputs("Error stopping capture: \(error.localizedDescription)\n", stderr)
					fflush(stderr)
					self.completionGroup.leave()
				}
			}
		}
	}

	func pause() {
		queue.async { self.recorder.pauseCapture() }
	}

	func resume() {
		queue.async { self.recorder.resumeCapture() }
	}

	func waitUntilFinished() {
		completionGroup.wait()
	}
}

guard CommandLine.arguments.count >= 2 else {
	fputs("Missing config JSON\n", stderr)
	fflush(stderr)
	exit(1)
}

// Force CoreGraphics Services initialization on the main thread — without this,
// SCContentFilter crashes with CGS_REQUIRE_INIT because CGS is never initialised in a
// plain CLI tool (no AppKit run loop).
let _ = CGMainDisplayID()

if !CGPreflightScreenCaptureAccess() {
	let granted = CGRequestScreenCaptureAccess()
	if !granted {
		fputs("SCREEN_RECORDING_PERMISSION_DENIED\n", stderr)
		fflush(stderr)
		exit(1)
	}
}

let service = RecorderService()
service.start(configJSON: CommandLine.arguments[1])

DispatchQueue.global(qos: .utility).async {
	while let input = readLine(strippingNewline: true)?.lowercased() {
		if input == "pause" {
			service.pause()
			continue
		}
		if input == "resume" {
			service.resume()
			continue
		}
		if input == "stop" {
			service.stop()
			break
		}
	}
}

service.waitUntilFinished()
