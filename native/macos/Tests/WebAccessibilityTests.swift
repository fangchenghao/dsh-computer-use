import ApplicationServices
import Darwin
import Foundation

@main
private enum WebAccessibilityTests {
    static func main() {
        func check(
            _ name: String, _ capability: AXError, settable: Bool, exposed: Bool, enabled: Bool,
            poll: Bool, calls expectedCalls: [String]
        ) {
            var calls: [String] = []
            let actual = shouldPollForWebArea(
                capability: capability, settable: settable,
                webAreaIsExposed: {
                    calls.append("tree")
                    return exposed
                },
                enable: {
                    calls.append("setter")
                    return enabled
                }
            )
            guard actual == poll, calls == expectedCalls else {
                FileHandle.standardError.write(Data("FAIL \(name): poll=\(actual), calls=\(calls)\n".utf8))
                Darwin.exit(1)
            }
        }

        check("unsupported AppKit control", .attributeUnsupported, settable: false, exposed: false, enabled: false,
              poll: false, calls: ["setter"])
        check("explicitly non-writable", .success, settable: false, exposed: false, enabled: false,
              poll: false, calls: ["setter"])
        check("unadvertised setter with exposed document", .success, settable: false, exposed: true, enabled: true,
              poll: false, calls: ["setter", "tree"])
        check("unadvertised setter with pending document", .attributeUnsupported, settable: false, exposed: false, enabled: true,
              poll: true, calls: ["setter", "tree"])
        check("exposed Electron document", .success, settable: true, exposed: true, enabled: true,
              poll: false, calls: ["tree"])
        check("Electron document enabling", .success, settable: true, exposed: false, enabled: true,
              poll: true, calls: ["tree", "setter"])
        check("inconclusive capability query", .cannotComplete, settable: false, exposed: true, enabled: false,
              poll: false, calls: ["tree"])
        check("legacy setter reports an error", .success, settable: true, exposed: false, enabled: false,
              poll: false, calls: ["tree", "setter"])
        print("PASS WebAccessibilityTests")
    }
}
