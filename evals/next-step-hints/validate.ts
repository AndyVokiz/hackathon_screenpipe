// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

// TypeScript mirror of `parse_hint` and `validate` in
// crates/screenpipe-engine/src/next_step/hint.rs. Rust is authoritative;
// validate.test.ts runs both against the shared validate_cases.json.

export type Risk = "safe" | "outward" | "destructive";
export type DropReason =
  | "no_hint"
  | "unparseable"
  | "low_confidence"
  | "bad_title"
  | "bad_how"
  | "ungrounded"
  | "restates_screen";

export interface Hint {
  show: boolean;
  task: string;
  title: string;
  how: string[];
  why: string;
  confidence: number;
  automation: {
    possible: boolean;
    /** `browser`, `shell`, `files`, `none`, or `connection:<id>`. */
    tool: string;
    risk: Risk;
    effect: string;
    agentPrompt: string;
  };
}

export type Outcome = { ok: true; hint: Hint } | { ok: false; reason: DropReason };

export const MIN_CONFIDENCE = 0.6;
export const TITLE_MAX_CHARS = 80;
export const HOW_MAX_LINES = 4;
export const HOW_LINE_MAX_CHARS = 120;
const TASK_MAX_CHARS = 100;
const WHY_MAX_CHARS = 160;
const EFFECT_MAX_CHARS = 160;
const AGENT_PROMPT_MAX_CHARS = 2_000;

const NOT_FILE_NAMES = ["e.g", "i.e", "a.m", "p.m"];
const NOT_PATHS = ["and/or"];
const OUTWARD_WORDS = [
  "send", "sent", "post", "reply", "email", "message", "publish", "submit", "pay", "paid",
  "purchase", "buy", "bought", "transfer", "invite", "share", "push", "merge", "deploy",
];
const DESTRUCTIVE_WORDS = ["delete", "remove", "drop", "force", "overwrite", "reset"];
const DESTRUCTIVE_PHRASES = ["rm -rf"];
const RISK_ORDER: Risk[] = ["safe", "outward", "destructive"];

const drop = (reason: DropReason): Outcome => ({ ok: false, reason });
const chars = (text: string) => [...text].length;

function truncate(text: string, maxChars: number): string {
  const all = [...text];
  return all.length <= maxChars ? text : all.slice(0, maxChars).join("") + "…";
}

/** Mirror of `screenpipe_core::strings::extract_json_object`. */
export function extractJsonObject(content: string): string | null {
  const trimmed = content.trim();
  let cleaned = trimmed;
  if (trimmed.startsWith("```")) {
    const inside: string[] = [];
    for (const line of trimmed.split(/\r?\n/).slice(1)) {
      if (line.startsWith("```")) break;
      inside.push(line);
    }
    cleaned = inside.join("\n");
  }
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  return start < 0 || end < start ? null : cleaned.slice(start, end + 1);
}

class Unparseable extends Error {}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function optional<T>(value: unknown, type: "string" | "boolean" | "number"): T | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== type) throw new Unparseable();
  return value as T;
}

function optionalObject(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isObject(value)) throw new Unparseable();
  return value;
}

function lines(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((line) => typeof line === "string")) return value;
  throw new Unparseable();
}

function parseTool(raw: string): string {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  if (lower === "browser" || lower === "shell" || lower === "files") return lower;
  if (trimmed.startsWith("connection:")) {
    const id = trimmed.slice("connection:".length).trim();
    if (id) return `connection:${id}`;
  }
  return "none";
}

function parseRisk(raw: string): Risk {
  const lower = raw.trim().toLowerCase();
  if (lower === "safe" || lower === "") return "safe";
  return lower === "destructive" ? "destructive" : "outward";
}

function markerEnd(after: string): string | null {
  return after === "" || /^\s/u.test(after) ? after.trimStart() : null;
}

function stripListMarker(line: string): string {
  let unbulleted = line;
  if (/^[-*•]/u.test(line)) unbulleted = markerEnd(line.slice(1)) ?? line;
  const digits = /^[0-9]*/.exec(unbulleted)![0].length;
  if (digits === 0) return unbulleted;
  const rest = unbulleted.slice(digits);
  if (rest.startsWith(".") || rest.startsWith(")")) return markerEnd(rest.slice(1)) ?? unbulleted;
  return unbulleted;
}

const clip = (text: string | undefined, maxChars: number) => truncate((text ?? "").trim(), maxChars);

export function parseHint(raw: string): Outcome {
  const think = raw.lastIndexOf("</think>");
  const answer = think >= 0 ? raw.slice(think + "</think>".length) : raw;
  const json = extractJsonObject(answer);
  if (json === null) return drop("unparseable");
  try {
    const wire: unknown = JSON.parse(json);
    if (!isObject(wire) || typeof wire.show !== "boolean") return drop("unparseable");
    const step = optionalObject(wire.next_step);
    if (wire.show && !step) return drop("unparseable");
    const automation = optionalObject(wire.automation) ?? {};
    const hint: Hint = {
      show: wire.show,
      task: clip(optional<string>(wire.task, "string"), TASK_MAX_CHARS),
      title: (optional<string>(step?.title, "string") ?? "").trim(),
      how: lines(step?.how)
        .map((line) => stripListMarker(line.trim()))
        .filter((line) => line !== ""),
      why: clip(optional<string>(step?.why, "string"), WHY_MAX_CHARS),
      confidence: optional<number>(wire.confidence, "number") ?? 0,
      automation: {
        possible: optional<boolean>(automation.possible, "boolean") ?? false,
        tool: parseTool(optional<string>(automation.tool, "string") ?? "none"),
        risk: parseRisk(optional<string>(automation.risk, "string") ?? ""),
        effect: clip(optional<string>(automation.effect, "string"), EFFECT_MAX_CHARS),
        agentPrompt: clip(optional<string>(automation.agent_prompt, "string"), AGENT_PROMPT_MAX_CHARS),
      },
    };
    return { ok: true, hint };
  } catch {
    return drop("unparseable");
  }
}

