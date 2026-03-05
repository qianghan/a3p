import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TemplateRegistry } from '../../services/TemplateRegistry.js';
import type { DeploymentTemplate } from '../../types/index.js';

describe('Feature: Template Discovery', () => {
  let registry: TemplateRegistry;

  beforeEach(() => {
    registry = new TemplateRegistry();
  });

  it('Given the system is initialized, When a user lists templates, Then built-in curated templates are returned', () => {
    // Given
    const templates = registry.getTemplates();

    // When
    const aiRunner = templates.find((t) => t.id === 'ai-runner');
    const scope = templates.find((t) => t.id === 'scope');

    // Then
    expect(templates.length).toBeGreaterThanOrEqual(2);

    expect(aiRunner).toBeDefined();
    expect(aiRunner!.name).toBe('AI Runner');
    expect(aiRunner!.category).toBe('curated');
    expect(aiRunner!.dockerImage).toBe('livepeer/ai-runner');
    expect(aiRunner!.healthEndpoint).toBe('/health');
    expect(aiRunner!.healthPort).toBe(8080);
    expect(aiRunner!.githubOwner).toBe('livepeer');
    expect(aiRunner!.githubRepo).toBe('ai-runner');

    expect(scope).toBeDefined();
    expect(scope!.name).toBe('Daydream Scope');
    expect(scope!.category).toBe('curated');
    expect(scope!.dockerImage).toBe('daydreamlive/scope');
  });

  it('Given a template with a GitHub repo, When a user requests versions, Then versions are fetched from GitHub releases', async () => {
    // Given
    const mockReleases = [
      {
        tag_name: 'v1.2.0',
        name: 'v1.2.0',
        published_at: '2025-06-01T00:00:00Z',
        prerelease: false,
        draft: false,
        html_url: 'https://github.com/livepeer/ai-runner/releases/tag/v1.2.0',
        assets: [],
      },
      {
        tag_name: 'v1.1.0',
        name: 'v1.1.0',
        published_at: '2025-05-01T00:00:00Z',
        prerelease: false,
        draft: false,
        html_url: 'https://github.com/livepeer/ai-runner/releases/tag/v1.1.0',
        assets: [],
      },
      {
        tag_name: 'v1.0.0-beta',
        name: 'v1.0.0-beta',
        published_at: '2025-04-01T00:00:00Z',
        prerelease: true,
        draft: true,
        html_url: 'https://github.com/livepeer/ai-runner/releases/tag/v1.0.0-beta',
        assets: [],
      },
    ];

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(mockReleases), { status: 200 }),
    );

    // When
    const versions = await registry.getVersions('ai-runner');

    // Then — draft releases are filtered out
    expect(versions).toHaveLength(2);
    expect(versions[0].version).toBe('v1.2.0');
    expect(versions[0].dockerImage).toBe('livepeer/ai-runner:v1.2.0');
    expect(versions[0].prerelease).toBe(false);
    expect(versions[1].version).toBe('v1.1.0');
    expect(versions[1].dockerImage).toBe('livepeer/ai-runner:v1.1.0');

    vi.restoreAllMocks();
  });

  it('Given a user wants a custom template, When they register it, Then it appears alongside built-in templates', () => {
    // Given
    const customTemplate: Omit<DeploymentTemplate, 'category'> = {
      id: 'my-custom-model',
      name: 'My Custom Model',
      description: 'A user-defined inference model',
      icon: '🧩',
      dockerImage: 'myregistry/custom-model',
      healthEndpoint: '/healthz',
      healthPort: 9090,
      defaultGpuModel: 'H100',
      defaultGpuVramGb: 80,
    };

    // When
    const added = registry.addCustomTemplate(customTemplate);
    const allTemplates = registry.getTemplates();
    const found = registry.getTemplate('my-custom-model');

    // Then
    expect(added.category).toBe('custom');
    expect(added.id).toBe('my-custom-model');
    expect(allTemplates.length).toBeGreaterThanOrEqual(3);
    expect(found).toBeDefined();
    expect(found!.name).toBe('My Custom Model');
    expect(found!.dockerImage).toBe('myregistry/custom-model');
    expect(found!.healthPort).toBe(9090);

    // Verify removal works
    const removed = registry.removeCustomTemplate('my-custom-model');
    expect(removed).toBe(true);
    expect(registry.getTemplate('my-custom-model')).toBeUndefined();
    expect(registry.getTemplates().length).toBeGreaterThanOrEqual(2);
  });
});
