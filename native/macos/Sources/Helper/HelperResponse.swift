import Foundation

enum HelperResponseError: Error {
    case protocolLimit
}

/// The subprocess collector's limit includes the newline written after the JSON envelope.
func encodeHelperResponse(_ payload: [String: Any], frameLimit: Int = 4 * 1024 * 1024) throws -> Data {
    let full = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
    guard full.count >= frameLimit else { return full }
    guard let value = payload["value"] as? [String: Any] else { throw HelperResponseError.protocolLimit }
    let nested = value["observation"] as? [String: Any]
    let observation = nested ?? value
    guard let elements = observation["elements"] as? [[String: Any]],
          let tree = observation["treeText"] as? String else { throw HelperResponseError.protocolLimit }

    func encodePrefix(_ count: Int, textEnd: String.Index) throws -> Data {
        var trimmed = observation
        trimmed["elements"] = Array(elements.prefix(count))
        trimmed["treeText"] = String(tree[..<textEnd])
        trimmed["truncated"] = true
        var envelope = payload
        if nested == nil {
            envelope["value"] = trimmed
        } else {
            var activation = value
            activation["observation"] = trimmed
            envelope["value"] = activation
        }
        return try JSONSerialization.data(withJSONObject: envelope, options: [.sortedKeys])
    }

    var count = 0
    var textEnd = tree.startIndex
    let empty = try encodePrefix(0, textEnd: textEnd)
    var bytes = empty.count
    guard bytes < frameLimit else { throw HelperResponseError.protocolLimit }
    var lines = tree.split(separator: "\n")[...]
    for element in elements {
        // The text budget may have omitted a long line before a later, shorter one.
        let line = lines.first.flatMap { $0.drop(while: { $0 == " " }).hasPrefix("[\(count)] ") ? $0 : nil }
        var added = try JSONSerialization.data(withJSONObject: element).count + (count == 0 ? 0 : 1)
        if let line {
            // Exclude the JSON string's surrounding quotes. A newline inside JSON occupies two bytes.
            let string = try JSONSerialization.data(withJSONObject: String(line), options: [.fragmentsAllowed])
            added += string.count - 2 + (textEnd == tree.startIndex ? 0 : 2)
        }
        guard bytes + added < frameLimit else { break }
        bytes += added
        count += 1
        if let line {
            textEnd = line.endIndex
            lines = lines.dropFirst()
        }
    }
    if count == 0 { return empty }
    let result = try encodePrefix(count, textEnd: textEnd)
    guard result.count < frameLimit else { throw HelperResponseError.protocolLimit }
    return result
}
