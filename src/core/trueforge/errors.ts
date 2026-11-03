export type TurnErrorKind =
  | 'quota'
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
  if (isConnectionFailure(raw)) {
    return { kind: 'unreachable', httpStatus: undefined, message: trueForgeUnreachableMessage(baseUrl), raw };
  }

  const text = raw.replace(/^\[Model Error\]\s*/, '');
  const statusMatch = /Request failed \((\d{3})\):\s*/.exec(text);
  const httpStatus = statusMatch?.[1] ? Number(statusMatch[1]) : undefined;
  const detail = statusMatch ? text.slice(statusMatch.index + statusMatch[0].length) : text;
  const summary = firstSentence(detail) || 'The request failed.';
  const prefix = httpStatus ? `(${httpStatus}) ` : '';

  if (httpStatus === 429) {
    const limit = /description: ([^.\n]*)/.exec(detail)?.[1];
    const retry = /retry in ([\dhms.]+)/i.exec(detail)?.[1];
    const parts = [`Model quota exceeded ${prefix}`.trim(), limit ? `: ${limit}.` : '.'];
    const message = `${parts.join('')}${retry ? ` Retry in ${retry.replace(/\.\d+s$/, 's')}.` : ''}`;
    return { kind: 'quota', httpStatus, message, raw };
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
  if (httpStatus === 400) {
    return { kind: 'bad-request', httpStatus, message: `The model provider rejected the request ${prefix}: ${summary}`, raw };
  }
  return { kind: 'other', httpStatus, message: `The agent failed: ${summary}`, raw };
}
