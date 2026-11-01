import { MessageController } from '@asenajs/asena/decorators';
import { MessagePattern } from '@asenajs/asena/microservice';

/**
 * Boot-failure fixture - NEVER part of the real app.
 *
 * Two request/response handlers under different method names resolve to the same final
 * pattern once the subclass's prefix is applied. Events are exempt (several subscribers on one
 * pattern is fan-out), but request/response has no way to decide which handler produces the
 * reply, so boot must fail loudly instead of letting one of them win at random.
 */
abstract class DuplicatePatternControllerBase {
  @MessagePattern('report')
  public async baseReport() {
    return { from: 'base' };
  }
}

@MessageController('dup')
export class DuplicatePatternController extends DuplicatePatternControllerBase {
  @MessagePattern('report')
  public async subReport() {
    return { from: 'sub' };
  }
}
