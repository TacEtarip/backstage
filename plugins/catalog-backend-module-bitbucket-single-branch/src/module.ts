import { createBackendModule, coreServices } from '@backstage/backend-plugin-api';
import { catalogProcessingExtensionPoint } from '@backstage/plugin-catalog-node/alpha';
import { BitbucketSingleBranchProvider } from './provider';

export const catalogModuleBitbucketSingleBranch = createBackendModule({
  pluginId: 'catalog',
  moduleId: 'bitbucket-single-branch',
  register(env) {
    env.registerInit({
      deps: {
        catalog: catalogProcessingExtensionPoint,
        config: coreServices.rootConfig,
        logger: coreServices.logger,
        scheduler: coreServices.scheduler,
        urlReader: coreServices.urlReader,
      },
      async init({ catalog, config, logger, scheduler, urlReader }) {
        const provider = BitbucketSingleBranchProvider.fromConfig({
          config,
          logger,
          urlReader,
        });

        catalog.addEntityProvider(provider);

        const schedule = provider.getSchedule();
        scheduler.scheduleTask({
          id: schedule.id,
          frequency: schedule.frequency,
          timeout: schedule.timeout,
          fn: async () => provider.run(),
        });
      },
    });
  },
});
