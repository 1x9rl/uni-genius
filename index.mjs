import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAiService, extractAttachment, ProviderError, UserInputError } from './ai-service.mjs';
import { createGroqService } from './groq-service.mjs';
import { checkCloudKnowledgeConnection, cloudKnowledgeConfigured, loadCloudCourseDocuments, saveCloudCourseDocuments } from './cloud-knowledge.mjs';

const app = express();
app.use(express.json({ limit: '24mb' }));

const port = Number(process.env.API_PORT || process.env.PORT || 8787);
const ai = createAiService({
  apiKey: process.env.GEMINI_API_KEY || '',
  model: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
});
const groq = createGroqService({
  apiKey: process.env.GROQ_API_KEY || '',
  model: process.env.GROQ_MODEL || 'qwen/qwen3.8-27b',
});

app.get('/api/health', async (_request, response) => {
  const [provider, fallbackProvider, cloudKnowledge] = await Promise.all([
    ai.health(),
    groq.health(),
    checkCloudKnowledgeConnection(),
  ]);
  response.json({
    ok: true,
    providerConfigured: provider.configured || fallbackProvider.configured,
    provider: provider.configured ? provider.provider : fallbackProvider.provider,
    model: provider.configured ? provider.model : fallbackProvider.model,
    fallbackConfigured: fallbackProvider.configured,
    fallbackProvider: fallbackProvider.provider,
    cloudKnowledgeConfigured: cloudKnowledgeConfigured(),
    cloudKnowledge,
    message: provider.configured || fallbackProvider.configured
      ? ''
      : 'No AI provider is configured. Add GEMINI_API_KEY or GROQ_API_KEY in Vercel Environment Variables.',
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

app.post('/api/transcribe', express.raw({
  type: (request) => /^audio\\//i.test(request.headers['content-type'] || ''),
  limit: '15mb',
}), async (request, response) => {
  if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
    return response.status(400).json({ error: 'empty_audio', message: 'No audio was received. Please record again.' });
  }
  try {
    const mimeType = (request.get('content-type') || 'audio/webm').split(';')[0].trim();
    const language = request.query.language === 'en' ? 'en' : 'ar';
    const result = await groq.transcribe({ audioBuffer: request.body, mimeType, language });
    return response.json({ ok: true, ...result });
  } catch (error) {
    console.error('Speech transcription failed:', error.code || 'unknown_transcription_error');
    return response.status(error.status || 502).json({
      error: error.code || 'transcription_failed',
      message: error.message || 'Speech recognition failed. Please try again.',
    });
  }
});

app.post('/api/admin/course-materials-text', async (request, response) => {
  const expectedToken = process.env.COURSE_IMPORT_TOKEN || '';
  const suppliedToken = request.get('authorization') || '';
  if (!expectedToken || suppliedToken !== `Bearer ${expectedToken}`) {
    return response.status(401).json({ error: 'unauthorized', message: 'A valid course import token is required.' });
  }
  try {
    const { name, subjectId, subjectLabel, chapter, materialType, text, pageCount } = request.body || {};
    if (typeof text !== 'string' || !text.trim()) {
      return response.status(400).json({ error: 'empty_document', message: 'No selectable text was found in this PDF. Scanned PDFs need OCR before import.' });
    }
    if (text.length > 120_000) {
      return response.status(413).json({ error: 'extracted_text_too_large', message: 'The extracted text is too large. Split this PDF into smaller parts.' });
    }
    const result = await saveCloudCourseDocuments([{
      subjectId: typeof subjectId === 'string' ? subjectId : '',
      subjectLabel: typeof subjectLabel === 'string' ? subjectLabel : subjectId,
      name: typeof name === 'string' ? name.slice(0, 180) : 'course-material.pdf',
      chapter: typeof chapter === 'string' ? chapter : '',
      materialType: typeof materialType === 'string' ? materialType : 'lecture',
      text: text.trim(),
      pageCount: Number.isInteger(pageCount) ? pageCount : 0,
    }]);
    return response.status(201).json({ ok: true, ...result });
  } catch (error) {
    console.error('Cloud course text import failed:', error);
    return response.status(503).json({ error: 'cloud_import_unavailable', message: error.message || 'Cloud import is not configured.' });
  }
});

app.post('/api/admin/course-materials', express.raw({ type: 'application/octet-stream', limit: '15mb' }), async (request, response) => {
  const expectedToken = process.env.COURSE_IMPORT_TOKEN || '';
  const suppliedToken = request.get('authorization') || '';
  if (!expectedToken || suppliedToken !== `Bearer ${expectedToken}`) {
    return response.status(401).json({ error: 'unauthorized', message: 'A valid course import token is required.' });
  }
  if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
    return response.status(400).json({ error: 'empty_upload', message: 'The uploaded file is empty. Select it again.' });
  }
  try {
    const name = typeof request.query.name === 'string' ? request.query.name.slice(0, 180) : 'course-material.pdf';
    const extracted = await extractAttachment({
      name,
      mimeType: 'application/octet-stream',
      dataBase64: request.body.toString('base64'),
    });
    if (extracted.kind !== 'text') {
      throw new UserInputError('text_document_required', 'The course library importer accepts text-based PDF, DOCX, TXT, and MD files.');
    }
    const subjectId = typeof request.query.subjectId === 'string' ? request.query.subjectId : '';
    const subjectLabel = typeof request.query.subjectLabel === 'string' ? request.query.subjectLabel : subjectId;
    const chapter = typeof request.query.chapter === 'string' ? request.query.chapter : '';
    const materialType = typeof request.query.materialType === 'string' ? request.query.materialType : 'lecture';
    const result = await saveCloudCourseDocuments([{
      subjectId, subjectLabel, name, chapter, materialType,
      text: extracted.text,
      pageCount: (extracted.text.match(/\\[Page \\d+\\]/g) || []).length,
    }]);
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
    const aiRequest = {
      message,
      subjectId,
      mode,
      language,
      history,
      attachment,
      courseDocuments: [...cloudDocuments, ...courseDocuments],
    };
    let result;
    try {
      result = await ai.reply(aiRequest);
    } catch (geminiError) {
      if (!(await groq.health()).configured) throw geminiError;
      console.warn('Gemini unavailable; switching to Groq fallback.', {
        code: geminiError instanceof Error ? geminiError.code : 'unknown_provider_error',
      });
      result = await groq.reply(aiRequest);
      result.fallback = true;
    }
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
