import type { CourseDoc } from './CourseLibrary';

const DB_NAME = 'uni-genius-offline';
const STORE = 'course-documents';
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB unavailable'));
  });
}

export async function saveOfflineCourseDocs(subjectId: string, docs: CourseDoc[]): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const prefix = subjectId + ':';
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      const item = cursor.result;
      if (item) {
        if (String(item.key).startsWith(prefix)) item.delete();
        item.continue();
      } else {
        for (const doc of docs) store.put({ ...doc, id: prefix + doc.id, subjectId });
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Could not save offline materials'));
    tx.onabort = () => reject(tx.error || new Error('Offline save aborted'));
  });
  db.close();
}

export async function getOfflineCourseDocs(subjectId: string): Promise<CourseDoc[]> {
  const db = await openDb();
  const docs = await new Promise<CourseDoc[]>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).getAll();
    request.onsuccess = () => resolve((request.result as CourseDoc[]).filter((doc) => doc.subjectId === subjectId));
    request.onerror = () => reject(request.error || new Error('Could not read offline materials'));
  });
  db.close();
  return docs;
}

export async function offlineCourseReply(question: string, subjectId: string): Promise<string> {
  const docs = await getOfflineCourseDocs(subjectId);
  const terms = question.toLocaleLowerCase().split(/[^\\p{L}\\p{N}]+/u).filter((term) => term.length > 2);
  if (!docs.length) return 'لا توجد محاضرات محفوظة أوفلاين لهذه المادة. اتصل بالإنترنت وافتح مزامنة المحاضرات أولاً.';
  const matches: { doc: CourseDoc; excerpt: string; score: number }[] = [];
  for (const doc of docs) {
    const paragraphs = doc.text.split(/\\n{2,}/).map((part) => part.trim()).filter(Boolean);
    for (const paragraph of paragraphs) {
      const lower = paragraph.toLocaleLowerCase();
      const score = terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0);
      if (score > 0) matches.push({ doc, excerpt: paragraph.slice(0, 1800), score });
    }
  }
  matches.sort((a, b) => b.score - a.score);
  const top = matches.slice(0, 5);
  if (!top.length) return 'بحثت في محاضراتك المحفوظة لهذه المادة، لكن لم أجد مقطعاً يطابق كلمات السؤال. لا أريد اختراع جواب غير موجود في مصادرك. اتصل بالإنترنت لاستخدام المساعد السحابي.';
  return 'إجابة محلية أوفلاين مبنية على المقاطع المطابقة من محاضراتك (وليست توليداً من نموذج سحابي):\\n\\n' +
    top.map((item, index) => `**مقطع ${index + 1} — ${item.doc.name}${item.doc.chapter ? ' / ' + item.doc.chapter : ''}**\\n\\n${item.excerpt}`).join('\\n\\n---\\n\\n');
}
