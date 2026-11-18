import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import mammoth from 'mammoth';

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const MAX_EXTRACTED_CHARS = 60_000;
const MAX_HISTORY_MESSAGES = 16;
const MAX_HISTORY_CHARS = 8_000;

export class UserInputError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'UserInputError';
    this.code = code;
    this.status = 400;
  }
}

export class ProviderError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.status = status;
  }
}

function normalizeBase64File(attachment) {
  if (!attachment || typeof attachment !== 'object') {
    throw new UserInputError('invalid_attachment', 'The attached file could not be read. Please select it again.');
  }

  const { name, mimeType, dataBase64 } = attachment;
  if (typeof name !== 'string' || typeof mimeType !== 'string' || typeof dataBase64 !== 'string') {
    throw new UserInputError('invalid_attachment', 'The attached file is missing required data. Please select it again.');
  }
  if (dataBase64.length > Math.ceil(MAX_UPLOAD_BYTES * 4 / 3) + 8) {
    throw new UserInputError('attachment_too_large', 'Files must be 15 MB or smaller.');
  }

  const bytes = Buffer.from(dataBase64, 'base64');
  if (!bytes.length || bytes.length > MAX_UPLOAD_BYTES) {
    throw new UserInputError('attachment_too_large', 'The file is empty or larger than the 15 MB limit.');
  }

  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  const mime = mimeType.toLowerCase().split(';')[0].trim();
  return { name: name.slice(0, 180), extension, mime, bytes, dataBase64 };
}

export async function extractAttachment(attachment) {
  const { name, extension, mime, bytes, dataBase64 } = normalizeBase64File(attachment);

  if (['png', 'jpg', 'jpeg'].includes(extension) || ['image/png', 'image/jpeg'].includes(mime)) {
    const isPng = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if ((mime === 'image/png' || extension === 'png') && !isPng) {
      throw new UserInputError('invalid_image', 'That file is not a valid PNG image.');
    }
    if ((mime === 'image/jpeg' || ['jpg', 'jpeg'].includes(extension)) && !isJpeg) {
      throw new UserInputError('invalid_image', 'That file is not a valid JPEG image.');
    }
    const resolvedMime = isPng ? 'image/png' : 'image/jpeg';
    return {
      name,
      kind: 'image',
      dataUrl: `data:${resolvedMime};base64,${dataBase64}`,
      text: '',
    };
  }

  if (extension === 'txt' || extension === 'md' || ['text/plain', 'text/markdown'].includes(mime)) {
    const text = bytes.toString('utf8').replace(/\u0000/g, '').trim();
    if (!text) throw new UserInputError('empty_document', 'The text document is empty.');
    return { name, kind: 'text', text: text.slice(0, MAX_EXTRACTED_CHARS) };
  }

  if (extension === 'docx' || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    try {
      const result = await mammoth.extractRawText({ buffer: bytes });
      const text = result.value.trim();
      if (!text) throw new UserInputError('empty_document', 'No readable text was found in this Word document.');
      return { name, kind: 'text', text: text.slice(0, MAX_EXTRACTED_CHARS) };
    } catch (error) {
      if (error instanceof UserInputError) throw error;
      throw new UserInputError('document_extraction_failed', 'Could not read this Word document. Please try a valid .docx file.');
    }
  }

  if (extension === 'pdf' || mime === 'application/pdf') {
    try {
      const document = await getDocument({ data: new Uint8Array(bytes), useSystemFonts: true }).promise;
      const pages = [];
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        const content = await page.getTextContent();
        const pageText = content.items
          .map((item) => ('str' in item ? item.str : ''))
          .filter(Boolean)
          .join(' ')
          .trim();
        if (pageText) pages.push(`[Page ${pageNumber}]\n${pageText}`);
      }
      await document.destroy();
      const text = pages.join('\n\n').slice(0, MAX_EXTRACTED_CHARS);
      if (!text) {
        throw new UserInputError('pdf_contains_no_text', 'No selectable text was found in this PDF. For scanned pages, upload a clear PNG or JPEG image instead.');
      }
      return { name, kind: 'text', text };
    } catch (error) {
      if (error instanceof UserInputError) throw error;
      throw new UserInputError('pdf_extraction_failed', 'Could not extract text from this PDF. Try another PDF or upload a page as a PNG/JPEG image.');
    }
  }

  throw new UserInputError('unsupported_attachment', 'Supported files are PNG/JPEG images, text or Markdown, text-based PDFs, and .docx documents.');
}

