"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  Bell,
  BellRing,
  BookOpen,
  Brain,
  Check,
  CheckCheck,
  ChevronRight,
  CloudCheck,
  House,
  Info,
  Library,
  RotateCcw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trophy,
  Upload,
  X,
  ChartColumn,
  type LucideIcon,
} from "lucide-react";
import styles from "./preview.module.css";

type Kind = "review" | "ready" | "milestone" | "sync";
type Notice = {
  id: number;
  kind: Kind;
  title: string;
  text: string;
  time: string;
  action?: string;
  unread: boolean;
  group: "Today" | "Yesterday";
};
const kinds: {
  id: Kind;
  title: string;
  description: string;
  Icon: LucideIcon;
  label: string;
}[] = [
  {
    id: "review",
    title: "A timely study nudge",
    description: "A gentle reminder when your cards are ready for review.",
    Icon: Brain,
    label: "Study reminders",
  },
  {
    id: "ready",
    title: "Ready when you are",
    description: "Know when your upload has become a fresh set of flashcards.",
    Icon: Sparkles,
    label: "Study sets ready",
  },
  {
    id: "milestone",
    title: "Small wins, celebrated",
    description: "A little encouragement for the progress you’re making.",
    Icon: Trophy,
    label: "Learning milestones",
  },
  {
    id: "sync",
    title: "Peace of mind",
    description: "Know your offline study progress is safely synced.",
    Icon: CloudCheck,
    label: "Sync updates",
  },
];
const samples: Notice[] = [
  {
    id: 1,
    kind: "review",
    title: "A little review goes a long way",
    text: "12 cards in Cell Biology are ready. Give your memory a quick refresh.",
    time: "5 min ago",
    action: "Review 12 cards",
    unread: true,
    group: "Today",
  },
  {
    id: 2,
    kind: "ready",
    title: "Your new study set is ready!",
    text: "From notes to knowledge. 24 flashcards from Human Anatomy are waiting for you.",
    time: "20 min ago",
    action: "Open study set",
    unread: true,
    group: "Today",
  },
  {
    id: 3,
    kind: "milestone",
    title: "Look at you, learning!",
    text: "You’ve reviewed 100 cards. That’s 100 little steps forward. Keep it up!",
    time: "1 hour ago",
    action: "See progress",
    unread: true,
    group: "Today",
  },
  {
    id: 4,
    kind: "sync",
    title: "All caught up, everywhere",
    text: "Your 8 offline answers are synced. Your progress is right where you left it.",
    time: "Yesterday, 4:30 PM",
    unread: false,
    group: "Yesterday",
  },
];

