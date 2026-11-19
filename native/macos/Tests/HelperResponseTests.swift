import Foundation

@main
private enum HelperResponseTests {
    static func main() throws {
        func observation(_ elements: [[String: Any]], _ text: String, truncated: Bool = false) -> [String: Any] {
            ["elements": elements, "treeText": text, "truncated": truncated, "stateHash": "full-state",
             "window": ["id": 42], "screenshot": ["path": "/tmp/fixture.png"], "permissions": ["accessibility": "granted"]]
        }
        func envelope(_ observation: [String: Any], nested: Bool = false) -> [String: Any] {
            let value = nested ? ["observation": observation, "activation": "activated"] : observation
            return ["ok": true, "value": value]
        }
        func json(_ value: [String: Any]) throws -> Data {
            try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        }

        let name = "汉字/\"\\💻e\u{301}"
        let rows: [[String: Any]] = (0..<5).map { ["index": $0, "title": name, "locator": [$0]] }
        let firstLine = "  [1] AXRow \(name)"
        let secondLine = "  [3] AXRow \(name)"
        let text = firstLine + "\n" + secondLine
        for nested in [false, true] {
            let payload = envelope(observation(rows, text), nested: nested)
            let original = try json(payload)
            let atLimit = try encodeHelperResponse(payload, frameLimit: original.count + 1)
            precondition(atLimit == original, "an envelope exactly at the limit, including its newline, must be unchanged")

            for (count, expectedText) in [(0, ""), (2, firstLine), (4, text)] {
                let expected = try json(envelope(observation(Array(rows.prefix(count)), expectedText, truncated: true), nested: nested))
                let trimmed = try encodeHelperResponse(payload, frameLimit: expected.count + 1)
                precondition(trimmed == expected, "retain exactly the fitting nodes and their rendered lines, including skipped indices")
            }
        }

        let directLimit = try json(envelope(observation(rows, text))).count + 1
        let nestedOutput = try encodeHelperResponse(envelope(observation(rows, text), nested: true), frameLimit: directLimit)
        precondition(nestedOutput.count + 1 <= directLimit, "the activation wrapper also consumes bytes")

        let title = String(repeating: "界", count: 180)
        let manyRows: [[String: Any]] = (0..<5_000).map { ["index": $0, "role": "AXRow", "title": title, "label": title] }
        let large = envelope(observation(manyRows, "[0] AXRow first\n[4999] AXRow last"))
        let trimmed = try encodeHelperResponse(large)
        precondition(trimmed.count + 1 <= 4 * 1024 * 1024)
        let decoded = try JSONSerialization.jsonObject(with: trimmed) as! [String: Any]
        let value = decoded["value"] as! [String: Any]
        let kept = value["elements"] as! [[String: Any]]
        precondition(!kept.isEmpty && kept.count < manyRows.count && kept.last?["index"] as? Int == kept.count - 1)
        precondition(value["treeText"] as? String == "[0] AXRow first" && value["truncated"] as? Bool == true)
        precondition(value["stateHash"] as? String == "full-state" && (value["window"] as? [String: Int])?["id"] == 42)
        precondition((value["screenshot"] as? [String: String])?["path"] == "/tmp/fixture.png")

        do {
            _ = try encodeHelperResponse(large, frameLimit: 50)
            preconditionFailure("metadata alone exceeds the limit")
        } catch HelperResponseError.protocolLimit {}
        print("PASS HelperResponseTests")
    }
}
