import {createController} from '../core/controller.mjs';
export default async context => {
  const controller = createController({codexHome: context.codexHome, config: context.config});
  await controller.stop();
};
