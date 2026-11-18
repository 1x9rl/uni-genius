import { useState } from 'react';
import { FileText, HardDrive, Upload, X } from 'lucide-react';
import { subjects } from './subjects';
import { read, write } from './storage';

export type CourseDoc = {
  id: string;
  name: string;
  subjectId: string;
  subjectLabel: string;
  chapter: string;
  text: string;
  pages: number;
  added: string;
};

export const COURSE_DOCS_KEY = 'courseDocs';
// Stay well under the browser's localStorage quota and the server's 1,000,000-character request cap.
export const MAX_STORED_CHARS = 1_500_000;
export const MAX_REQUEST_CHARS = 900_000;
export const MAX_REQUEST_DOCS = 15;
const MAX_FILE_BYTES = 15 * 1024 * 1024;

export function loadCourseDocs(): CourseDoc[] {
  return read<CourseDoc[]>(COURSE_DOCS_KEY, []);
}

/** Documents of one subject, newest first, trimmed to what a single chat request may carry. */
export function docsForRequest(subjectId: string) {
  const picked: { name: string; text: string; subject: string; chapter: string }[] = [];
  let total = 0;
  for (const doc of loadCourseDocs()) {
    if (doc.subjectId !== subjectId) continue;
    if (picked.length >= MAX_REQUEST_DOCS || total + doc.text.length > MAX_REQUEST_CHARS) continue;
    picked.push({ name: doc.name, text: doc.text, subject: doc.subjectLabel, chapter: doc.chapter });
    total += doc.text.length;
  }
  return picked;
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result.slice(reader.result.indexOf(',') + 1))
      : reject(new Error('read_failed'));
    reader.onerror = () => reject(new Error('read_failed'));
    reader.readAsDataURL(file);
  });
}

function mimeFor(file: File): string {
  if (file.type) return file.type;
  const ext = file.name.split('.').pop()?.toLowerCase();
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (ext === 'md') return 'text/markdown';
  return 'text/plain';
}

type Props = {
  lang: 'ar' | 'en';
  subject: string;
  onChanged: () => void;
};

export function CourseLibrary({ lang, subject, onChanged }: Props) {
  const isAr = lang === 'ar';
  const t = (ar: string, en: string) => (isAr ? ar : en);
  const [docs, setDocs] = useState<CourseDoc[]>(() => loadCourseDocs());
  const [chapter, setChapter] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const current = subjects.find((s) => s.id === subject) ?? subjects[0];
  const currentDocs = docs.filter((d) => d.subjectId === current.id);

  function persist(next: CourseDoc[]): boolean {
    if (!write(COURSE_DOCS_KEY, next)) return false;
    setDocs(next);
    onChanged();
    return true;
  }

  async function addFile(file: File) {
    setMessage(null);
    if (file.size > MAX_FILE_BYTES) {
      setMessage({ kind: 'error', text: t('حجم الملف أكبر من 15 ميغابايت.', 'Files must be 15 MB or smaller.') });
      return;
    }
    setBusy(true);
    try {
      const dataBase64 = await readAsBase64(file);
      const response = await fetch('/api/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attachment: { name: file.name, mimeType: mimeFor(file), dataBase64 } }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || t('تعذر قراءة الملف.', 'The file could not be read.'));
      if (data.kind !== 'text' || typeof data.text !== 'string' || !data.text.trim()) {
        throw new Error(t(
          'المكتبة تقبل ملفات نصية فقط (PDF نصي، DOCX، TXT، MD). أما الصور فأرسلها مباشرة من المساعد.',
          'The library accepts text documents only (text PDF, DOCX, TXT, MD). Send images directly from the tutor.',
        ));
      }
      const used = docs.reduce((sum, d) => sum + d.text.length, 0);
      if (used + data.text.length > MAX_STORED_CHARS) {
        throw new Error(t('المكتبة ممتلئة على هذا الجهاز. احذف ملفاً قبل إضافة غيره.', 'Library storage is full on this device. Remove a file before adding another.'));
      }
      const doc: CourseDoc = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: String(data.name || file.name).slice(0, 180),
        subjectId: current.id,
        subjectLabel: current.ar,
        chapter: chapter.trim().slice(0, 100),
        text: data.text,
        pages: (data.text.match(/\[Page \d+\]/g) ?? []).length,
        added: new Date().toLocaleDateString(isAr ? 'ar-IQ' : 'en-US'),
      };
      if (!persist([doc, ...docs])) {
        throw new Error(t('تعذر الحفظ على هذا الجهاز (المساحة ممتلئة).', 'Could not save on this device (storage is full).'));
      }
      setChapter('');
      setMessage({ kind: 'ok', text: t(`أُضيف «${doc.name}» إلى ${current.ar}. سيستخدمه المساعد عند الإجابة.`, `Added “${doc.name}” to ${current.en}. The tutor will use it when answering.`) });
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error && error.message !== 'read_failed' ? error.message : t('تعذر قراءة الملف.', 'Could not read the file.') });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel upload-panel course-docs">
      <div className="course-docs-head">
        <div className="upload-icon"><Upload /></div>
        <div>
          <h3>{t('ملازم المادة (PDF / DOCX / TXT)', 'Course materials (PDF / DOCX / TXT)')}</h3>
          <p>{t(`تُضاف إلى مادة «${current.ar}». يستخرج الخادم النص، ويبحث المساعد فيه ويذكر اسم الملف ورقم الصفحة.`, `Added to “${current.en}”. The server extracts the text; the tutor searches it and cites the file and page.`)}</p>
        </div>
      </div>
      <div className="course-docs-form">
        <input
          className="chapter-input"
          value={chapter}
          onChange={(event) => setChapter(event.target.value)}
          placeholder={t('الفصل / الموضوع (اختياري)', 'Chapter / topic (optional)')}
          aria-label={t('الفصل أو الموضوع', 'Chapter or topic')}
        />
        <label className={'secondary-btn' + (busy ? ' is-busy' : '')}>
          {busy ? t('جارٍ الاستخراج…', 'Extracting…') : t('اختر ملفاً', 'Choose file')}
          <input
            type="file"
            accept=".pdf,.txt,.md,.docx"
            hidden
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.currentTarget.value = '';
              if (file) void addFile(file);
            }}
          />
        </label>
      </div>
      {message && <div className={message.kind === 'ok' ? 'doc-ok' : 'error-box'} role="status">{message.text}</div>}
      <div className="course-docs-list">
        {currentDocs.length === 0
          ? <p className="doc-empty">{t('لا توجد ملازم لهذه المادة بعد.', 'No materials for this subject yet.')}</p>
          : currentDocs.map((doc) => (
            <div className="doc-row" key={doc.id}>
              <FileText size={16} />
              <div>
                <b>{doc.name}</b>
                <small>{[doc.chapter, doc.pages ? t(`${doc.pages} صفحة`, `${doc.pages} pages`) : '', doc.added].filter(Boolean).join(' · ')}</small>
              </div>
              <button
                className="icon-btn danger"
                aria-label={t('حذف الملف', 'Remove file')}
                onClick={() => persist(docs.filter((d) => d.id !== doc.id))}
              ><X size={16} /></button>
            </div>
          ))}
      </div>
      <div className="local-tag"><HardDrive size={14} />{t('الملازم محفوظة محلياً على جهازك، ويُرسل منها للخادم فقط ما يخص المادة المختارة وقت السؤال.', 'Materials are stored on this device; only the selected subject’s files are sent when you ask a question.')}</div>
    </div>
  );
}
