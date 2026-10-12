// The /agent-text table, shared by Pi (index.ts) and this mod (register.tsx).
// No imports: a hooks module runs without Node, and Pi loads this file directly.

export type TableAgent = {
  id: string
  cwd: string
  model?: string
  kind?: string
  status: string
}

const HEADERS = ['Kind', 'Status', 'ID', 'Model', 'Directory']
// Columns that give up width when the table is too wide (Model, Directory), widest first.
const SHRINK = [3, 4]
const DIRECTORY = 4
const MIN_WIDTH = 8

// Agent names come from peers: no control, line-separator or bidi characters reach the screen.
function clean(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ')
}

function charWidth(char: string): number {
  if (/\p{Mn}|\p{Me}|\u200b|\u200d|\ufe0f/u.test(char)) return 0
  return /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]/u.test(char) ? 2 : 1
}

export function textWidth(text: string): number {
  let width = 0
  for (const char of text) width += charWidth(char)
  return width
}

// Pads to exactly `width` cells; a longer text loses its end, or its start for paths.
function fit(text: string, width: number, keepEnd = false): string {
  if (textWidth(text) > width) {
    const chars = [...text]
    if (keepEnd) chars.reverse()
    let kept = ''
    let used = 1
    for (const char of chars) {
      if (used + charWidth(char) > width) break
      kept = keepEnd ? char + kept : kept + char
      used += charWidth(char)
    }
    text = keepEnd ? `…${kept}` : `${kept}…`
  }
  return text + ' '.repeat(Math.max(0, width - textWidth(text)))
}

// Self first is the caller's order; `self` only marks its kind. `width` is the room in cells.
export function agentTable(agents: TableAgent[], self: string, home: string | undefined, width: number): string[] {
  home = home?.replace(/\/+$/, '')
  const rows = agents.map(agent => {
    const cwd = home && (agent.cwd === home || agent.cwd.startsWith(`${home}/`)) ? `~${agent.cwd.slice(home.length)}` : agent.cwd
    return [
      `${agent.kind ?? 'pi'}${agent.id === self ? ' (you)' : ''}`,
      agent.status,
      agent.id,
      agent.model ?? 'model unknown',
      cwd,
    ].map(clean)
  })
  const widths = HEADERS.map((header, column) => Math.max(textWidth(header), ...rows.map(row => textWidth(row[column] ?? ''))))
  const spare = (column: number) => (widths[column] ?? 0) - Math.max(MIN_WIDTH, textWidth(HEADERS[column] ?? ''))
  // Each column takes its width plus a space either side and one border.
  let excess = widths.reduce((sum, columnWidth) => sum + columnWidth + 3, 1) - width
  while (excess > 0) {
    // One cell at a time from the widest column that can still give one up.
    const column = SHRINK.filter(index => spare(index) > 0).sort((a, b) => (widths[b] ?? 0) - (widths[a] ?? 0))[0]
    if (column === undefined) break
    widths[column] = (widths[column] ?? 0) - 1
    excess--
  }
  const rule = (left: string, middle: string, right: string) => left + widths.map(columnWidth => '─'.repeat(columnWidth + 2)).join(middle) + right
  const line = (cells: string[]) => `│${cells.map((cell, column) => ` ${fit(cell, widths[column] ?? 0, column === DIRECTORY)} `).join('│')}│`
  const separator = rule('├', '┼', '┤')
  return [rule('╭', '┬', '╮'), line(HEADERS), ...rows.flatMap(row => [separator, line(row)]), rule('╰', '┴', '╯')]
}
