/** Shared constants of the demo site. Everything here is fictional. */
export const DEMO_BASE_URL = 'https://demo.example.atlassian.net';
export const DEMO_HOST = new URL(DEMO_BASE_URL).host;
export const DEMO_EMAIL = 'ana.demo@example.com';
/** Fixed dummy credential: it only exists so the Jira client has something to send; never persisted. */
export const DEMO_TOKEN = 'demo-token-not-a-secret';
export const STORY_POINTS_FIELD_ID = 'customfield_10016';
export const EPIC_LINK_FIELD_ID = 'customfield_10014';
