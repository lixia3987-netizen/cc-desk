import test from 'node:test';
import { resolveNativeRuntimeConfig } from '../src/shared/native-runtime-policy';
import assert from 'node:assert/strict';
import { nativeAutoApproves, nativePermissionInstructions, NATIVE_PERMISSION_MODES } from '../src/shared/native-permissions';

test('default and unknown modes never silently authorize approval-required tools', () => {
  for (const mode of ['default', 'future'] as typeof NATIVE_PERMISSION_MODES[number][]) {
    for (const tool of [{ name: 'apply_patch', risk: 'write' }, { name: 'run_command', risk: 'command' }, { name: 'mcp_remote', risk: 'write' }, { name: 'read_file', risk: 'read' }]) {
      assert.equal(nativeAutoApproves(mode, tool), false);
    }
  }
});

test('automatic edits authorize only known local file tools, never commands, MCP or sensitive reads', () => {
  for (const name of ['apply_patch', 'edit_file', 'apply_change_set']) assert.equal(nativeAutoApproves('acceptEdits', { name, risk: 'write' }), true);
  for (const tool of [{ name: 'apply_patch', risk: 'command' }, { name: 'run_command', risk: 'command' }, { name: 'start_command', risk: 'command' }, { name: 'mcp_stdio_startup', risk: 'command' }, { name: 'mcp_remote', risk: 'write' }, { name: 'read_file', risk: 'read' }]) {
    assert.equal(nativeAutoApproves('acceptEdits', tool), false);
  }
});

test('automatic tool mode authorizes tools but no mode bypasses a user question', () => {
  for (const tool of [{ name: 'apply_patch', risk: 'write' }, { name: 'run_command', risk: 'command' }, { name: 'mcp_remote', risk: 'write' }, { name: 'mcp_stdio_startup', risk: 'command' }, { name: 'read_file', risk: 'read' }]) {
    assert.equal(nativeAutoApproves('bypassPermissions', tool), true);
  }
  for (const mode of NATIVE_PERMISSION_MODES) assert.equal(nativeAutoApproves(mode, { name: 'ask_user', risk: 'read' }), false);
});

test('model instructions match the configured permission policy', () => {
  assert.match(nativePermissionInstructions('default'), /individual approval/);
  assert.match(nativePermissionInstructions('acceptEdits'), /Commands, external MCP calls, sensitive reads/);
  assert.match(nativePermissionInstructions('bypassPermissions'), /without individual prompts/);
});

test('changing global runtime defaults cannot escalate an existing session permission mode', () => {
  const session = { schemaVersion: 1, options: { runtimePolicy: 'defaults', permissionMode: 'default', maxToolCalls: 60 } };
  const defaults = { schemaVersion: 1, options: { permissionMode: 'bypassPermissions', maxToolCalls: 100 } };
  const resolved = resolveNativeRuntimeConfig(session, defaults);
  assert.equal(resolved.options.permissionMode, 'default');
  assert.equal(resolved.options.maxToolCalls, 100);
  assert.equal(session.options.maxToolCalls, 60);
});
