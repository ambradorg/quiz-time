"use client";

/**
 * "Who's online" — the owner's roster.
 *
 * Three pieces, deliberately separated so the same rows can be reused in the
 * design preview page (src/app/clay-preview) without any auth or network:
 *
 *   OwnerPresenceBar  the slim strip the app shell renders for the owner
 *   PresencePanel     the modal list (opened by the bar)
 *   PresenceList      the rows themselves (online / offline / never seen)
 *
 * Only the owner ever sees any of this: the bar is rendered from
 * `session.user.isOwner`, and `/api/presence` re-checks OWNER_EMAIL on the
 * server, so a non-owner who renders the component anyway gets a 403 and the
 * bar removes itself.
 *
 * Copy rule of thumb: presence is a *hint*, never a promise — say "3 online",
 * "4 min ago", "never seen", never "currently studying for 12 minutes".
 */
import { useEffect, useState } from "react";
import { ChevronRight, RefreshCw, Users, WifiOff, X } from "lucide-react";
import {
  ONLINE_WINDOW_SECONDS,
  displayName,
  formatLastSeen,
  formatOnlineCount,
  initialsFor,
  type PresenceEntry,
} from "@/lib/presence";
import { usePresenceRoster, type PresenceError, type PresenceRoster } from "@/lib/use-presence";

/** The owner's strip, wired up: reads the roster and opens the panel.
 *  Renders nothing if the server says this session isn't the owner (403). */
export function OwnerPresenceBar() {
  const { roster, loading, error, refresh } = usePresenceRoster({ enabled: true });
  const [open, setOpen] = useState(false);

  // Not the owner (env changed since the page was server-rendered, or a stale
  // client flag): disappear rather than show a broken panel.
  if (error === "forbidden") return null;

  return (
    <>
      <div style={{ padding: "12px 16px 0" }}>
        <PresenceBar
          roster={roster}
          loading={loading}
          onOpen={() => {
            setOpen(true);
            // Opening is a "give me the truth now" moment.
            void refresh();
          }}
        />
      </div>

      {open && (
        <PresencePanel
          roster={roster}
          loading={loading}
          error={error}
          onRefresh={refresh}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/**
 * The strip itself: "● Who's online  [avatars]  3 online ›".
 *
 * Presentational on purpose — pass `onOpen` for the real thing (it becomes a
 * button), or omit it to render the same look as a static preview (see
 * src/app/clay-preview).
 */
export function PresenceBar({
  roster,
  loading = false,
  onOpen,
}: {
  roster: PresenceRoster | null;
  loading?: boolean;
  onOpen?: () => void;
}) {
  const online = roster?.users.filter((entry) => entry.online) ?? [];
  const summary = roster ? formatOnlineCount(roster.online) : loading ? "Checking…" : "—";

  const contents = (
    <>
      <span className="presence-dot" aria-hidden />
      <span style={{ fontWeight: 800, fontSize: 13 }}>Who&apos;s online</span>
      <span className="presence-avatars">
        {online.slice(0, 4).map((entry) => (
          <PresenceAvatar key={entry.id} entry={entry} size={22} />
        ))}
      </span>
      <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 12.5, fontWeight: 800, color: "#0f766e" }}>{summary}</span>
        <ChevronRight size={16} aria-hidden style={{ color: "var(--text-muted)" }} />
      </span>
    </>
  );

  if (!onOpen) return <div className="presence-bar">{contents}</div>;

  return (
    <button type="button" className="presence-bar" onClick={onOpen} aria-haspopup="dialog">
      {contents}
    </button>
  );
}

/**
 * The modal roster. Fixed-position card (not a popover) so it behaves the same
 * on a 360 px phone and on the desktop shell — same pattern as the deck editor.
 */
export function PresencePanel({
  roster,
  loading,
  error,
  onRefresh,
  onClose,
}: {
  roster: PresenceRoster | null;
  loading: boolean;
  error: PresenceError;
  onRefresh: () => Promise<void> | void;
  onClose: () => void;
}) {
  // The refresh button owns its own spinner: polling in the background should
  // never make the list look busy.
  const [refreshing, setRefreshing] = useState(false);
  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  // Escape closes (the backdrop click is handled below), and the page behind
  // the modal stops scrolling while it is open.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  const users = roster?.users ?? [];
  const windowLabel = roster?.windowSeconds ?? ONLINE_WINDOW_SECONDS;

  return (
    <>
      <div className="presence-backdrop" onClick={onClose} aria-hidden />
      <div
        className="presence-panel animate-slide-up"
        role="dialog"
        aria-modal="true"
        aria-label="Who's online"
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 4 }}>
          <span
            style={{
              width: 34,
              height: 34,
              borderRadius: 12,
              background: "linear-gradient(135deg, #34d399, #0ea5e9)",
              color: "white",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <Users size={18} aria-hidden />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 900 }}>Who&apos;s online</h2>
            <p style={{ margin: "2px 0 0", fontSize: 11.5, color: "var(--text-muted)", fontWeight: 600 }}>
              Owner-only view · updates itself every few seconds
            </p>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void handleRefresh()}
            disabled={refreshing}
            aria-label="Refresh"
            style={{ padding: "6px 8px", flexShrink: 0 }}
          >
            <RefreshCw
              size={16}
              aria-hidden
              style={refreshing ? { animation: "spin 1s linear infinite" } : undefined}
            />
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onClose}
            aria-label="Close"
            style={{ padding: "6px 8px", flexShrink: 0 }}
          >
            <X size={16} aria-hidden />
          </button>
        </div>

        <p
          style={{
            margin: "0 0 12px",
            fontSize: 12,
            fontWeight: 700,
            color: roster && roster.online > 0 ? "#0f766e" : "var(--text-muted)",
          }}
        >
          {roster ? `${formatOnlineCount(roster.online)} now` : loading ? "Checking…" : "—"}
          <span style={{ fontWeight: 600, color: "var(--text-muted)" }}>
            {" "}
            · online = seen in the last {windowLabel}s
          </span>
        </p>

        {error === "unreachable" && (
          <div className="presence-empty">
            <WifiOff size={18} aria-hidden />
            <p style={{ margin: 0, fontSize: 12.5, fontWeight: 700 }}>
              Can&apos;t reach the server
            </p>
            <p style={{ margin: "2px 0 0", fontSize: 11.5, color: "var(--text-muted)" }}>
              Who&apos;s online needs a connection — the list below may be out of date.
            </p>
          </div>
        )}

        <PresenceList users={users} ownerId={users.find((entry) => entry.isOwner)?.id ?? null} />

        {!roster && !error && (
          <div className="presence-empty">
            <Users size={18} aria-hidden />
            <p style={{ margin: 0, fontSize: 12.5, fontWeight: 700 }}>Loading the list…</p>
          </div>
        )}
      </div>
    </>
  );
}

