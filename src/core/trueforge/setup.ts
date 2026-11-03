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
    return { ok: false, message: 'TrueForge has no models. Add one under Settings → Models in the TrueForge UI.' };
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

export function instantiateAgent(definition: AgentDefinition, model: string): AgentDefinition {
  if (definition.manifest.model.name !== MODEL_PLACEHOLDER) {
    throw new Error(`Agent ${definition.name} must use ${MODEL_PLACEHOLDER} as its model name.`);
  }
  return { ...definition, manifest: { ...definition.manifest, model: { ...definition.manifest.model, name: model } } };
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
}): Promise<SetupResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const health = await checkTrueForge(options.baseUrl, fetchFn);
  if (!health.ok) throw new Error(health.message);
  const choice = chooseModel(options.configuredModels, health.models);
  if (!choice.ok) throw new Error(choice.message);

  await registerMcpServer(options.baseUrl, options.mcp, fetchFn);
  const agents: Record<string, 'created' | 'updated'> = {};
  for (const definition of options.agents) {
    agents[definition.name] = await upsertAgent(options.baseUrl, instantiateAgent(definition, choice.model), fetchFn);
  }
  return { model: choice.model, note: choice.note, agents };
}
