import ApplicationServices

/// Decide whether to wait for an app to expose its web tree after requesting accessibility.
func shouldPollForWebArea(
    capability: AXError,
    settable: Bool,
    webAreaIsExposed: () -> Bool,
    enable: () -> Bool
) -> Bool {
    if capability == .attributeUnsupported || (capability == .success && !settable) {
        // Most native apps reject this switch. Try it once before walking
        // thousands of children, so an app with an unadvertised setter still works.
        guard enable() else { return false }
        return !webAreaIsExposed()
    }
    // An enabled Electron document should not receive another enable request.
    // An inconclusive capability query retains the same window-first check.
    guard !webAreaIsExposed() else { return false }
    return enable()
}
