import { describe, expect, it } from 'vitest';
import agent from '../../agents/forgelens-agent.json';
import inline from '../../agents/forgelens-inline.json';
import {
  checkTrueForge,
  chooseModel,
  instantiateAgent,
  MODEL_PLACEHOLDER,
  createSessionForModel,
  setUpTrueForge,
  type AgentDefinition,
} from '../../src/core/trueforge/setup';

const BASE = 'http://tf.test';

/** A small in-memory TrueForge, recording writes. */
function fakeTrueForge(models: string[], existingAgents: { id: string; name: string }[] = []) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const path = url.slice(`${BASE}/api/v1`.length);
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    if (method === 'GET' && path === '/models') return Response.json({ data: models.map((name) => ({ name })) });
    if (method === 'GET' && path === '/agents') return Response.json({ data: existingAgents });
    return Response.json({ data: {} });
  }) as typeof fetch;
  return { fetchFn, calls };
}

describe('committed agent definitions', () => {
  it.each([
    ['forgelens-agent', agent],
    ['forgelens-inline', inline],
  ])('%s is not tied to a provider and gates writes by name', (name, definition) => {
    expect(definition.name).toBe(name);
    expect(definition.manifest.model.name).toBe(MODEL_PLACEHOLDER);
    const server = definition.manifest.mcp_servers[0];
    expect(server?.name).toBe('forgelens-editor');
    expect(server?.require_approval_for_tools).toEqual(['apply_changes', 'run_command']);
    expect(JSON.stringify(definition)).not.toMatch(/gemini|groq|openai\//i);
  });

  it.each([
    ['forgelens-agent', agent],
    ['forgelens-inline', inline],
  ])('%s can reach every tool it preloads and every tool its instructions name', (_name, definition) => {
    const server = definition.manifest.mcp_servers[0] as { enable_tools?: string[]; preload_tools: string[] };
    const enabled = server.enable_tools;
    if (!enabled) return; // No list means every tool is enabled.
    for (const tool of server.preload_tools) expect(enabled).toContain(tool);
    const named = ['stage_edit', 'stage_replace_lines', 'unstage_file', 'apply_changes', 'read_file', 'search_code'].filter((tool) =>
      definition.manifest.instructions.includes(tool),
    );
    for (const tool of named) expect(enabled).toContain(tool);
  });
});

describe('chooseModel', () => {
  const available = ['a/one', 'b/two'];

  it('uses the first configured model that exists, and says what it skipped', () => {
    expect(chooseModel(['x/gone', 'b/two'], available)).toEqual({
      ok: true,
      model: 'b/two',
      note: 'Not available in TrueForge, skipped: x/gone',
    });
  });

  it('defaults to the first available model', () => {
    expect(chooseModel([], available)).toEqual({ ok: true, model: 'a/one', note: undefined });
  });

  it('falls back with a note when nothing configured exists', () => {
    const choice = chooseModel(['x/gone'], available);
    expect(choice).toMatchObject({ ok: true, model: 'a/one' });
    expect(choice.ok && choice.note).toContain('None of forgelens.models');
  });

  it('explains when TrueForge has no models', () => {
    expect(chooseModel(['a/one'], [])).toMatchObject({ ok: false });
  });
});

describe('instantiateAgent', () => {
  it('fills in the model without changing the committed definition', () => {
    const definition = agent as AgentDefinition;
    const ready = instantiateAgent(definition, 'p/m');
    expect(ready.manifest.model.name).toBe('p/m');
    expect(definition.manifest.model.name).toBe(MODEL_PLACEHOLDER);
  });

  it('sends the reasoning effort as model.params, and nothing for default', () => {
    const definition = agent as AgentDefinition;
    expect(instantiateAgent(definition, 'p/m', { reasoningEffort: 'low' }).manifest.model).toEqual({ name: 'p/m', params: { reasoning_effort: 'low' } });
    expect(instantiateAgent(definition, 'p/m', { reasoningEffort: 'default' }).manifest.model).toEqual({ name: 'p/m' });
    expect(instantiateAgent(definition, 'p/m').manifest.model).toEqual({ name: 'p/m' });
  });

  it('rejects a definition with a hardcoded model', () => {
    expect(() =>
      instantiateAgent({ name: 'x', description: 'd', manifest: { model: { name: 'p/m' } } }, 'q/n'),
    ).toThrow(/must use/);
  });
});

describe('checkTrueForge', () => {
  it('gives the clear message when nothing is listening', async () => {
    const down = (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch;
    expect(await checkTrueForge(BASE, down)).toEqual({
      ok: false,
      message: expect.stringContaining(`TrueForge is not running at ${BASE}`) as string,
    });
  });

  it('reports a server error as itself', async () => {
    const broken = (() => Promise.resolve(new Response('nope', { status: 500 }))) as typeof fetch;
    const result = await checkTrueForge(BASE, broken);
    expect(result.ok === false && result.message).toContain('failed (500)');
  });

  it('lists models when healthy', async () => {
    expect(await checkTrueForge(BASE, fakeTrueForge(['a/one']).fetchFn)).toEqual({ ok: true, models: ['a/one'] });
  });
});

describe('setUpTrueForge', () => {
  const agents = [agent, inline] as AgentDefinition[];
  const mcp = { url: 'http://127.0.0.1:8799/mcp', token: 'secret-token' };

  it('registers the server, then creates agents with the chosen model', async () => {
    const { fetchFn, calls } = fakeTrueForge(['a/one', 'b/two']);
    const result = await setUpTrueForge({ baseUrl: BASE, mcp, configuredModels: ['b/two'], agents, fetchFn });
    expect(result).toMatchObject({
      model: 'b/two',
      note: undefined,
      agents: { 'forgelens-agent': 'created', 'forgelens-inline': 'created' },
    });
    const writes = calls.filter((call) => call.method !== 'GET');
    expect(writes.map((call) => `${call.method} ${call.path}`)).toEqual([
      'PUT /settings/mcp-servers',
      'POST /agents',
      'POST /agents',
    ]);
    expect(writes[0]?.body).toMatchObject({
      manifest: { name: 'forgelens-editor', auth: { headers: { 'x-forgelens-token': 'secret-token' } } },
    });
    expect(writes[1]?.body).toMatchObject({ name: 'forgelens-agent', manifest: { model: { name: 'b/two' } } });
  });

  it('updates agents that already exist, by id', async () => {
    const { fetchFn, calls } = fakeTrueForge(['a/one'], [{ id: 'id-1', name: 'forgelens-agent' }]);
    const result = await setUpTrueForge({ baseUrl: BASE, mcp, configuredModels: [], agents, fetchFn });
    expect(result.agents).toEqual({ 'forgelens-agent': 'updated', 'forgelens-inline': 'created' });
    expect(calls.some((call) => call.method === 'PUT' && call.path === '/agents/id-1')).toBe(true);
  });

  it('writes nothing when TrueForge is down', async () => {
    const calls: string[] = [];
    const down = ((input: string) => {
      calls.push(String(input));
      return Promise.reject(new TypeError('fetch failed'));
    }) as typeof fetch;
    await expect(setUpTrueForge({ baseUrl: BASE, mcp, configuredModels: [], agents, fetchFn: down })).rejects.toThrow(/not running/);
    expect(calls).toHaveLength(1);
  });
});

describe('the fallback chain and sessions per model', () => {
  it('lists the configured models TrueForge has, in order', async () => {
    const { fetchFn } = fakeTrueForge(['a/one', 'b/two', 'c/three']);
    const mcp = { url: 'http://127.0.0.1:1/mcp', token: 't' };
    const result = await setUpTrueForge({ baseUrl: BASE, mcp, configuredModels: ['x/gone', 'c/three', 'a/one'], agents: [agent as AgentDefinition], fetchFn });
    expect(result.model).toBe('c/three');
    expect(result.chain).toEqual(['c/three', 'a/one']);
  });

  it('makes a session from the committed manifest with only the model swapped', async () => {
    const calls: { path: string; body: unknown }[] = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ path: String(input).slice(`${BASE}/api/v1`.length), body: JSON.parse(String(init?.body)) });
      return Response.json({ data: { id: 'sess-9' } });
    }) as typeof fetch;
    expect(await createSessionForModel(BASE, agent as AgentDefinition, 'b/two', fetchFn, { reasoningEffort: 'medium' })).toBe('sess-9');
    const spec = (calls[0]?.body as { agent: { spec: { model: { name: string }; instructions: string } } }).agent.spec;
    expect(calls[0]?.path).toBe('/sessions');
    expect(spec.model).toEqual({ name: 'b/two', params: { reasoning_effort: 'medium' } });
    expect(spec.instructions).toBe(agent.manifest.instructions);
  });
});

