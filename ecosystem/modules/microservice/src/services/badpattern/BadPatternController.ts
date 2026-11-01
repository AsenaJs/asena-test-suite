import { MessageController } from '@asenajs/asena/decorators';
import { MessagePattern } from '@asenajs/asena/microservice';

/**
 * C11 fixture - NEVER part of the real app. Empty prefix + empty pattern
 * produce an empty FINAL pattern, which the decorator cannot see; boot must
 * fail loudly at transport registration, not start a silently broken service.
 */
@MessageController('')
export class BadPatternController {
  @MessagePattern('')
  public async bad() {
    return null;
  }
}
