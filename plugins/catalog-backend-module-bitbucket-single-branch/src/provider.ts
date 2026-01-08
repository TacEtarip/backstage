import { Config } from '@backstage/config';
import {
  EntityProvider,
  EntityProviderConnection,
} from '@backstage/plugin-catalog-node';
import { LocationEntityV1alpha1 } from '@backstage/catalog-model';
import { LoggerService, UrlReaderService } from '@backstage/backend-plugin-api';

export class BitbucketSingleBranchProvider implements EntityProvider {
  private connection?: EntityProviderConnection;

  private constructor(
    private readonly opts: {
      workspace: string;
      branch: string;
      catalogPath: string;
      logger: LoggerService;
      urlReader: UrlReaderService;
    },
  ) {}

  static fromConfig(args: {
    config: Config;
    logger: LoggerService;
    urlReader: UrlReaderService;
  }) {
    const cfg = args.config.getConfig(
      'catalog.providers.bitbucketSingleBranch',
    );

    return new BitbucketSingleBranchProvider({
      workspace: cfg.getString('workspace'),
      branch: cfg.getString('branch'),
      catalogPath: cfg.getOptionalString('catalogPath') ?? 'catalog-info.yaml',
      logger: args.logger,
      urlReader: args.urlReader,
    });
  }

  getProviderName() {
    return `bitbucket-single-branch:${this.opts.workspace}:${this.opts.branch}`;
  }

  getSchedule() {
    return {
      id: `catalog.bitbucket.singleBranch.${this.opts.branch}`,
      frequency: { minutes: 10 },
      timeout: { minutes: 2 },
    };
  }

  async connect(connection: EntityProviderConnection) {
    this.connection = connection;
  }

  async run() {
    if (!this.connection) throw new Error('Provider not connected');

    const repos = await this.listRepos();
    const locations: LocationEntityV1alpha1[] = [];

    for (const repo of repos) {
      const target = `https://bitbucket.org/${
        this.opts.workspace
      }/${repo}/raw/${encodeURIComponent(this.opts.branch)}/${
        this.opts.catalogPath
      }`;

      const locationRef = `url:${target}`;

      console.log(
        'xxxxxxxxxxxxxxxxxxxxxxxxChecking existence of:xxxxxxxxxxxxxxxxxxxx',
        target,
      );

      if (!(await this.exists(target))) continue;

      locations.push({
        apiVersion: 'backstage.io/v1alpha1',
        kind: 'Location',
        metadata: {
          name: `bb-${repo}-${this.opts.branch}`,
          annotations: {
            'backstage.io/managed-by-location': locationRef,
            'backstage.io/managed-by-origin-location': locationRef,
          },
          labels: {
            branch: this.opts.branch,
            workspace: this.opts.workspace,
            repo,
          },
        },
        spec: {
          type: 'url',
          targets: [target],
        },
      });
    }

    await this.connection.applyMutation({
      type: 'full',
      entities: locations.map(e => ({
        entity: e,
        locationKey: this.getProviderName(),
      })),
    });

    this.opts.logger.info(
      `Published ${locations.length} catalog locations for branch ${this.opts.branch}`,
    );
  }

  private async exists(url: string): Promise<boolean> {
    try {
      await this.opts.urlReader.readUrl(url);
      return true;
    } catch {
      return false;
    }
  }

  private async listRepos(): Promise<string[]> {
    const { workspace, logger } = this.opts;

    const username = process.env.BITBUCKET_USERNAME;
    const token = process.env.BITBUCKET_TOKEN;

    console.log(
      'xxxxxxxxxxxxxxxxxxxxxxxxUsing Bitbucket username:xxxxxxxxxxxxxxxxxxxx',
      username,
    );

    if (!username || !token) {
      throw new Error('BITBUCKET_USERNAME or BITBUCKET_TOKEN not set');
    }

    const auth = Buffer.from(`${username}:${token}`).toString('base64');

    let url = `https://api.bitbucket.org/2.0/repositories/${workspace}?pagelen=100`;
    const repos: string[] = [];

    while (url) {
      const res = await fetch(url, {
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: 'application/json',
        },
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Bitbucket listRepos failed (${res.status}): ${body}`);
      }

      const data: any = await res.json();

      for (const repo of data.values ?? []) {
        if (repo.slug) {
          repos.push(repo.slug);
        }
      }

      url = data.next ?? '';
    }

    logger.info(
      `BitbucketSingleBranchProvider discovered ${repos.length} repos in workspace ${workspace}`,
    );

    return repos;
  }
}
