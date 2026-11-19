import { describe, expect, it } from 'vitest'
import { diffElements } from '../src/diff.ts'
import { ComputerTargetHandle, type ComputerElement } from '../src/types.ts'

function element(index: number, overrides: Partial<ComputerElement> = {}): ComputerElement {
  return { index, targetHandle: ComputerTargetHandle(String(index)), role: 'AXButton', title: 'Apply', actions: ['AXPress'], ...overrides }
}

describe('Accessibility diff projection', () => {
  it('reports removed, added, and changed current rows with current indexes', () => {
    const previous = [
      element(2, { title: 'Removed' }),
      element(3, { title: 'Changed', value: 'before' }),
    ]
    const current = [
      element(7, { title: 'Changed', value: 'after' }),
      element(8, { title: 'Added' }),
    ]
    expect(diffElements(previous, current, 4096)).toBe([
      '- AXButton "Removed"',
      '~ [7] AXButton "Changed" value="after"',
      '+ [8] AXButton "Added"',
    ].join('\n'))
  })

  it('returns a stable empty marker and truncates by UTF-8 bytes', () => {
    const rows = [element(0, { title: '同一个控件' })]
    expect(diffElements(rows, rows, 1024)).toBe('(no accessibility changes)')
    for (let limit = 0; limit <= 80; limit++) {
      const diff = diffElements([], [element(1, { title: '按钮🖱️'.repeat(20) })], limit)
      expect(Buffer.byteLength(diff)).toBeLessThanOrEqual(limit)
      expect(diff).not.toContain('\uFFFD')
      if (limit >= 20) expect(diff).toContain('diff truncated')
    }
  })

  it('keeps repeated controls when one changes, appears or disappears', () => {
    const previous = [element(0), element(1)]
    expect(diffElements(previous, [element(0, { selected: true }), element(1)], 1024))
      .toBe('~ [0] AXButton "Apply" selected')
    expect(diffElements(previous, [element(0)], 1024)).toBe('- AXButton "Apply"')
    expect(diffElements([element(0)], previous, 1024)).toBe('+ [1] AXButton "Apply"')
  })

  it('reports new indexes and keeps field boundaries when labels contain pipes', () => {
    expect(diffElements([element(0)], [element(2)], 1024)).toBe('~ [2] AXButton "Apply"')
    const before = [element(0, { title: 'A|B', label: 'C' })]
    const after = [element(0, { title: 'A', label: 'B|C' })]
    expect(diffElements(before, after, 1024)).toBe('- AXButton "A|B"\n+ [0] AXButton "A"')
  })
})
