// SSE chunks can split anywhere, including inside UTF-8 characters and event lines.
export async function* responseText(body: ReadableStream<Uint8Array>) {
  let buffer = '';
  let data: string[] = [];
  let completed = false;
  const decoder = new TextDecoder();
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end).replace(/\r$/, '');
      buffer = buffer.slice(end + 1);
      if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      if (line !== '' || !data.length) continue;
      const raw = data.join('\n');
      data = [];
      if (raw === '[DONE]') continue;
      const event = JSON.parse(raw);
      if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') yield event.delta as string;
      if (event.type === 'response.refusal.delta' && typeof event.delta === 'string') yield event.delta as string;
      if (event.type === 'response.completed') completed = true;
      if (['error', 'response.failed', 'response.incomplete'].includes(event.type)) throw new Error('The response could not be completed. Check your plan usage or try again.');
    }
  }
  if (!completed) throw new Error('The response stream ended before completion. Please try again.');
}
