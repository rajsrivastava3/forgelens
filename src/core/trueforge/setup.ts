import { MCP_SERVER_DESCRIPTION, MCP_SERVER_NAME, MCP_TOKEN_HEADER } from '../mcp/server';
import { trueForgeUnreachableMessage } from './errors';

/** Committed definitions hold this instead of a model, so none is tied to one provider. */
export const MODEL_PLACEHOLDER = '${FORGELENS_MODEL}';

export interface AgentDefinition {
  name: string;
  description: string;
  /** In TrueForge's documented wire format (snake_case), so the file also works with plain curl. */
  manifest: { model: { name: string } } & Record<string, unknown>;
}

export type HealthResult =
  | { ok: true; models: string[] }
  | { ok: false; message: string };

const HEALTH_TIMEOUT_MS = 3_000;

function apiUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}/api/v1${path}`;
}

async function apiRequest(
  fetchFn: typeof fetch,
  baseUrl: string,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const response = await fetchFn(apiUrl(baseUrl, path), {
    ...init,
    headers: { 'content-type': 'application/json' },
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    throw new Error(`TrueForge ${init?.method ?? 'GET'} ${path} failed (${response.status}): ${detail}`);
  }
  return response.json();
}

function dataArray(body: unknown): Record<string, unknown>[] {
  const data = typeof body === 'object' && body !== null ? (body as { data?: unknown }).data : undefined;
  return Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
}

export async function checkTrueForge(baseUrl: string, fetchFn: typeof fetch = fetch): Promise<HealthResult> {
  try {
    const body = await apiRequest(fetchFn, baseUrl, '/models', { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    const models = dataArray(body).map((model) => String(model['name']));
    return { ok: true, models };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return /failed \(\d{3}\)/.test(reason)
      ? { ok: false, message: reason }
      : { ok: false, message: trueForgeUnreachableMessage(baseUrl) };
  }
}

export type ModelChoice =
  | { ok: true; model: string; note: string | undefined }
  | { ok: false; message: string };

/** The first configured model TrueForge really has; with none configured, whatever TrueForge lists first. */
export function chooseModel(configured: readonly string[], available: readonly string[]): ModelChoice {
  if (available.length === 0) {
    return { ok: false, message: 'TrueForge has no models. Add one under Settings > Models in the TrueForge UI.' };
  }
  const usable = configured.find((model) => available.includes(model));
  if (usable) {
    const skipped = configured.slice(0, configured.indexOf(usable));
    return {
      ok: true,
      model: usable,
      note: skipped.length > 0 ? `Not available in TrueForge, skipped: ${skipped.join(', ')}` : undefined,
    };
  }
  const first = available[0] ?? '';
  return {
    ok: true,
    model: first,
    note: configured.length > 0 ? `None of forgelens.models is available in TrueForge. Using ${first}.` : undefined,
  };
}

/** How hard the model thinks: "low", "medium" or "high", forwarded as model.params.reasoning_effort. "default" sends nothing. */
export interface ModelOptions {
  reasoningEffort?: string | undefined;
}

export function instantiateAgent(definition: AgentDefinition, model: string, options: ModelOptions = {}): AgentDefinition {
  if (definition.manifest.model.name !== MODEL_PLACEHOLDER) {
    throw new Error(`Agent ${definition.name} must use ${MODEL_PLACEHOLDER} as its model name.`);
  }
  const effort = options.reasoningEffort && options.reasoningEffort !== 'default' ? options.reasoningEffort : undefined;
  const base = definition.manifest.model as { name: string; params?: Record<string, unknown> };
  const params = effort ? { ...(base.params ?? {}), reasoning_effort: effort } : base.params;
  return { ...definition, manifest: { ...definition.manifest, model: { ...base, name: model, ...(params ? { params } : {}) } } };
}

export async function registerMcpServer(
  baseUrl: string,
  server: { url: string; token: string },
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  await apiRequest(fetchFn, baseUrl, '/settings/mcp-servers', {
    method: 'PUT',
    body: JSON.stringify({
      manifest: {
        type: 'remote',
        name: MCP_SERVER_NAME,
        url: server.url,
        description: MCP_SERVER_DESCRIPTION,
        auth: { type: 'header', headers: { [MCP_TOKEN_HEADER]: server.token } },
      },
    }),
  });
}

export async function upsertAgent(
  baseUrl: string,
  agent: AgentDefinition,
  fetchFn: typeof fetch = fetch,
): Promise<'created' | 'updated'> {
  const existing = dataArray(await apiRequest(fetchFn, baseUrl, '/agents')).find(
    (candidate) => candidate['name'] === agent.name,
  );
  if (existing) {
    await apiRequest(fetchFn, baseUrl, `/agents/${String(existing['id'])}`, {
      method: 'PUT',
      body: JSON.stringify({ description: agent.description, manifest: agent.manifest }),
    });
    return 'updated';
  }
  await apiRequest(fetchFn, baseUrl, '/agents', { method: 'POST', body: JSON.stringify(agent) });
  return 'created';
}

export interface SetupResult {
  model: string;
  /** Configured models TrueForge has, in order, primary first. The fallback chain. */
  chain: string[];
  note: string | undefined;
  agents: Record<string, 'created' | 'updated'>;
}

/** Idempotent: safe on every activation. Makes "works from a clean clone" true. */
export async function setUpTrueForge(options: {
  baseUrl: string;
  mcp: { url: string; token: string };
  configuredModels: readonly string[];
  agents: readonly AgentDefinition[];
  fetchFn?: typeof fetch;
  reasoningEffort?: string | undefined;
}): Promise<SetupResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const health = await checkTrueForge(options.baseUrl, fetchFn);
  if (!health.ok) throw new Error(health.message);
  const choice = chooseModel(options.configuredModels, health.models);
  if (!choice.ok) throw new Error(choice.message);

  await registerMcpServer(options.baseUrl, options.mcp, fetchFn);
  const agents: Record<string, 'created' | 'updated'> = {};
  for (const definition of options.agents) {
    agents[definition.name] = await upsertAgent(options.baseUrl, instantiateAgent(definition, choice.model, { reasoningEffort: options.reasoningEffort }), fetchFn);
  }
  const chain = options.configuredModels.filter((model) => health.models.includes(model));
  return { model: choice.model, chain: chain.length > 0 ? [...new Set(chain)] : [choice.model], note: choice.note, agents };
}

/**
 * A session for a model other than the one the saved agent names: the same manifest from the committed
 * definition, with only the model swapped. This is how a fallback runs the very same agent.
 */
export async function createSessionForModel(
  baseUrl: string,
  definition: AgentDefinition,
  model: string,
  fetchFn: typeof fetch = fetch,
  options: ModelOptions = {},
): Promise<string> {
  const { manifest } = instantiateAgent(definition, model, options);
  const body = await apiRequest(fetchFn, baseUrl, '/sessions', { method: 'POST', body: JSON.stringify({ agent: { spec: manifest } }) });
  const id = (body as { data?: { id?: string } }).data?.id;
  if (!id) throw new Error('TrueForge did not return a session id.');
  return id;
}

/** Every model TrueForge has, for the model picker. */
export async function listModels(baseUrl: string, fetchFn: typeof fetch = fetch): Promise<string[]> {
  const health = await checkTrueForge(baseUrl, fetchFn);
  if (!health.ok) throw new Error(health.message);
  return health.models;
}
