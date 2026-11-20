import test from 'node:test';
import assert from 'node:assert/strict';
import { createAiService, buildEngineeringPrompt, retrieveCoursePassages, ProviderError } from './ai-service.mjs';

test('engineering prompt identifies the selected subject and teaching mode', () => {
  const prompt = buildEngineeringPrompt({ subjectId: 'gasdyn', mode: 'study', language: 'ar' });
  assert.match(prompt, /Gas Dynamics/);
  assert.match(prompt, /Arabic/);
  assert.match(prompt, /step by step/i);
});

test('course retrieval returns matching student-provided passages and source labels', () => {
  const result = retrieveCoursePassages('Mach number velocity', [
    { name: 'Gas Dynamics.pdf', subject: 'Gas Dynamics', text: '[Page 4]\nThe Mach number is the ratio of flow velocity to the local speed of sound.' },
  ]);
  assert.equal(result.passages.length, 1);
  assert.match(result.sources[0], /Gas Dynamics\.pdf/);
  assert.match(result.sources[0], /page 4/);
});

test('health reports Gemini as unconfigured when no key is supplied', async () => {
  const service = createAiService({ apiKey: '' });
  const health = await service.health();
  assert.equal(health.configured, false);
  assert.equal(health.provider, 'Google Gemini');
});

test('chat refuses cloud requests when the Gemini key is missing', async () => {
  const service = createAiService({ apiKey: '' });
  await assert.rejects(
    service.reply({ message: 'Explain stress and strain', subjectId: 'manufacturing' }),
    (error) => error instanceof ProviderError && error.code === 'gemini_not_configured',
  );
});

test('chat sends a Gemini request and returns its answer', async () => {
  let requestedUrl = '';
  const service = createAiService({
    apiKey: 'test-key',
    model: 'gemini-test-model',
    fetchImpl: async (url) => {
      requestedUrl = String(url);
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'Stress is force per unit area.' }] } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  const result = await service.reply({
    message: 'Define stress',
    subjectId: 'manufacturing',
    language: 'en',
  });
  assert.match(requestedUrl, /gemini-test-model:generateContent/);
  assert.equal(result.answer, 'Stress is force per unit area.');
  assert.equal(result.model, 'gemini-test-model');
});