describe('agent mode is told to keep costs down', () => {
  const text = (agent as { manifest: { instructions: string } }).manifest.instructions;

  it('plans in one turn and implements in the next, reading narrowly and testing and applying once', () => {
    expect(text).toContain('A change runs as two turns of this session.');
    expect(text).toContain('Delegate the lookups to an explorer: call create_sub_agent once');
    expect(text).toContain('search with search_code (on the MCP server named forgelens-editor, loaded with get_tool_info), at most 3 searches');
    expect(text).toContain('at most 150 lines a call');
    expect(text).toContain('Never read a range you have already read');
    expect(text).toContain('one stage_edit per file, with several edits in it');
    expect(text).toContain('Call run_command once with target "staged"');
    expect(text).toContain('Call apply_changes once');
    expect(text).toContain('make all of them in the same message');
  });

  it('states the read limit and asks for defensive code over research', () => {
    expect(text).toContain('stop working after 8 in a turn with nothing staged');
    expect(text).toContain('Do not research library internals or edge cases before staging.');
    expect(text).toContain('never send an edit whose old_text equals new_text');
    expect(text).toContain('MCP server named forgelens-editor');
  });

  it('has a short iteration limit and names no file of any repository', () => {
    expect((agent as { manifest: { config: { iteration_limit: number } } }).manifest.config.iteration_limit).toBe(25);
    expect(text).not.toMatch(/cli\.py|helpers\.py|flask/i);
  });
});
