/**
 * The courses offered at the school, grouped by college — the list the
 * course picker shows as one-tap buttons.
 *
 * These are *suggestions*, not a closed list: the picker's "Something
 * else…" field accepts any free text, and whatever the user ends up with
 * (a button pick or typed text) is stored as a single string on their
 * account. Editing this list is a 30-second task and never breaks anything.
 */
export interface College {
  /** Short code shown in the section header (e.g. "AHC"). */
  code: string;
  /** Full college name shown in the section header. */
  name: string;
  /** The programs in this college — one button each in the picker. */
  programs: string[];
}

export const COLLEGES: College[] = [
  {
    code: "AHC",
    name: "Allied Health College",
    programs: [
      "BS Pharmacy",
      "BS Medical Technology",
      "BS Radiologic Technology",
      "BS Midwifery",
    ],
  },
  {
    code: "CECS",
    name: "College of Engineering and Computer Studies",
    programs: [
      "BS Civil Engineering",
      "BS Computer Engineering",
      "BS Electronic Engineering",
      "BS Information Technology",
      "BS Library and Information Science",
    ],
  },
  {
    code: "CTEAS",
    name: "College of Teachers, Education, Arts and Sciences",
    programs: [
      "BS Secondary Education",
      "BS Elementary Education",
      "BS Psychology",
    ],
  },
  {
    code: "CHBA",
    name: "College of Hospitality, Business and Accountancy",
    programs: [
      "BS Accountancy",
      "BS Business Administration",
      "BS Hospitality Management",
    ],
  },
  {
    code: "CCJE",
    name: "College of Criminal Justice Education",
    programs: ["BS Criminology"],
  },
];

/** Every known program, flat — used to detect "is this a button pick?". */
export const ALL_PROGRAMS: string[] = COLLEGES.flatMap((c) => c.programs);
