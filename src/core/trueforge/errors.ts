export type TurnErrorKind =
  | 'quota'
  | 'billing'
  | 'network'
  | 'timeout'
  | 'overloaded'
  | 'auth'
  | 'model-not-found'
  | 'bad-request'
  | 'unreachable'
  | 'other';

export interface DescribedTurnError {
  kind: TurnErrorKind;
  httpStatus: number | undefined;
  /** One clear sentence for the user. Never a stack trace. */
  message: string;
  /** The harness's text, for logs. */
  raw: string;
}

export function trueForgeUnreachableMessage(baseUrl: string): string {
  return `TrueForge is not running at ${baseUrl}. Start it with scripts/start-trueforge.ps1 (or .sh), then run "ForgeLens: Set up TrueForge".`;
}

const CONNECTION_FAILURE = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|fetch failed|socket hang up|network error|connect ETIMEDOUT/i;

export function isConnectionFailure(raw: string): boolean {
  return CONNECTION_FAILURE.test(raw);
}

function firstSentence(text: string): string {
  const line = text.split('\n')[0]?.trim() ?? '';
  const end = line.search(/[.!?](\s|$)/);
  return end >= 0 ? line.slice(0, end + 1) : line;
}

/** Turns a failed turn's message into something a user can act on. */
export function describeTurnError(raw: string, baseUrl = 'http://localhost:8790'): DescribedTurnError {
  const described = describeRaw(raw, baseUrl);
  // "(402) : reason" reads badly on screen; the status code goes right before the colon.
  return { ...described, message: described.message.replace(/\s+:\s/g, ': ') };
}

function describeRaw(raw: string, baseUrl: string): DescribedTurnError {
  // TrueForge itself answered, but could not reach the model provider: that is the provider, not TrueForge.
  // "Cannot connect to API" is how TrueForge reports a provider endpoint that refuses connections (seen in P5).
  if ((/^\[Model Error\]/.test(raw) && (isConnectionFailure(raw) || /timed? ?out|ETIMEDOUT|network/i.test(raw))) || /Cannot connect to API/i.test(raw)) {
    const detail = raw.replace(/^\[Model Error\]\s*/, '');
    return { kind: 'network', httpStatus: undefined, message: `The model provider could not be reached: ${firstSentence(detail)}`, raw };
  }
  if (isConnectionFailure(raw)) {
    return { kind: 'unreachable', httpStatus: undefined, message: trueForgeUnreachableMessage(baseUrl), raw };
  }

  const fromModel = /^\[Model Error\]/.test(raw);
  const text = raw.replace(/^\[Model Error\]\s*/, '');
  const statusMatch = /Request failed \((\d{3})\):\s*/.exec(text);
  const httpStatus = statusMatch?.[1] ? Number(statusMatch[1]) : undefined;
  const detail = statusMatch ? text.slice(statusMatch.index + statusMatch[0].length) : text;
  const summary = firstSentence(detail) || 'The request failed.';
  const prefix = httpStatus ? `(${httpStatus}) ` : '';

  if (httpStatus === 429) {
    const limit = /description: ([^.\n]*)/.exec(detail)?.[1];
    const retry = /retry in ((?:\d+h)?(?:\d+m)?[\d.]+)s/i.exec(detail)?.[1];
    const parts = [`Model quota exceeded ${prefix}`.trim(), limit ? `: ${limit}.` : '.'];
    const message = `${parts.join('')}${retry ? ` Retry in ${retry.replace(/\.\d+$/, '')}s.` : ''}`;
    return { kind: 'quota', httpStatus, message, raw };
  }
  if (httpStatus === 402) {
    return { kind: 'billing', httpStatus, message: `The model provider refused the request for billing reasons ${prefix}: ${summary}`, raw };
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return { kind: 'auth', httpStatus, message: `The model provider rejected the API key ${prefix}: ${summary}`, raw };
  }
  if (httpStatus === 404) {
    return { kind: 'model-not-found', httpStatus, message: `Model not available ${prefix}: ${summary}`, raw };
  }
  if (httpStatus !== undefined && httpStatus >= 500) {
    return { kind: 'overloaded', httpStatus, message: `The model provider is unavailable ${prefix}: ${summary}`, raw };
  }
  if (httpStatus === 400 && /api[ _-]?key|API_KEY_INVALID|invalid key|unauthorized/i.test(detail)) {
    return { kind: 'auth', httpStatus, message: `The model provider rejected the API key ${prefix}: ${summary}`, raw };
  }
  if (httpStatus === 400) {
    return { kind: 'bad-request', httpStatus, message: `The model provider rejected the request ${prefix}: ${summary}`, raw };
  }
  return { kind: 'other', httpStatus, message: `The agent failed: ${summary}`, raw };
}

export type FailureAction = 'fallback' | 'retry' | 'stop';

/**
 * Billing, auth, a missing model or a request the provider will not take cannot get better by trying again, so
 * they move to the next model at once. Quota, overload, network and timeouts may pass, so they retry first.
 * TrueForge being down, or the agent itself failing, is the same on every model, so there is nothing to switch to.
 */
export function failureAction(error: DescribedTurnError): FailureAction {
  switch (error.kind) {
    case 'billing':
    case 'auth':
    case 'model-not-found':
    case 'bad-request':
      return 'fallback';
    case 'quota':
    case 'overloaded':
    case 'network':
    case 'timeout':
      return 'retry';
    case 'unreachable':
    case 'other':
      return 'stop';
  }
}

/** A short reason for the banner: "invalid API key (401)". */
export function shortReason(error: DescribedTurnError): string {
  const code = error.httpStatus ? ` (${error.httpStatus})` : '';
  switch (error.kind) {
    case 'billing':
      return `billing refused the request${code}`;
    case 'auth':
      return `invalid API key${code}`;
    case 'model-not-found':
      return `model not available${code}`;
    case 'quota':
      return `quota exceeded${code}`;
    case 'overloaded':
      return `provider unavailable${code}`;
    case 'network':
      return 'provider unreachable';
    case 'timeout':
      return 'no response in time';
    case 'bad-request':
      return `request rejected${code}`;
    default:
      return error.message;
  }
}
