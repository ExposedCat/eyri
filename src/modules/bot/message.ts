// Each rendered line contains complete HTML elements. Keep lines intact so
// chunking cannot split links, custom emoji, or bucket command shortcuts.
export function splitMessageLines(text: string, limit = 3500) {
  const chunks: string[] = [];
  let chunk = "";
  for (const line of text.split("\n")) {
    if (line.length > limit) {
      throw new Error("A message line is too long to send");
    }
    if (chunk.length + line.length + 1 > limit) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += `${chunk ? "\n" : ""}${line}`;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}
