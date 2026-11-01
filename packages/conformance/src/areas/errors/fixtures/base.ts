import { HttpException } from '@asenajs/asena/adapter';

export const BASE_FORBIDDEN_BODY = { error: 'forbidden-by-base' };

export abstract class ErrorsGuardedBase {
  protected deny(): never {
    throw new HttpException(403, BASE_FORBIDDEN_BODY);
  }
}
