import { randomUUID } from 'node:crypto';

export function requestId(): string { return randomUUID(); }
export function logMetric(event: string, fields: Record<string, string | number | boolean | undefined>): void {
  // Never log prompt text, generated content, or credentials.
  console.info(JSON.stringify({ event, timestamp: new Date().toISOString(), ...fields }));
}
