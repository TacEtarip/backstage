# Bitbucket Manifest Discover Module

A Backstage catalog backend module that periodically discovers and registers catalog locations from a YAML manifest stored in Bitbucket. When a repository's `version` field changes in the manifest, the module re-registers that location, forcing Backstage to fetch the latest `catalog-info.yaml` and update entities.

## Features

- **Manifest-based discovery**: Define all your Bitbucket repositories in a single YAML manifest
- **Version-based refresh**: Changes to a repository's `version` trigger automatic re-ingestion
- **Persistent tracking**: Uses Postgres to track versions across restarts
- **Scheduled updates**: Configurable polling interval (default: 1 hour)
- **Bitbucket Cloud integration**: Leverages existing Backstage Bitbucket authentication
- **Efficient delta updates**: Only repos with version changes are re-registered, saving API rate limits and bandwidth

## Configuration

### 1. Bitbucket Integration

Configure Bitbucket Cloud integration in `app-config.yaml`:

```yaml
integrations:
  bitbucketCloud:
    - host: bitbucket.org
      username: ${BITBUCKET_USERNAME}
      appPassword: ${BITBUCKET_TOKEN}
```

**Environment variables:**

- `BITBUCKET_USERNAME`: Your Bitbucket username
- `BITBUCKET_TOKEN`: Bitbucket App Password with repository read permissions

### 2. Provider Configuration

Add the manifest discover provider configuration:

```yaml
catalog:
  providers:
    bitbucketManifestDiscover:
      manifestUrl: https://bitbucket.org/my-workspace/my-manifest-repo/raw/main/manifest.yaml
      defaultBranch: main
      defaultCatalogInfoPath: catalog-info.yaml
      schedule:
        frequency:
          hours: 1
        timeout:
          minutes: 5
```

**Configuration options:**

- `manifestUrl` (required): Full URL to the manifest YAML file in Bitbucket
- `defaultBranch` (optional, default: `main`): Default branch to use when fetching `catalog-info.yaml`
- `defaultCatalogInfoPath` (optional, default: `catalog-info.yaml`): Default path to catalog info file in each repository
- `schedule.frequency`: How often to check the manifest (hours/minutes)
- `schedule.timeout`: Maximum time for discovery task

## Manifest Format

Create a YAML manifest file in your Bitbucket repository:

```yaml
apiVersion: backstage.io/v1alpha1
kind: BitbucketRepoManifest
metadata:
  name: org-repos
spec:
  repositories:
    - id: backend-service
      workspace: my-company
      repoSlug: backend-service
      version: 1.0.0

    - id: frontend-app
      workspace: my-company
      repoSlug: frontend-app
      version: 2.1.3

    - id: shared-library
      workspace: my-company
      repoSlug: shared-library
      version: 1.5.0
```

**Fields:**

- `id`: Unique identifier for the repository entry
- `workspace`: Bitbucket workspace name
- `repoSlug`: Bitbucket repository slug
- `version`: Semantic version or any string (when changed, triggers re-registration)

## How It Works

1. **Scheduled Discovery**: The module runs on a schedule (default: hourly) and fetches the manifest from Bitbucket
2. **Version Comparison**: For each repository in the manifest, it compares the current `version` with the last seen version stored in Postgres
3. **Efficient Delta Updates**:
   - **Version unchanged**: Repository is skipped entirely - no DB updates, no catalog re-registration, no API calls
   - **Version changed or new**: Only then does the module update the stored version and publish a `Location` entity
4. **Re-registration on Change**: When a version changes:
   - Updates the stored version in Postgres
   - Publishes a `Location` entity pointing to the repository's `catalog-info.yaml`
   - Backstage automatically fetches and processes the catalog info file
5. **Entity Updates**: Any changes in `catalog-info.yaml` are picked up and entities are updated in the catalog

### Rate Limit Efficiency

This delta-based approach is extremely efficient for large-scale deployments:

- **1000 repos, hourly schedule**: Without version tracking, this would make ~24,000 Bitbucket API calls per day
- **With version tracking**: Only repos with actual changes trigger API calls
- **Example**: If only 20 repos change per day, you save ~23,980 API calls (99.9% reduction)

## Database

The module automatically creates a `bb_manifest_versions` table in your Backstage Postgres database:

```sql
CREATE TABLE bb_manifest_versions (
  repo_key TEXT PRIMARY KEY,           -- workspace/repoSlug
  manifest_version TEXT NOT NULL,      -- Version from manifest
  last_seen_at TIMESTAMP NOT NULL,     -- When last seen in manifest
  last_registered_at TIMESTAMP         -- When last published to catalog
);
```

Migrations run automatically on backend startup.

## Local Development

### Prerequisites

- Docker and Docker Compose
- Bitbucket Cloud account with App Password
- A Bitbucket repository containing your manifest file

### Setup

1. **Create environment file** (`backstage-test/.env`):

