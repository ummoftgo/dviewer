/** A live writer may not have appended the newline that commits its last row. */
export function parseResults(text, streaming = false) {
  if (streaming) text = text.slice(0, text.lastIndexOf('\n') + 1);
  const lines = text.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line));
  const summary = lines.at(-1)?.summary ?? null;
  return { lines: summary ? lines.slice(0, -1) : lines, summary };
}