export function buildEngineeringPrompt({ subjectId, mode, language }) {
  const subjects = {
    manufacturing: 'Manufacturing Processes',
    ice: 'Internal Combustion Engines',
    analysis: 'Mathematical Analysis',
    gasdyn: 'Gas Dynamics',
    manufacturing_lab: 'Manufacturing Lab',
    ice_lab: 'Engines Lab',
    gasdyn_lab: 'Gas Dynamics Lab',
  };
  const subject = subjects[subjectId] ?? 'Mechanical Engineering';
  const responseLanguage = language === 'ar' ? 'Arabic (clear, natural Iraqi-friendly Arabic)' : 'English';
  const teachingMode = mode === 'quick'
    ? 'Keep the answer concise while retaining essential assumptions and units.'
    : mode === 'professor'
      ? 'Give a thorough derivation, explain why each step is valid, and discuss relevant limitations.'
      : 'Teach step by step, defining the symbols and explaining each substitution.';

  return `You are UNI GENIUS, an engineering assistant for a third-year mechanical engineering student.
Current subject: ${subject}.
Answer in ${responseLanguage}. ${teachingMode}
For engineering problems, identify knowns and unknowns, state assumptions, define symbols, show the governing equation, substitute values with units, calculate carefully, and check dimensions and physical plausibility. Use SI units unless the user requests otherwise.
Read uploaded images as engineering questions: transcribe visible text and equations as needed, state any uncertain symbols, then solve only when the givens are sufficient.
When uploaded course passages are provided, answer from those passages first, cite only the source labels supplied with them, and never invent citations or page references. If the passages do not cover the topic, explicitly say "This topic was not found in your uploaded course materials." (translate that sentence into Arabic for an Arabic response), then put any optional general explanation under a clearly labeled "General engineering explanation" heading.
Never invent measurements or course-note content. Do not claim you inspected a file unless its contents are present in this request. If information is missing or an image is unclear, say exactly what is needed. Use Markdown and LaTeX for readable equations.`;
}

const COURSE_STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'what', 'when', 'where',
  'which', 'how', 'why', 'does', 'have', 'has', 'are', 'was', 'were', 'into',
  'about', 'show', 'explain', 'please', 'using', 'used', 'ماذا', 'ما', 'من',
  'في', 'على', 'عن', 'الى', 'إلى', 'هذا', 'هذه', 'كيف', 'اشرح', 'احسب',
  'مع', 'هو', 'هي', 'كان', 'كانت', 'كل',
]);

function normalizeTerm(term) {
  // Light Arabic normalisation so "المحرك" matches "محرك" and alef/ya variants match.
  let value = term
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[إأآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه');
  if (value.length > 4 && value.startsWith('ال')) value = value.slice(2);
  return value;
}

function searchTerms(text) {
  return new Set(
    (text.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])
      .filter((term) => !COURSE_STOP_WORDS.has(term))
      .map(normalizeTerm),
  );
}

// Split a document into page-aware passages of roughly 700 characters.
function documentPassages(text) {
  const passages = [];
  const pageParts = text.split(/(?=\[Page \d+\])/u);
  for (const part of pageParts) {
    const pageMatch = part.match(/^\[Page (\d+)\]\s*/);
    const page = pageMatch ? pageMatch[1] : undefined;
    const body = pageMatch ? part.slice(pageMatch[0].length) : part;
    const sentences = body.split(/(?<=[.!?؟])\s+|\n+/u).map((item) => item.trim()).filter(Boolean);
    let current = '';
    for (const sentence of sentences) {
      if (current && current.length + sentence.length > 700) {
        passages.push({ page, text: current });
        current = '';
      }
      current = current ? `${current} ${sentence}` : sentence;
    }
    if (current) passages.push({ page, text: current });
  }
  return passages;
}

export function retrieveCoursePassages(question, documents = []) {
  const terms = searchTerms(question);
  const matches = [];
  const safeDocuments = Array.isArray(documents) ? documents.slice(0, 20) : [];
  if (terms.size === 0) return { passages: [], sources: [] };

  for (const document of safeDocuments) {
    if (!document || typeof document.name !== 'string' || typeof document.text !== 'string') continue;
    const name = document.name.slice(0, 180);
    const text = document.text.slice(0, MAX_EXTRACTED_CHARS);

    for (const passage of documentPassages(text)) {
      const passageTerms = searchTerms(passage.text);
      const overlap = [...terms].filter((term) => passageTerms.has(term));
      if (overlap.length === 0) continue;
      const labels = [
        name,
        typeof document.subject === 'string' ? document.subject.slice(0, 100) : '',
        typeof document.chapter === 'string' ? document.chapter.slice(0, 100) : '',
        typeof document.semester === 'string' ? document.semester.slice(0, 60) : '',
        passage.page ? `page ${passage.page}` : '',
      ].filter(Boolean);
      matches.push({
        score: overlap.length / Math.max(1, terms.size),
        label: labels.join(' · '),
        text: passage.text.slice(0, 1800),
      });
    }
  }

  matches.sort((a, b) => b.score - a.score);
  const selected = [];
  const sources = [];
  const seenText = new Set();
  let contextLength = 0;
  for (const match of matches) {
    if (selected.length >= 8 || seenText.has(match.text)) continue;
    const passage = `[Source: ${match.label}]\n${match.text}`;
    if (contextLength + passage.length > 24_000) continue;
    selected.push(passage);
    seenText.add(match.text);
    if (!sources.includes(match.label)) sources.push(match.label);
    contextLength += passage.length;
  }
  return { passages: selected, sources };
}