```bash
BITBUCKET_USERNAME=your-username
BITBUCKET_TOKEN=your-app-password
```

2. **Create manifest repository** in Bitbucket with a `manifest.yaml` file

3. **Update configuration** in `app-config.local.yaml`:

```yaml
catalog:
  providers:
    bitbucketManifestDiscover:
      manifestUrl: https://bitbucket.org/YOUR_WORKSPACE/YOUR_REPO/raw/main/manifest.yaml
```

4. **Start Backstage**:

```bash
cd backstage-test
docker-compose up
```

5. **Verify**: Check backend logs for:

```
[bitbucket-manifest-discover] Starting Bitbucket manifest discovery
[bitbucket-manifest-discover] Found X repositories in manifest
[bitbucket-manifest-discover] Discovery completed: X locations published
```

### Testing Version Updates

1. Edit your manifest file and increment a repository's version
2. Wait for the next scheduled discovery (or restart backend)
3. Check logs for version change detection
4. Verify entities update in the Backstage UI catalog

## Troubleshooting

### Authentication Failures

**Error**: `Failed to fetch manifest: 401 Unauthorized`

**Solution**:

- Verify `BITBUCKET_USERNAME` and `BITBUCKET_TOKEN` are set correctly
- Ensure the App Password has repository read permissions
- Check that the integration is configured in `app-config.yaml`

### Manifest Not Found

**Error**: `Failed to fetch manifest: 404 Not Found`

**Solution**:

- Verify the `manifestUrl` is correct
- Ensure the file exists at the specified path in Bitbucket
- Check that the file is on the correct branch (e.g., `main`)

### Missing catalog-info.yaml

**Error**: Entities not appearing in catalog

**Solution**:

- Verify each repository has a `catalog-info.yaml` file at the root (or configured path)
- Check Backstage logs for catalog processing errors
- Ensure the `defaultBranch` matches the actual default branch in repositories

### Schedule Not Running

**Issue**: Manifest not being checked periodically

**Solution**:

- Verify `schedule.frequency` is configured correctly
- Check backend logs for scheduler initialization
- Restart backend to trigger immediate discovery

### Version Changes Not Detected

**Issue**: Catalog not updating when manifest version changes

**Solution**:

- Check database for stored versions: `SELECT * FROM bb_manifest_versions;`
- Verify version string actually changed in manifest
- Ensure backend has completed at least one full discovery cycle
- Check backend logs for processing errors

## Advanced Configuration

### Custom Schedule

Run every 30 minutes:

```yaml
catalog:
  providers:
    bitbucketManifestDiscover:
      schedule:
        frequency:
          minutes: 30
        timeout:
          minutes: 3
```

### Different Catalog Path

If your repositories use a non-standard path for catalog info:

```yaml
catalog:
  providers:
    bitbucketManifestDiscover:
      defaultCatalogInfoPath: .backstage/catalog-info.yaml
```

### Different Default Branch

If your repositories use `develop` or another default branch:

```yaml
catalog:
  providers:
    bitbucketManifestDiscover:
      defaultBranch: develop
```

## Architecture

```
┌─────────────────────────────────────────────┐
│ Backstage Backend                           │
│                                             │
│  ┌───────────────────────────────────────┐ │
│  │ BitbucketManifestDiscoverProvider      │ │
│  │                                         │ │
│  │  ┌──────────────────────────────────┐  │ │
│  │  │ Scheduler (hourly)               │  │ │
│  │  └──────────────────────────────────┘  │ │
│  │           │                             │ │
│  │           ▼                             │ │
│  │  ┌──────────────────────────────────┐  │ │
│  │  │ Fetch Manifest (Bitbucket)       │  │ │
│  │  └──────────────────────────────────┘  │ │
│  │           │                             │ │
│  │           ▼                             │ │
│  │  ┌──────────────────────────────────┐  │ │
│  │  │ Compare Versions (VersionStore)  │  │ │
│  │  └──────────────────────────────────┘  │ │
│  │           │                             │ │
│  │           ▼                             │ │
│  │  ┌──────────────────────────────────┐  │ │
│  │  │ Publish Location Entities        │  │ │
│  │  └──────────────────────────────────┘  │ │
│  └───────────────────────────────────────┘ │
│                                             │
│  ┌───────────────────────────────────────┐ │
│  │ Postgres                               │ │
│  │  - bb_manifest_versions table         │ │
│  └───────────────────────────────────────┘ │
│                                             │
│  ┌───────────────────────────────────────┐ │
│  │ Catalog Processing Engine              │ │
│  │  - Fetches catalog-info.yaml          │ │
│  │  - Processes entities                 │ │
│  └───────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

## Contributing

When making changes to this module:

1. Update version tracking logic in `versionStore.ts`
2. Modify provider behavior in `provider.ts`
3. Update module registration in `module.ts`
4. Test with local Backstage instance
5. Update this README with any configuration changes

## License

Apache-2.0
