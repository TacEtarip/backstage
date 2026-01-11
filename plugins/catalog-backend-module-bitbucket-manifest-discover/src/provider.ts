import { LoggerService, SchedulerService } from '@backstage/backend-plugin-api';
import { LocationEntity } from '@backstage/catalog-model';
import { Config } from '@backstage/config';
import { ScmIntegrations } from '@backstage/integration';
import {
  EntityProvider,
  EntityProviderConnection,
} from '@backstage/plugin-catalog-node';
import { Knex } from 'knex';
import fetch from 'node-fetch';
import * as yaml from 'yaml';
import { VersionStore } from './versionStore';

interface BitbucketManifestRepo {
  id: string;
  workspace: string;
  repoSlug: string;
  version: string;
}

interface BitbucketManifest {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
  };
  spec: {
    repositories: BitbucketManifestRepo[];
  };
}

interface ProviderConfig {
  manifestUrl: string;
  defaultBranch: string;
  defaultCatalogInfoPath: string;
  schedule: {
    frequency: { hours?: number; minutes?: number };
    timeout: { minutes?: number };
  };
}

/**
 * Provider that discovers catalog locations from a Bitbucket manifest file
 */
export class BitbucketManifestDiscoverEntityProvider implements EntityProvider {
  private readonly config: ProviderConfig;
  private readonly integrations: ScmIntegrations;
  private readonly logger: LoggerService;
  private readonly scheduler: SchedulerService;
  private readonly versionStore: VersionStore;
  private connection?: EntityProviderConnection;

  static create(options: {
    config: Config;
    logger: LoggerService;
    scheduler: SchedulerService;
    database: Knex;
  }): BitbucketManifestDiscoverEntityProvider {
    const providerConfig = options.config.getConfig(
      'catalog.providers.bitbucketManifestDiscover',
    );

    const config: ProviderConfig = {
      manifestUrl: providerConfig.getString('manifestUrl'),
      defaultBranch:
        providerConfig.getOptionalString('defaultBranch') || 'main',
      defaultCatalogInfoPath:
        providerConfig.getOptionalString('defaultCatalogInfoPath') ||
        'catalog-info.yaml',
      schedule: {
        frequency: providerConfig.getOptional('schedule.frequency') || {
          hours: 1,
        },
        timeout: providerConfig.getOptional('schedule.timeout') || {
          minutes: 5,
        },
      },
    };

    const integrations = ScmIntegrations.fromConfig(options.config);
    const versionStore = new VersionStore(options.database, options.logger);

    return new BitbucketManifestDiscoverEntityProvider(
      config,
      integrations,
      options.logger,
      options.scheduler,
      versionStore,
    );
  }

  constructor(
    config: ProviderConfig,
    integrations: ScmIntegrations,
    logger: LoggerService,
    scheduler: SchedulerService,
    versionStore: VersionStore,
  ) {
    this.config = config;
    this.integrations = integrations;
    this.logger = logger;
    this.scheduler = scheduler;
    this.versionStore = versionStore;
  }

  getProviderName(): string {
    return 'bitbucket-manifest-discover';
  }

  async connect(connection: EntityProviderConnection): Promise<void> {
    this.connection = connection;

    // Run migrations before starting
    await this.versionStore.runMigrations();

    // Schedule the discovery task
    await this.scheduler.scheduleTask({
      id: 'bitbucket-manifest-discover',
      frequency: this.config.schedule.frequency,
      timeout: this.config.schedule.timeout,
      fn: async () => {
        await this.discover();
      },
    });

    this.logger.info('Bitbucket Manifest Discover provider initialized');
  }

