// Bank format shared with the app (LukeEvansTech/examprep). Keep the two in step.

export type QuestionKind = "single" | "multi" | "hotspot" | "dragdrop";

export interface Vote {
  answer: string; // letters, combined for multi-select ("BFG")
  percent: number;
  votes: number;
}

export interface Choice {
  letter: string;
  html: string;
}

export interface Question {
  id: string; // ExamTopics question id (data-id): the merge key across re-imports
  number: number;
  topic: string;
  kind: QuestionKind;
  stemHtml: string; // image src rewritten to the bare filename
  images: string[]; // filenames referenced by the stem
  choices: Choice[];
  pick: number; // how many choices to select
  suggested: string | null; // ExamTopics answer letters, null when it is an image
  suggestedImage: string | null; // hotspot / drag-drop answer image filename
  votes: Vote[];
  discussionId: string | null;
}

// Hand/Claude-authored layer, kept in data/enrich/<exam>.json keyed by question id so a
// re-parse of the raw pages never overwrites it.

export interface HotspotItem {
  label: string; // the prompt beside the drop-down / Yes-No box
  options: string[];
  answer: string; // ExamTopics' answer, read off the answer image; one of options
  docsAnswer?: string; // set only when the docs point to a different option
}

export interface Interactive {
  type: "hotspot" | "dragdrop";
  context?: string; // text around the answer area, e.g. a code template with gaps
  items: HotspotItem[]; // drag-drop: one item per target; options = the full source list
  ordered?: boolean; // drag-drop where the target order is the answer
}

export interface Enrichment {
  id: string;
  explanation: string; // Markdown, AI-written from the cited docs
  docsAnswer: string | null; // letters the docs support; null when they don't settle it
  docsVerdict: "agrees" | "disagrees" | "unclear"; // relative to the ExamTopics suggested answer
  sources: { title: string; url: string }[];
  interactive?: Interactive;
  review: "unreviewed" | "reviewed";
}

export interface ExamSettings {
  examQuestions: number; // exam-mode default question count
  minutes: number;
  passPct: number;
}

export interface Resolved {
  answer: string | null; // letters for choice questions
  items: string[] | null; // per-item answers for hotspot / drag-drop
  basis: "community" | "suggested+docs" | "docs" | "suggested";
  disputed: boolean;
}

export type BankQuestion = Question & { enrichment: Enrichment | null; resolved: Resolved };

// What the importer uploads and what the app serves.
export interface BankPayload {
  exam: Bank["exam"] & { settings: ExamSettings };
  importedAt: string;
  questions: BankQuestion[];
}

// Per-user rows the client creates offline and syncs. `at` is ISO time; last write wins.
export interface AnswerRow {
  id: string; // client-generated uuid, so re-sent rows are ignored
  questionId: string;
  exam: string;
  mode: "exam" | "study" | "weak" | "srs";
  given: string; // letters, or items joined with "\u001f"
  correct: boolean;
  at: string;
}
export interface SrsRow {
  questionId: string;
  exam: string;
  card: unknown;
  due: string;
  at: string;
}
export interface OverrideRow {
  questionId: string;
  answer: string | null;
  at: string;
} // null clears
export interface NoteRow {
  questionId: string;
  text: string;
  at: string;
}
export interface FlagRow {
  questionId: string;
  flagged: boolean;
  at: string;
}
export interface ReviewRow {
  questionId: string;
  status: "unreviewed" | "reviewed";
  items?: string[];
  rev?: string; // transcriptionRev() of what the reviewer saw; the server rejects a stale one
  at: string;
}

// The in-progress session for one exam (the web client's Session, opaque to the server);
// null data clears it. Kept server-side so a session started on one device resumes on another.
export interface SessionRow {
  exam: string;
  data: unknown | null;
  at: string;
}
// A finished exam-mode attempt, for the history list.
export interface ResultRow {
  id: string;
  exam: string;
  at: string;
  total: number;
  correct: number;
  seconds: number;
}

export interface SyncPush {
  sessions?: SessionRow[];
  results?: ResultRow[];
  answers?: AnswerRow[];
  srs?: SrsRow[];
  overrides?: OverrideRow[];
  notes?: NoteRow[];
  flags?: FlagRow[];
  reviews?: ReviewRow[];
}

export interface UserState {
  session: SessionRow | null;
  results: ResultRow[];
  answers: AnswerRow[];
  srs: SrsRow[];
  overrides: OverrideRow[];
  notes: NoteRow[];
  flags: FlagRow[];
  reviews: ReviewRow[]; // bank-wide, not per user
  ourVotes: Record<string, Record<string, number>>; // questionId → answer → count, all users
}

export interface Bank {
  exam: { code: string; vendor: string; title: string; totalOnSite: number };
  importedAt: string;
  questions: Question[];
}
