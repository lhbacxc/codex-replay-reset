import {createController} from '../core/controller.mjs';
import {assertSessionIdle} from '../core/session-state.mjs';
export default ({config, sessionQuery}) => {
  const controller = createController({config});
  const assertIdle = id => assertSessionIdle({id, sessionQuery});
  return {
    status: () => controller.status(),
    initialize: async () => { await controller.resume(); return controller.status(); },
    attach: () => controller.attach(), detach: () => controller.detach(), stop: () => controller.stop(),
    arm: async args => { await assertIdle(args.sessionId); return controller.arm(args); },
    clear: async args => { await assertIdle(args.sessionId); return controller.clear(args); },
  };
};
