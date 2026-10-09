// macOS-only, dependency-free validation of the actual Release framebuffer.
// simctl can return portrait physical pixels while the app is in landscape.
// Keep that raw image; normalize both possible quarter-turns and select the one
// whose known title layout has amber branding left and bright artwork right.
import Foundation
import CoreGraphics
import ImageIO

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

struct Frame {
    let width: Int
    let height: Int
    let pixels: [UInt8]
    let transform: String

    func quarterTurn(clockwise: Bool) -> Frame {
        var output = [UInt8](repeating: 0, count: pixels.count)
        for y in 0..<height {
            for x in 0..<width {
                let nx = clockwise ? height - 1 - y : y
                let ny = clockwise ? x : width - 1 - x
                let src = (y * width + x) * 4, dst = (ny * height + nx) * 4
                for channel in 0..<4 { output[dst + channel] = pixels[src + channel] }
            }
        }
        return Frame(width: height, height: width, pixels: output,
                     transform: clockwise ? "physical-clockwise-90" : "physical-counterclockwise-90")
    }

    func metrics() -> (passes: Bool, detail: String) {
        var colors = Set<Int>()
        var lightest = 0, darkest = 255, amber = 0, bright = 0, nonDark = 0, samples = 0
        var leftAmber = 0, rightAmber = 0, rightBright = 0
        for gy in 2..<29 {
            for gx in 8..<49 {
                let x = width * gx / 56, y = height * gy / 32
                let offset = (y * width + x) * 4
                let r = Int(pixels[offset]), g = Int(pixels[offset + 1]), b = Int(pixels[offset + 2])
                colors.insert((r / 16) * 256 + (g / 16) * 16 + b / 16)
                let luminance = (r * 21 + g * 72 + b * 7) / 100
                lightest = max(lightest, luminance); darkest = min(darkest, luminance)
                if r > 180 && g > 90 && g < 210 && b < 100 {
                    amber += 1
                    if gx < 28 { leftAmber += 1 } else { rightAmber += 1 }
                }
                if r > 170 && g > 170 && b > 160 {
                    bright += 1
                    if gx >= 28 { rightBright += 1 }
                }
                if luminance > 50 { nonDark += 1 }
                samples += 1
            }
        }
        let detail = "transform=\(transform), colors=\(colors.count), contrast=\(lightest - darkest), amber=\(amber), bright=\(bright), nonDark=\(nonDark)/\(samples), leftAmber=\(leftAmber), rightAmber=\(rightAmber), rightBright=\(rightBright)"
        let passes = width > height && colors.count > 20 && lightest - darkest > 100 &&
            amber > 10 && bright > 20 && nonDark > samples / 5 && leftAmber > rightAmber && rightBright > 10
        return (passes, detail)
    }

    func writePNG(to path: String) {
        guard let provider = CGDataProvider(data: Data(pixels) as CFData),
              let image = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32,
                bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGBitmapInfo(rawValue: CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.premultipliedLast.rawValue),
                provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent),
              let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, "public.png" as CFString, 1, nil)
        else { fail("Could not prepare normalized screenshot") }
        CGImageDestinationAddImage(destination, image, nil)
        if !CGImageDestinationFinalize(destination) { fail("Could not save normalized screenshot") }
    }
}

guard CommandLine.arguments.count == 3,
      let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: CommandLine.arguments[1]) as CFURL, nil),
      let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: 1400
      ] as CFDictionary) else { fail("Usage: check-ios-screenshot raw.png normalized.png") }
let width = image.width, height = image.height
var pixels = [UInt8](repeating: 0, count: width * height * 4)
let decoded = pixels.withUnsafeMutableBytes { buffer -> Bool in
    guard let context = CGContext(data: buffer.baseAddress, width: width, height: height,
        bitsPerComponent: 8, bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
    context.draw(image, in: CGRect(x: 0, y: 0, width: CGFloat(width), height: CGFloat(height)))
    return true
}
guard decoded else { fail("Screenshot pixels could not be decoded") }
let raw = Frame(width: width, height: height, pixels: pixels, transform: "metadata-oriented")
let candidates = width > height ? [raw] : [raw.quarterTurn(clockwise: true), raw.quarterTurn(clockwise: false)]
var failures: [String] = []
for frame in candidates {
    let result = frame.metrics()
    if result.passes {
        frame.writePNG(to: CommandLine.arguments[2])
        print("PASS Release game pixels (raw \(width)x\(height)): " + result.detail)
        exit(0)
    }
    failures.append(result.detail)
}
fail("Framebuffer does not yet contain the complete rendered title. " + failures.joined(separator: " | "))
