/** Accessibility-tree diff projection for model-context efficiency. */

import type { ComputerElement } from './types.ts'

function identity(element: ComputerElement): string {
  const frame = element.frame === undefined
    ? ''
    : `${Math.round(element.frame.x)},${Math.round(element.frame.y)},${Math.round(element.frame.width)},${Math.round(element.frame.height)}`
  return JSON.stringify([element.role, element.subrole, element.title, element.label, frame])
}

function summary(element: ComputerElement, includeIndex: boolean): string {
  const parts = [includeIndex ? `[${element.index}]` : undefined, element.role]
  if (element.title !== undefined) parts.push(JSON.stringify(element.title))
  else if (element.label !== undefined) parts.push(JSON.stringify(element.label))
  if (element.value !== undefined) parts.push(`value=${JSON.stringify(element.value)}`)
  if (element.enabled === false) parts.push('disabled')
  if (element.focused === true) parts.push('focused')
  if (element.selected === true) parts.push('selected')
  return parts.filter((part): part is string => part !== undefined).join(' ')
}

function sameState(left: ComputerElement, right: ComputerElement): boolean {
  return left.index === right.index && left.value === right.value
    && left.enabled === right.enabled && left.focused === right.focused && left.selected === right.selected
    && left.actions.length === right.actions.length && left.actions.every((action, index) => action === right.actions[index])
}

function* changeLines(previous: readonly ComputerElement[], current: readonly ComputerElement[]): Generator<string> {
  // Several anonymous controls can have the same role, label and frame. Pair
  // occurrences in tree order, retaining every row and its observation-local index.
  const positions = new Map<string, number[]>()
  for (let i = previous.length - 1; i >= 0; i--) {
    const key = identity(previous[i]!)
    const group = positions.get(key)
    if (group === undefined) positions.set(key, [i])
    else group.push(i)
  }
  const matched = new Uint8Array(previous.length)
  const oldPositions = current.map(element => {
    const position = positions.get(identity(element))?.pop()
    if (position !== undefined) matched[position] = 1
    return position
  })
  for (const [i, element] of previous.entries()) {
    if (!matched[i]) yield `- ${summary(element, false)}`
  }
  for (const [i, element] of current.entries()) {
    const old = oldPositions[i]
    if (old === undefined) yield `+ ${summary(element, true)}`
    else if (!sameState(previous[old]!, element)) yield `~ ${summary(element, true)}`
  }
}

function utf8Prefix(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text)
  let end = Math.min(bytes.length, Math.max(0, maxBytes))
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--
  return bytes.toString('utf8', 0, end)
}

/** Render only as many diff rows as fit in the model's UTF-8 text budget. */
export function projectElementDiff(previous: readonly ComputerElement[], current: readonly ComputerElement[], maxBytes: number) {
  const lines: string[] = []
  let bytes = 0
  for (const line of changeLines(previous, current)) {
    bytes += Buffer.byteLength(line) + (lines.length === 0 ? 0 : 1)
    lines.push(line)
    if (bytes > maxBytes) {
      const marker = '… diff truncated'
      const prefixBytes = maxBytes - Buffer.byteLength(marker) - 1
      const text = prefixBytes <= 0
        ? utf8Prefix(marker, maxBytes)
        : `${utf8Prefix(lines.join('\n'), prefixBytes)}\n${marker}`
      return { text, truncated: true }
    }
  }
  if (lines.length > 0) return { text: lines.join('\n'), truncated: false }
  const empty = '(no accessibility changes)'
  return { text: empty.slice(0, Math.max(0, maxBytes)), truncated: empty.length > maxBytes }
}

/** Return the text projection for callers that only consume the rendered diff. */
export function diffElements(previous: readonly ComputerElement[], current: readonly ComputerElement[], maxBytes: number): string {
  return projectElementDiff(previous, current, maxBytes).text
}
