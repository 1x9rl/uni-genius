import { neon } from '@neondatabase/serverless';

const MAX_DOCUMENTS_PER_SUBJECT = 200;
const MAX_TEXT_CHARS = 120_000;

let cachedSql;
let cachedUrl = '';

function config() {
  const url = (process.env.DATABASE_URL || '').trim();
  return url ? { url } : null;
}

function database() {
  const cfg = config();
  if (!cfg) return null;
  if (!cachedSql || cachedUrl !== cfg.url) {
    cachedSql = neon(cfg.url);
    cachedUrl = cfg.url;
  }
  return cachedSql;
}

export function cloudKnowledgeConfigured() {
  return Boolean(config());
}

export async function checkCloudKnowledgeConnection() {
  const sql = database();
  if (!sql) return { configured: false, connected: false, tableAvailable: false };
  try {
    const rows = await sql`
      SELECT to_regclass('public.course_documents') AS table_name
    `;
    const tableAvailable = Boolean(rows[0]?.table_name);
    return {
      configured: true,
      connected: true,
      tableAvailable,
      ...(tableAvailable ? {} : { error: 'course_documents_table_missing' }),
    };
  } catch (error) {
    console.error('Neon database health check failed', {
      name: error instanceof Error ? error.name : 'UnknownError',
      code: error && typeof error === 'object' && 'code' in error ? error.code : undefined,
    });
    return {
      configured: true,
      connected: false,
      tableAvailable: false,
      error: 'database_connection_failed',
    };
  }
}

export async function saveCloudCourseDocuments(documents) {
  const sql = database();
  if (!sql) throw new Error('Cloud knowledge storage is not configured. Add DATABASE_URL on the server.');
  if (!Array.isArray(documents) || !documents.length || documents.length > 50) {
    throw new Error('Send between 1 and 50 course documents per import batch.');
  }

  const rows = documents.map((doc) => ({
    subject_id: doc.subjectId,
    subject_label: doc.subjectLabel || doc.subjectId,
    name: String(doc.name || 'Untitled').slice(0, 180),
    chapter: String(doc.chapter || '').slice(0, 120),
    material_type: String(doc.materialType || 'course_material').slice(0, 40),
    content_text: String(doc.text || '').slice(0, MAX_TEXT_CHARS),
    page_count: Number.isInteger(doc.pageCount) ? doc.pageCount : 0,
  }));

  for (const row of rows) {
    if (!/^[a-z0-9_-]{1,120}$/i.test(row.subject_id || '') || !row.content_text.trim()) {
      throw new Error('Each document needs a valid subject ID and extracted text.');
    }
  }

  let imported = 0;
  for (const row of rows) {
    await sql`
      INSERT INTO public.course_documents
        (subject_id, subject_label, name, chapter, material_type, content_text, page_count)
      VALUES
        (${row.subject_id}, ${row.subject_label}, ${row.name}, ${row.chapter},
         ${row.material_type}, ${row.content_text}, ${row.page_count})
    `;
    imported += 1;
  }
  return { imported };
}

export async function loadCloudCourseDocuments(subjectId) {
  const sql = database();
  if (!sql) return [];
  if (typeof subjectId !== 'string' || !/^[a-z0-9_-]{1,120}$/i.test(subjectId)) return [];

  const rows = await sql`
    SELECT subject_id, subject_label, name, chapter, content_text, page_count
    FROM public.course_documents
    WHERE subject_id = ${subjectId}
    ORDER BY created_at DESC
    LIMIT ${MAX_DOCUMENTS_PER_SUBJECT}
  `;

  return rows.map((row) => ({
    name: row.name,
    subject: row.subject_label,
    chapter: row.chapter,
    text: row.content_text,
  }));
}
