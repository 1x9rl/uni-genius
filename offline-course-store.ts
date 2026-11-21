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

function normalizeSearchText(value: string): string {
  return value
    .replace(/\\n/g, '\n')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[ـ\u200e\u200f]/g, '');
}

export async function offlineCourseReply(question: string, subjectId: string): Promise<string> {
  const docs = await getOfflineCourseDocs(subjectId);
  const normalizedQuestion = normalizeSearchText(question);
  const terms = normalizedQuestion.match(/[a-z0-9\u0600-\u06ff]+/g)?.filter((term) => term.length > 1) ?? [];
  if (!docs.length) return 'لا توجد محاضرات محفوظة أوفلاين لهذه المادة. اتصل بالإنترنت وافتح مزامنة المحاضرات أولاً.';
  if (!terms.length) return 'اكتب كلمة أو مصطلحاً واضحاً حتى أبحث عنه في محاضراتك المحفوظة.';

  const matches: { doc: CourseDoc; excerpt: string; score: number }[] = [];
  for (const doc of docs) {
    const source = typeof doc.text === 'string' ? doc.text : '';
    if (!source.trim()) continue;
    const normalized = normalizeSearchText(source);
    const chunks = normalized
      .split(/(?<=[.!?؟])\s+|\n+/u)
      .map((part) => part.trim())
      .filter((part) => part.length > 35);

    const candidates = chunks.length ? chunks : [normalized];
    let documentMatched = false;
    for (const chunk of candidates) {
      const score = terms.reduce((sum, term) => sum + (chunk.includes(term) ? 1 : 0), 0);
      if (score > 0) {
        documentMatched = true;
        const firstTerm = terms.find((term) => chunk.includes(term)) || '';
        const position = Math.max(0, chunk.indexOf(firstTerm) - 650);
        matches.push({
          doc,
          excerpt: chunk.slice(position, position + 1800),
          score: score + (terms.length > 1 && chunk.includes(normalizedQuestion) ? 2 : 0),
        });
      }
    }

    if (!documentMatched) {
      const wholeScore = terms.reduce((sum, term) => sum + (normalized.includes(term) ? 1 : 0), 0);
      if (wholeScore > 0) {
        const firstTerm = terms.find((term) => normalized.includes(term)) || '';
        const position = Math.max(0, normalized.indexOf(firstTerm) - 650);
        matches.push({ doc, excerpt: normalized.slice(position, position + 1800), score: wholeScore });
      }
    }
  }

  matches.sort((a, b) => b.score - a.score);
  const top = matches.slice(0, 5);
  if (!top.length) return 'بحثت في محاضراتك المحفوظة لهذه المادة، لكن لم أجد مقطعاً يطابق كلمات السؤال. لا أريد اختراع جواب غير موجود في مصادرك. اتصل بالإنترنت لاستخدام المساعد السحابي.';
  return 'إجابة محلية أوفلاين مبنية على المقاطع المطابقة من محاضراتك (وليست توليداً من نموذج سحابي):\n\n' +
    top.map((item, index) => '**مقطع ' + (index + 1) + ' — ' + item.doc.name + (item.doc.chapter ? ' / ' + item.doc.chapter : '') + '**\n\n' + item.excerpt).join('\n\n---\n\n');
}
