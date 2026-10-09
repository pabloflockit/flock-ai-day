import { normalizeConfig } from '../../proxy/config/normalize.mjs';
import {
  DEMO_BASE_URL,
  DEMO_EMAIL,
  EPIC_LINK_FIELD_ID,
  STORY_POINTS_FIELD_ID,
} from './constants.mjs';

export * from './constants.mjs';
export { createDemoFetch } from './demo-fetch.mjs';

/**
 * The configuration seeded on the first `--demo` start: the demo site, one team with two
 * fictional members and one project with the three demo epics (DEMO-3 is the failing one).
 * @returns {import('../../proxy/config/normalize.mjs').AppConfig}
 */
export function buildDemoConfig() {
  return normalizeConfig({
    jira: {
      baseUrl: DEMO_BASE_URL,
      email: DEMO_EMAIL,
      epicLinkMode: 'auto',
      epicLinkFieldId: EPIC_LINK_FIELD_ID,
    },
    teams: [
      {
        id: 'demo-team',
        name: 'Demo team',
        members: [
          { accountId: 'demo-account-001', displayName: 'Ana Demo', emailAddress: 'ana.demo@example.com' },
          { accountId: 'demo-account-002', displayName: 'Ben Demo', emailAddress: 'ben.demo@example.com' },
          // Not in the demo Jira users: a sync flags it `jiraActive: false` and keeps it (architecture section 6.7).
          { accountId: 'demo-account-099', displayName: 'Former Demo', emailAddress: null },
        ],
      },
    ],
    projects: [
      {
        id: 'demo-project',
        teamId: 'demo-team',
        name: 'Demo project',
        measure: { kind: 'field', fieldId: STORY_POINTS_FIELD_ID, fieldName: 'Story Points', valueType: 'number' },
        epics: [
          { key: 'DEMO-1', issueTypeId: '10000', summary: 'Demo: onboarding flow' },
          { key: 'DEMO-2', issueTypeId: '10000', summary: 'Demo: reporting module' },
          { key: 'DEMO-3', issueTypeId: '10000', summary: 'Demo: legacy migration' },
        ],
      },
    ],
  });
}

/**
 * Seeds the demo configuration only when the demo database has none yet; later starts keep
 * whatever the user changed.
 *
 * @param {{
 *   handle: { db: import('node:sqlite').DatabaseSync },
 *   configStore: { save(raw: unknown): unknown },
 * }} deps
 * @returns {boolean} whether it seeded
 */
export function seedDemoConfig({ handle, configStore }) {
  const existing = handle.db.prepare('SELECT 1 AS present FROM app_config WHERE id = 1').get();
  if (existing) return false;
  configStore.save(buildDemoConfig());
  return true;
}
