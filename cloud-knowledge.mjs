const MAX_DOCUMENTS_PER_SUBJECT = 200;
const MAX_TEXT_CHARS = 120_000;

function config() {
  const url = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  return url && key ? { url, key } : null;
}

function headers(key, extra = {}) {
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...extra };
}

export function cloudKnowledgeConfigured() {
  return Boolean(config());
}

export async function saveCloudCourseDocuments(documents, fetchImpl = fetch) {
  const cfg = config();
  if (!cfg) throw new Error('Cloud knowledge storage is not configured. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
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
  const response = await fetchImpl(`${cfg.url}/rest/v1/course_documents`, {
    method: 'POST',
    headers: headers(cfg.key, { Prefer: 'return=representation' }),
    body: JSON.stringify(rows),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    console.error('Cloud course import failed', { status: response.status, detail: detail.slice(0, 300) });
    throw new Error('Could not save course materials to the cloud database. Check the database migration and server credentials.');
  }
  const saved = await response.json();
  return { imported: Array.isArray(saved) ? saved.length : rows.length };
}

export async function loadCloudCourseDocuments(subjectId, fetchImpl = fetch) {
  const cfg = config();
  if (!cfg) return [];
  const query = new URLSearchParams({
    select: 'subject_id,subject_label,name,chapter,content_text,page_count',
    subject_id: `eq.${subjectId}`,
    order: 'created_at.desc',
    limit: String(MAX_DOCUMENTS_PER_SUBJECT),
  });
  const response = await fetchImpl(`${cfg.url}/rest/v1/course_documents?${query}`, {
    headers: headers(cfg.key),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    console.error('Cloud course retrieval failed', { status: response.status, detail: detail.slice(0, 300) });
    throw new Error('Could not retrieve this subject’s cloud course materials.');
  }
  const rows = await response.json();
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    name: row.name,
    subject: row.subject_label,
    chapter: row.chapter,
    text: row.content_text,
  }));
}
