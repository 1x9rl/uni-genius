import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { BrainCircuit, Camera, Check, Cloud, FileText, Library, LoaderCircle, Mic, Send, ShieldCheck, Sparkles, Square, Upload, WifiOff, X } from 'lucide-react';
import { subjects } from './subjects';
import { read, write } from './storage';
import { localReply } from './assistant';
import { docsForRequest, type CourseDoc } from './CourseLibrary';
import { offlineCourseReply, saveOfflineCourseDocs } from './offline-course-store';

const ChatMessage = lazy(() => import('./ChatMessage').then((module) => ({ default: module.ChatMessage })));

type ChatMessageRecord = {
  role: 'user' | 'assistant';
  text: string;
  attachment?: { name: string; mimeType: string };
  sources?: string[];
};

type RequestAttachment = {
  name: string;
  mimeType: string;
  dataBase64: string;
};

type PendingRequest = {
  message: string;
  subjectId: string;
  mode: string;
  language: 'ar' | 'en';
  history: ChatMessageRecord[];
  attachment?: RequestAttachment;
  courseDocuments?: { name: string; text: string; subject: string; chapter: string }[];
};

type TutorPageProps = {
  lang: 'ar' | 'en';
  subject: string;
  setSubject: (value: string) => void;
  mode: string;
  setMode: (value: string) => void;
  onOpenLibrary: () => void;
};

const MAX_FILE_BYTES = 15 * 1024 * 1024;

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result)
      : reject(new Error('Could not read the selected file.'));
    reader.onerror = () => reject(new Error('Could not read the selected file.'));
    reader.readAsDataURL(file);
  });
}

function inferredMimeType(file: File): string {
  if (file.type) return file.type;
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (extension === 'png') return 'image/png';
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'pdf') return 'application/pdf';
  if (extension === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (extension === 'md') return 'text/markdown';
  return 'text/plain';
}

