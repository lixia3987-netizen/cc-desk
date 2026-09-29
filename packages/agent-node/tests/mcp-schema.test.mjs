import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertMcpInputSchema, assertMcpOutputSchema, assertMcpToolInput, assertMcpToolOutput } from '../dist/mcp-schema.js';

const schema = (property, extra = {}) => ({ type: 'object', properties: { value: property }, required: ['value'], additionalProperties: false, ...extra });
const accepted = (rule, value) => assert.doesNotThrow(() => assertMcpToolInput(schema(rule), { value }));
const rejected = (rule, value) => assert.throws(() => assertMcpToolInput(schema(rule), { value }), /arguments/);

test('object schemas enforce required, extra properties, nested types and own-property names', () => {
  const rule = { type: 'object', properties: { amount: { type: 'integer' }, nested: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } }, required: ['amount', 'nested'], additionalProperties: false };
  assertMcpToolInput(rule, { amount: 1, nested: { ok: true } });
  for (const input of [{ amount: 'oops', extra: true }, { amount: 1 }, { amount: 1.5, nested: { ok: true } }, { amount: 1, nested: { ok: 'yes' } }, { amount: 1, nested: { ok: true, extra: 2 } }, { amount: 1, nested: { ok: true }, extra: false }]) assert.throws(() => assertMcpToolInput(rule, input));
  accepted({ type: 'object', additionalProperties: { type: 'integer' }, minProperties: 1, maxProperties: 2 }, { a: 1 });
  rejected({ type: 'object', additionalProperties: { type: 'integer' } }, { a: '1' });
  rejected({ type: 'object', minProperties: 1 }, {});
  rejected({ type: 'object', maxProperties: 1 }, { a: 1, b: 2 });
  const special = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"integer"}},"required":["__proto__"],"additionalProperties":false}');
  assertMcpToolInput(special, JSON.parse('{"__proto__":1}'));
  assert.throws(() => assertMcpToolInput(special, {}));
  assert.throws(() => assertMcpToolInput(special, JSON.parse('{"__proto__":"wrong"}')));
});

test('type unions preserve null, enforce booleans and reject coercion or nonfinite JSON', () => {
  for (const value of ['yes', null]) accepted({ type: ['string', 'null'] }, value);
  for (const value of [0, false, [], {}]) rejected({ type: ['string', 'null'] }, value);
  accepted({ type: 'boolean' }, false);
  rejected({ type: 'boolean' }, 'false');
  accepted({ type: 'number' }, 1.5);
  accepted({ type: 'integer' }, 1);
  rejected({ type: 'integer' }, 1.5);
  for (const value of [NaN, Infinity, undefined]) rejected({}, value);
  assert.throws(() => assertMcpToolInput({ type: 'object' }, []));
});

test('numeric limits use the declared inclusive and exclusive boundaries', () => {
  const inclusive = { type: 'number', minimum: 1, maximum: 2 };
  for (const value of [1, 1.5, 2]) accepted(inclusive, value);
  for (const value of [0, 3]) rejected(inclusive, value);
  const exclusive = { type: 'number', exclusiveMinimum: 1, exclusiveMaximum: 2 };
  accepted(exclusive, 1.5);
  for (const value of [1, 2]) rejected(exclusive, value);
});

test('string length counts Unicode code points and array items/count/uniqueness are enforced', () => {
  accepted({ type: 'string', minLength: 1, maxLength: 1 }, '🌍');
  rejected({ type: 'string', minLength: 1 }, '');
  rejected({ type: 'string', maxLength: 1 }, '🌍x');
  const array = { type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: 2, uniqueItems: true };
  accepted(array, [1, 2]);
  for (const value of [[], [1, 1], [1, '2'], [1, 2, 3]]) rejected(array, value);
  rejected({ type: 'array', uniqueItems: true }, [{ a: 1, b: 2 }, { b: 2, a: 1 }]);
  accepted({ type: 'array', items: false }, []);
  rejected({ type: 'array', items: false }, [1]);
  accepted({ type: 'object', properties: { forbidden: false } }, {});
  rejected({ type: 'object', properties: { forbidden: false } }, { forbidden: null });
});

test('enum and const compare complete JSON values independent of property order', () => {
  accepted({ enum: ['x', null, { a: 1, b: [true] }] }, { b: [true], a: 1 });
  rejected({ enum: ['x', null] }, 'null');
  accepted({ const: [1, { ok: true }] }, [1, { ok: true }]);
  rejected({ const: [1, { ok: true }] }, [1, { ok: true, extra: 1 }]);
});

test('bounded schema composition enforces every branch and exact oneOf matching', () => {
  const all = { allOf: [{ type: 'integer' }, { minimum: 1 }, { maximum: 3 }] };
  accepted(all, 2); rejected(all, 0); rejected(all, 2.5);
  const any = { anyOf: [{ type: 'string', minLength: 2 }, { type: 'integer', minimum: 1 }] };
  accepted(any, 'ok'); accepted(any, 1); rejected(any, 'x'); rejected(any, null);
  const one = { oneOf: [{ type: 'number' }, { type: 'integer' }] };
  accepted(one, 1.5); rejected(one, 1); rejected(one, '1');
  accepted({ not: { const: 'blocked' } }, 'allowed'); rejected({ not: { const: 'blocked' } }, 'blocked');
  accepted({ allOf: [true, { not: false }] }, null);
  rejected({ anyOf: [false] }, null);
});

