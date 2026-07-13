/**
 * Canonical plugin-name normalization, shared so name-keyed maps (core
 * plugins, add-on gating) all bucket names identically regardless of the
 * hyphen/underscore/case variants that appear across WorkflowPlugin,
 * PluginPackage, and plugin.json (e.g. "agentbook-core" / "agentbookCore").
 */
export const normalizePluginName = (name: string): string =>
  name.toLowerCase().replace(/[-_]/g, '');
