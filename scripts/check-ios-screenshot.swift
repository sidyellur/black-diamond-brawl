// A macOS-only, dependency-free check of a real simctl screenshot. This runs on
// the shipping Release app, without adding diagnostics or probes to that app.
import Foundation
import CoreGraphics
import ImageIO

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

guard CommandLine.arguments.count == 2,
      let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: CommandLine.arguments[1]) as CFURL, nil),
      let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: 1400
      ] as CFDictionary) else { fail("Screenshot could not be decoded") }
let width = image.width, height = image.height
guard width > height else { fail("App has not presented a landscape frame yet") }
var pixels = [UInt8](repeating: 0, count: width * height * 4)
let decoded = pixels.withUnsafeMutableBytes { buffer -> Bool in
    guard let context = CGContext(data: buffer.baseAddress, width: width, height: height,
        bitsPerComponent: 8, bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
    context.draw(image, in: CGRect(x: 0, y: 0, width: CGFloat(width), height: CGFloat(height)))
    return true
}
guard decoded else { fail("Screenshot pixels could not be decoded") }
var colors = Set<Int>()
var lightest = 0, darkest = 255, amber = 0, bright = 0, nonDark = 0, samples = 0
// Interior samples avoid the Dynamic Island, home bar and device bezel. The
// title art must have amber branding, bright snow/text and varied rendered art;
// a process that stays alive on the dark launch screen cannot pass this check.
for gy in 2..<29 {
    for gx in 8..<49 {
        let x = width * gx / 56, y = height * gy / 32
        let offset = (y * width + x) * 4
        let r = Int(pixels[offset]), g = Int(pixels[offset + 1]), b = Int(pixels[offset + 2])
        colors.insert((r / 16) * 256 + (g / 16) * 16 + b / 16)
        let luminance = (r * 21 + g * 72 + b * 7) / 100
        lightest = max(lightest, luminance); darkest = min(darkest, luminance)
        if r > 180 && g > 90 && g < 210 && b < 100 { amber += 1 }
        if r > 170 && g > 170 && b > 160 { bright += 1 }
        if luminance > 50 { nonDark += 1 }
        samples += 1
    }
}
let metrics = "colors=\(colors.count), contrast=\(lightest - darkest), amber=\(amber), bright=\(bright), nonDark=\(nonDark)/\(samples)"
guard colors.count > 20, lightest - darkest > 100,
      amber > 10, bright > 20, nonDark > samples / 5 else {
    fail("Landscape image does not yet contain the rendered game title: " + metrics)
}
print("PASS Release game pixels: " + metrics)
