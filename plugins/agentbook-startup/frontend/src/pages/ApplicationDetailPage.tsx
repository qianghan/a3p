import React, { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  FileText, Upload, Loader2, CheckCircle2, XCircle, HelpCircle,
  BookOpen, File as FileIcon, Sparkles, Send,
} from 'lucide-react';
import {
  startupApi,
  type StartupBenefitApplication, type StartupBenefitDocument, type StartupBenefitDecisionPoint,
  type DocumentRequirement, type DraftField,
} from '../lib/api';

const SOURCE_LABEL: Record<DraftField['sourceType'], string> = {
  book_entry: 'From your books',
  document: 'From a document',
  user_input: 'Your answer',
  computed: 'Computed',
};

const SOURCE_STYLE: Record<DraftField['sourceType'], string> = {
  book_entry: 'bg-blue-500/10 text-blue-600 border-blue-500/20',
  document: 'bg-purple-500/10 text-purple-600 border-purple-500/20',
  user_input: 'bg-green-500/10 text-green-600 border-green-500/20',
  computed: 'bg-muted text-muted-foreground border-border',
};

const STATUS_LABEL: Record<string, string> = {
  docs_pending: 'Documents needed',
  drafting: 'Drafting',
  decision_pending: 'Your input needed',
  ready_for_review: 'Ready for review',
  audit_reviewed: 'Audit reviewed',
  submitted: 'Submitted',
  monitoring: 'Monitoring',
  closed: 'Closed',
};

function DraftFieldRow({ field }: { field: DraftField }) {
  const displayValue = typeof field.value === 'number' ? `$${field.value.toLocaleString()}` : field.value;
  return (
    <div className="flex items-center justify-between py-2 border-b border-border last:border-0">
      <div>
        <p className="text-sm text-foreground">{field.label}</p>
        <span className={`inline-flex items-center text-xs px-2 py-0.5 rounded-full border mt-1 ${SOURCE_STYLE[field.sourceType]}`}>
          {SOURCE_LABEL[field.sourceType]}
        </span>
      </div>
      <p className="text-sm font-medium text-foreground">{displayValue}</p>
    </div>
  );
}

