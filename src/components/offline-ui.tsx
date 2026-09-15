"use client";

/**
 * Offline UI pieces — the clay-styled bits that tell a learner what still
 * works when the network is gone:
 *
 *   - `OfflineChip`      the "Offline" / "3 waiting to sync" pill in the top bar
 *   - `OfflineNotice`    the banner at the top of an offline page
 *   - `OfflinePinButton` per-deck "Save offline" / "Saved" toggle
 *   - `OfflineBadge`     "Offline" tag on a deck row
 *   - `OfflineReadyCard` the Home-page "study anywhere" card with Download all
 *
 * They are deliberately dumb: all state comes from `useOffline*` hooks in
 * src/lib/use-offline.ts and all actions are callbacks, so the same pieces
 * work in every tab without knowing how the cache is stored.
 */
import {
  CircleCheck,
  CloudDownload,
  CloudOff,
  CloudUpload,
  HardDriveDownload,
  RefreshCcw,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import { formatSavedAgo } from "@/lib/offline";

/** The top-bar status pill: offline badge + pending-writes counter. */
export function OfflineChip({
  online,
  pending,
  syncing,
  onSync,
}: {
  online: boolean;
  pending: number;
  syncing: boolean;
  onSync: () => void;
}) {
  return (
    <>
      {!online && (
        <span
          className="badge animate-fade-in"
          title="No connection — showing what's saved on this device"
          style={{
            background: "#fed7aa",
            color: "#9a3412",
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          <WifiOff size={12} aria-hidden />
          Offline
        </span>
      )}
      {pending > 0 && (
        <button
          type="button"
          className="badge"
          onClick={onSync}
          disabled={syncing}
          title={
            online
              ? `${pending} answer${pending === 1 ? "" : "s"} waiting — tap to sync now`
              : `${pending} answer${pending === 1 ? "" : "s"} saved on this device — they sync when you're back online`
          }
          style={{
            background: online ? "#dbeafe" : "#e0e7ff",
            color: online ? "#1d4ed8" : "#4338ca",
            border: "none",
            cursor: syncing ? "wait" : "pointer",
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            fontFamily: "inherit",
            fontWeight: 700,
          }}
        >
          {syncing ? (
            <span
              className="spinner"
              style={{ width: 12, height: 12, borderWidth: 2, margin: 0 }}
              aria-hidden
            />
          ) : (
            <CloudUpload size={12} aria-hidden />
          )}
          {pending}
        </button>
      )}
    </>
  );
}

/** A page-level banner explaining that the content below came from the cache. */
export function OfflineNotice({
  title = "You're offline",
  children,
  tone = "info",
  action,
}: {
  title?: string;
  children?: React.ReactNode;
  tone?: "info" | "warn";
  action?: React.ReactNode;
}) {
  const Icon: LucideIcon = tone === "warn" ? CloudOff : HardDriveDownload;
  const palette =
    tone === "warn"
      ? { bg: "#fff7ed", border: "#fed7aa", fg: "#9a3412" }
      : { bg: "#eff6ff", border: "#bfdbfe", fg: "#1e40af" };
  return (
    <div
      role="status"
      className="animate-fade-in"
      style={{
        margin: "0 0 14px",
        background: palette.bg,
        border: `1.5px solid ${palette.border}`,
        borderRadius: 16,
        padding: "12px 14px",
        display: "flex",
        gap: 10,
        alignItems: "flex-start",
      }}
    >
      <span style={{ color: palette.fg, flexShrink: 0, display: "flex", marginTop: 1 }}>
        <Icon size={20} aria-hidden />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ margin: 0, fontSize: 13, fontWeight: 800, color: palette.fg }}>{title}</p>
        {children && (
          <p style={{ margin: "2px 0 0", fontSize: 12.5, color: "var(--text-muted)" }}>
            {children}
          </p>
        )}
      </div>
      {action}
    </div>
  );
}

/** "Try again" for the offline banners — probes the network and reloads. */
export function OfflineRetryButton({
  onRetry,
  busy,
  label = "Reconnect",
}: {
  onRetry: () => void;
  busy?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      className="btn btn-white-clay btn-sm"
      onClick={onRetry}
      disabled={busy}
      style={{ flexShrink: 0, padding: "6px 10px" }}
    >
      {busy ? (
        <span
          className="spinner"
          style={{ width: 14, height: 14, borderWidth: 2, margin: 0 }}
          aria-hidden
        />
      ) : (
        <RefreshCcw />
      )}
      {label}
    </button>
  );
}

/** Per-deck "Save offline" toggle (a cloud download that becomes a check). */
export function OfflinePinButton({
  title,
  saved,
  busy,
  onToggle,
}: {
  title: string;
  saved: boolean;
  busy?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      style={{ padding: "6px", color: saved ? "#047857" : "var(--text-muted)", opacity: busy ? 0.6 : 1 }}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      disabled={busy}
      aria-label={saved ? `Remove ${title} from offline storage` : `Save ${title} for offline study`}
      title={saved ? "Saved offline — tap to remove" : "Save for offline study"}
    >
      {busy ? (
        <span
          className="spinner"
          style={{ width: 14, height: 14, borderWidth: 2, margin: 0 }}
          aria-hidden
        />
      ) : saved ? (
        <CircleCheck />
      ) : (
        <CloudDownload />
      )}
    </button>
  );
}

/** The small "Offline" tag next to a saved deck's card count. */
export function OfflineBadge({ savedAt }: { savedAt?: string | null }) {
  return (
    <span
      className="badge"
      style={{ background: "#d1fae5", color: "#047857", display: "inline-flex", alignItems: "center", gap: 4 }}
      title={savedAt ? `Saved for offline study ${formatSavedAgo(savedAt)}` : "Saved for offline study"}
    >
      <CloudOff size={11} aria-hidden />
      Offline
    </span>
  );
}

/** Home-page card: how ready is this device, and the one-tap "Download all". */
export function OfflineReadyCard({
  deckCount,
  cardCount,
  savedAt,
  online,
  busy,
  onDownloadAll,
  onOpenSets,
}: {
  deckCount: number;
  cardCount: number;
  savedAt: string | null;
  online: boolean;
  busy: boolean;
  onDownloadAll: () => void;
  onOpenSets: () => void;
}) {
  const ready = deckCount > 0;
  return (
    <div
      className="glass-card animate-fade-in"
      style={{ padding: 16, marginBottom: 14, display: "flex", gap: 12, alignItems: "center" }}
    >
      <div
        style={{
          width: 46,
          height: 46,
          borderRadius: 14,
          background: ready
            ? "linear-gradient(135deg, #d1fae5, #a7f3d0)"
            : "linear-gradient(135deg, #e0e7ff, #eef2ff)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: ready ? "#047857" : "#4338ca",
          flexShrink: 0,
        }}
        aria-hidden
      >
        {ready ? <CircleCheck size={24} /> : <CloudDownload size={24} />}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ margin: 0, fontSize: 14.5, fontWeight: 800 }}>Offline study</p>
        <p style={{ margin: "2px 0 0", fontSize: 12.5, color: "var(--text-muted)" }}>
          {ready
            ? `${deckCount} set${deckCount === 1 ? "" : "s"} · ${cardCount} cards on this device${
                savedAt ? ` · updated ${formatSavedAgo(savedAt)}` : ""
              }`
            : "Save your sets to study with no signal — answers sync when you're back."}
        </p>
      </div>
      {online ? (
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={onDownloadAll}
          disabled={busy}
          style={{ flexShrink: 0 }}
        >
          {busy ? (
            <span
              className="spinner"
              style={{
                width: 14,
                height: 14,
                borderWidth: 2,
                margin: 0,
                borderColor: "rgba(255,255,255,0.35)",
                borderTopColor: "#fff",
              }}
              aria-hidden
            />
          ) : (
            <CloudDownload />
          )}
          {ready ? "Refresh" : "Download all"}
        </button>
      ) : (
        <button
          type="button"
          className="btn btn-white-clay btn-sm"
          onClick={onOpenSets}
          style={{ flexShrink: 0 }}
        >
          My Sets
        </button>
      )}
    </div>
  );
}
