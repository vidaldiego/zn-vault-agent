// Path: src/lib/websocket/update-handler.ts
// Handler for operator-initiated agent update events (Fix B — daemon wiring).
//
// The vault server sends a top-level `{type:'update-available', ...}` WebSocket
// message when an operator triggers an update from the dashboard or CLI. The
// dispatcher turns that into an AgentUpdateEvent and fires the registered
// `update` handlers (see dispatcher.handleUpdateAvailable). This module is the
// final connection: it drives the durable manual update rail
// (NpmAutoUpdateService.requestUpdate), which works even when the automatic
// periodic checker is disabled (AUTO_UPDATE=false is the production default).
//
// Extracted into its own module so it can be unit-tested without standing up
// the whole daemon (websocket.ts pulls in a large dependency graph).

import { wsLogger as log } from '../logger.js';
import { randomUUID } from 'node:crypto';
import type { AgentUpdateEvent } from './types.js';
import type { NpmAutoUpdateService } from '../../services/npm-auto-update.js';

/**
 * Act on an operator-initiated update-available event.
 *
 * Logs receipt, then — if an npm auto-update service is available — invokes the
 * manual, gate-bypassing `requestUpdate()` and logs its pending operation. When no
 * service is wired (e.g. the daemon was started without one), logs a clear
 * warning instead. Never throws: errors from `requestUpdate()` are caught and
 * logged so the WebSocket loop is not disrupted.
 *
 * @param event - The update-available event from the dispatcher.
 * @param npmAutoUpdateService - The agent's npm auto-update service, or null/
 *   undefined when none was provided to the daemon.
 */
export async function handleUpdateEvent(
  event: AgentUpdateEvent,
  npmAutoUpdateService: NpmAutoUpdateService | null | undefined
): Promise<void> {
  log.info(
    { version: event.version, channel: event.channel, force: event.force },
    'Received update-available event from vault'
  );

  if (!npmAutoUpdateService) {
    log.warn(
      { version: event.version, channel: event.channel },
      'Update available but no npm auto-update service is wired - ignoring (agent cannot self-update)'
    );
    return;
  }

  try {
    // Manual trigger: bypasses the `enabled` gate so operator-initiated updates
    // work even when the automatic periodic checker is off (AUTO_UPDATE=false).
    // Thread the operator's `force` flag through so "force update" reinstalls an
    // agent already at latest instead of silently no-opping.
    const requestId = randomUUID();
    const result = await npmAutoUpdateService.requestUpdate({
      requestId,
      expectedCurrentVersion: npmAutoUpdateService.getCurrentVersion(),
      targetVersion: event.version,
      force: event.force ?? false,
    });
    if (result.status !== 'pending') {
      log.info(
        {
          status: result.status,
          requestId: result.requestId,
          previousVersion: result.previousVersion,
          targetVersion: result.targetVersion,
          finishedAt: result.finishedAt,
        },
        'Agent update request replayed a durable terminal receipt'
      );
      return;
    }
    log.info(
      {
        status: result.status,
        requestId: result.requestId,
        previousVersion: result.previousVersion,
        targetVersion: result.targetVersion,
        pollPath: result.pollPath,
      },
      'Agent update accepted by durable root-owned rail'
    );
  } catch (err) {
    log.error({ err, version: event.version }, 'Failed to trigger update from update-available event');
  }
}