export default function NotificationPreview() {
  const [notices, setNotices] = useState(samples);
  const [open, setOpen] = useState(true);
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [view, setView] = useState<"inbox" | "settings">("inbox");
  const [selected, setSelected] = useState<Notice | null>(null);
  const [preferences, setPreferences] = useState<Record<Kind, boolean>>({
    review: true,
    ready: true,
    milestone: true,
    sync: true,
  });
  const [announcement, setAnnouncement] = useState("");
  const bell = useRef<HTMLButtonElement>(null);
  const unread = notices.filter((n) => n.unread).length;
  const visible = notices.filter((n) => filter === "all" || n.unread);

  function reset() {
    setNotices(samples);
    setOpen(true);
    setFilter("all");
    setView("inbox");
    setSelected(null);
    setPreferences({ review: true, ready: true, milestone: true, sync: true });
    setAnnouncement("Sample notifications restored.");
  }
  function close() {
    setOpen(false);
    bell.current?.focus();
  }
  function openNotice(notice: Notice) {
    setNotices((current) =>
      current.map((n) => (n.id === notice.id ? { ...n, unread: false } : n)),
    );
    setSelected(notice);
  }

  return (
    <main className={styles.preview}>
      <header className={styles.siteHeader}>
        <Link className={styles.brand} href="/" aria-label="QuizTime home">
          <span className={styles.brandIcon}>
            <BookOpen size={23} />
          </span>
          <span>
            QuizTime<span className={styles.brandDot}>.</span>
          </span>
        </Link>
        <div className={styles.headerRight}>
          <span className={styles.conceptBadge}>
            <span /> Design concept
          </span>
          <span className={styles.headerDivider} />
          <span className={styles.version}>Notifications / 01</span>
        </div>
      </header>

      <div className={styles.layout}>
        <section className={styles.intro}>
          <div className={styles.eyebrow}>
            <span /> A LITTLE MORE CONNECTED
          </div>
          <h1>
            A little nudge.
            <br />A lot of <span>progress.</span>
          </h1>
          <p className={styles.lead}>
            The right update, at the right time.
            <br />
            Meet a calmer way to stay on top of your learning.
          </p>
          <div className={styles.recommendation}>
            <BellRing size={16} />
            <span>Recommended: an in-app notification center</span>
          </div>
          <div className={styles.suggestions}>
            {kinds.map(({ id, title, description, Icon }, index) => (
              <div className={styles.suggestion} key={id}>
                <span className={`${styles.kindIcon} ${styles[id]}`}>
                  <Icon size={21} />
                </span>
                <div>
                  <h2>{title}</h2>
                  <p>{description}</p>
                </div>
                <span className={styles.number}>0{index + 1}</span>
              </div>
            ))}
          </div>
          <div className={styles.promise}>
            <ShieldCheck size={19} />
            <p>
              <strong>Helpful, never noisy.</strong> No pop-ups during a quiz.
              <br />
              Browser push and email can wait until you opt in.
            </p>
          </div>
        </section>

        <section
          className={styles.demoArea}
          aria-label="Interactive notification design"
        >
          <div className={styles.demoCaption}>
            <span>
              <span className={styles.liveDot} /> INTERACTIVE PREVIEW
            </span>
            <button onClick={reset}>
              <RotateCcw size={13} /> Reset demo
            </button>
          </div>
          <div className={styles.appShell}>
            <header className={styles.appHeader}>
              <span className={styles.appLogo}>
                <BookOpen size={22} />
              </span>
              <div className={styles.appName}>
                QuizTime<small>Your AI Study Partner</small>
              </div>
              <button
                ref={bell}
                className={`${styles.bell} ${open ? styles.bellActive : ""}`}
                aria-label={`Notifications, ${unread} unread`}
                aria-expanded={open}
                aria-controls="notification-panel"
                onClick={() => {
                  setOpen(!open);
                  setView("inbox");
                  setSelected(null);
                }}
              >
                <Bell size={21} />
                {unread > 0 && <span className={styles.badge}>{unread}</span>}
              </button>
              <span className={styles.avatar} aria-label="Sample user Alex">
                A
              </span>
            </header>
            {open ? (
              <section
                id="notification-panel"
                className={styles.panel}
                aria-label="Notifications"
                onKeyDown={(e) => {
                  if (e.key === "Escape") close();
                }}
              >
                <div className={styles.panelHeading}>
                  <div>
                    <h2>
                      {view === "settings"
                        ? "Your preferences"
                        : selected
                          ? "A closer look"
                          : "Notifications"}
                      {view === "inbox" && !selected && unread > 0 && (
                        <span>{unread} new</span>
                      )}
                    </h2>
                    <p>
                      {view === "settings"
                        ? "A little less noise. A little more you."
                        : selected
                          ? "A preview of where this update takes you."
                          : "Little updates for your learning journey."}
                    </p>
                  </div>
                  <button
                    className={styles.iconButton}
                    aria-label="Close notifications"
                    onClick={close}
                  >
                    <X size={19} />
                  </button>
                </div>
                {view === "settings" ? (
                  <div className={styles.settings}>
                    <button
                      className={styles.back}
                      onClick={() => setView("inbox")}
                    >
                      <ArrowLeft size={15} /> Back to notifications
                    </button>
                    <p className={styles.settingsIntro}>
                      Choose the updates you’d like to receive.
                    </p>
                    {kinds.map(({ id, label, Icon }) => (
                      <div className={styles.preference} key={id}>
                        <span className={`${styles.kindIcon} ${styles[id]}`}>
                          <Icon size={19} />
                        </span>
                        <span>{label}</span>
                        <button
                          role="switch"
                          aria-checked={preferences[id]}
                          aria-label={label}
                          className={`${styles.toggle} ${preferences[id] ? styles.toggleOn : ""}`}
                          onClick={() =>
                            setPreferences((p) => ({ ...p, [id]: !p[id] }))
                          }
                        >
                          <span />
                        </button>
                      </div>
                    ))}
                    <div className={styles.settingsNote}>
                      <Info size={17} />
                      <p>
                        These switches are a visual demo. They won’t change your
                        account or send notifications.
                      </p>
                    </div>
                    <div className={styles.channel}>
                      <Bell size={16} />
                      <span>In-app only</span>
                      <span className={styles.channelTag}>Recommended</span>
                    </div>
                    <p className={styles.permissionNote}>
                      No email. No browser permission request.
                    </p>
                  </div>
                ) : selected ? (
                  <div className={styles.detail}>
                    <button
                      className={styles.back}
                      onClick={() => setSelected(null)}
                    >
                      <ArrowLeft size={15} /> Back to notifications
                    </button>
                    <div
                      className={`${styles.detailIcon} ${styles[selected.kind]}`}
                    >
                      {(() => {
                        const Icon = kinds.find(
                          (k) => k.id === selected.kind,
                        )!.Icon;
                        return <Icon size={32} />;
                      })()}
                    </div>
                    <span className={styles.detailLabel}>
                      SAMPLE DESTINATION
                    </span>
                    <h3>
                      {selected.kind === "review"
                        ? "Your daily review"
                        : selected.kind === "ready"
                          ? "Human Anatomy"
                          : selected.kind === "milestone"
                            ? "100 cards. Real progress."
                            : "Progress safely synced"}
                    </h3>
                    <p>
                      {selected.kind === "review"
                        ? "This would open your spaced-review queue, with 12 Cell Biology cards ready to practice."
                        : selected.kind === "ready"
                          ? "This would open your newly generated set of 24 flashcards, ready to study your way."
                          : selected.kind === "milestone"
                            ? "This would open your Stats page to see how far you’ve come."
                            : "Your offline answers would be confirmed here once they reach your account."}
                    </p>
                    <span className={styles.sampleTag}>
                      Preview only · No account changes
                    </span>
                  </div>
                ) : (
                  <>
                    <div className={styles.toolbar}>
                      <div
                        className={styles.tabs}
                        role="group"
                        aria-label="Filter notifications"
                      >
                        <button
                          aria-pressed={filter === "all"}
                          className={filter === "all" ? styles.activeTab : ""}
                          onClick={() => setFilter("all")}
                        >
                          All updates
                        </button>
                        <button
                          aria-pressed={filter === "unread"}
                          className={
                            filter === "unread" ? styles.activeTab : ""
                          }
                          onClick={() => setFilter("unread")}
                        >
                          Unread <span>{unread}</span>
                        </button>
                      </div>
                      <button
                        className={styles.markRead}
                        disabled={!unread}
                        onClick={() => {
                          setNotices((n) =>
                            n.map((item) => ({ ...item, unread: false })),
                          );
                          setAnnouncement("All notifications marked as read.");
                        }}
                      >
                        <CheckCheck size={15} />
                        <span>Mark all read</span>
                      </button>
                    </div>
                    <div className={styles.feed}>
                      {visible.length === 0 ? (
                        <div className={styles.empty}>
                          <span>
                            <CheckCheck size={32} />
                          </span>
                          <h3>You’re all caught up!</h3>
                          <p>A clear inbox. A little room to focus.</p>
                          <button
                            className={styles.back}
                            onClick={() => setFilter("all")}
                          >
                            See all updates <ArrowRight size={15} />
                          </button>
                        </div>
                      ) : (
                        ["Today", "Yesterday"].map((group) => {
                          const entries = visible.filter(
                            (n) => n.group === group,
                          );
                          return (
                            entries.length > 0 && (
                              <div key={group}>
                                <h3 className={styles.groupLabel}>{group}</h3>
                                {entries.map((notice) => {
                                  const Icon = kinds.find(
                                    (k) => k.id === notice.kind,
                                  )!.Icon;
                                  return (
                                    <article
                                      className={`${styles.notice} ${notice.unread ? styles.unreadNotice : ""}`}
                                      key={notice.id}
                                    >
                                      <span
                                        className={`${styles.kindIcon} ${styles[notice.kind]}`}
                                      >
                                        <Icon size={20} />
                                      </span>
                                      <div className={styles.noticeContent}>
                                        <div className={styles.noticeTitle}>
                                          <h4>{notice.title}</h4>
                                          {notice.unread && (
                                            <span
                                              className={styles.unreadDot}
                                              aria-label="Unread"
                                            />
                                          )}
                                        </div>
                                        <p>{notice.text}</p>
                                        <div className={styles.noticeMeta}>
                                          <time>{notice.time}</time>
                                          {notice.unread && (
                                            <button
                                              aria-label={`Mark ${notice.title} as read`}
                                              title="Mark as read"
                                              onClick={() =>
                                                setNotices((n) =>
                                                  n.map((item) =>
                                                    item.id === notice.id
                                                      ? {
                                                          ...item,
                                                          unread: false,
                                                        }
                                                      : item,
                                                  ),
                                                )
                                              }
                                            >
                                              <Check size={14} />
                                            </button>
                                          )}
                                        </div>
                                        {notice.action && (
                                          <button
                                            className={`${styles.noticeAction} ${notice.kind === "review" ? styles.primaryAction : ""}`}
                                            onClick={() => openNotice(notice)}
                                          >
                                            {notice.action}
                                            <ArrowRight size={13} />
                                          </button>
                                        )}
                                      </div>
                                    </article>
                                  );
                                })}
                              </div>
                            )
                          );
                        })
                      )}
                    </div>
                  </>
                )}
                <footer className={styles.panelFooter}>
                  <span>
                    <span /> You’re in control
                  </span>
                  <button
                    onClick={() => {
                      setView(view === "settings" ? "inbox" : "settings");
                      setSelected(null);
                    }}
                  >
                    <Settings2 size={14} />
                    {view === "settings"
                      ? "Back to inbox"
                      : "Notification preferences"}
                    <ChevronRight size={13} />
                  </button>
                </footer>
              </section>
            ) : (
              <div className={styles.homePreview}>
                <span className={styles.homeEyebrow}>
                  YOUR DAILY DOSE OF PROGRESS
                </span>
                <h2>
                  Hey, Alex <span>✦</span>
                  <br />
                  Ready for a little learning?
                </h2>
                <p>Your next small step starts here.</p>
                <div className={styles.reviewCard}>
                  <Brain size={30} />
                  <h3>Freshen up your memory</h3>
                  <p>12 cards are ready for review today.</p>
                  <button
                    onClick={() => {
                      setOpen(true);
                      setView("inbox");
                      setSelected(samples[0]);
                    }}
                  >
                    Let’s review <ArrowRight size={15} />
                  </button>
                </div>
                <div className={styles.bellHint}>
                  <BellRing size={19} />
                  <p>
                    Tap the bell to see your updates.
                    <br />
                    <strong>Good things are waiting.</strong>
                  </p>
                </div>
              </div>
            )}
            <div
              className={styles.bottomNav}
              aria-label="App navigation context (visual only)"
            >
              {[
                { Icon: House, label: "Home" },
                { Icon: Upload, label: "Upload" },
                { Icon: Library, label: "My Sets" },
                { Icon: Brain, label: "Review" },
                { Icon: ChartColumn, label: "Stats" },
              ].map(({ Icon, label }, i) => (
                <div className={i === 0 ? styles.currentNav : ""} key={label}>
                  <Icon size={19} />
                  <span>{label}</span>
                </div>
              ))}
            </div>
          </div>
          <p className={styles.tryHint}>
            <span>Try it out</span> Filter unread, mark as read, or customize
            preferences.
          </p>
        </section>
      </div>
      <footer className={styles.pageFooter}>
        <span>
          <span className={styles.footerDot} /> A thoughtful addition. Not
          another distraction.
        </span>
        <span>
          Visual preview only <span className={styles.footerSlash}>/</span>{" "}
          Sample data, no notifications sent
        </span>
      </footer>
      <span className={styles.srOnly} role="status" aria-live="polite">
        {announcement}
      </span>
    </main>
  );
}