function providerError(status, detail = '') {
  if (status === 401 || status === 403 || (status === 400 && /api key|credential|unauthori[sz]ed/i.test(detail))) {
    return new ProviderError(
      'gemini_invalid_credentials',
      'Google Gemini rejected the configured API key. Check GEMINI_API_KEY in Replit Secrets.',
      503,
    );
  }
  if (status === 429) {
    return new ProviderError('gemini_rate_limited', 'Gemini is temporarily rate-limiting requests. Wait a moment and retry.', 429);
  }
  if (status === 404) {
    return new ProviderError('gemini_model_unavailable', 'The configured Gemini model is unavailable for this API key.', 502);
  }
  return new ProviderError('gemini_provider_error', 'Gemini could not complete the request. Please retry shortly.', 502);
}

export function createAiService({ apiKey = '', model = 'gemini-2.5-flash', fetchImpl = fetch }) {
  const geminiKey = apiKey.trim();

  async function requestJson(requestBody) {
    let response;
    try {
      response = await fetchImpl(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(geminiKey ? { 'x-goog-api-key': geminiKey } : {}),
          },
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(30_000),
        },
      );
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw new ProviderError('gemini_timeout', 'Gemini took too long to respond. Retry when your connection is stable.', 504);
      }
      throw new ProviderError('gemini_unreachable', 'Could not reach Google Gemini. Check your internet connection and retry.', 502);
    }

    let responseBody = {};
    try {
      responseBody = await response.json();
    } catch {
      responseBody = {};
    }
    if (!response.ok) throw providerError(response.status, responseBody.error?.message ?? '');
    return responseBody;
  }

  async function health() {
    return { available: Boolean(geminiKey), configured: Boolean(geminiKey), provider: 'Google Gemini', model };
  }

  async function reply({
    message,
    subjectId,
    mode = 'study',
    language = 'ar',
    history = [],
    attachment,
    courseDocuments = [],
  }) {
    if (!geminiKey) {
      throw new ProviderError(
        'gemini_not_configured',
        'Google Gemini is not configured. Add GEMINI_API_KEY in Replit Secrets to enable cloud AI.',
        503,
      );
    }

    const extracted = attachment ? await extractAttachment(attachment) : null;
    const documents = Array.isArray(courseDocuments) ? courseDocuments.slice(0, 20) : [];
    if (extracted?.kind === 'text') {
      documents.unshift({ name: extracted.name, text: extracted.text });
    }
    const question = typeof message === 'string' ? message.trim() : '';
    const retrieval = retrieveCoursePassages(question, documents);
    const cleanHistory = Array.isArray(history)
      ? history.slice(-MAX_HISTORY_MESSAGES)
        .filter((item) => item && (item.role === 'user' || item.role === 'assistant') && typeof item.text === 'string')
        .map((item) => ({
          role: item.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: item.text.slice(0, MAX_HISTORY_CHARS) }],
        }))
      : [];

    const userPrompt = question || (language === 'ar'
      ? 'حل المسألة الهندسية الظاهرة في الملف المرفق، واشرح خطواتك.'
      : 'Solve the engineering question in the attached file and explain your steps.');
    const parts = [{ text: userPrompt }];
    if (retrieval.passages.length) {
      parts.push({
        text: `Retrieved passages from the student's uploaded course materials. Use only these passages for course-grounded claims and cite their exact source labels:\n\n${retrieval.passages.join('\n\n')}`,
      });
    }
    if (extracted?.kind === 'image') {
      const comma = extracted.dataUrl.indexOf(',');
      parts.push({
        inline_data: {
          mime_type: extracted.dataUrl.slice(5, extracted.dataUrl.indexOf(';')),
          data: extracted.dataUrl.slice(comma + 1),
        },
      });
    }

    const body = await requestJson({
      system_instruction: {
        parts: [{ text: buildEngineeringPrompt({ subjectId, mode, language }) }],
      },
      contents: [
        ...cleanHistory,
        { role: 'user', parts },
      ],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 2500,
      },
    });

    const text = body.candidates?.[0]?.content?.parts
      ?.map((part) => typeof part.text === 'string' ? part.text : '')
      .join('');
    if (typeof text !== 'string' || !text.trim()) {
      throw new ProviderError('gemini_empty_response', 'Gemini returned no answer. The request may have been blocked; revise it and retry.', 502);
    }
    return { answer: text.trim(), model, sources: retrieval.sources };
  }

  return { health, reply };
}
