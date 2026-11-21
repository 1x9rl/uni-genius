import { buildEngineeringPrompt, extractAttachment, retrieveCoursePassages } from './ai-service.mjs';

export function createGroqService({ apiKey = '', model = 'qwen/qwen3.8-27b', fetchImpl = fetch }) {
  const groqKey = apiKey.trim();

  async function health() {
    return { available: Boolean(groqKey), configured: Boolean(groqKey), provider: 'Groq', model };
  }

  async function reply({ message, subjectId, mode = 'study', language = 'ar', history = [], attachment, courseDocuments = [] }) {
    if (!groqKey) {
      const error = new Error('Groq fallback is not configured. Add GROQ_API_KEY in Vercel Environment Variables.');
      error.code = 'groq_not_configured';
      error.status = 503;
      throw error;
    }

    const extracted = attachment ? await extractAttachment(attachment) : null;
    const documents = Array.isArray(courseDocuments) ? courseDocuments.slice(0, 200) : [];
    if (extracted?.kind === 'text') documents.unshift({ name: extracted.name, text: extracted.text });
    const question = typeof message === 'string' ? message.trim() : '';
    const retrieval = retrieveCoursePassages(question, documents);
    const userPrompt = question || (language === 'ar'
      ? 'حل المسألة الهندسية الظاهرة في الملف المرفق، واشرح خطواتك.'
      : 'Solve the engineering question in the attached file and explain your steps.');

    let userContent = userPrompt;
    if (retrieval.passages.length) {
      userContent += '\n\nRetrieved passages from the student uploaded course materials. Use these passages first and cite only their exact source labels:\n\n' + retrieval.passages.join('\n\n');
    }
    if (extracted?.kind === 'image') {
      userContent = [
        { type: 'text', text: userContent },
        { type: 'image_url', image_url: { url: extracted.dataUrl } },
      ];
    }

    const messages = [
      { role: 'system', content: buildEngineeringPrompt({ subjectId, mode, language }) },
      ...(Array.isArray(history) ? history.slice(-16)
        .filter((item) => item && (item.role === 'user' || item.role === 'assistant') && typeof item.text === 'string')
        .map((item) => ({ role: item.role, content: item.text.slice(0, 8000) })) : []),
      { role: 'user', content: userContent },
    ];

    let response;
    try {
      response = await fetchImpl('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + groqKey },
        body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: 2500 }),
        signal: AbortSignal.timeout(25_000),
      });
    } catch {
      const error = new Error('Groq could not be reached. Please retry shortly.');
      error.code = 'groq_unreachable';
      error.status = 502;
      throw error;
    }

    let body = {};
    try { body = await response.json(); } catch { body = {}; }
    if (!response.ok) {
      const error = new Error(response.status === 429
        ? 'Groq free usage limit was reached. Please retry later.'
        : 'Groq could not complete the request. Check the GROQ_API_KEY and selected model.');
      error.code = response.status === 429 ? 'groq_rate_limited' : 'groq_provider_error';
      error.status = response.status === 429 ? 429 : 502;
      console.error('Groq API response error', { httpStatus: response.status, providerMessage: body.error?.message?.slice(0, 300) });
      throw error;
    }

    const answer = body.choices?.[0]?.message?.content;
    if (typeof answer !== 'string' || !answer.trim()) {
      const error = new Error('Groq returned an empty answer. Please retry.');
      error.code = 'groq_empty_response';
      error.status = 502;
      throw error;
    }
    return { answer: answer.trim(), model, provider: 'Groq', sources: retrieval.sources };
  }
  return { health, reply };
}
