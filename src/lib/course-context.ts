/**
 * Course-aware framing for the flashcard generation prompt.
 *
 * The student's course (a known program like "BS Pharmacy" or anything
 * they typed) is appended to the system prompt so the AI frames questions
 * for that audience. The course *frames* the cards — it must never filter
 * the content: a pharmacy student uploading an anatomy PDF still gets
 * anatomy cards, just framed for a pharmacy student.
 *
 * Returns "" when no course is set, so the prompt stays exactly the
 * generic one for users who skipped the picker.
 */
export function coursePromptContext(course: string | null | undefined): string {
  const trimmed = (course ?? "").trim();
  if (!trimmed) return "";
  return `

The student is enrolled in ${trimmed}. Frame the flashcards for that audience: use terminology that is natural to that program and calibrate the difficulty to a typical student in it. Stay strictly faithful to the provided content — never invent facts to fit the course, and never skip important content just because it is unusual for that program.`;
}
