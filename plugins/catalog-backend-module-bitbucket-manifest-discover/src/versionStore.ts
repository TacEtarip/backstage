import { LoggerService } from '@backstage/backend-plugin-api';
import { Knex } from 'knex';

export interface VersionRecord {
  repoKey: string;
  manifestVersion: string;
  lastSeenAt: Date;
  lastRegisteredAt: Date | null;
}

/**
 * Store for tracking manifest versions in Postgres
 */
export class VersionStore {
  constructor(
    private readonly db: Knex,
    private readonly logger: LoggerService,
  ) {}

  /**
   * Get the stored version record for a repository
   */
  async get(repoKey: string): Promise<VersionRecord | null> {
    const row = await this.db('bb_manifest_versions')
      .where({ repo_key: repoKey })
      .first();

    if (!row) {
      return null;
    }

    return {
      repoKey: row.repo_key,
      manifestVersion: row.manifest_version,
      lastSeenAt: new Date(row.last_seen_at),
      lastRegisteredAt: row.last_registered_at
        ? new Date(row.last_registered_at)
        : null,
    };
  }

  /**
   * Update the last seen version for a repository
   */
  async upsertSeen(repoKey: string, version: string): Promise<void> {
    await this.db('bb_manifest_versions')
      .insert({
        repo_key: repoKey,
        manifest_version: version,
        last_seen_at: this.db.fn.now(),
        last_registered_at: null,
      })
      .onConflict('repo_key')
      .merge({
        manifest_version: version,
        last_seen_at: this.db.fn.now(),
      });

    this.logger.debug(`Updated version for ${repoKey} to ${version}`);
  }

  /**
   * Mark a repository as registered (location published to catalog)
   */
  async markRegistered(repoKey: string): Promise<void> {
    await this.db('bb_manifest_versions').where({ repo_key: repoKey }).update({
      last_registered_at: this.db.fn.now(),
    });

    this.logger.debug(`Marked ${repoKey} as registered`);
  }

  /**
   * Run database migrations
   */
  async runMigrations(): Promise<void> {
    this.logger.info('Running Bitbucket Manifest Discover migrations...');

    await this.db.migrate.latest({
      directory: require('node:path').resolve(__dirname, '../migrations'),
      tableName: 'knex_migrations_bitbucket_manifest',
    });

    this.logger.info('Migrations completed successfully');
  }
}
