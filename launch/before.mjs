import {createController} from '../core/controller.mjs';
export default async context => {
  await createController({codexHome: context.codexHome, config: context.config}).resume();
};
