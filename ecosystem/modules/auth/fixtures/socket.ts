import { openWs } from '@asenajs/adapter-conformance/helpers';

export type SocketOutcome = { opened: true; protocol: string; message: any } | { opened: false };

export interface SocketInit {
  headers?: Record<string, string>;
  protocols?: string[];
}

/** Opens a socket and reports the negotiated subprotocol and the first message, or that the upgrade was refused. */
export async function connect(url: string, { headers, protocols }: SocketInit = {}): Promise<SocketOutcome> {
  let socket;

  try {
    socket = await openWs(url, { ...(headers && { headers }), ...(protocols && { protocols }) });
  } catch (error) {
    if (error instanceof Error && error.message.includes('closed before open')) return { opened: false };

    throw error;
  }

  await using open = socket;

  return { opened: true, protocol: open.protocol, message: await open.nextJson() };
}
