import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../proxy/config/normalize.mjs';
import { initials, teamSummaries, userSearchHits } from '../shared/config-view.mjs';

const member = (accountId, extra = {}) => ({ accountId, displayName: `User ${accountId}`, ...extra });
const config = () =>
  normalizeConfig({
    teams: [
      { id: 't1', name: 'Equipo Norte', members: [member('a'), member('b', { active: false })] },
      { id: 't2', name: 'Pagos', active: false, members: [member('a')] },
    ],
    projects: [
      { id: 'p1', teamId: 't1', name: 'Uno', epics: [{ key: 'A-1', issueTypeId: '1' }, { key: 'A-2', issueTypeId: '1' }] },
      { id: 'p2', teamId: 't1', name: 'Dos', epics: [{ key: 'A-3', issueTypeId: '1' }] },
    ],
  });

test('initials: first letters of the first and last word, upper-case', () => {
  assert.equal(initials('Ana María López'), 'AL');
  assert.equal(initials('  juan  '), 'J');
  assert.equal(initials('Ñandú Ávila'), 'ÑÁ');
  assert.equal(initials(''), '?');
});

test('teamSummaries counts members, projects and epics per team', () => {
  const rows = teamSummaries(config());
  assert.deepEqual(
    rows.map((r) => [r.team.id, r.members, r.activeMembers, r.projects, r.epics]),
    [
      ['t1', 2, 1, 2, 3],
      ['t2', 1, 1, 0, 0],
    ],
  );
});

test('userSearchHits marks people already in this team and lists their other teams', () => {
  const hits = userSearchHits(config(), 't1', [
    { accountId: 'a', displayName: 'Ana', emailAddress: 'ana@x.com' },
    { accountId: 'z', displayName: 'Zoe', emailAddress: null },
  ]);
  assert.deepEqual(
    hits.map((h) => [h.user.accountId, h.inThisTeam, h.otherTeams]),
    [
      ['a', true, ['Pagos']],
      ['z', false, []],
    ],
  );
});