export function groundingTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const [url] of text.matchAll(/https?:\/\/[^\s<>()\[\]{}"'`]+/gu)) {
    tokens.push(url.replace(/[.,;:!?]+$/, ""));
  }
  for (const [file] of text.matchAll(/\b[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,10}\b/g)) {
    if (!NOT_FILE_NAMES.includes(file.toLowerCase())) tokens.push(file);
  }
  for (const [env] of text.matchAll(/\b[A-Z][A-Z0-9_]{3,}\b/g)) tokens.push(env);
  for (const word of text.split(/\s+/u).filter(Boolean)) {
    const path = word.replace(/^["'`(\[{<]+/, "").replace(/["'`)\]}>,;:!?.]+$/, "");
    if (
      path.includes("/") &&
      !path.includes("://") &&
      /[A-Za-z0-9]/.test(path) &&
      !NOT_PATHS.includes(path.toLowerCase())
    ) {
      tokens.push(path);
    }
  }
  return tokens;
}

function isFormOf(word: string, stem: string): boolean {
  if (word.startsWith(stem)) {
    const rest = word.slice(stem.length);
    if (["", "s", "es", "ed", "d", "ing"].includes(rest)) return true;
    const last = stem.at(-1)!;
    if (rest === `${last}ed` || rest === `${last}ing`) return true;
  }
  if (stem.endsWith("e") && word === `${stem.slice(0, -1)}ing`) return true;
  if (stem.endsWith("y")) {
    const base = stem.slice(0, -1);
    if (word === `${base}ies` || word === `${base}ied`) return true;
  }
  return false;
}

export function riskFloor(texts: string[]): Risk {
  let floor: Risk = "safe";
  for (const text of texts) {
    const lower = text.toLowerCase();
    if (DESTRUCTIVE_PHRASES.some((phrase) => lower.includes(phrase))) return "destructive";
    for (const word of lower.split(/[^a-z0-9]+/).filter(Boolean)) {
      if (DESTRUCTIVE_WORDS.some((stem) => isFormOf(word, stem))) return "destructive";
      if (OUTWARD_WORDS.some((stem) => isFormOf(word, stem))) floor = "outward";
    }
  }
  return floor;
}

const normalize = (text: string) =>
  text.split(/\s+/u).filter(Boolean).join(" ").toLowerCase().replace(/[.!:]+$/, "");

/** Mirrors `path_from_visible_parts` in `hint.rs`: a visible file joined to a
 * folder that appears inside a visible path. Both arguments lowercase. */
export function pathFromVisibleParts(path: string, corpus: string): boolean {
  const trimmed = path.replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  if (cut < 0) return false;
  const name = trimmed.slice(cut + 1);
  const folder = trimmed.slice(0, cut).replace(/^~+/, "").replace(/^\/+/, "");
  return name !== "" && folder !== "" && corpus.includes(name) && corpus.includes(`${folder}/`);
}

export function validate(input: Hint, groundingCorpus: string, focusedText: string): Outcome {
  const hint: Hint = { ...input, automation: { ...input.automation } };
  if (!hint.show) return drop("no_hint");
  if (Number.isNaN(hint.confidence) || hint.confidence < MIN_CONFIDENCE) return drop("low_confidence");
  if (hint.title === "" || chars(hint.title) > TITLE_MAX_CHARS) return drop("bad_title");
  if (
    hint.how.length === 0 ||
    hint.how.length > HOW_MAX_LINES ||
    hint.how.some((line) => chars(line) > HOW_LINE_MAX_CHARS)
  ) {
    return drop("bad_how");
  }
  const corpus = groundingCorpus.toLowerCase();
  const grounded = [hint.title, ...hint.how].flatMap(groundingTokens).every((token) => {
    const lower = token.toLowerCase();
    // Only path tokens contain `/` without `://`.
    const isPath = lower.includes("/") && !lower.includes("://");
    return corpus.includes(lower) || (isPath && pathFromVisibleParts(lower, corpus));
  });
  if (!grounded) return drop("ungrounded");
  if (normalize(focusedText).includes(normalize(hint.title))) return drop("restates_screen");

  const floor = riskFloor([hint.title, ...hint.how, hint.automation.effect, hint.automation.agentPrompt]);
  if (RISK_ORDER.indexOf(floor) > RISK_ORDER.indexOf(hint.automation.risk)) hint.automation.risk = floor;
  if (hint.automation.tool === "none") hint.automation.possible = false;
  return { ok: true, hint };
}

export function check(raw: string, groundingCorpus: string, focusedText: string): Outcome {
  const parsed = parseHint(raw);
  return parsed.ok ? validate(parsed.hint, groundingCorpus, focusedText) : parsed;
}

/** The visible text block of a rendered bundle. */
export function focusedTextOf(bundle: string): string {
  const open = "<<<SCREEN_TEXT\n";
  const start = bundle.indexOf(open);
  const end = bundle.indexOf("\nSCREEN_TEXT>>>");
  return start < 0 || end < start ? "" : bundle.slice(start + open.length, end);
}
