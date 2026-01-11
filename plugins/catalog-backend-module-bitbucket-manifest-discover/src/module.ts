import { coreServices, createBackendModule } from '@backstage/backend-plugin-api';
import { catalogProcessingExtensionPoint } from '@backstage/plugin-catalog-node/alpha';
import { BitbucketManifestDiscoverEntityProvider } from './provider';

/**
 * Backstage module for Bitbucket manifest-based catalog discovery
 * 
 * Periodically fetches a YAML manifest from Bitbucket and registers
 * listed repositories as catalog locations. Re-registers when version changes.
 */
export const catalogModuleBitbucketManifestDiscover = createBackendModule({
  pluginId: 'catalog',
  moduleId: 'bitbucket-manifest-discover',
  register(env) {
    env.registerInit({
      deps: {
        catalog: catalogProcessingExtensionPoint,
        config: coreServices.rootConfig,
        logger: coreServices.logger,
        scheduler: coreServices.scheduler,
        database: coreServices.database,
      },
      async init({ catalog, config, logger, scheduler, database }) {
        // Get database client
        const client = await database.getClient();

        // Create and register the provider
        const provider = BitbucketManifestDiscoverEntityProvider.create({
          config,
          logger,
          scheduler,
          database: client,
        });

        catalog.addEntityProvider(provider);

        logger.info('Bitbucket Manifest Discover module registered');
      },
    });
  },
});
