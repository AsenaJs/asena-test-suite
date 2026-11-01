import { UlakError, UlakErrorCode } from '@asenajs/asena/messaging';

export interface MappedError {
  status: number;
  body: { error: { code: string; message: string } };
}

/**
 * Single translation point from transport errors to HTTP semantics:
 * - TIMEOUT      -> 504 (upstream did not answer in time)
 * - REMOTE_ERROR -> 404 when the handler used the 'NOT_FOUND:' message
 *                   convention (domain miss), otherwise 502 (handler crashed)
 * - SEND_FAILED  -> 502 (broker publish failed / no in-memory handler)
 * - NO_TRANSPORT / TRANSPORT_NOT_FOUND -> 503 (configuration error)
 */
export function mapUlakError(error: unknown): MappedError {
  if (error instanceof UlakError) {
    const message = error.message;

    switch (error.code) {
      case UlakErrorCode.TIMEOUT:
        return { status: 504, body: { error: { code: String(error.code), message } } };
      case UlakErrorCode.REMOTE_ERROR:
        if (message.includes('NOT_FOUND:')) {
          return { status: 404, body: { error: { code: String(error.code), message } } };
        }

        return { status: 502, body: { error: { code: String(error.code), message } } };
      case UlakErrorCode.SEND_FAILED:
        return { status: 502, body: { error: { code: String(error.code), message } } };
      case UlakErrorCode.NO_TRANSPORT:
      case UlakErrorCode.TRANSPORT_NOT_FOUND:
        return { status: 503, body: { error: { code: String(error.code), message } } };
    }
  }

  return {
    status: 500,
    body: { error: { code: 'INTERNAL', message: String((error as Error)?.message ?? error) } },
  };
}
