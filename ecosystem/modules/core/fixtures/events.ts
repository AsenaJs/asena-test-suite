import type { AsenaContext } from '@asenajs/asena/adapter';
import { Controller, EventService } from '@asenajs/asena/decorators';
import { Post } from '@asenajs/asena/decorators/http';
import { Inject } from '@asenajs/asena/decorators/ioc';
import { emitter, type EventEmitter, On } from '@asenajs/asena/event';

type Ctx = AsenaContext<any, any>;
type Component = new (...args: any[]) => unknown;

export interface EventEntry {
  event: string;
  data: unknown;
  source: string;
}

export interface EventFixture {
  components: Component[];
  log: EventEntry[];
}

export function eventFixture(): EventFixture {
  const log: EventEntry[] = [];

  @EventService('user')
  class SuiteUserEvents {
    @On('created')
    public onCreated(event: string, data: unknown) {
      log.push({ event, data, source: 'user' });
    }
  }

  abstract class AuditEventsBase {
    @On('created')
    public onCreated(event: string, data: unknown) {
      log.push({ event, data, source: 'base' });
    }
  }

  @EventService('audit')
  class SuiteAuditEvents extends AuditEventsBase {
    @On('archived')
    public onArchived(event: string, data: unknown) {
      log.push({ event, data, source: 'own' });
    }
  }

  @Controller('/events')
  class SuiteEventController {
    @Inject(emitter())
    private events!: EventEmitter;

    @Post('/emit')
    public async emit(context: Ctx) {
      const { name, data } = await context.getBody<{ name: string; data: unknown }>();

      return context.send({ matched: this.events.emit(name, data) });
    }
  }

  return { components: [SuiteUserEvents, SuiteAuditEvents, SuiteEventController], log };
}
