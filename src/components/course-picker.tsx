"use client";

import { useEffect, useRef, useState } from "react";
import {
  Check,
  GraduationCap,
  PenLine,
  X,
} from "lucide-react";
import { ALL_PROGRAMS, COLLEGES } from "@/lib/courses";

/**
 * The "What's your course?" picker.
 *
 * One component for both moments: the first-login modal (canSkip → "Maybe
 * later") and the later "change my course" edit (pre-filled, no skip).
 *
 * The design rule (agreed with the user): the course buttons are just
 * shortcuts that fill one answer — the answer is either a known program
 * (button pick) or free text ("Something else…"). There is no closed list:
 * nobody is ever locked out, and the AI only ever sees one string.
 */
export function CoursePickerModal({
  initialCourse,
  busy,
  canSkip,
  onSave,
  onSkip,
}: {
  /** The saved course — null on first login, a string when editing. */
  initialCourse: string | null;
  /** Save request in flight — disables the buttons. */
  busy: boolean;
  /** First-login mode shows "Maybe later"; edit mode just closes. */
  canSkip: boolean;
  onSave: (course: string) => void;
  onSkip: () => void;
}) {
  const isKnown = ALL_PROGRAMS.includes(initialCourse ?? "");
  const [selected, setSelected] = useState<string | null>(
    isKnown ? (initialCourse as string) : null
  );
  const [otherOpen, setOtherOpen] = useState(!isKnown && initialCourse !== null);
  const [other, setOther] = useState(isKnown ? "" : (initialCourse ?? ""));
  const otherRef = useRef<HTMLInputElement>(null);

  // "Something else…" just opened → jump straight into the field.
  useEffect(() => {
    if (otherOpen) otherRef.current?.focus();
  }, [otherOpen]);

  // Escape closes without saving.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onSkip();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSkip]);

  const value = otherOpen ? other.trim() : (selected ?? "").trim();

  const pickProgram = (program: string) => {
    setSelected(program);
    setOtherOpen(false);
  };

  const openOther = () => {
    setSelected(null);
    setOtherOpen(true);
  };

  return (
    <div
      className="course-picker-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="What's your course?"
      onClick={onSkip}
    >
      <div
        className="glass-card course-picker-card"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 16 }}>
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 14,
              background: "linear-gradient(135deg, #3b82f6, #7c3aed)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "white",
              flexShrink: 0,
            }}
          >
            <GraduationCap size={24} strokeWidth={1.75} aria-hidden />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: 19, fontWeight: 800 }}>
              {initialCourse !== null ? "Change your course" : "What's your course?"}
            </h2>
            <p style={{ margin: "2px 0 0", fontSize: 13, color: "var(--text-muted)", lineHeight: 1.5 }}>
              QuizTime tailors your flashcards to this course — the AI writes
              questions in terms your program uses.
            </p>
          </div>
          <button
            className="btn btn-ghost btn-sm"
            onClick={onSkip}
            style={{ padding: 6, borderRadius: 10, flexShrink: 0 }}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* The grouped course buttons — scrollable on small screens. */}
        <div
          className="course-picker-list"
          style={{
            maxHeight: "46vh",
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 14,
            paddingRight: 4,
            marginBottom: 14,
          }}
        >
          {COLLEGES.map((college) => (
            <div key={college.code}>
              <p
                style={{
                  margin: "0 0 7px",
                  fontSize: 11.5,
                  fontWeight: 800,
                  letterSpacing: 0.4,
                  textTransform: "uppercase",
                  color: "var(--text-muted)",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <span
                  style={{
                    background: "#eef2ff",
                    color: "#4338ca",
                    borderRadius: 6,
                    padding: "1px 6px",
                    fontSize: 10.5,
                  }}
                >
                  {college.code}
                </span>
                {college.name}
              </p>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(2, 1fr)",
                  gap: 7,
                }}
              >
                {college.programs.map((program) => {
                  const active = !otherOpen && selected === program;
                  return (
                    <button
                      key={program}
                      type="button"
                      className={`course-chip${active ? " active" : ""}`}
                      onClick={() => pickProgram(program)}
                      disabled={busy}
                    >
                      {active && <Check size={14} aria-hidden style={{ flexShrink: 0 }} />}
                      <span>{program}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

          {/* The open-ended escape hatch — nothing blocks anyone. */}
          <div style={{ borderTop: "1.5px dashed #c7d9f7", paddingTop: 14 }}>
            {!otherOpen ? (
              <button
                type="button"
                className={`course-chip wide${busy ? " disabled" : ""}`}
                onClick={openOther}
                disabled={busy}
              >
                <PenLine size={14} aria-hidden style={{ flexShrink: 0 }} />
                <span>Something else… type your own</span>
              </button>
            ) : (
              <input
                ref={otherRef}
                className="course-other-input"
                value={other}
                onChange={(e) => setOther(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && value && !busy) onSave(value);
                }}
                placeholder="Type your course, e.g. BS Pharmacy 3rd year"
                maxLength={80}
                aria-label="Your course"
              />
            )}
          </div>
        </div>

        {/* Footer */}
        <div style={{ display: "flex", gap: 10 }}>
          {canSkip && (
            <button
              className="btn btn-ghost"
              style={{ flex: 1 }}
              onClick={onSkip}
              disabled={busy}
            >
              Maybe later
            </button>
          )}
          <button
            className="btn btn-primary"
            style={{ flex: canSkip ? 2 : 1 }}
            onClick={() => onSave(value)}
            disabled={!value || busy}
          >
            {busy ? "Saving…" : (
              <>
                <Check />
                {initialCourse !== null ? "Save course" : "Start studying"}
              </>
            )}
          </button>
        </div>
        <p
          style={{
            margin: "10px 0 0",
            fontSize: 11.5,
            color: "var(--text-muted)",
            textAlign: "center",
          }}
        >
          You can change this any time from the Home screen.
        </p>
      </div>
    </div>
  );
}
