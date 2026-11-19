import CoreGraphics

struct WindowNumberCandidate {
    let number: Int?
    let title: String?
    let frame: CGRect?

    init(number: Int?, title: String?, frame: CGRect? = nil) {
        self.number = number
        self.title = title
        self.frame = frame
    }
}

private func titlesMatch(_ observed: String, _ candidate: String) -> Bool {
    if observed == candidate { return true }
    let (shorter, longer) = observed.count < candidate.count
        ? (observed, candidate)
        : (candidate, observed)
    guard longer.hasPrefix(shorter), let boundary = longer.dropFirst(shorter.count).first else { return false }
    return boundary.isWhitespace || "-–—:|([{·".contains(boundary)
}

func matchedWindowNumber(
    candidates: [WindowNumberCandidate],
    observedTitle: String?,
    observedFrame: CGRect? = nil,
    observedNumber: Int? = nil
) -> Int? {
    let matches = candidates.filter { candidate in
        if let observedNumber, candidate.number != observedNumber { return false }
        guard let observedFrame else { return true }
        guard let frame = candidate.frame else { return false }
        let tolerance: CGFloat = 2
        return abs(frame.minX - observedFrame.minX) <= tolerance
            && abs(frame.minY - observedFrame.minY) <= tolerance
            && abs(frame.width - observedFrame.width) <= tolerance
            && abs(frame.height - observedFrame.height) <= tolerance
    }
    if matches.count == 1 {
        return matches[0].number
    }
    guard let observedTitle, !observedTitle.isEmpty else { return nil }
    let titled = matches.filter { candidate in
        guard let candidateTitle = candidate.title, !candidateTitle.isEmpty else { return false }
        return titlesMatch(observedTitle, candidateTitle)
    }
    guard titled.count == 1 else { return nil }
    return titled[0].number
}
