import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAiService, extractAttachment, ProviderError, UserInputError } from './ai-service.mjs';
import { checkCloudKnowledgeConnection, cloudKnowledgeConfigured, loadCloudCourseDocuments, saveCloudCourseDocuments } from './cloud-knowledge.mjs';

const app = express();
app.use(express.json({ limit: '24mb' }));

const port = Number(process.env.API_PORT || process.env.PORT || 8787);
const ai = createAiService({
  apiKey: process.env.GEMINI_API_KEY || '',
  model: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
});

app.get('/api/health', async (_request, response) => {
  const [provider, cloudKnowledge] = await Promise.all([
    ai.health(),
    checkCloudKnowledgeConnection(),
  ]);
  response.json({
    ok: true,
    providerConfigured: provider.configured,
    provider: provider.provider,
    model: provider.model,
    cloudKnowledgeConfigured: cloudKnowledgeConfigured(),
    cloudKnowledge,
    message: provider.configured
      ? ''
      : 'Google Gemini is not configured. Add GEMINI_API_KEY in Vercel Environment Variables to enable cloud AI.',
  });
});

app.post('/api/extract', async (request, response) => {
  try {
    const extracted = await extractAttachment(request.body?.attachment);
    response.json({
      name: extracted.name,
      kind: extracted.kind,
      text: extracted.kind === 'text' ? extracted.text : '',
    });
  } catch (error) {
    if (error instanceof UserInputError) {
      return response.status(error.status).json({ error: error.code, message: error.message });
    }
    console.error('Document extraction failed:', error);
    return response.status(500).json({
      error: 'document_extraction_failed',
      message: 'The document could not be read. Check the file and try again.',
    });
  }
});

app.post('/api/admin/course-materials', async (request, response) => {
  const expectedToken = process.env.COURSE_IMPORT_TOKEN || '';
  const suppliedToken = request.get('authorization') || '';
  if (!expectedToken || suppliedToken !== `Bearer ${expectedToken}`) {
    return response.status(401).json({ error: 'unauthorized', message: 'A valid course import token is required.' });
  }
  const entries = request.body?.documents;
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 10) {
    return response.status(400).json({ error: 'invalid_import_batch', message: 'Send between 1 and 10 documents per batch.' });
  }
  try {
    const documents = [];
    for (const entry of entries) {
      const extracted = await extractAttachment(entry?.attachment);
      if (extracted.kind !== 'text') {
        throw new UserInputError('text_document_required', 'The course library importer accepts text-based PDF, DOCX, TXT, and MD files.');
      }
      documents.push({
        subjectId: entry.subjectId,
        subjectLabel: entry.subjectLabel,
        name: entry.name || extracted.name,
        chapter: entry.chapter,
        materialType: entry.materialType,
        text: extracted.text,
        pageCount: (extracted.text.match(/\[Page \d+\]/g) || []).length,
      });
    }
    const result = await saveCloudCourseDocuments(documents);
    return response.status(201).json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof UserInputError) {
      return response.status(error.status).json({ error: error.code, message: error.message });
    }
    console.error('Cloud course import failed:', error);
    return response.status(503).json({ error: 'cloud_import_unavailable', message: error.message || 'Cloud import is not configured.' });
  }
});

app.post('/api/chat', async (request, response) => {
  const {
    message = '',
    subjectId,
    mode = 'study',
    language = 'ar',
    history = [],
    attachment,
    courseDocuments = [],
  } = request.body ?? {};

  if (typeof message !== 'string' || message.length > 12_000) {
    return response.status(400).json({ error: 'invalid_message', message: 'Enter a question of 12,000 characters or fewer.' });
  }
  if (!message.trim() && !attachment) {
    return response.status(400).json({ error: 'message_required', message: 'Enter a question or attach a supported file.' });
  }
  if (typeof subjectId !== 'string' || subjectId.length > 120 || !['ar', 'en'].includes(language)) {
    return response.status(400).json({ error: 'invalid_request', message: 'Select a valid subject and response language.' });
  }
  if (!['quick', 'study', 'professor'].includes(mode)) {
    return response.status(400).json({ error: 'invalid_mode', message: 'Select a valid response mode.' });
  }
  if (!Array.isArray(history) || history.length > 50) {
    return response.status(400).json({ error: 'invalid_history', message: 'The conversation is too long. Start a new chat or clear saved history.' });
  }
  if (!Array.isArray(courseDocuments) || courseDocuments.length > 20) {
    return response.status(400).json({ error: 'invalid_course_materials', message: 'Select fewer course documents and try again.' });
  }
  const totalCourseText = courseDocuments.reduce(
    (total, item) => total + (typeof item?.text === 'string' ? item.text.length : 0),
    0,
  );
  if (totalCourseText > 1_000_000) {
    return response.status(413).json({ error: 'course_materials_too_large', message: 'The selected course materials are too large to search in one request.' });
  }

  try {
    // Cloud knowledge is an enhancement, not a dependency for the AI tutor.
    // If Supabase is temporarily unavailable or its credentials need attention,
    // keep Gemini and any user-provided local course documents working.
    let cloudDocuments = [];
    try {
      cloudDocuments = await loadCloudCourseDocuments(subjectId);
    } catch (cloudError) {
      console.warn(
        'Cloud course materials unavailable; continuing with chat and request materials.',
        cloudError instanceof Error ? cloudError.message : 'unknown_cloud_error',
      );
    }
    const result = await ai.reply({
      message,
      subjectId,
      mode,
      language,
      history,
      attachment,
      courseDocuments: [...cloudDocuments, ...courseDocuments],
    });
    return response.json(result);
  } catch (error) {
    if (error instanceof UserInputError) {
      return response.status(error.status).json({ error: error.code, message: error.message });
    }
    if (error instanceof ProviderError) {
      console.error('Gemini request failed:', error.code);
      return response.status(error.status).json({ error: error.code, message: error.message });
    }
    console.error('Unexpected chat request failure:', error);
    return response.status(500).json({
      error: 'chat_internal_error',
      message: 'The chat service encountered an unexpected error. Please retry.',
    });
  }
});

// Production: serve the built web app from the same process (Vite only proxies /api during development).
const distDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
if (existsSync(path.join(distDir, 'index.html'))) {
  app.use(express.static(distDir, { index: false, maxAge: '1h' }));
  app.get(/^\/(?!api\/).*/, (_request, response) => {
    response.setHeader('Cache-Control', 'no-cache');
    response.sendFile(path.join(distDir, 'index.html'));
  });
}

app.use((error, _request, response, _next) => {
  if (error instanceof SyntaxError && 'body' in error) {
    return response.status(400).json({ error: 'invalid_json', message: 'The request body is not valid JSON.' });
  }
  if (error?.type === 'entity.too.large') {
    return response.status(413).json({ error: 'request_too_large', message: 'The request is too large. Keep each file at or below 15 MB.' });
  }
  console.error('Unhandled API error:', error);
  return response.status(500).json({ error: 'server_error', message: 'The server could not complete this request.' });
});

// On Vercel the app is imported by api/index.mjs as a serverless function; everywhere else it listens normally.
if (!process.env.VERCEL) {
  app.listen(port, '0.0.0.0', () => console.log(`UNI GENIUS API listening on 0.0.0.0:${port}`));
}

export default app;
