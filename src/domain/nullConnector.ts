// The Phase 2 placeholder connector.
//
// Phase 3 replaces this with the Baileys implementation. Until then the service
// runs, authenticates, enforces tenant ownership, persists its manifest and
// emits events — everything except actually talking to WhatsApp.
//
// ── Why a placeholder rather than half a Baileys client ─────────────────────
//
// It keeps Phase 3 an implementation of a tested interface rather than surgery
// on a running service, and it means every ownership and lifecycle test in this
// repo can run forever without a WhatsApp connection. A real connection cannot
// be part of an automated suite, so the tests that matter most for security
// have to be able to run against something else.
//
// It is deliberately honest rather than optimistic: it never reports
// `connected`, so nothing downstream can mistake a stub for a working pairing.

import { operationLogger } from '../logger.js';
import {
  InstanceState,
  type InstanceStateValue,
  type WhatsAppConnector,
} from './instance.js';

export class NullConnector implements WhatsAppConnector {
  readonly #states = new Map<string, InstanceStateValue>();

  start(instanceId: string): Promise<InstanceStateValue> {
    this.#states.set(instanceId, InstanceState.NEVER_CONNECTED);
    operationLogger({ instance_id: instanceId, operation: 'connector.start' }).warn(
      { status: 'error', reason: 'no_connector' },
      'whatsapp_connector_not_implemented — pairing is unavailable until Phase 3',
    );
    return Promise.resolve(InstanceState.NEVER_CONNECTED);
  }

  stop(instanceId: string): Promise<void> {
    this.#states.set(instanceId, InstanceState.DISCONNECTED);
    return Promise.resolve();
  }

  logout(instanceId: string): Promise<void> {
    this.#states.delete(instanceId);
    return Promise.resolve();
  }

  stateOf(instanceId: string): InstanceStateValue {
    return this.#states.get(instanceId) ?? InstanceState.NEVER_CONNECTED;
  }

  detailsOf(_instanceId: string): {
    phone_e164: string | null;
    connected_at: string | null;
    disconnected_at: string | null;
    last_error_code: string | null;
  } {
    return {
      phone_e164: null,
      connected_at: null,
      disconnected_at: null,
      last_error_code: null,
    };
  }

  shutdown(): Promise<void> {
    this.#states.clear();
    return Promise.resolve();
  }
}
