import { describe, expect, it, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { toWorkflowPluginData, type DiscoveredPlugin } from '../src/plugin-discovery';

function makePlugin(overrides: Partial<DiscoveredPlugin> = {}): DiscoveredPlugin {
  return {
    name: 'agentbook-startup',
    dirName: 'agentbook-startup',
    displayName: 'Startup Tax Benefits',
    version: '1.0.0',
    globalName: 'NaapPluginAgentbookStartup',
    routes: ['/plugins/agentbook-startup', '/plugins/agentbook-startup/*'],
    originalRoutes: ['/plugins/agentbook-startup', '/plugins/agentbook-startup/*'],
    order: 0,
    icon: 'rocket',
    ...overrides,
  } as DiscoveredPlugin;
}

describe('toWorkflowPluginData stylesUrl', () => {
  let tmpRoot: string;

  afterEach(() => {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('points at the manifest\'s actual CSS filename, not a {dirName}.css guess', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-discovery-test-'));
    const distDir = path.join(tmpRoot, 'plugins', 'agentbook-startup', 'frontend', 'dist', 'production');
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(
      path.join(distDir, 'manifest.json'),
      JSON.stringify({ stylesFile: 'plugin-agentbook-startup-frontend.css' }),
    );

    const data = toWorkflowPluginData(makePlugin(), '/cdn/plugins', tmpRoot);

    expect(data.stylesUrl).toBe(
      '/cdn/plugins/agentbook-startup/1.0.0/plugin-agentbook-startup-frontend.css',
    );
  });

  it('leaves stylesUrl null for a headless plugin with no CSS output', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-discovery-test-'));
    const distDir = path.join(tmpRoot, 'plugins', 'dashboard-data-provider', 'frontend', 'dist', 'production');
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, 'manifest.json'), JSON.stringify({ stylesFile: undefined }));

    const data = toWorkflowPluginData(
      makePlugin({ name: 'dashboard-data-provider', dirName: 'dashboard-data-provider' }),
      '/cdn/plugins',
      tmpRoot,
    );

    expect(data.stylesUrl).toBeNull();
  });

  it('leaves stylesUrl null when no manifest has been built yet', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-discovery-test-'));

    const data = toWorkflowPluginData(makePlugin(), '/cdn/plugins', tmpRoot);

    expect(data.stylesUrl).toBeNull();
  });
});
