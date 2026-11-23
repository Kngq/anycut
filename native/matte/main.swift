// anycut-matte: background-removal mattes on macOS with Apple's Vision framework (Neural Engine /
// GPU), used by electron/main/background.ts instead of the ONNX models when available.
//
//   anycut-matte <person|subject> <width> <height>
//
// Reads raw BGRA frames (width*height*4 bytes each) from stdin until EOF and writes one 8-bit
// matte per frame (width*height bytes, 255 = keep) to stdout, in order.
//   person:  VNGeneratePersonSegmentationRequest, accurate quality, through a sequence handler
//            so the mask is temporally consistent across frames (macOS 12+).
//   subject: VNGenerateForegroundInstanceMaskRequest ("lift subject"), all instances (macOS 14+).
// Exit codes: 2 = bad arguments, 3 = mode not supported on this macOS version, 4 = Vision error.

import Accelerate
import CoreVideo
import Foundation
import Vision

func fail(_ code: Int32, _ message: String) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(code)
}

let args = CommandLine.arguments
guard args.count == 4, let width = Int(args[2]), let height = Int(args[3]), width > 0, height > 0 else {
  fail(2, "usage: anycut-matte <person|subject> <width> <height>")
}
let mode = args[1]
if mode == "subject" {
  guard #available(macOS 14.0, *) else { fail(3, "Any-subject cutout needs macOS 14 or later") }
} else if mode == "person" {
  guard #available(macOS 12.0, *) else { fail(3, "Person segmentation needs macOS 12 or later") }
} else {
  fail(2, "unknown mode \(mode)")
}

let frameBytes = width * height * 4
var input = [UInt8](repeating: 0, count: frameBytes)
var output = [UInt8](repeating: 0, count: width * height)

// One IOSurface-backed buffer, refilled per frame (Vision can hand it to the ANE without a copy).
var pixelBuffer: CVPixelBuffer?
let attrs: [String: Any] = [kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any]()]
guard CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_32BGRA, attrs as CFDictionary, &pixelBuffer) == kCVReturnSuccess, let frame = pixelBuffer else {
  fail(4, "could not allocate a frame buffer")
}

/// Reads exactly one frame from stdin; false at EOF.
func readFrame() -> Bool {
  var got = 0
  while got < frameBytes {
    let n = input.withUnsafeMutableBytes { fread($0.baseAddress! + got, 1, frameBytes - got, stdin) }
    if n <= 0 { return false }
    got += n
  }
  CVPixelBufferLockBaseAddress(frame, [])
  let dst = CVPixelBufferGetBaseAddress(frame)!
  let rowBytes = CVPixelBufferGetBytesPerRow(frame)
  input.withUnsafeBytes { src in
    for y in 0..<height {
      memcpy(dst + y * rowBytes, src.baseAddress! + y * width * 4, width * 4)
    }
  }
  CVPixelBufferUnlockBaseAddress(frame, [])
  return true
}

/// Scales an 8-bit or float mask buffer to width x height into `output`.
func writeMask(_ mask: CVPixelBuffer) {
  CVPixelBufferLockBaseAddress(mask, .readOnly)
  defer { CVPixelBufferUnlockBaseAddress(mask, .readOnly) }
  let mw = CVPixelBufferGetWidth(mask)
  let mh = CVPixelBufferGetHeight(mask)
  let base = CVPixelBufferGetBaseAddress(mask)!
  let rowBytes = CVPixelBufferGetBytesPerRow(mask)
  var plane8 = [UInt8](repeating: 0, count: mw * mh)
  if CVPixelBufferGetPixelFormatType(mask) == kCVPixelFormatType_OneComponent32Float {
    var src = vImage_Buffer(data: base, height: vImagePixelCount(mh), width: vImagePixelCount(mw), rowBytes: rowBytes)
    plane8.withUnsafeMutableBytes { p in
      var dst = vImage_Buffer(data: p.baseAddress!, height: vImagePixelCount(mh), width: vImagePixelCount(mw), rowBytes: mw)
      vImageConvert_PlanarFtoPlanar8(&src, &dst, 1, 0, vImage_Flags(kvImageNoFlags))
    }
  } else {
    plane8.withUnsafeMutableBytes { p in
      for y in 0..<mh { memcpy(p.baseAddress! + y * mw, base + y * rowBytes, mw) }
    }
  }
  if mw == width && mh == height {
    output = plane8
  } else {
    plane8.withUnsafeMutableBytes { s in
      output.withUnsafeMutableBytes { d in
        var src = vImage_Buffer(data: s.baseAddress!, height: vImagePixelCount(mh), width: vImagePixelCount(mw), rowBytes: mw)
        var dst = vImage_Buffer(data: d.baseAddress!, height: vImagePixelCount(height), width: vImagePixelCount(width), rowBytes: width)
        vImageScale_Planar8(&src, &dst, nil, vImage_Flags(kvImageHighQualityResampling))
      }
    }
  }
}

func emit() {
  output.withUnsafeBytes { _ = fwrite($0.baseAddress!, 1, output.count, stdout) }
  fflush(stdout)
}

if mode == "person", #available(macOS 12.0, *) {
  let sequence = VNSequenceRequestHandler()
  let request = VNGeneratePersonSegmentationRequest()
  request.qualityLevel = .accurate
  request.outputPixelFormat = kCVPixelFormatType_OneComponent8
  while readFrame() {
    do {
      try sequence.perform([request], on: frame)
      if let mask = request.results?.first?.pixelBuffer { writeMask(mask) } else { output = [UInt8](repeating: 0, count: width * height) }
    } catch {
      fail(4, "Vision: \(error.localizedDescription)")
    }
    emit()
  }
} else if #available(macOS 14.0, *) {
  let request = VNGenerateForegroundInstanceMaskRequest()
  while readFrame() {
    let handler = VNImageRequestHandler(cvPixelBuffer: frame, options: [:])
    do {
      try handler.perform([request])
      if let result = request.results?.first, !result.allInstances.isEmpty {
        writeMask(try result.generateScaledMaskForImage(forInstances: result.allInstances, from: handler))
      } else {
        output = [UInt8](repeating: 0, count: width * height)
      }
    } catch {
      fail(4, "Vision: \(error.localizedDescription)")
    }
    emit()
  }
}
