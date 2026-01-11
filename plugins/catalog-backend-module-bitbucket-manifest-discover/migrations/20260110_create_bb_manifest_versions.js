/**
 * Migration: Create bb_manifest_versions table
 *
 * Tracks the last seen version for each repository in the manifest
 * to detect when catalog-info.yaml should be re-fetched.
 */

exports.up = async function up(knex) {
  await knex.schema.createTable('bb_manifest_versions', table => {
    table
      .text('repo_key')
      .primary()
      .notNullable()
      .comment('Stable identifier: workspace/repoSlug');
    table
      .text('manifest_version')
      .notNullable()
      .comment('Version from manifest spec');
    table
      .timestamp('last_seen_at')
      .notNullable()
      .defaultTo(knex.fn.now())
      .comment('When this version was last seen in manifest');
    table
      .timestamp('last_registered_at')
      .nullable()
      .comment('When we last published this location to catalog');
    table.index(['last_seen_at'], 'idx_bb_manifest_versions_last_seen');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTable('bb_manifest_versions');
};