test('unsupported validation keywords fail closed even inside otherwise unreachable branches', () => {
  for (const keyword of ['$ref', '$defs', '$id', 'pattern', 'format', 'multipleOf', 'contains', 'prefixItems', 'unevaluatedProperties', 'if', 'then', 'else', 'dependentRequired', 'propertyNames', 'patternProperties', 'customValidation']) {
    assert.throws(() => assertMcpInputSchema(schema({ [keyword]: 'unsupported' })), /Schema/);
    assert.throws(() => assertMcpInputSchema(schema({ anyOf: [true, { [keyword]: 'unsupported' }] })), /Schema/);
  }
});

test('malformed keyword shapes and unsupported root schemas are excluded before exposure', () => {
  const invalid = [{ type: 'unknown' }, { type: [] }, { type: ['string', 'string'] }, { properties: [] }, { properties: { x: 1 } }, { required: 'x' }, { required: [1] }, { required: ['x', 'x'] }, { items: [] }, { additionalProperties: 0 }, { minimum: '1' }, { exclusiveMinimum: true }, { minItems: -1 }, { maxLength: 1.5 }, { uniqueItems: 1 }, { enum: [] }, { enum: {} }, { anyOf: [] }, { oneOf: [1] }, { not: [] }, { examples: {} }, { title: 1 }];
  for (const value of invalid) assert.throws(() => assertMcpInputSchema(schema(value)), /Schema/);
  for (const value of [true, [], {}, { type: 'array' }, { type: ['object', 'null'] }]) assert.throws(() => assertMcpInputSchema(value), /Schema/);
  assertMcpInputSchema(schema({ type: 'string', title: 'Name', description: 'Plain name', default: 'default', examples: ['sample'], readOnly: true, writeOnly: false, deprecated: false, 'x-mcp-header': 'Name' }, { $schema: 'https://json-schema.org/draft/2020-12/schema' }));
});

test('schema/input byte, depth and validation work budgets stop oversized or combinatorial cases', () => {
  assert.throws(() => assertMcpInputSchema(schema({ description: 'x'.repeat(16384) })), /Schema/);
  let nested = { type: 'string' }; for (let index = 0; index < 35; index++) nested = { type: 'object', properties: { child: nested } };
  assert.throws(() => assertMcpInputSchema(schema(nested)), /Schema/);
  assert.throws(() => assertMcpInputSchema(schema({ anyOf: Array.from({ length: 33 }, () => ({})) })), /Schema/);
  rejected({ type: 'string' }, 'x'.repeat(65536));
  rejected({ type: 'array', uniqueItems: true }, Array.from({ length: 300 }, (_, index) => index));
  const cyclic = {}; cyclic.cycle = cyclic;
  assert.throws(() => assertMcpToolInput({ type: 'object' }, cyclic), /arguments/);
});

test('declared dialect is restricted to the supported JSON Schema 2020-12 semantics', () => {
  for (const dialect of ['https://json-schema.org/draft/2020-12/schema', 'https://json-schema.org/draft/2020-12/schema#']) assertMcpInputSchema({ type: 'object', $schema: dialect });
  for (const dialect of ['https://example.test/custom', 'http://json-schema.org/draft-07/schema#', 'https://json-schema.org/draft/2019-09/schema', '']) assert.throws(() => assertMcpInputSchema({ type: 'object', $schema: dialect }), /Schema/);
});


test('output schemas support arbitrary JSON roots while input roots remain objects', () => {
  const cases = [
    [{ type: 'array', items: { type: 'integer' }, minItems: 1 }, [1, 2], [1, '2']],
    [{ type: 'string', minLength: 2 }, 'ok', 'x'],
    [{ type: 'integer', minimum: 1 }, 1, 1.5],
    [{ type: 'boolean' }, false, 'false'],
    [{ type: 'null' }, null, {}],
    [{ anyOf: [{ type: 'string' }, { type: 'null' }] }, null, false],
  ];
  for (const [rule, valid, invalid] of cases) {
    assertMcpOutputSchema(rule);
    assertMcpToolOutput(rule, valid);
    assert.throws(() => assertMcpToolOutput(rule, invalid), /structured output/);
    assert.throws(() => assertMcpInputSchema(rule), /Schema/);
  }
  for (const value of [null, true, 1, 'x', [], {}]) assertMcpToolOutput({}, value);
});

test('output validation preserves unsupported-keyword, finite JSON and byte/work limits', () => {
  for (const rule of [{ type: 'string', pattern: '.*' }, { $ref: 'https://never-fetch.invalid' }, true, []]) assert.throws(() => assertMcpOutputSchema(rule), /Schema/);
  for (const value of [undefined, NaN, Infinity, 'x'.repeat(65536)]) assert.throws(() => assertMcpToolOutput({}, value), /structured output/);
  assert.throws(() => assertMcpToolOutput({ type: 'array', uniqueItems: true }, Array.from({ length: 300 }, (_, index) => index)), /structured output/);
  const cyclic = []; cyclic.push(cyclic);
  assert.throws(() => assertMcpToolOutput({ type: 'array' }, cyclic), /structured output/);
});
