import Darwin
import Foundation

@main
private enum WindowNumberMatcherTests {
    private static func expectEqual(_ actual: Int?, _ expected: Int?, _ name: String) {
        guard actual == expected else {
            FileHandle.standardError.write(Data("FAIL \(name): expected \(String(describing: expected)), got \(String(describing: actual))\n".utf8))
            Darwin.exit(1)
        }
    }

    static func main() {
        expectEqual(
            matchedWindowNumber(
                candidates: [WindowNumberCandidate(number: 101, title: "WindowServer title")],
                observedTitle: "Different accessibility title"
            ),
            101,
            "unique owner-frame candidate ignores title mismatch"
        )

        expectEqual(
            matchedWindowNumber(
                candidates: [
                    WindowNumberCandidate(number: 201, title: "备忘录"),
                    WindowNumberCandidate(number: 202, title: "Preferences"),
                ],
                observedTitle: "备忘录 – 5个备忘录"
            ),
            201,
            "multiple candidates select one non-empty prefix"
        )

        expectEqual(
            matchedWindowNumber(
                candidates: [
                    WindowNumberCandidate(number: 301, title: ""),
                    WindowNumberCandidate(number: 302, title: "备忘录"),
                ],
                observedTitle: "备忘录 – 5个备忘录"
            ),
            302,
            "empty candidate title does not participate"
        )

        expectEqual(
            matchedWindowNumber(
                candidates: [
                    WindowNumberCandidate(number: 401, title: "备忘录"),
                    WindowNumberCandidate(number: 402, title: "备忘录 – 5个备忘录"),
                    WindowNumberCandidate(number: 403, title: ""),
                ],
                observedTitle: "备忘录 – 5个备忘录"
            ),
            nil,
            "multiple candidates without a unique title match fail closed"
        )

        expectEqual(
            matchedWindowNumber(
                candidates: [
                    WindowNumberCandidate(number: 501, title: "Document"),
                    WindowNumberCandidate(number: 502, title: "Preferences"),
                ],
                observedTitle: "Doc"
            ),
            nil,
            "plain lexical prefix is not window identity evidence"
        )

        let frame = CGRect(x: 40, y: 60, width: 500, height: 350)
        let sameFrameWindows = [
            WindowNumberCandidate(number: 601, title: "Document", frame: frame),
            WindowNumberCandidate(number: 602, title: "Document", frame: frame),
        ]
        expectEqual(
            matchedWindowNumber(candidates: sameFrameWindows, observedTitle: "Document", observedFrame: frame),
            nil,
            "a screenshot cannot choose between same-size overlapping documents with the same title"
        )
        expectEqual(
            matchedWindowNumber(candidates: sameFrameWindows, observedTitle: "Document", observedFrame: frame, observedNumber: 602),
            602,
            "the observed id disambiguates overlapping documents"
        )
        let moved = WindowNumberCandidate(number: 602, title: "Document", frame: frame.offsetBy(dx: 20, dy: 0))
        expectEqual(
            matchedWindowNumber(candidates: [sameFrameWindows[0], moved], observedTitle: "Document", observedFrame: frame, observedNumber: 602),
            nil,
            "a stale screenshot id-frame pair cannot fall back to another document at the old frame"
        )
        let resized = WindowNumberCandidate(number: 602, title: "Document", frame: frame.insetBy(dx: 0, dy: 5))
        expectEqual(
            matchedWindowNumber(candidates: [resized], observedTitle: "Document", observedFrame: frame, observedNumber: 602),
            nil,
            "a resized window cannot provide pixels for the observed geometry"
        )
        let near = WindowNumberCandidate(number: 603, title: "Another title", frame: frame.offsetBy(dx: 1, dy: -1))
        expectEqual(
            matchedWindowNumber(candidates: [moved, near], observedTitle: "Document", observedFrame: frame),
            603,
            "a single owner-frame match allows the existing point tolerance and title differences"
        )

        print("PASS WindowNumberMatcherTests")
    }
}
