export interface RawResponse {
  status: number;
  body: string;
}

export async function rawExchange(port: number, head: string[], body = ''): Promise<RawResponse> {
  const chunks: Uint8Array[] = [];

  await new Promise<void>((resolve, reject) => {
    Bun.connect({
      hostname: '127.0.0.1',
      port,
      socket: {
        open(socket) {
          socket.write(`${[...head, 'Host: localhost', 'Connection: close'].join('\r\n')}\r\n\r\n${body}`);
        },
        data(_socket, data) {
          chunks.push(data);
        },
        close() {
          resolve();
        },
        error(_socket, error) {
          reject(error);
        },
      },
    }).catch(reject);
  });

  const raw = Buffer.concat(chunks).toString();
  const split = raw.indexOf('\r\n\r\n');
  const statusLine = split === -1 ? raw : raw.slice(0, split);

  return { status: Number(statusLine.split(' ')[1]), body: split === -1 ? '' : raw.slice(split + 4) };
}
