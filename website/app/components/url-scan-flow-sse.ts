/**
 * Minimal text/event-stream parser. Enough for our shape (event: ... \n
 * data: ... \n \n). Keep-alive comment lines (":...") are ignored. Returns
 * when the server closes the stream or the signal aborts.
 */
export async function consumeSseStream(
  res: Response,
  onEvent: (event: string, data: unknown) => void,
  signal: AbortSignal
): Promise<void> {
  if (!res.body) throw new Error("Stream response had no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "message";
  let currentData = "";
  const flush = () => {
    if (currentData) {
      try {
        const parsed = JSON.parse(currentData);
        onEvent(currentEvent, parsed);
      } catch {
        onEvent(currentEvent, currentData);
      }
    }
    currentEvent = "message";
    currentData = "";
  };
  while (true) {
    if (signal.aborted) {
      try { await reader.cancel(); } catch { /* ignore */ }
      return;
    }
    const { done, value } = await reader.read();
    if (done) {
      if (currentData) flush();
      return;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line.startsWith(":")) continue;
      if (line === "") { flush(); continue; }
      if (line.startsWith("event:")) currentEvent = line.slice(6).trim();
      else if (line.startsWith("data:")) currentData += (currentData ? "\n" : "") + line.slice(5).trim();
    }
  }
}