  /**
   * Main discovery method - fetches manifest and processes repositories
   */
  private async discover(): Promise<void> {
    if (!this.connection) {
      throw new Error('Provider not connected');
    }

    this.logger.info('Starting Bitbucket manifest discovery');

    try {
      // Fetch and parse manifest
      const manifest = await this.fetchManifest();
      this.logger.info(
        `Found ${manifest.spec.repositories.length} repositories in manifest`,
      );

      // Process each repository
      const locationsToRegister: LocationEntity[] = [];

      for (const repo of manifest.spec.repositories) {
        const result = await this.processRepository(repo);
        if (result.shouldRegister) {
          locationsToRegister.push(result.location);
        }
      }

      // Only apply changes for repos with version updates
      if (locationsToRegister.length > 0) {
        await this.connection.applyMutation({
          type: 'delta',
          added: locationsToRegister.map(location => ({
            entity: location,
            locationKey: this.getProviderName(),
          })),
          removed: [],
        });

        this.logger.info(
          `Discovery completed: ${locationsToRegister.length} locations registered/updated`,
        );
      } else {
        this.logger.info('Discovery completed: no version changes detected');
      }
    } catch (error) {
      this.logger.error(`Discovery failed: ${error}`);
      throw error;
    }
  }

  /**
   * Fetch the manifest from Bitbucket
   */
  private async fetchManifest(): Promise<BitbucketManifest> {
    this.logger.debug(`Fetching manifest from ${this.config.manifestUrl}`);

    // Get authentication from integrations
    const integration = this.integrations.bitbucketCloud.byUrl(
      this.config.manifestUrl,
    );
    if (!integration) {
      throw new Error(
        'No Bitbucket Cloud integration configured for manifest URL',
      );
    }

    const headers: Record<string, string> = {
      Accept: 'application/yaml',
    };

    // Add authentication if configured
    const credentials = integration.config;
    if (credentials.username && credentials.appPassword) {
      const auth = Buffer.from(
        `${credentials.username}:${credentials.appPassword}`,
      ).toString('base64');
      headers['Authorization'] = `Basic ${auth}`;
    }

    const response = await fetch(this.config.manifestUrl, { headers });

    if (!response.ok) {
      throw new Error(
        `Failed to fetch manifest: ${response.status} ${response.statusText}`,
      );
    }

    const content = await response.text();
    const manifest = yaml.parse(content) as BitbucketManifest;

    // Validate manifest structure
    if (!manifest.spec?.repositories) {
      throw new Error('Invalid manifest: missing spec.repositories');
    }

    return manifest;
  }

  /**
   * Process a single repository from the manifest
   */
  private async processRepository(
    repo: BitbucketManifestRepo,
  ): Promise<{ location: LocationEntity; shouldRegister: boolean }> {
    const repoKey = `${repo.workspace}/${repo.repoSlug}`;

    this.logger.debug(`Processing ${repoKey} version ${repo.version}`);

    // Check if version has changed
    const stored = await this.versionStore.get(repoKey);

    if (stored && stored.manifestVersion === repo.version) {
      this.logger.debug(
        `${repoKey} version unchanged (${repo.version}), skipping registration`,
      );

      // Return the location entity but don't register
      return {
        location: this.createLocationEntity(repo),
        shouldRegister: false,
      };
    }

    // Version changed or new repo - update store and trigger registration
    this.logger.info(
      `${repoKey} version changed: ${stored?.manifestVersion || 'new'} -> ${
        repo.version
      }`,
    );

    await this.versionStore.upsertSeen(repoKey, repo.version);
    await this.versionStore.markRegistered(repoKey);

    return {
      location: this.createLocationEntity(repo),
      shouldRegister: true,
    };
  }

  /**
   * Create a LocationEntity for a repository
   */
  private createLocationEntity(repo: BitbucketManifestRepo): LocationEntity {
    const catalogUrl = `https://bitbucket.org/${repo.workspace}/${repo.repoSlug}/raw/${this.config.defaultBranch}/${this.config.defaultCatalogInfoPath}`;

    return {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Location',
      metadata: {
        name: `bitbucket-manifest-${repo.workspace}-${repo.repoSlug}`,
        annotations: {
          'backstage.io/managed-by-location': `url:${this.config.manifestUrl}`,
          'bitbucket.org/repo-key': `${repo.workspace}/${repo.repoSlug}`,
          'bitbucket.org/manifest-version': repo.version,
        },
      },
      spec: {
        type: 'url',
        target: catalogUrl,
      },
    };
  }
}
