export interface RawResponse {
  status: number | undefined;
  head: string;
  closedWithoutResponse: boolean;
}

export async function rawRequest(port: number, requestLine: string, timeoutMs = 3000): Promise<RawResponse> {
  const chunks: Uint8Array[] = [];
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const socket = await Bun.connect({
    hostname: '127.0.0.1',
    port,
    socket: {
      data(_socket, data) {
        chunks.push(data);

        if (Buffer.concat(chunks).includes('\r\n\r\n')) resolveDone();
      },
      close() {
        resolveDone();
      },
      error() {
        resolveDone();
      },
    },
  });

  socket.write(`${requestLine}\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);

  const timer = setTimeout(resolveDone, timeoutMs);

  await done;
  clearTimeout(timer);
  socket.end();

  const text = Buffer.concat(chunks).toString('latin1');
  const head = text.split('\r\n\r\n')[0] ?? '';
  const match = /^HTTP\/1\.[01] (\d{3})/.exec(head);

  return { status: match ? Number(match[1]) : undefined, head, closedWithoutResponse: chunks.length === 0 };
}