function DecisionPointCard({
  decisionPoint, onRespond, submitting,
}: {
  decisionPoint: StartupBenefitDecisionPoint;
  onRespond: (id: string, response: string) => void;
  submitting: boolean;
}) {
  const [answer, setAnswer] = useState('');
  return (
    <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-4 mb-3">
      <div className="flex items-start gap-2 mb-3">
        <HelpCircle className="w-4 h-4 shrink-0 mt-0.5 text-amber-600" />
        <p className="text-sm text-foreground">{decisionPoint.prompt}</p>
      </div>
      {decisionPoint.kind === 'approval' ? (
        <div className="flex gap-2">
          <button
            type="button"
            disabled={submitting}
            onClick={() => onRespond(decisionPoint.id, 'approve')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            <CheckCircle2 className="w-4 h-4" /> Approve
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => onRespond(decisionPoint.id, 'reject')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-background border border-border rounded-lg text-sm font-medium hover:bg-muted/50 transition-colors disabled:opacity-50"
          >
            <XCircle className="w-4 h-4" /> Reject
          </button>
        </div>
      ) : (
        <div className="flex gap-2">
          <label htmlFor={`answer-${decisionPoint.id}`} className="sr-only">Your answer</label>
          <input
            id={`answer-${decisionPoint.id}`}
            type="text"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="Your answer"
            className="flex-1 px-3 py-1.5 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
          <button
            type="button"
            disabled={submitting || !answer}
            onClick={() => onRespond(decisionPoint.id, answer)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            <Send className="w-4 h-4" /> Submit
          </button>
        </div>
      )}
    </div>
  );
}

export function ApplicationDetailPage() {
  const { id } = useParams<{ id: string }>();

  const [application, setApplication] = useState<StartupBenefitApplication | null>(null);
  const [documents, setDocuments] = useState<StartupBenefitDocument[]>([]);
  const [decisionPoints, setDecisionPoints] = useState<StartupBenefitDecisionPoint[]>([]);
  const [documentChecklist, setDocumentChecklist] = useState<DocumentRequirement[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [uploadingDocType, setUploadingDocType] = useState<string | null>(null);

  // Sourced from the server (not router state) so refreshing, bookmarking,
  // or returning to this page later — story C5 — still shows the correct
  // checklist and draft, not an empty page.
  const refresh = useCallback(async () => {
    if (!id) return;
    const data = await startupApi.getApplication(id);
    setApplication(data.application);
    setDocuments(data.documents);
    setDecisionPoints(data.decisionPoints);
    setDocumentChecklist(data.documentChecklist ?? []);
  }, [id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleRespond(decisionPointId: string, response: string) {
    setSubmitting(true);
    try {
      await startupApi.respondToDecisionPoint(decisionPointId, response);
      await refresh();
    } finally {
      setSubmitting(false);
    }
  }

  async function handleUpload(docType: string, file: File) {
    if (!id) return;
    setUploadingDocType(docType);
    try {
      await startupApi.uploadDocument(id, docType, file);
      await startupApi.triggerDraft(id);
      await refresh();
    } finally {
      setUploadingDocType(null);
    }
  }

  if (!application) {
    return (
      <div className="p-6 max-w-2xl mx-auto flex items-center gap-2 text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading application…
      </div>
    );
  }

  const pendingDecisionPoints = decisionPoints.filter((dp) => dp.response == null);
  const uploadedDocTypes = new Set(documents.map((d) => d.docType));

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <div className="flex items-center gap-2 mb-2">
        <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
          <FileText className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-foreground">Application</h1>
          <span className="inline-flex text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
            {STATUS_LABEL[application.status] ?? application.status}
          </span>
        </div>
      </div>

      {pendingDecisionPoints.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-semibold text-foreground mb-2">Needs your input</h2>
          {pendingDecisionPoints.map((dp) => (
            <DecisionPointCard key={dp.id} decisionPoint={dp} onRespond={handleRespond} submitting={submitting} />
          ))}
        </div>
      )}

      {documentChecklist.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-semibold text-foreground mb-2 flex items-center gap-1.5">
            <Upload className="w-4 h-4" /> Documents
          </h2>
          {documentChecklist.map((req) => {
            const uploaded = uploadedDocTypes.has(req.docType);
            return (
              <div key={req.docType} className="flex items-center justify-between bg-card border border-border rounded-lg p-3 mb-2">
                <div className="flex items-center gap-2">
                  <FileIcon className="w-4 h-4 text-muted-foreground shrink-0" />
                  <div>
                    <p className="text-sm text-foreground">{req.label}</p>
                    <p className="text-xs text-muted-foreground">{req.description}</p>
                  </div>
                </div>
                {uploaded ? (
                  <span className="inline-flex items-center gap-1 text-xs text-green-600"><CheckCircle2 className="w-3.5 h-3.5" /> Uploaded</span>
                ) : (
                  <label className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-background border border-border rounded-lg text-xs font-medium hover:bg-muted/50 transition-colors cursor-pointer">
                    {uploadingDocType === req.docType ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                    Upload
                    <input
                      type="file"
                      className="hidden"
                      disabled={uploadingDocType === req.docType}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void handleUpload(req.docType, file);
                        e.target.value = '';
                      }}
                    />
                  </label>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="mb-6">
        <h2 className="text-sm font-semibold text-foreground mb-2 flex items-center gap-1.5">
          <BookOpen className="w-4 h-4" /> Draft
        </h2>
        {Object.entries(application.draft.sections ?? {}).map(([sectionName, fields]) => (
          <div key={sectionName} className="bg-card border border-border rounded-xl p-4 mb-3">
            <h3 className="text-sm font-semibold text-foreground mb-2">{sectionName}</h3>
            {fields.length === 0 ? (
              <p className="text-sm text-muted-foreground">Waiting on the decision point above.</p>
            ) : (
              fields.map((field, i) => <DraftFieldRow key={i} field={field} />)
            )}
          </div>
        ))}
      </div>

      {application.status === 'ready_for_review' && (
        <div className="bg-primary/5 border border-primary/20 rounded-lg p-4 flex items-start gap-2">
          <Sparkles className="w-4 h-4 shrink-0 mt-0.5 text-primary" />
          <p className="text-sm text-muted-foreground">
            This draft is complete and every decision point is resolved — it&apos;s ready for review.
          </p>
        </div>
      )}
    </div>
  );
}
