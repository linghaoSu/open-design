import type { HubWorkspaceEventType } from '../shared/wire.js';
import type { SyncDigestFace } from './store.js';

/**
 * Event -> sync-digest face mapping. Reimplements (does not import — tools/
 * must not depend on e2e/) `noteEvent` in e2e/lib/collab-hub-core/store.ts:303-327
 * so a daemon comparing digest tokens sees the same faces move for the same
 * events against the fake hub and against od-hub.
 */
export function digestFacesForEvent(type: string): SyncDigestFace[] {
  switch (type as HubWorkspaceEventType) {
    case 'team-projects-changed':
    case 'project-metadata-changed':
    case 'project-content-changed':
    case 'team-resources-changed':
      return ['catalogToken'];
    case 'workspace-members-changed':
      return ['membersToken'];
    case 'workspace-context-changed':
      return ['membersToken', 'contextToken'];
    case 'billing-changed':
    case 'billing-subscription-changed':
    case 'wallet-balance-changed':
      return ['billingToken'];
    default:
      return [];
  }
}
