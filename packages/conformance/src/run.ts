import { register as registerBuiltins } from './areas/builtins/scenarios.ts';
import { register as registerContext } from './areas/context/scenarios.ts';
import { register as registerErrors } from './areas/errors/scenarios.ts';
import { register as registerHarness } from './areas/harness/scenarios.ts';
import { register as registerLifecycle } from './areas/lifecycle/scenarios.ts';
import { register as registerMiddleware } from './areas/middleware/scenarios.ts';
import { register as registerResolution } from './areas/resolution/scenarios.ts';
import { register as registerRouting } from './areas/routing/scenarios.ts';
import { register as registerSmoke } from './areas/smoke/scenarios.ts';
import { register as registerStatic } from './areas/static/scenarios.ts';
import { register as registerStreaming } from './areas/streaming/scenarios.ts';
import { register as registerValidation } from './areas/validation/scenarios.ts';
import { register as registerWebsocket } from './areas/websocket/scenarios.ts';
import type { AdapterDescriptor } from './descriptor.ts';
import { setDescriptor } from './load.ts';

export function runConformance(descriptor: AdapterDescriptor): void {
  setDescriptor(descriptor);

  registerResolution();
  registerSmoke();
  registerRouting();
  registerErrors();
  registerContext();
  registerMiddleware();
  registerValidation();
  registerStreaming();
  registerStatic();
  registerWebsocket();
  registerLifecycle();
  registerHarness();
  registerBuiltins();
}