export function TutorPage({ lang, subject, setSubject, mode, setMode, onOpenLibrary }: TutorPageProps) {
  const isArabic = lang === 'ar';
  const t = (ar: string, en: string) => isArabic ? ar : en;
  const currentSubject = subjects.find((item) => item.id === subject) ?? subjects[0];
  const [messagesBySubject, setMessagesBySubject] = useState<Record<string, ChatMessageRecord[]>>(() => {
    const stored = read<unknown>('messagesBySubject', {});
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
    return Object.fromEntries(Object.entries(stored).map(([subjectId, value]) => [
      subjectId,
      Array.isArray(value) ? value.filter((item): item is ChatMessageRecord =>
        Boolean(item) &&
        typeof item === 'object' &&
        ((item as ChatMessageRecord).role === 'user' || (item as ChatMessageRecord).role === 'assistant') &&
        typeof (item as ChatMessageRecord).text === 'string'
      ) : [],
    ]));
  });
  const messages = Array.isArray(messagesBySubject[subject]) ? messagesBySubject[subject] : [];

  function updateSubjectMessages(
    subjectId: string,
    update: ChatMessageRecord[] | ((previous: ChatMessageRecord[]) => ChatMessageRecord[]),
  ) {
    setMessagesBySubject((previous) => {
      const current = Array.isArray(previous[subjectId]) ? previous[subjectId] : [];
      const next = typeof update === 'function' ? update(current) : update;
      return { ...previous, [subjectId]: next };
    });
  }
  const [query, setQuery] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [chatError, setChatError] = useState('');
  const [lastRequest, setLastRequest] = useState<PendingRequest | null>(null);
  const [aiStatus, setAiStatus] = useState<'checking' | 'ready' | 'unavailable'>('checking');
  const [aiModel, setAiModel] = useState('');
  const [healthMessage, setHealthMessage] = useState('');
  const [offlineSyncStatus, setOfflineSyncStatus] = useState('');
  const [offlineSyncBusy, setOfflineSyncBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    // Keep the previous mixed chat safely archived; never feed it into a subject-specific AI context.
    const legacyMessages = read<ChatMessageRecord[]>('messages', []);
    if (legacyMessages.length && !read('legacyMessagesArchive', []).length) {
      write('legacyMessagesArchive', legacyMessages);
    }
    write('messagesBySubject', messagesBySubject);
  }, [messagesBySubject]);

  useEffect(() => {
    let active = true;
    fetch('/api/health')
      .then(async (response) => {
        const data = await response.json();
        if (!active) return;
        if (response.ok && data.providerConfigured) {
          setAiStatus('ready');
          setAiModel(data.model || 'Gemini');
          setHealthMessage('');
        } else {
          setAiStatus('unavailable');
          setAiModel('');
          setHealthMessage(data.message || t('محرك AI غير متاح حالياً.','Cloud AI is currently unavailable.'));
        }
      })
      .catch(() => {
        if (!active) return;
        setAiStatus('unavailable');
        setHealthMessage(t('تعذر الاتصال بخادم AI.','Could not reach the AI server.'));
      });
    return () => { active = false; };
  }, [lang]);

  async function toggleRecording() {
    if (recording) {
      recorderRef.current?.stop();
      setRecording(false);
      return;
    }
    if (busy || transcribing) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setChatError(t('تسجيل الصوت غير مدعوم في هذا المتصفح. جرّب فتح الموقع في Safari.','Audio recording is not supported here. Try opening the app in Safari.'));
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeCandidates = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];
      const mimeType = mimeCandidates.find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      recorderRef.current = recorder;
      audioChunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        stream.getTracks().forEach((track) => track.stop());
        setRecording(false);
        setChatError(t('صار خطأ أثناء التسجيل. حاول مرة ثانية.','Recording failed. Please try again.'));
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        setRecording(false);
        const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        audioChunksRef.current = [];
        if (!blob.size) {
          setChatError(t('التسجيل فارغ. حاول مرة ثانية.','The recording was empty. Please try again.'));
          return;
        }
        setTranscribing(true);
        setChatError('');
        try {
          const response = await fetch(`/api/transcribe?language=${lang}`, {
            method: 'POST',
            headers: { 'Content-Type': blob.type || 'audio/webm' },
            body: blob,
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok || typeof data.text !== 'string' || !data.text.trim()) {
            throw new Error(data.message || t('تعذر فهم التسجيل الصوتي. حاول مرة ثانية.','Could not understand the recording. Please try again.'));
          }
          setQuery(data.text.trim());
          await send(data.text.trim());
        } catch (error) {
          setChatError(error instanceof Error ? error.message : t('تعذر تحويل الصوت إلى نص.','Could not transcribe the audio.'));
        } finally {
          setTranscribing(false);
        }
      };
      recorder.start();
      setRecording(true);
      setChatError('');
    } catch (error) {
      const message = error instanceof Error && error.name === 'NotAllowedError'
        ? t('اسمح للمتصفح باستخدام المايك من إعدادات الآيفون.','Allow microphone access in your iPhone browser settings.')
        : t('تعذر تشغيل المايك. تأكد من صلاحية المايك وحاول ثانية.','Could not start the microphone. Check microphone permission and retry.');
      setChatError(message);
    }
  }

  async function submit(request: PendingRequest) {
    setBusy(true);
    setChatError('');
    let providerProblem = true;
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        // 4xx = a problem with this request (bad file, too long...) — the provider itself is not down.
        providerProblem = response.status >= 500;
        throw new Error(data.message || t('تعذر الحصول على إجابة من AI.','AI could not answer this request.'));
      }
      if (typeof data.answer !== 'string' || !data.answer.trim()) {
        throw new Error(t('وصل رد فارغ من مزود AI. أعد المحاولة.','The AI provider returned an empty response. Please retry.'));
      }
      const sources = Array.isArray(data.sources) ? data.sources.filter((item: unknown): item is string => typeof item === 'string') : [];
      updateSubjectMessages(request.subjectId, (previous) => [...previous, { role: 'assistant', text: data.answer, ...(sources.length ? { sources } : {}) }]);
      setAiStatus('ready');
      setAiModel(data.model || 'Gemini');
      setHealthMessage('');
      setChatError('');
      setLastRequest(null);
    } catch (error) {
      if (error instanceof TypeError || !navigator.onLine) {
        try {
          const localAnswer = await offlineCourseReply(request.message, request.subjectId);
          updateSubjectMessages(request.subjectId, (previous) => [...previous, { role: 'assistant', text: localAnswer }]);
          setLastRequest(null);
          setChatError('');
          setAiStatus('unavailable');
          setHealthMessage(t('أنت تعمل الآن دون إنترنت — وضع المحاضرات المحلي.','Offline mode — local course materials.'));
          return;
        } catch (offlineError) {
          setChatError(offlineError instanceof Error ? offlineError.message : t('تعذر البحث في المحاضرات المحلية.','Could not search local course materials.'));
          return;
        }
      }
      const message = error instanceof Error ? error.message : t('حدث خطأ غير متوقع.','An unexpected error occurred.');
      setChatError(message);
      if (providerProblem) {
        setAiStatus('unavailable');
        setHealthMessage(message);
      }
    } finally {
      setBusy(false);
    }
  }

  async function send(voiceText?: string) {
    const text = typeof voiceText === 'string' ? voiceText.trim() : query.trim();
    const file = selectedFile;
    if ((!text && !file) || busy) return;
    if (file && file.size > MAX_FILE_BYTES) {
      setChatError(t('حجم الملف أكبر من 15 ميغابايت.','Files must be 15 MB or smaller.'));
      return;
    }

    setChatError('');
    let attachment: RequestAttachment | undefined;
    try {
      if (file) {
        const dataUrl = await readAsDataUrl(file);
        attachment = {
          name: file.name,
          mimeType: inferredMimeType(file),
          dataBase64: dataUrl.slice(dataUrl.indexOf(',') + 1),
        };
      }
    } catch (error) {
      setChatError(error instanceof Error ? error.message : t('تعذر قراءة الملف.','Could not read the file.'));
      return;
    }

    const userText = text || t('حل المسألة الهندسية في الملف المرفق واشرح الخطوات.','Solve the engineering question in the attached file and explain the steps.');
    const userMessage: ChatMessageRecord = {
      role: 'user',
      text: userText,
      ...(file ? { attachment: { name: file.name, mimeType: inferredMimeType(file) } } : {}),
    };
    const request: PendingRequest = {
      message: text,
      subjectId: subject,
      mode,
      language: lang,
      history: messages.map(({ role, text }) => ({ role, text })),
      ...(attachment ? { attachment } : {}),
      courseDocuments: docsForRequest(subject),
    };
    updateSubjectMessages(request.subjectId, (previous) => [...previous, userMessage]);
    setQuery('');
    setSelectedFile(null);
    setLastRequest(request);
    await submit(request);
  }

  async function syncOfflineMaterials() {
    if (!navigator.onLine || offlineSyncBusy) {
      setOfflineSyncStatus(t('اتصل بالإنترنت أولاً لتنزيل المحاضرات.','Connect to the internet first to download materials.'));
      return;
    }
    setOfflineSyncBusy(true);
    setOfflineSyncStatus(t('جارٍ تنزيل محاضرات المواد إلى الآيفون…','Downloading course materials to this iPhone…'));
    let total = 0;
    let totalChars = 0;
    let persistenceGranted = false;
    try {
      // Ask the browser to protect the offline database from automatic eviction when supported.
      try {
        if (navigator.storage?.persist) persistenceGranted = await navigator.storage.persist();
      } catch {
        persistenceGranted = false;
      }
      for (const item of subjects) {
        const response = await fetch(`/api/course-materials?subjectId=${encodeURIComponent(item.id)}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`تعذر تنزيل مادة ${item.ar}`);
        const data = await response.json();
        const docs = Array.isArray(data.documents) ? data.documents as CourseDoc[] : [];
        await saveOfflineCourseDocs(item.id, docs);
        total += docs.length;
        totalChars += docs.reduce((sum, doc) => sum + (typeof doc.text === 'string' ? doc.text.length : 0), 0);
      }
      const approxMb = (totalChars * 2 / (1024 * 1024)).toFixed(1);
      const protection = persistenceGranted
        ? t(' وحماية التخزين مفعّلة.', ' Persistent storage protection granted.')
        : t(' ملاحظة: احتفظ بفتح التطبيق دورياً لأن iOS قد يدير مساحة التخزين.', ' Note: open the app periodically; iOS may manage website storage.');
      setOfflineSyncStatus(t(
        `اكتملت المزامنة: ${total} ملف محاضرة محفوظ محلياً (حوالي ${approxMb} MB).${protection}`,
        `Sync complete: ${total} lecture files saved locally (about ${approxMb} MB).${protection}`,
      ));
    } catch (error) {
      setOfflineSyncStatus(error instanceof Error ? error.message : t('فشلت مزامنة المحاضرات.','Material sync failed.'));
    } finally {
      setOfflineSyncBusy(false);
    }
  }

  function useLocalGuidance() {
    if (!lastRequest) return;
    const localQuestion = lastRequest.message || t('اشرح المسألة المرفقة.','Explain the attached question.');
    updateSubjectMessages(lastRequest.subjectId, (previous) => [
      ...previous,
      { role: 'assistant', text: localReply(localQuestion, lastRequest.subjectId, lastRequest.mode) },
    ]);
    setLastRequest(null);
    setChatError('');
  }

  const statusText = aiStatus === 'checking'
    ? t('جارٍ التحقق من Gemini','Checking Gemini')
    : aiStatus === 'ready'
      ? `${t('Gemini متصل','Gemini connected')} · ${aiModel}`
      : t('AI السحابي غير متاح','Cloud AI unavailable');

  return (
    <>
      <div className="page-heading">
        <div className="eyebrow"><BrainCircuit size={14}/> INTELLIGENT TUTOR</div>
        <h1>{t('مساعدك الهندسي','Your engineering tutor')}</h1>
        <p>{t('اسأل، ناقش، وارفع سياق المسألة. المساعد يوضح لك ما يعرفه وما يحتاج إلى مصدر.','Ask, discuss, and provide context. The tutor distinguishes known guidance from source-dependent answers.')}</p>
      </div>
      <div className="tutor-layout">
        <div className="chat-panel">
          <div className="chat-top">
            <div className="ai-avatar"><BrainCircuit/></div>
            <div>
              <b>UNI GENIUS AI</b>
              <small className={aiStatus === 'ready' ? 'ai-status ready' : 'ai-status unavailable'}>
                {aiStatus === 'ready' ? <Cloud size={12}/> : <WifiOff size={12}/>} {statusText}
              </small>
            </div>
            <div className="chat-top-end">
              <span className="mode-chip">{mode === 'quick' ? 'QUICK' : mode === 'study' ? 'STUDY' : 'PROFESSOR'}</span>
            </div>
          </div>
          <div className="chat-context">
            <label>{t('المادة الحالية','CURRENT SUBJECT')}</label>
            <select value={subject} onChange={(event) => setSubject(event.target.value)}>
              {subjects.map((item) => <option value={item.id} key={item.id}>{isArabic ? item.ar : item.en}</option>)}
            </select>
            <label>{t('أسلوب الشرح','RESPONSE MODE')}</label>
            <select value={mode} onChange={(event) => setMode(event.target.value)}>
              <option value="quick">{t('سريع','Quick')}</option>
              <option value="study">{t('دراسة خطوة بخطوة','Step-by-step study')}</option>
              <option value="professor">{t('بروفيسور — شرح عميق','Professor — deep explanation')}</option>
            </select>
          </div>
          <div className="messages">
            {messages.length === 0 ? (
              <div className="empty-chat">
                <div className="empty-icon"><Sparkles size={28}/></div>
                <h3>{t('خلّينا نفهمها سوا.','Let’s understand it together.')}</h3>
                <p>{t('ابدأ بسؤال في','Start with a question in')} {currentSubject.ar}</p>
                <div className="suggestions">
                  <button onClick={() => setQuery(t('اشرح لي أهم مفاهيم هذه المادة مع مثال.','Explain the key concepts of this subject with an example.'))}>{t('اشرح المفاهيم الأساسية','Explain core concepts')}</button>
                  <button onClick={() => setQuery(t('شلون أبدأ بحل مسألة من هذه المادة؟','How should I approach a problem in this subject?'))}>{t('طريقة حل المسائل','Problem-solving approach')}</button>
                </div>
              </div>
            ) : messages.map((message, index) => (
              <div key={`${index}-${message.role}`} className={`message ${message.role}`}>
                <div className="message-avatar">
                  {message.role === 'assistant' ? <BrainCircuit size={16}/> : <span>M</span>}
                </div>
                <div className="bubble">
                  <div className="bubble-label">{message.role === 'assistant' ? 'UNI GENIUS' : 'YOU'}</div>
                  <Suspense fallback={<p className="markdown-loading">…</p>}>
                    <ChatMessage role={message.role} text={message.text} attachment={message.attachment}/>
                  </Suspense>
                  {message.sources && message.sources.length > 0 && (
                    <div className="answer-sources">
                      <b><Library size={11}/> {t('من ملازمك','From your materials')}</b>
                      {message.sources.map((source) => <span key={source}>{source}</span>)}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {busy && (
              <div className="message assistant">
                <div className="message-avatar"><BrainCircuit size={16}/></div>
                <div className="bubble"><div className="typing"><i/><i/><i/></div></div>
              </div>
            )}
            {chatError && (
              <div className="chat-error" role="alert">
                <p>{chatError}</p>
                <div>
                  {lastRequest && <button onClick={() => void submit(lastRequest)} disabled={busy}>{t('أعد المحاولة','Retry')}</button>}
                  {lastRequest && <button onClick={useLocalGuidance} disabled={busy}>{t('استخدم الإرشاد المحلي','Use local guidance')}</button>}
                </div>
              </div>
            )}
          </div>
          {selectedFile && (
            <div className="selected-file">
              <FileText size={15}/>
              <span>{selectedFile.name} · {(selectedFile.size / (1024 * 1024)).toFixed(1)} MB</span>
              <button className="icon-btn" aria-label={t('إزالة الملف','Remove file')} onClick={() => setSelectedFile(null)}><X size={15}/></button>
            </div>
          )}
          {(recording || transcribing) && (
            <div className="voice-status" role="status">
              {recording ? <Mic size={14}/> : <LoaderCircle size={14} className="spin"/>}
              {recording ? t('جاري التسجيل… اضغط المايك للإيقاف','Recording… tap the mic to stop') : t('جاري تحويل كلامك إلى نص…','Transcribing your speech…')}
            </div>
          )}
          <div className="chat-compose">
            <div className="compose-tools">
              <label className="icon-btn" title={t('إرفاق صورة أو ملف','Attach an image or file')}>
                <Upload size={17}/>
                <input
                  type="file"
                  accept="image/png,image/jpeg,.pdf,.docx,.txt,.md"
                  hidden
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) {
                      setChatError('');
                      setSelectedFile(file);
                    }
                    event.currentTarget.value = '';
                  }}
                />
              </label>
              <button className="icon-btn" title={t('الكاميرا — ارفع صورة من جهازك','Camera — select an image to upload')} onClick={() => document.querySelector<HTMLInputElement>('.chat-compose input[type=file]')?.click()}><Camera size={17}/></button>
              <button
                className={`icon-btn ${recording ? 'recording' : ''}`}
                title={recording ? t('إيقاف التسجيل وإرسال السؤال','Stop recording and send question') : t('اسأل بالصوت','Ask by voice')}
                onClick={() => void toggleRecording()}
                disabled={busy || transcribing}
              >
                {transcribing ? <LoaderCircle size={17} className="spin"/> : recording ? <Square size={15}/> : <Mic size={17}/>}
              </button>
            </div>
            <textarea
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
              placeholder={t('اكتب سؤالك الهندسي هنا...','Ask your engineering question...')}
              aria-label={t('سؤالك الهندسي','Your engineering question')}
            />
            <button className="send-btn" onClick={() => void send()} disabled={(!query.trim() && !selectedFile) || busy} aria-label={t('إرسال','Send')}><Send size={18}/></button>
          </div>
          {aiStatus === 'unavailable' && healthMessage && (
            <div className="provider-notice">
              <WifiOff size={13}/>{healthMessage}
            </div>
          )}
          <div className="chat-disclaimer"><ShieldCheck size={13}/>{t('تحقق من النتائج العلمية، ولا تعتمد على إجابة غير موثقة في التسليم النهائي.','Verify scientific results; do not submit unverified answers.')}</div>
        </div>
        <aside className="tutor-aside">
          <div className="panel">
            <div className="panel-head"><h3>{t('قدرات المساعد','Tutor capabilities')}</h3><Sparkles size={18}/></div>
            {[
              [Check, t('شرح المفاهيم','Concept explanations'), 'ok'],
              [Check, t('توجيه خطوات الحل','Solution guidance'), 'ok'],
              [Check, t('حسابات محلية محددة','Selected local calculations'), 'ok'],
              [Cloud, t('إجابات AI سحابية','Cloud AI responses'), aiStatus === 'ready' ? 'ok' : 'wait'],
              [Camera, t('تحليل الصور والأسئلة','Image and question analysis'), aiStatus === 'ready' ? 'ok' : 'wait'],
              [Mic, t('المحادثة الصوتية','Voice conversation'), 'ok'],
            ].map(([Icon, label, status], index) => (
              <div className="cap-row" key={index}>
                <Icon size={16}/><span>{label as string}</span>
                <i className={status as string}>{status === 'ok' ? '●' : '○'}</i>
              </div>
            ))}
          </div>
          <div className="panel source-panel">
            <div className="eyebrow">OFFLINE STUDY</div>
            <h3>{t('الدراسة بدون إنترنت','Study offline')}</h3>
            <p>{t('نزّل محاضراتك إلى تخزين الآيفون. بعدها تقدر تبحث داخلها وتستعرض المقاطع المطابقة حتى بدون اتصال.','Download your lectures into iPhone storage. Then search and view matching passages without a connection.')}</p>
            <button className="secondary-btn" onClick={() => void syncOfflineMaterials()} disabled={offlineSyncBusy}>
              {offlineSyncBusy ? <LoaderCircle size={16} className="spin"/> : <Cloud size={16}/>}
              {offlineSyncBusy ? t('جارٍ التنزيل…','Downloading…') : t('نزّل/حدّث كل المحاضرات','Download/update all lectures')}
            </button>
            {offlineSyncStatus && <p role="status">{offlineSyncStatus}</p>}
          </div>
          <div className="panel source-panel">
            <div className="eyebrow">GROUNDING</div>
            <h3>{t('مصادر إجاباتك','Answer sources')}</h3>
            <p>{t('ارفع ملزمتك أو الصق نص السؤال حتى نربط الشرح بمحتواك بدلاً من التخمين.','Upload your lecture or paste the question to ground explanations in your material.')}</p>
            <button className="secondary-btn" onClick={onOpenLibrary}><Library size={16}/>{t('افتح مكتبتي','Open my library')}</button>
          </div>
        </aside>
      </div>
    </>
  );
}
