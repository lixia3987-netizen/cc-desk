import assert from 'node:assert/strict';
import test from 'node:test';
import { claudeCapabilities } from '@cc-desk/engine-claude';

const base = { executable: '', version: '', available: false, flags: [], efforts: ['default'], error: 'CLI not installed' };
const structuredFlags = ['--print', '--input-format', '--output-format', '--verbose', '--permission-prompt-tool'];

test('undiscovered CLI retains adapter identity capabilities while execution remains unavailable', () => {
  for (const mode of ['structured', 'terminal']) {
    const capabilities = claudeCapabilities(base, mode);
    assert.equal(capabilities.available, false);
    assert.equal(capabilities.error, 'CLI not installed');
    assert.equal(capabilities.resume, true);
    assert.equal(capabilities.fork, true);
  }
});

test('known CLI flags remain authoritative for missing resume and fork support', () => {
  for (const available of [true, false]) {
    const older = claudeCapabilities({ ...base, available, flags: structuredFlags }, 'structured');
    assert.equal(older.available, available);
    assert.equal(older.resume, false);
    assert.equal(older.fork, false);
    const partial = claudeCapabilities({ ...base, available, flags: [...structuredFlags, '--resume', '--fork-session'] }, 'structured');
    assert.equal(partial.resume, true);
    assert.equal(partial.fork, false, 'fork also requires explicit session identity support');
    const complete = claudeCapabilities({ ...base, available, flags: [...structuredFlags, '--resume', '--fork-session', '--session-id'] }, 'structured');
    assert.equal(complete.resume, true);
    assert.equal(complete.fork, true);
  }
  const detectedWithoutFlags = claudeCapabilities({ ...base, available: true }, 'terminal');
  assert.equal(detectedWithoutFlags.resume, false);
  assert.equal(detectedWithoutFlags.fork, false);
});