/**
 * The roster rows, grouped so the answer to "who's online?" is the first thing
 * read: online first, then recently seen, then accounts that never checked in.
 */
export function PresenceList({
  users,
  ownerId = null,
  max = 60,
}: {
  users: PresenceEntry[];
  ownerId?: string | null;
  max?: number;
}) {
  const online = users.filter((entry) => entry.online);
  const seen = users.filter((entry) => !entry.online && entry.lastSeenSecondsAgo !== null);
  const never = users.filter((entry) => entry.lastSeenSecondsAgo === null);

  if (users.length === 0) {
    return (
      <div className="presence-empty">
        <Users size={18} aria-hidden />
        <p style={{ margin: 0, fontSize: 12.5, fontWeight: 700 }}>No accounts yet</p>
        <p style={{ margin: "2px 0 0", fontSize: 11.5, color: "var(--text-muted)" }}>
          Once somebody signs in, they show up here.
        </p>
      </div>
    );
  }

  const rows = (list: PresenceEntry[]) =>
    list.slice(0, max).map((entry) => (
      <PresenceRow key={entry.id} entry={entry} isYou={entry.id === ownerId} />
    ));

  const overflow = (list: PresenceEntry[]) =>
    list.length > max ? (
      <p style={{ margin: "6px 2px 0", fontSize: 11.5, color: "var(--text-muted)", fontWeight: 600 }}>
        +{list.length - max} more
      </p>
    ) : null;

  return (
    <div>
      {online.length > 0 && (
        <PresenceSection title={`Online now (${online.length})`}>
          {rows(online)}
          {overflow(online)}
        </PresenceSection>
      )}
      {seen.length > 0 && (
        <PresenceSection title="Recently active">
          {rows(seen)}
          {overflow(seen)}
        </PresenceSection>
      )}
      {never.length > 0 && (
        <PresenceSection title="Never seen">
          {rows(never)}
          {overflow(never)}
        </PresenceSection>
      )}
    </div>
  );
}

function PresenceSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 10 }}>
      <p className="presence-section-title">{title}</p>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
        {children}
      </ul>
    </div>
  );
}

function PresenceRow({ entry, isYou }: { entry: PresenceEntry; isYou: boolean }) {
  const name = displayName(entry);
  const meta = [entry.activity, entry.device].filter(Boolean).join(" · ");

  return (
    <li className="presence-row">
      <PresenceAvatar entry={entry} size={34} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <p
          style={{
            margin: 0,
            fontSize: 13,
            fontWeight: 800,
            display: "flex",
            alignItems: "center",
            gap: 6,
            minWidth: 0,
          }}
        >
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {name}
          </span>
          {isYou && <span className="presence-tag presence-tag-you">you</span>}
          {entry.isOwner && !isYou && <span className="presence-tag">owner</span>}
        </p>
        {entry.email && (
          <p
            style={{
              margin: "1px 0 0",
              fontSize: 11.5,
              color: "var(--text-muted)",
              fontWeight: 600,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {entry.email}
          </p>
        )}
        {meta && (
          <p
            style={{
              margin: "3px 0 0",
              fontSize: 11.5,
              color: "var(--text-muted)",
              fontWeight: 600,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {meta}
          </p>
        )}
      </div>
      <div style={{ textAlign: "right", flexShrink: 0 }}>
        {entry.online ? (
          <span className="presence-status-online">
            <span className="presence-dot" aria-hidden />
            Online
          </span>
        ) : (
          <span style={{ fontSize: 11.5, fontWeight: 700, color: "var(--text-muted)" }}>
            {formatLastSeen(entry.lastSeenSecondsAgo)}
          </span>
        )}
      </div>
    </li>
  );
}

/** Avatar with a coloured-initials fallback (Google images are optional). */
export function PresenceAvatar({ entry, size = 34 }: { entry: PresenceEntry; size?: number }) {
  const ring = entry.online ? "2px solid #34d399" : "2px solid rgba(148, 163, 184, 0.5)";
  if (entry.image) {
    return (
      /* eslint-disable-next-line @next/next/no-img-element */
      <img
        src={entry.image}
        alt=""
        width={size}
        height={size}
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          objectFit: "cover",
          flexShrink: 0,
          boxShadow: `0 0 0 ${ring}`,
        }}
      />
    );
  }
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: "linear-gradient(135deg, #3b82f6, #7c3aed)",
        color: "white",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: Math.max(10, Math.round(size * 0.4)),
        fontWeight: 800,
        flexShrink: 0,
        boxShadow: `0 0 0 ${ring}`,
      }}
    >
      {initialsFor(displayName(entry))}
    </span>
  );
}
