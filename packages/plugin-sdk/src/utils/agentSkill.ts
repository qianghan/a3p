/**
 * AgentBook skill-registration SDK (PR 60).
 *
 * A typed helper plugin authors call to register their own skills with
 * the AgentBook agent. Wraps POST /api/v1/agentbook-core/skills/register
 * with the right shape + auth header.
 *
 * Designed for SERVER-SIDE use only — the underlying endpoint is gated
 * by INTERNAL_ADMIN_SECRET so browser-side calls won't succeed. Plugin
 * authors call this from a plugin install hook or a one-shot script.
 *
 * Example:
 *   import { registerAgentSkill } from '@naap/plugin-sdk';
 *
 *   await registerAgentSkill({
 *     baseUrl: 'http://localhost:3000',
 *     internalAdminSecret: process.env.INTERNAL_ADMIN_SECRET!,
 *     skill: {
 *       name: 'my-plugin-action',
 *       description: 'Triggers my plugin to do its thing',
 *       category: 'custom',
 *       triggerPatterns: ['my plugin .*'],
 *       parameters: {
 *         entityId: { type: 'string', required: true, extractHint: 'the entity to act on' },
 *       },
 *       endpoint: { method: 'POST', url: '/api/v1/my-plugin/run' },
 *       confirmBefore: false,
 *     },
 *   });
 */

export interface AgentSkillSpec {
  /** Unique kebab-case name; identifies the skill within (tenantId, name). */
  name: string;
  description: string;
  category: string;
  /** Regex source strings — the agent's classifier compiles them. */
  triggerPatterns: string[];
  /** Optional further-narrowing patterns. */
  requirePatterns?: string[];
  /** Patterns whose presence disqualifies this skill (used for negation). */
  excludePatterns?: string[];
  /** Param-name → spec map. The agent extracts these from the user text. */
  parameters: Record<string, AgentSkillParameter>;
  endpoint: AgentSkillEndpoint;
  /** Mustache-like template for the agent's reply ("Recorded {{amount}}!"). */
  responseTemplate?: string | null;
  /** When true, the agent shows a plan preview + Proceed/Cancel before calling. */
  confirmBefore?: boolean;
  /**
   * `null` makes the skill global (visible to every tenant). A string scopes
   * it to one tenant — useful for per-customer custom skills.
   */
  tenantId?: string | null;
}

export interface AgentSkillParameter {
  type: 'string' | 'number' | 'boolean';
  required?: boolean;
  /** Free-form hint the agent uses when extracting from chat text. */
  extractHint?: string;
}

export interface AgentSkillEndpoint {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  /** When method='GET', these param names become querystring keys. */
  queryParams?: string[];
}

export interface RegisterAgentSkillOptions {
  /** Base URL of the AgentBook deployment ('http://localhost:3000' for dev). */
  baseUrl: string;
  /**
   * Shared-secret header. Must match the deployment's INTERNAL_ADMIN_SECRET.
   * In dev, the deployment treats the route as open when the secret is unset,
   * but production deployments always require this.
   */
  internalAdminSecret: string;
  skill: AgentSkillSpec;
}

export interface RegisterAgentSkillResult {
  success: boolean;
  data?: {
    id: string;
    name: string;
    tenantId: string | null;
    created: boolean;
    updated: boolean;
  };
  error?: string;
}

/**
 * Register (upsert) a skill with the AgentBook agent. Returns the
 * { id, created, updated } from the server. Throws when the HTTP layer
 * fails — domain errors come back in `result.error`.
 */
export async function registerAgentSkill(
  opts: RegisterAgentSkillOptions,
): Promise<RegisterAgentSkillResult> {
  const url = `${opts.baseUrl.replace(/\/$/, '')}/api/v1/agentbook-core/skills/register`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-admin': opts.internalAdminSecret,
    },
    body: JSON.stringify(opts.skill),
  });
  return (await res.json()) as RegisterAgentSkillResult;
}

/**
 * Unregister (soft-disable) a previously-registered skill.
 * Pass `tenantId: null` to target the global slot.
 */
export async function unregisterAgentSkill(opts: {
  baseUrl: string;
  internalAdminSecret: string;
  name: string;
  tenantId?: string | null;
}): Promise<RegisterAgentSkillResult> {
  const u = new URL(`${opts.baseUrl.replace(/\/$/, '')}/api/v1/agentbook-core/skills/register`);
  u.searchParams.set('name', opts.name);
  if (opts.tenantId) u.searchParams.set('tenantId', opts.tenantId);
  const res = await fetch(u.toString(), {
    method: 'DELETE',
    headers: { 'x-internal-admin': opts.internalAdminSecret },
  });
  return (await res.json()) as RegisterAgentSkillResult;
}
