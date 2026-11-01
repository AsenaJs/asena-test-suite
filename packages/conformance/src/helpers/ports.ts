export function randomPort(): number {
  return 10000 + Math.floor(Math.random() * 22000);
}

export async function isPortFree(port: number, hostname = '0.0.0.0'): Promise<boolean> {
  let listener: Bun.TCPSocketListener | undefined;

  try {
    listener = Bun.listen({ hostname, port, socket: { data() {} } });

    return true;
  } catch {
    return false;
  } finally {
    listener?.stop(true);
  }
}
