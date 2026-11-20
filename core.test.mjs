import test from 'node:test';
import assert from 'node:assert/strict';
import { solve } from './.core-test/solver.js';

test('density calculator returns mass divided by volume', () => {
  const result = solve('density', { mass: '10', volume: '2' });
  assert.equal(result.result, '5.00000');
  assert.equal(result.unit, 'kg/m³');
});

test('Mach calculator returns velocity divided by speed of sound', () => {
  const result = solve('mach', { velocity: '340', sound: '340' });
  assert.equal(result.result, '1.00000');
});

test('compression ratio rejects non-positive volumes', () => {
  assert.throws(() => solve('compression', { v1: '10', v2: '0' }), /موجبة/);
});
