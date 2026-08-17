import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getSqliteDatabase } from '@/server/storage/sqlite-database';
import { readOnboardingState, updateOnboardingState } from './onboarding-state';

test('persists onboarding progress per user and treats existing users as completed', () => {
  const previousDataRoot = process.env.APP_DATA_DIR;
  const dataRoot = mkdtempSync(path.join(os.tmpdir(), 'webpilot-onboarding-'));
  process.env.APP_DATA_DIR = dataRoot;
  try {
    const fresh = readOnboardingState('new-user');
    assert.equal(fresh.status, 'not_started');
    assert.deepEqual(fresh.completedSteps, []);

    const started = updateOnboardingState('new-user', { action: 'start' });
    assert.equal(started.status, 'in_progress');
    assert.deepEqual(started.completedSteps, []);
    let progressed = started;
    for (const step of ['welcome', 'accounts', 'skills', 'memory', 'permissions', 'model', 'readiness', 'browser_task'] as const) {
      progressed = updateOnboardingState('new-user', { action: 'complete_step', step });
    }
    assert.equal(progressed.completedSteps.includes('browser_task'), true);
    assert.equal(progressed.status, 'completed');
    assert.deepEqual(readOnboardingState('new-user'), progressed);

    const database = getSqliteDatabase();
    database.prepare('UPDATE user_onboarding_state SET tutorial_version = 1 WHERE user_id = ?').run('new-user');
    const upgraded = readOnboardingState('new-user');
    assert.equal(upgraded.tutorialVersion, 2);
    assert.equal(upgraded.status, 'not_started');
    assert.deepEqual(upgraded.completedSteps, []);

    const timestamp = new Date().toISOString();
    database.prepare(`
      INSERT INTO browser_chat_session (
        id, user_id, title, status, revision, snapshot_json, summary_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 0, '{}', '{}', ?, ?)
    `).run('legacy-session', 'existing-user', 'Existing conversation', 'idle', timestamp, timestamp);
    database.prepare(`
      INSERT INTO browser_chat_message (session_id, id, time, record_json)
      VALUES (?, ?, ?, '{}')
    `).run('legacy-session', 'legacy-message', timestamp);
    assert.equal(readOnboardingState('existing-user').status, 'completed');
  } finally {
    getSqliteDatabase().close();
    if (previousDataRoot === undefined) delete process.env.APP_DATA_DIR;
    else process.env.APP_DATA_DIR = previousDataRoot;
    rmSync(dataRoot, { force: true, recursive: true });
  }
});
